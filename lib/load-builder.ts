import { randomUUID, timingSafeEqual } from "node:crypto";
import { recordCarrierAssignment, type CarrierNoticeResult, type CarrierUpdate } from "@/lib/carrier-notice";
import type { PortalContext } from "@/lib/db";
import { PortalError } from "@/lib/http";
import { getOrder } from "@/lib/orders";
import { assignSelectLoadNumber, parseSelectLoadNumber } from "@/lib/select-load";
import { recordCustomerShareLink } from "@/lib/tracking-link";
import type { CustomerOrder } from "@/lib/types";

const MIN_KEY_LENGTH = 16;
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

function presentedBearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

/**
 * Bearer secret only. A session cookie is not enough, and a short or missing secret never matches.
 * Either LOAD_BUILDER_SECRET or LOAD_STATUS_WEBHOOK_SECRET is accepted. Both are checked.
 */
export function loadBuilderSecretMatches(req: Request): boolean {
  const presented = presentedBearer(req);
  const secrets = [process.env.LOAD_BUILDER_SECRET ?? "", process.env.LOAD_STATUS_WEBHOOK_SECRET ?? ""].filter(
    (secret) => secret.length >= MIN_KEY_LENGTH,
  );
  if (secrets.length === 0) {
    const standIn = "x".repeat(MIN_KEY_LENGTH);
    tokenMatches(presented || standIn, standIn);
    return false;
  }
  let matched = false;
  for (const secret of secrets) {
    if (tokenMatches(presented, secret)) matched = true;
  }
  return matched;
}

async function markBuild(ctx: PortalContext, orderId: string): Promise<void> {
  await ctx.db
    .prepare(`UPDATE loads SET sam_build_status = NULL, sam_build_error = NULL, sam_build_at = NULL, updated_at = ? WHERE id = ?`)
    .run(ctx.now().toISOString(), orderId);
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
    .prepare(`SELECT id FROM loads WHERE LOWER(TRIM(sales_order_number)) = ?`)
    .all(salesOrderNumber.trim().toLowerCase());
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
  await markBuild(ctx, id);
  const done = await getOrder(ctx, id);
  return done ?? saved;
}

export async function applyLoadStatus(
  ctx: PortalContext,
  input: {
    orderId?: string;
    salesOrderNumber?: string;
    loadNumber?: string;
    trackingUrl?: string;
    carrier: CarrierUpdate | null;
  },
): Promise<{ order: CustomerOrder; notice: CarrierNoticeResult | null; tracking: "started" | "updated" | "unchanged" | null }> {
  const id = await orderIdForCallback(ctx, input.orderId?.trim() ?? "", input.salesOrderNumber?.trim() ?? "");
  if (input.loadNumber?.trim()) {
    await acceptBuiltLoadNumber(ctx, { orderId: id, loadNumber: input.loadNumber });
  }
  let notice: CarrierNoticeResult | null = null;
  if (input.carrier) {
    const current = await getOrder(ctx, id);
    if (!current) throw new PortalError("Order not found", 404);
    notice = await recordCarrierAssignment(ctx, current, input.carrier);
  }
  const tracking = input.trackingUrl ? await recordCustomerShareLink(ctx, id, input.trackingUrl) : null;
  const order = await getOrder(ctx, id);
  if (!order) throw new PortalError("Order not found", 404);
  return { order, notice, tracking };
}
