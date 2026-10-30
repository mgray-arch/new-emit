import {
  SALES_ORDER_MATCH_SQL,
  parseLegacySalesOrders,
  resolveSalesOrders,
  salesOrderMatchArgs,
  salesOrdersForStop,
} from "@/lib/sales-orders";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { PortalContext } from "@/lib/db";
import { PortalError } from "@/lib/http";
import { getOrder } from "@/lib/orders";
import { assignSelectLoadNumber, parseSelectLoadNumber } from "@/lib/select-load";
import { assignLoadOwner, type LoadOwner } from "@/lib/load-owner";
import { slackUserIdForOwner } from "@/lib/slack-new-load";
import type { CustomerOrder } from "@/lib/types";

const MIN_KEY_LENGTH = 16;
const BUILDING_WINDOW_MS = 2 * 60 * 1000;
const CALLBACK_LIMIT = 60;
const CALLBACK_WINDOW_MS = 60 * 1000;

function tokenMatches(presented: string, expected: string): boolean {
  const actual = Buffer.from(presented);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length) {
    timingSafeEqual(wanted, wanted);
    return false;
  }
  return timingSafeEqual(actual, wanted);
}

export function loadBuilderSecret(): string {
  return process.env.LOAD_BUILDER_SECRET ?? "";
}

/** Bearer secret only. A session cookie is not enough, and a short or missing secret never matches. */
export function loadBuilderSecretMatches(req: Request): boolean {
  const expected = loadBuilderSecret();
  const header = req.headers.get("authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (expected.length < MIN_KEY_LENGTH) {
    const standIn = "x".repeat(MIN_KEY_LENGTH);
    tokenMatches(presented || standIn, standIn);
    return false;
  }
  return tokenMatches(presented, expected);
}

export function loadBuilderConfigured(): boolean {
  const url = process.env.LOAD_BUILDER_WEBHOOK_URL?.trim() ?? "";
  return url.startsWith("https://") || url.startsWith("http://");
}

/** Drew's Slack member id, used when SLACK_USER_ID_DREW is not set. */
export const DREW_SLACK_USER_ID = "U0AGS6MDBL1";

export interface LoadBuilderOwner {
  name: LoadOwner;
  /** Slack member id to tag, or null when unknown (tag by name in plain text). */
  slackUserId: string | null;
}

/**
 * The same owner the portal assigns and shows: the stored owner, or the
 * load-owner rule from equipment and final delivery state for older loads.
 */
export function loadBuilderOwner(
  order: CustomerOrder,
  env: Record<string, string | undefined> = process.env,
): LoadBuilderOwner {
  const lastStop = order.stops[order.stops.length - 1];
  const name: LoadOwner =
    order.owner ?? assignLoadOwner({ destinationState: lastStop?.place.state, equipment: order.truckType }).owner;
  const fromEnv = slackUserIdForOwner(name, env);
  return { name, slackUserId: fromEnv ?? (name === "Drew" ? DREW_SLACK_USER_ID : null) };
}

/**
 * What the Load Builder bot receives. An allowlist, so carrier pay cannot ride along
 * even if it is later added to the stored order.
 */
export function loadBuilderPayload(order: CustomerOrder): Record<string, unknown> {
  const salesOrderLines = order.salesOrders?.length
    ? order.salesOrders
    : resolveSalesOrders(parseLegacySalesOrders(order.salesOrderNumber).map((number) => ({ number, stopId: null })), order.stops);
  return {
    orderId: order.id,
    salesOrderNumber: order.salesOrderNumber,
    salesOrders: salesOrderLines.map((line) => ({
      number: line.number,
      stopSequence: line.stopId ? order.stops.findIndex((stop) => stop.id === line.stopId) + 1 || null : null,
    })),
    portalStatus: order.portalStatus,
    stops: order.stops.map((stop, index) => ({
      sequence: index + 1,
      kind: stop.kind,
      salesOrders: stop.kind === "drop" ? salesOrdersForStop(salesOrderLines, stop.id) : [],
      company: stop.place.company,
      address1: stop.place.address1,
      address2: stop.place.address2 ?? "",
      city: stop.place.city,
      state: stop.place.state,
      postalCode: stop.place.postalCode,
      country: stop.place.country,
    })),
    truckType: order.truckType,
    transit: order.transit,
    shipDate: order.shipDate,
    shipTime: order.shipTime,
    mustDeliverDate: order.mustDeliverDate,
    truckEta: order.truckEta,
    customerCost: order.customerCost ?? null,
    rateReason: order.rateReason ?? null,
    comments: order.comments,
    createdBy: order.createdBy,
    owner: loadBuilderOwner(order),
  };
}

async function markBuild(
  ctx: PortalContext,
  orderId: string,
  status: "building" | "failed" | null,
  error: string | null,
): Promise<void> {
  await ctx.db
    .prepare(`UPDATE loads SET sam_build_status = ?, sam_build_error = ?, sam_build_at = ?, updated_at = ? WHERE id = ?`)
    .run(status, error, status ? ctx.now().toISOString() : null, ctx.now().toISOString(), orderId);
}

