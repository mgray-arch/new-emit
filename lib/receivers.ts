import { randomBytes, randomUUID } from "node:crypto";
import { assertNoCarrierFields } from "@/lib/customer-view";
import type { PortalContext } from "@/lib/db";
import { PortalError } from "@/lib/http";
import { listOrders } from "@/lib/orders";
import { hiddenFromReceiver, listCarrierPhotos, readCarrierPhoto } from "@/lib/photos";
import { portalPublicUrl } from "@/lib/public-url";
import type { PortalStatus, StopKind, TimelineEvent, TrackingStage } from "@/lib/types";

export interface ReceiverRecord {
  id: string;
  company: string;
  contactEmails: string[];
  enabled: boolean;
  token: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReceiverShipment {
  id: string;
  salesOrderNumber: string;
  loadNumber: string | null;
  portalStatus: PortalStatus;
  trackingStage: TrackingStage;
  timeline: TimelineEvent[];
  stops: Array<{ kind: StopKind; company: string; city: string; state: string }>;
  shipDate: string | null;
  mustDeliverDate: string | null;
  latestEta: string | null;
  truckType: string | null;
  trackingUrl: string;
  trackingLink: string | null;
  photos: Array<{ id: string; filename: string; mediaType: string; receivedAt: string }>;
}

interface ReceiverRow {
  id: string;
  company: string;
  contact_emails: string;
  access_token: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function receiverUrl(token: string): string {
  return `${portalPublicUrl()}/r/${token}`;
}

function parseEmails(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function toRecord(row: ReceiverRow): ReceiverRecord {
  const token = row.access_token || "";
  return {
    id: row.id,
    company: row.company,
    contactEmails: parseEmails(row.contact_emails),
    enabled: row.enabled === 1,
    token,
    url: token ? receiverUrl(token) : "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readRow(ctx: PortalContext, id: string): Promise<ReceiverRow | null> {
  const row = (await ctx.db
    .prepare(
      `SELECT id, company, contact_emails, access_token, enabled, created_at, updated_at
       FROM receivers WHERE id = ?`,
    )
    .get(id)) as ReceiverRow | undefined;
  return row ?? null;
}

export async function listReceivers(ctx: PortalContext): Promise<ReceiverRecord[]> {
  const rows = (await ctx.db
    .prepare(
      `SELECT id, company, contact_emails, access_token, enabled, created_at, updated_at
       FROM receivers ORDER BY company`,
    )
    .all()) as unknown as ReceiverRow[];
  return rows.map(toRecord);
}

export async function createReceiver(
  ctx: PortalContext,
  input: { company: string; contactEmails: string[] },
): Promise<ReceiverRecord> {
  const id = randomUUID();
  const now = ctx.now().toISOString();
  const token = newToken();
  await ctx.db
    .prepare(
      `INSERT INTO receivers (id, company, contact_emails, access_token, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(id, input.company.trim(), JSON.stringify(input.contactEmails), token, now, now);
  const row = await readRow(ctx, id);
  if (!row) throw new PortalError("The receiver could not be saved", 500);
  return toRecord(row);
}

export async function updateReceiver(
  ctx: PortalContext,
  id: string,
  patch: { company?: string; contactEmails?: string[]; enabled?: boolean },
): Promise<ReceiverRecord> {
  const existing = await readRow(ctx, id);
  if (!existing) throw new PortalError("Receiver not found", 404);
  const company = patch.company?.trim() || existing.company;
  const emails = patch.contactEmails ?? parseEmails(existing.contact_emails);
  const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0;
  await ctx.db
    .prepare(`UPDATE receivers SET company = ?, contact_emails = ?, enabled = ?, updated_at = ? WHERE id = ?`)
    .run(company, JSON.stringify(emails), enabled, ctx.now().toISOString(), id);
  const row = await readRow(ctx, id);
  if (!row) throw new PortalError("Receiver not found", 404);
  return toRecord(row);
}

export async function deleteReceiver(ctx: PortalContext, id: string): Promise<void> {
  const result = await ctx.db.prepare(`DELETE FROM receivers WHERE id = ?`).run(id);
  if (result.changes === 0) throw new PortalError("Receiver not found", 404);
}

/** Replaces the token. The previous URL stops working. */
export async function regenerateReceiverLink(ctx: PortalContext, id: string): Promise<ReceiverRecord> {
  const existing = await readRow(ctx, id);
  if (!existing) throw new PortalError("Receiver not found", 404);
  const token = newToken();
  await ctx.db.prepare(`UPDATE receivers SET access_token = ?, updated_at = ? WHERE id = ?`).run(token, ctx.now().toISOString(), id);
  const row = await readRow(ctx, id);
  if (!row) throw new PortalError("Receiver not found", 404);
  return toRecord(row);
}

export async function receiverCompanyForToken(
  ctx: PortalContext,
  token: string,
): Promise<{ id: string; company: string } | null> {
  if (!token || token.length < 20) return null;
  const row = (await ctx.db
    .prepare(`SELECT id, company FROM receivers WHERE access_token = ? AND enabled = 1`)
    .get(token)) as { id: string; company: string } | undefined;
  return row ?? null;
}

const FORBIDDEN_RECEIVER_KEY =
  /^(carrierpay|carrierrate|carriercost|carriername|carriermc|staffnotes|customercost|customerrate|ratereason|rateconfirmation|ratecon|documents|comments|bolcount|attachmentcount|pendingreviewcount)$/;

/** The receiver response is an allowlist. A forbidden key fails the request instead of being sent. */
export function assertReceiverPayload(value: unknown): void {
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (FORBIDDEN_RECEIVER_KEY.test(key.toLowerCase().replace(/_/g, ""))) {
        throw new Error("Receiver payload contained a forbidden field");
      }
      walk(child);
    }
  };
  walk(value);
  assertNoCarrierFields(value);
}

function deliversToCompany(load: ReceiverShipment, company: string): boolean {
  const target = company.trim().toLowerCase();
  return load.stops.some((stop) => stop.kind === "drop" && stop.company.trim().toLowerCase() === target);
}

async function photosForReceiver(ctx: PortalContext, loadId: string): Promise<ReceiverShipment["photos"]> {
  const listed = await listCarrierPhotos(ctx, loadId, false);
  const photos: ReceiverShipment["photos"] = [];
  for (const photo of listed) {
    const full = await readCarrierPhoto(ctx, photo.id);
    if (!full || hiddenFromReceiver(full)) continue;
    photos.push({
      id: photo.id,
      filename: photo.filename,
      mediaType: photo.mediaType,
      receivedAt: photo.receivedAt,
    });
  }
  return photos;
}

/** Loads, tracking, and photos for one receiver. No cost, documents, or comments. */
export async function shipmentsForReceiver(ctx: PortalContext, company: string): Promise<ReceiverShipment[]> {
  const first = await listOrders(ctx, { receiverCompany: company, page: 1, pageSize: 50 });
  const orders = [...first.orders];
  const pageSize = 50;
  for (let page = 2; page <= Math.ceil(first.total / pageSize); page += 1) {
    orders.push(...(await listOrders(ctx, { receiverCompany: company, page, pageSize })).orders);
  }
  const shipments = await Promise.all(orders.map(async (order) => ({
    id: order.id,
    salesOrderNumber: order.salesOrderNumber,
    loadNumber: order.loadNumber,
    portalStatus: order.portalStatus,
    trackingStage: order.trackingStage,
    timeline: order.timeline,
    stops: order.stops.map((stop) => ({
      kind: stop.kind,
      company: stop.place.company,
      city: stop.place.city,
      state: stop.place.state,
    })),
    shipDate: order.shipDate,
    mustDeliverDate: order.mustDeliverDate,
    latestEta: order.latestEta,
    truckType: order.truckType,
    trackingUrl: order.trackingUrl,
    trackingLink: order.trackingLink,
    photos: await photosForReceiver(ctx, order.id),
  })));
  return shipments.filter((load) => deliversToCompany(load, company));
}

/** Null when the token is missing, disabled, or already rotated. The body never includes pay or documents. */
export async function receiverPortal(
  ctx: PortalContext,
  token: string,
): Promise<{ company: string; loads: ReceiverShipment[] } | null> {
  const receiver = await receiverCompanyForToken(ctx, token);
  if (!receiver) return null;
  const body = { company: receiver.company, loads: await shipmentsForReceiver(ctx, receiver.company) };
  assertReceiverPayload(body);
  return body;
}
