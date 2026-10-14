import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { PortalContext } from "@/lib/db";
import { CUSTOMER_LOAD_COLUMNS, withTransaction } from "@/lib/db";
import { serializeCustomerOrder, trackingUrlFor } from "@/lib/customer-view";
import { denverDate } from "@/lib/dates";
import { listCustomerDocuments } from "@/lib/documents";
import { sendOrderConfirmation } from "@/lib/email";
import { PortalError } from "@/lib/http";
import type { CustomerOrder, PortalStatus, Session, TimelineEvent, TrackingStage } from "@/lib/types";
import { STAGE_LABEL, TRACKING_STAGES } from "@/lib/types";
import type { OrderInput, OrderPatch } from "@/lib/validate";

export interface OrderFilter {
  q?: string;
  status?: PortalStatus | null;
  shipFrom?: string | null;
  shipTo?: string | null;
  page?: number;
  pageSize?: number;
}

export interface OrderPage {
  orders: CustomerOrder[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OrderStats {
  total: number;
  being_prepared: number;
  ready_to_ship: number;
  shipped: number;
  cancelled: number;
}

interface LoadRow {
  id: string;
  sales_order_number: string;
  load_number: string;
  portal_status: string;
  tracking_stage: string;
  timeline_json: string;
  origin_json: string;
  destination_json: string;
  truck_type: string | null;
  transit: string | null;
  ship_date: string | null;
  ship_time: string | null;
  must_deliver_date: string | null;
  truck_eta: string | null;
  latest_eta: string | null;
  tracking_token: string;
  customer_cost_cents: number | null;
  rate_reason: string | null;
  comments: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  pending_review_count: number;
  attachment_count: number;
  bol_count: number;
}

const LIST_SQL_HEAD = `
SELECT ${CUSTOMER_LOAD_COLUMNS},
  (SELECT COUNT(*) FROM customer_documents d WHERE d.load_id = loads.id AND d.kind = 'attachment') AS attachment_count,
  (SELECT COUNT(*) FROM customer_documents d WHERE d.load_id = loads.id AND d.kind = 'bol') AS bol_count
FROM loads
`;

export function likeContains(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function rowToOrder(ctx: PortalContext, row: LoadRow, withDocuments: boolean): CustomerOrder {
  return serializeCustomerOrder({
    id: row.id,
    salesOrderNumber: row.sales_order_number,
    loadNumber: row.load_number,
    portalStatus: row.portal_status,
    trackingStage: row.tracking_stage,
    timeline: JSON.parse(row.timeline_json),
    origin: JSON.parse(row.origin_json),
    destination: JSON.parse(row.destination_json),
    truckType: row.truck_type,
    transit: row.transit,
    shipDate: row.ship_date,
    shipTime: row.ship_time,
    mustDeliverDate: row.must_deliver_date,
    truckEta: row.truck_eta,
    latestEta: row.latest_eta,
    trackingUrl: trackingUrlFor(row.tracking_token),
    customerCost: row.customer_cost_cents == null ? null : row.customer_cost_cents / 100,
    rateReason: row.rate_reason,
    comments: row.comments,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachmentCount: row.attachment_count ?? 0,
    bolCount: row.bol_count ?? 0,
    pendingReviewCount: row.pending_review_count ?? 0,
    documents: withDocuments ? listCustomerDocuments(ctx, row.id) : [],
  });
}

function buildWhere(filter: OrderFilter): { sql: string; params: SQLInputValue[] } {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.status) {
    clauses.push("portal_status = ?");
    params.push(filter.status);
  }
  if (filter.shipFrom) {
    clauses.push("ship_date >= ?");
    params.push(filter.shipFrom);
  }
  if (filter.shipTo) {
    clauses.push("ship_date <= ?");
    params.push(filter.shipTo);
  }
  if (filter.q && filter.q.trim()) {
    const like = likeContains(filter.q.trim());
    clauses.push(
      `(sales_order_number LIKE ? ESCAPE '\\' OR load_number LIKE ? ESCAPE '\\' OR origin_json LIKE ? ESCAPE '\\' OR destination_json LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like, like);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function listOrders(ctx: PortalContext, filter: OrderFilter = {}): OrderPage {
  const pageSize = Math.min(50, Math.max(1, filter.pageSize ?? 8));
  const page = Math.max(1, filter.page ?? 1);
  const where = buildWhere(filter);
  const totalRow = ctx.db.prepare(`SELECT COUNT(*) AS n FROM loads ${where.sql}`).get(...where.params) as { n: number };
  const today = denverDate(ctx.now());
  const rows = ctx.db
    .prepare(
      `${LIST_SQL_HEAD} ${where.sql}
       ORDER BY ship_date IS NULL,
         CASE WHEN ship_date >= ? THEN 0 ELSE 1 END,
         CASE WHEN ship_date >= ? THEN ship_date END ASC,
         ship_date DESC,
         sales_order_number ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...where.params, today, today, pageSize, (page - 1) * pageSize) as unknown as LoadRow[];
  return {
    orders: rows.map((row) => rowToOrder(ctx, row, false)),
    total: totalRow.n,
    page,
    pageSize,
  };
}

export function listAllOrders(ctx: PortalContext): CustomerOrder[] {
  const rows = ctx.db
    .prepare(`${LIST_SQL_HEAD} ORDER BY ship_date IS NULL, ship_date ASC`)
    .all() as unknown as LoadRow[];
  return rows.map((row) => rowToOrder(ctx, row, false));
}

export function getOrder(ctx: PortalContext, id: string): CustomerOrder | null {
  const row = ctx.db.prepare(`${LIST_SQL_HEAD} WHERE id = ?`).get(id) as LoadRow | undefined;
  if (!row) return null;
  return rowToOrder(ctx, row, true);
}

export function getOrderByToken(ctx: PortalContext, token: string): CustomerOrder | null {
  const row = ctx.db.prepare(`${LIST_SQL_HEAD} WHERE tracking_token = ?`).get(token) as LoadRow | undefined;
  if (!row) return null;
  return rowToOrder(ctx, row, false);
}

export function orderStats(ctx: PortalContext): OrderStats {
  const rows = ctx.db.prepare(`SELECT portal_status, COUNT(*) AS n FROM loads GROUP BY portal_status`).all() as Array<{
    portal_status: string;
    n: number;
  }>;
  const stats: OrderStats = { total: 0, being_prepared: 0, ready_to_ship: 0, shipped: 0, cancelled: 0 };
  for (const row of rows) {
    const count = Number(row.n);
    stats.total += count;
    if (row.portal_status in stats) {
      stats[row.portal_status as PortalStatus] = count;
    }
  }
  return stats;
}

function nextLoadNumber(ctx: PortalContext): string {
  const rows = ctx.db.prepare(`SELECT load_number FROM loads`).all() as Array<{ load_number: string }>;
  let max = 900100;
  for (const row of rows) {
    const value = Number(row.load_number.split("-")[0]);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return `${max + 1}-1`;
}

export function timelineThrough(stage: TrackingStage, at: string): TimelineEvent[] {
  const index = TRACKING_STAGES.indexOf(stage);
  return TRACKING_STAGES.slice(0, index + 1).map((item, itemIndex) => ({
    stage: item,
    at: new Date(new Date(at).getTime() - (index - itemIndex) * 12 * 3600 * 1000).toISOString(),
    label: STAGE_LABEL[item],
  }));
}

function advanceStage(current: TrackingStage, portalStatus: PortalStatus): TrackingStage {
  if (portalStatus === "cancelled") return current;
  const order = TRACKING_STAGES;
  const minimum: TrackingStage =
    portalStatus === "being_prepared" ? "submitted" : portalStatus === "ready_to_ship" ? "booked" : "in_transit";
  return order.indexOf(minimum) > order.indexOf(current) ? minimum : current;
}

export function submitOrder(ctx: PortalContext, input: OrderInput, actor: Session): {
  order: CustomerOrder;
  confirmation: ReturnType<typeof sendOrderConfirmation>;
} {
  const now = ctx.now().toISOString();
  const id = randomUUID();
  const loadNumber = nextLoadNumber(ctx);
  const token = randomBytes(24).toString("base64url");
  const portalStatus = input.portalStatus ?? "being_prepared";
  const trackingStage = advanceStage("submitted", portalStatus);
  const timeline = timelineThrough(trackingStage, now);
  withTransaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO loads (
           id, sales_order_number, load_number, portal_status, tracking_stage, timeline_json,
           origin_json, destination_json, truck_type, transit, ship_date, ship_time,
           must_deliver_date, truck_eta, latest_eta, tracking_token, customer_cost_cents,
           rate_reason, comments, created_by, created_at, updated_at, pending_review_count,
           carrier_pay_cents, carrier_name, carrier_mc, staff_notes
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0,
           NULL, NULL, NULL, NULL
         )`,
      )
      .run(
        id,
        input.salesOrderNumber,
        loadNumber,
        portalStatus,
        trackingStage,
        JSON.stringify(timeline),
        JSON.stringify(input.origin),
        JSON.stringify(input.destination),
        input.truckType ?? null,
        input.transit ?? null,
        input.shipDate ?? null,
        input.shipTime ?? null,
        input.mustDeliverDate ?? null,
        input.truckEta ?? null,
        token,
        input.customerCost == null ? null : Math.round(input.customerCost * 100),
        input.rateReason ?? null,
        input.comments ?? "",
        actor.name,
        now,
        now,
      );
  });
  const order = getOrder(ctx, id);
  if (!order) throw new PortalError("The order could not be saved", 500);
  const confirmation = sendOrderConfirmation(ctx, order, actor.email);
  return { order, confirmation };
}

export function updateOrder(ctx: PortalContext, id: string, patch: OrderPatch, actor: Session): CustomerOrder {
  const existing = ctx.db.prepare(`${LIST_SQL_HEAD} WHERE id = ?`).get(id) as LoadRow | undefined;
  if (!existing) throw new PortalError("Order not found", 404);
  const current = rowToOrder(ctx, existing, false);
  const portalStatus = patch.portalStatus ?? current.portalStatus;
  const trackingStage = advanceStage(current.trackingStage, portalStatus);
  const timeline =
    trackingStage === current.trackingStage ? current.timeline : timelineThrough(trackingStage, ctx.now().toISOString());
  const origin = patch.origin ?? current.origin;
  const destination = patch.destination ?? current.destination;
  const now = ctx.now().toISOString();
  ctx.db
    .prepare(
      `UPDATE loads SET
         sales_order_number = ?, portal_status = ?, tracking_stage = ?, timeline_json = ?,
         origin_json = ?, destination_json = ?, truck_type = ?, transit = ?, ship_date = ?,
         ship_time = ?, must_deliver_date = ?, truck_eta = ?, customer_cost_cents = ?,
         rate_reason = ?, comments = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      patch.salesOrderNumber ?? current.salesOrderNumber,
      portalStatus,
      trackingStage,
      JSON.stringify(timeline),
      JSON.stringify(origin),
      JSON.stringify(destination),
      patch.truckType === undefined ? current.truckType : patch.truckType,
      patch.transit === undefined ? current.transit : patch.transit,
      patch.shipDate === undefined ? current.shipDate : patch.shipDate,
      patch.shipTime === undefined ? current.shipTime : patch.shipTime,
      patch.mustDeliverDate === undefined ? current.mustDeliverDate : patch.mustDeliverDate,
      patch.truckEta === undefined ? current.truckEta : patch.truckEta,
      patch.customerCost === undefined
        ? existing.customer_cost_cents
        : patch.customerCost == null
          ? null
          : Math.round(patch.customerCost * 100),
      patch.rateReason === undefined ? current.rateReason : patch.rateReason,
      patch.comments === undefined ? current.comments : patch.comments,
      now,
      id,
    );
  void actor;
  const updated = getOrder(ctx, id);
  if (!updated) throw new PortalError("Order not found", 404);
  return updated;
}

export function demoTrackingToken(loadNumber: string): string {
  return createHash("sha256").update(`emit-demo:${loadNumber}`).digest("base64url");
}

/** Test-only reader for the columns EMIT must never receive. */
export function readInternalLoad(ctx: PortalContext, id: string): {
  carrierPayCents: number | null;
  carrierName: string | null;
  carrierMc: string | null;
  staffNotes: string | null;
} | null {
  const row = ctx.db
    .prepare(`SELECT carrier_pay_cents, carrier_name, carrier_mc, staff_notes FROM loads WHERE id = ?`)
    .get(id) as
    | { carrier_pay_cents: number | null; carrier_name: string | null; carrier_mc: string | null; staff_notes: string | null }
    | undefined;
  if (!row) return null;
  return {
    carrierPayCents: row.carrier_pay_cents,
    carrierName: row.carrier_name,
    carrierMc: row.carrier_mc,
    staffNotes: row.staff_notes,
  };
}