export async function requestLoadBuild(
  ctx: PortalContext,
  orderId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CustomerOrder> {
  const order = await getOrder(ctx, orderId);
  if (!order) throw new PortalError("Order not found", 404);
  if (order.loadNumber) return order;
  const url = process.env.LOAD_BUILDER_WEBHOOK_URL?.trim() ?? "";
  if (!loadBuilderConfigured()) {
    throw new PortalError(
      "LOAD_BUILDER_WEBHOOK_URL is not set. In Vercel, add it for this environment and redeploy. The load was not sent.",
      503,
    );
  }
  if (loadBuilderSecret().length < MIN_KEY_LENGTH) {
    throw new PortalError(
      "LOAD_BUILDER_SECRET is missing or shorter than 16 characters. Add it in Vercel and redeploy. The load was not sent.",
      503,
    );
  }
  if (order.samBuildStatus === "building" && order.samBuildError == null) {
    const row = await ctx.db.prepare(`SELECT sam_build_at FROM loads WHERE id = ?`).get(orderId);
    const at = Date.parse(String(row?.sam_build_at ?? ""));
    if (Number.isFinite(at) && ctx.now().getTime() - at < BUILDING_WINDOW_MS) {
      throw new PortalError("This load is already being built in SAM.", 409);
    }
  }
  await markBuild(ctx, orderId, "building", null);
  const payload = loadBuilderPayload(order);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${loadBuilderSecret()}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    await markBuild(ctx, orderId, "failed", "The Load Builder bot did not answer. Try again.");
    const failed = await getOrder(ctx, orderId);
    if (!failed) throw new PortalError("Order not found", 404);
    return failed;
  }
  if (!response.ok) {
    await markBuild(ctx, orderId, "failed", `The Load Builder bot returned ${response.status}. Try again.`);
    const failed = await getOrder(ctx, orderId);
    if (!failed) throw new PortalError("Order not found", 404);
    return failed;
  }
  const building = await getOrder(ctx, orderId);
  if (!building) throw new PortalError("Order not found", 404);
  return building;
}

export async function consumeLoadBuilderCallback(
  ctx: PortalContext,
  ip: string,
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const bucket = `sam-callback:${ip.slice(0, 80) || "unknown"}`;
  const start = new Date(ctx.now().getTime() - CALLBACK_WINDOW_MS).toISOString();
  const row = await ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE bucket = ? AND created_at >= ?`)
    .get(bucket, start);
  if (Number(row?.n ?? 0) >= CALLBACK_LIMIT) {
    return { allowed: false, retryAfterSeconds: Math.ceil(CALLBACK_WINDOW_MS / 1000) };
  }
  await ctx.db.prepare(`INSERT INTO login_attempts (id, bucket, created_at) VALUES (?, ?, ?)`).run(randomUUID(), bucket, ctx.now().toISOString());
  return { allowed: true };
}

async function orderIdForCallback(ctx: PortalContext, orderId: string, salesOrderNumber: string): Promise<string> {
  if (orderId) {
    const row = await ctx.db.prepare(`SELECT id FROM loads WHERE id = ?`).get(orderId);
    if (!row) throw new PortalError("No portal load with that id.", 404);
    return String(row.id);
  }
  const matches = await ctx.db
    .prepare(`SELECT id FROM loads WHERE ${SALES_ORDER_MATCH_SQL}`)
    .all(...salesOrderMatchArgs(salesOrderNumber));
  if (matches.length === 0) throw new PortalError(`No load with sales order ${salesOrderNumber}.`, 404);
  if (matches.length > 1) throw new PortalError(`Sales order ${salesOrderNumber} matches more than one load.`, 409);
  return String(matches[0].id);
}

/** Store the SAM load number the bot sends back. The same number again is a no-op. */
export async function acceptBuiltLoadNumber(
  ctx: PortalContext,
  input: { orderId?: string; salesOrderNumber?: string; loadNumber: string },
): Promise<CustomerOrder> {
  const parsed = parseSelectLoadNumber(input.loadNumber);
  if (!parsed) throw new PortalError("Enter a Select load number like 458934-1.");
  const id = await orderIdForCallback(ctx, input.orderId?.trim() ?? "", input.salesOrderNumber?.trim() ?? "");
  const current = await getOrder(ctx, id);
  if (!current) throw new PortalError("Order not found", 404);
  if (current.loadNumber && current.loadNumber !== parsed) {
    throw new PortalError("This load already has a different Select load number.", 409);
  }
  const saved = current.loadNumber === parsed ? current : await assignSelectLoadNumber(ctx, id, parsed, "sam");
  await markBuild(ctx, id, null, null);
  const done = await getOrder(ctx, id);
  return done ?? saved;
}
