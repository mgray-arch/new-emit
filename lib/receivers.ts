import { randomBytes, randomUUID } from "node:crypto";
import type { PortalContext } from "@/lib/db";
import { PortalError } from "@/lib/http";
import { listOrders } from "@/lib/orders";
import { listCarrierPhotos } from "@/lib/photos";
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
  loadNumber: string;
  portalStatus: PortalStatus;
  trackingStage: TrackingStage;
  timeline: TimelineEvent[];
  stops: Array<{ kind: StopKind; company: string; city: string; state: string }>;
  shipDate: string | null;
  mustDeliverDate: string | null;
  latestEta: string | null;
  truckType: string | null;
  trackingUrl: string;
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
  const base = (process.env.PORTAL_PUBLIC_URL || "").replace(/\/$/, "");
  return `${base}/r/${token}`;
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

function readRow(ctx: PortalContext, id: string): ReceiverRow | null {
  const row = ctx.db
    .prepare(
      `SELECT id, company, contact_emails, access_token, enabled, created_at, updated_at
       FROM receivers WHERE id = ?`,
    )
    .get(id) as ReceiverRow | undefined;
  return row ?? null;
}

export function listReceivers(ctx: PortalContext): ReceiverRecord[] {
  const rows = ctx.db
    .prepare(
      `SELECT id, company, contact_emails, access_token, enabled, created_at, updated_at
       FROM receivers ORDER BY company`,
    )
    .all() as unknown as ReceiverRow[];
  return rows.map(toRecord);
}

export function createReceiver(ctx: PortalContext, input: { company: string; contactEmails: string[] }): ReceiverRecord {
  const id = randomUUID();
  const now = ctx.now().toISOString();
  const token = newToken();
  ctx.db
    .prepare(
      `INSERT INTO receivers (id, company, contact_emails, access_token, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(id, input.company.trim(), JSON.stringify(input.contactEmails), token, now, now);
  const row = readRow(ctx, id);
  if (!row) throw new PortalError("The receiver could not be saved", 500);
  return toRecord(row);
}

export function updateReceiver(
  ctx: PortalContext,
  id: string,
  patch: { company?: string; contactEmails?: string[]; enabled?: boolean },
): ReceiverRecord {
  const existing = readRow(ctx, id);
  if (!existing) throw new PortalError("Receiver not found", 404);
  const company = patch.company?.trim() || existing.company;
  const emails = patch.contactEmails ?? parseEmails(existing.contact_emails);
  const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0;
  ctx.db
    .prepare(`UPDATE receivers SET company = ?, contact_emails = ?, enabled = ?, updated_at = ? WHERE id = ?`)
    .run(company, JSON.stringify(emails), enabled, ctx.now().toISOString(), id);
  const row = readRow(ctx, id);
  if (!row) throw new PortalError("Receiver not found", 404);
  return toRecord(row);
}

export function deleteReceiver(ctx: PortalContext, id: string): void {
  const result = ctx.db.prepare(`DELETE FROM receivers WHERE id = ?`).run(id);
  if (result.changes === 0) throw new PortalError("Receiver not found", 404);
}

/** Replaces the token. The previous URL stops working. */
export function regenerateReceiverLink(ctx: PortalContext, id: string): ReceiverRecord {
  const existing = readRow(ctx, id);
  if (!existing) throw new PortalError("Receiver not found", 404);
  const token = newToken();
  ctx.db
    .prepare(`UPDATE receivers SET access_token = ?, updated_at = ? WHERE id = ?`)
    .run(token, ctx.now().toISOString(), id);
  const row = readRow(ctx, id);
  if (!row) throw new PortalError("Receiver not found", 404);
  return toRecord(row);
}

export function receiverCompanyForToken(ctx: PortalContext, token: string): { id: string; company: string } | null {
  if (!token || token.length < 20) return null;
  const row = ctx.db
    .prepare(`SELECT id, company FROM receivers WHERE access_token = ? AND enabled = 1`)
    .get(token) as { id: string; company: string } | undefined;
  return row ?? null;
}

/** Loads, tracking, and photos for one receiver. No cost, documents, or comments. */
export function shipmentsForReceiver(ctx: PortalContext, company: string): ReceiverShipment[] {
  const first = listOrders(ctx, { receiverCompany: company, page: 1, pageSize: 50 });
  const orders = [...first.orders];
  const pageSize = 50;
  for (let page = 2; page <= Math.ceil(first.total / pageSize); page += 1) {
    orders.push(...listOrders(ctx, { receiverCompany: company, page, pageSize }).orders);
  }
  return orders.map((order) => ({
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
    photos: listCarrierPhotos(ctx, order.id, false).map((photo) => ({
      id: photo.id,
      filename: photo.filename,
      mediaType: photo.mediaType,
      receivedAt: photo.receivedAt,
    })),
  }));
}
