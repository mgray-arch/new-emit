import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SqlArg } from "@/lib/db";
import type { PortalContext } from "@/lib/db";
import { CUSTOMER_LOAD_COLUMNS, withTransaction } from "@/lib/db";
import { serializeCustomerOrder, trackingUrlFor } from "@/lib/customer-view";
import { addDaysISO, denverDate, weekRange } from "@/lib/dates";
import type { LoadTab } from "@/lib/load-list";
import { listCustomerDocuments } from "@/lib/documents";
import { PortalError } from "@/lib/http";
import type { CustomerOrder, PortalStatus, Session, TimelineEvent, TrackingStage } from "@/lib/types";
import { STAGE_LABEL, TRACKING_STAGES, canAddLoads, canSeePricing } from "@/lib/types";
import { syncStopLocations } from "@/lib/locations";
import { legacyStops, resolvedRoute } from "@/lib/stops";
import type { OrderInput, OrderPatch } from "@/lib/validate";
import type { Stop } from "@/lib/types";

export interface OrderFilter {
  q?: string;
  status?: PortalStatus | null;
  shipFrom?: string | null;
  shipTo?: string | null;
  page?: number;
  pageSize?: number;
  receiverCompany?: string | null;
  /** Pickup yard company, matched to the origin. */
  pickup?: string | null;
  tab?: LoadTab | null;
  /** Group by pickup date. The dashboard uses this. Other callers keep the older order. */
  grouped?: boolean;
  /** Internal. The CSV export asks for every matching row. */
  exportAll?: boolean;
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
  load_number: string | null;
  portal_status: string;
  tracking_stage: string;
  timeline_json: string;
  origin_json: string;
  destination_json: string;
  stops_json: string | null;
  truck_type: string | null;
  transit: string | null;
  ship_date: string | null;
  ship_time: string | null;
  must_deliver_date: string | null;
  truck_eta: string | null;
  latest_eta: string | null;
  tracking_token: string;
  tracking_link: string | null;
  customer_cost_cents: number | null;
  rate_reason: string | null;
  comments: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  pending_review_count: number;
  attachment_count: number;
  bol_count: number;
  sam_build_status: string | null;
  sam_build_error: string | null;
  sam_build_at: string | null;
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

async function rowToOrder(ctx: PortalContext, row: LoadRow, withDocuments: boolean): Promise<CustomerOrder> {
  const order = serializeCustomerOrder({
    id: row.id,
    salesOrderNumber: row.sales_order_number,
    loadNumber: row.load_number,
    portalStatus: row.portal_status,
    trackingStage: row.tracking_stage,
    timeline: JSON.parse(row.timeline_json),
    origin: JSON.parse(row.origin_json),
    destination: JSON.parse(row.destination_json),
    stops: parseStops(row),
    truckType: row.truck_type,
    transit: row.transit,
    shipDate: row.ship_date,
    shipTime: row.ship_time,
    mustDeliverDate: row.must_deliver_date,
    truckEta: row.truck_eta,
    latestEta: row.latest_eta,
    trackingUrl: trackingUrlFor(row.tracking_token),
    trackingLink: row.tracking_link,
    customerCost: row.customer_cost_cents == null ? null : row.customer_cost_cents / 100,
    rateReason: row.rate_reason,
    comments: row.comments,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachmentCount: row.attachment_count ?? 0,
    bolCount: row.bol_count ?? 0,
    pendingReviewCount: row.pending_review_count ?? 0,
    documents: withDocuments ? await listCustomerDocuments(ctx, row.id) : [],
  });
  const status = row.sam_build_status === "building" || row.sam_build_status === "failed" ? row.sam_build_status : null;
  return {
    ...order,
    samBuildStatus: status,
    samBuildError: row.sam_build_error || null,
    samBuildAt: row.sam_build_at || null,
  };
}

function parseStops(row: LoadRow): Stop[] {
  if (row.stops_json) {
    try {
      const parsed = JSON.parse(row.stops_json) as Stop[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      /* fall through to the two-stop route */
    }
  }
  return resolvedRoute({
    stops: legacyStops(JSON.parse(row.origin_json), JSON.parse(row.destination_json)),
  }).stops;
}

function deliversTo(row: { destination_json: string; stops_json: string | null }, company: string): boolean {
  const target = company.trim().toLowerCase();
  try {
    const destination = JSON.parse(row.destination_json) as { company?: string };
    if ((destination.company || "").trim().toLowerCase() === target) return true;
  } catch {
    /* ignore */
  }
  if (!row.stops_json) return false;
  try {
    const stops = JSON.parse(row.stops_json) as Stop[];
    return stops.some(
      (stop) => stop.kind === "drop" && (stop.place?.company || "").trim().toLowerCase() === target,
    );
  } catch {
    return false;
  }
}

const DELIVERED_ON = `COALESCE(NULLIF(must_deliver_date, ''), NULLIF(ship_date, ''), substr(updated_at, 1, 10))`;

function attentionReasonSql(): { sql: string; params: (today: string) => SqlArg[] } {
  return {
    sql: `(
      load_number IS NULL OR trim(load_number) = ''
      OR pending_review_count > 0
      OR (tracking_stage IN ('at_pickup', 'in_transit') AND (tracking_link IS NULL OR trim(tracking_link) = ''))
      OR (tracking_stage != 'delivered' AND NULLIF(must_deliver_date, '') IS NOT NULL AND must_deliver_date < ?)
    )`,
    params: (today) => [today],
  };
}

function tabClause(tab: LoadTab, today: string): { sql: string; params: SqlArg[] } {
  const reasons = attentionReasonSql();
  if (tab === "history") {
    return {
      sql: `(portal_status = 'cancelled' OR (tracking_stage = 'delivered' AND ${DELIVERED_ON} < date(?, '-6 days')))`,
      params: [today],
    };
  }
  if (tab === "attention") {
    return {
      sql: `(portal_status != 'cancelled' AND NOT (tracking_stage = 'delivered' AND ${DELIVERED_ON} < date(?, '-6 days')) AND ${reasons.sql})`,
      params: [today, ...reasons.params(today)],
    };
  }
  if (tab === "delivered") {
    return {
      sql: `(portal_status != 'cancelled' AND tracking_stage = 'delivered' AND ${DELIVERED_ON} >= date(?, '-6 days') AND NOT ${reasons.sql})`,
      params: [today, ...reasons.params(today)],
    };
  }
  return {
    sql: `(portal_status != 'cancelled' AND tracking_stage != 'delivered' AND NOT ${reasons.sql})`,
    params: reasons.params(today),
  };
}

function buildWhere(filter: OrderFilter, today: string): { sql: string; params: SqlArg[] } {
  const clauses: string[] = [];
  const params: SqlArg[] = [];
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
  if (filter.pickup && filter.pickup.trim()) {
    clauses.push(`LOWER(json_extract(origin_json, '$.company')) = LOWER(?)`);
    params.push(filter.pickup.trim());
  }
  if (filter.tab) {
    const tab = tabClause(filter.tab, today);
    clauses.push(tab.sql);
    params.push(...tab.params);
  }
  if (filter.receiverCompany) {
    clauses.push(`(
      LOWER(json_extract(destination_json, '$.company')) = LOWER(?)
      OR EXISTS (
        SELECT 1 FROM json_each(stops_json) AS stop
        WHERE LOWER(json_extract(stop.value, '$.kind')) = 'drop'
          AND LOWER(json_extract(stop.value, '$.place.company')) = LOWER(?)
      )
    )`);
    params.push(filter.receiverCompany, filter.receiverCompany);
  }
  if (filter.q && filter.q.trim()) {
    const like = likeContains(filter.q.trim());
    clauses.push(
      `(sales_order_number LIKE ? ESCAPE '\\' OR load_number LIKE ? ESCAPE '\\' OR origin_json LIKE ? ESCAPE '\\' OR destination_json LIKE ? ESCAPE '\\' OR IFNULL(stops_json, '') LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like, like, like);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function groupOrderSql(): string {
  return `ORDER BY
    CASE
      WHEN ship_date IS NULL OR ship_date = '' THEN 5
      WHEN ship_date < ? THEN 0
      WHEN ship_date = ? THEN 1
      WHEN ship_date = ? THEN 2
      WHEN ship_date <= ? THEN 3
      ELSE 4
    END,
    CASE WHEN ship_date < ? THEN ship_date END DESC,
    ship_date ASC,
    sales_order_number ASC`;
}

export async function listOrders(ctx: PortalContext, filter: OrderFilter = {}): Promise<OrderPage> {
  const cap = filter.exportAll ? 5000 : 50;
  const pageSize = Math.min(cap, Math.max(1, filter.pageSize ?? 8));
  const page = Math.max(1, filter.page ?? 1);
  const today = denverDate(ctx.now());
  const tomorrow = addDaysISO(today, 1);
  const { end: weekEnd } = weekRange(ctx.now());
  const where = buildWhere(filter, today);
  const totalRow = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM loads ${where.sql}`).get(...where.params);
  const grouped = Boolean(filter.grouped || filter.tab);
  const rows = (await ctx.db
    .prepare(
      grouped
        ? `${LIST_SQL_HEAD} ${where.sql} ${groupOrderSql()} LIMIT ? OFFSET ?`
        : `${LIST_SQL_HEAD} ${where.sql}
       ORDER BY ship_date IS NULL,
         CASE WHEN ship_date >= ? THEN 0 ELSE 1 END,
         CASE WHEN ship_date >= ? THEN ship_date END ASC,
         ship_date DESC,
         sales_order_number ASC
       LIMIT ? OFFSET ?`,
    )
    .all(
      ...(grouped
        ? [...where.params, today, today, tomorrow, weekEnd, today, pageSize, (page - 1) * pageSize]
        : [...where.params, today, today, pageSize, (page - 1) * pageSize]),
    )) as unknown as LoadRow[];
  return {
    orders: await Promise.all(rows.map((row) => rowToOrder(ctx, row, false))),
    total: Number(totalRow?.n ?? 0),
    page,
    pageSize,
  };
}

export interface LoadBoard {
  orders: CustomerOrder[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<LoadTab, number>;
  today: string;
  tomorrow: string;
  weekEnd: string;
  scope: "tab" | "all";
  tab: LoadTab;
  receivers: string[];
}

async function countTabs(ctx: PortalContext, filter: OrderFilter, today: string): Promise<Record<LoadTab, number>> {
  const tabs: LoadTab[] = ["attention", "active", "delivered", "history"];
  const pieces = tabs.map((tab) => {
    const clause = tabClause(tab, today);
    return { sql: `SUM(CASE WHEN ${clause.sql} THEN 1 ELSE 0 END) AS ${tab}`, params: clause.params };
  });
  const where = buildWhere({ ...filter, tab: null }, today);
  const row = await ctx.db
    .prepare(`SELECT ${pieces.map((piece) => piece.sql).join(", ")} FROM loads ${where.sql}`)
    .get(...pieces.flatMap((piece) => piece.params), ...where.params);
  return {
    attention: Number(row?.attention ?? 0),
    active: Number(row?.active ?? 0),
    delivered: Number(row?.delivered ?? 0),
    history: Number(row?.history ?? 0),
  };
}

/** Dashboard list. A search ignores the selected tab so one box finds any load. */
export async function listBoard(ctx: PortalContext, filter: OrderFilter & { tab?: LoadTab | null }): Promise<LoadBoard> {
  const today = denverDate(ctx.now());
  const tomorrow = addDaysISO(today, 1);
  const { end: weekEnd } = weekRange(ctx.now());
  const tab: LoadTab = filter.tab ?? "attention";
  const searching = Boolean(filter.q && filter.q.trim());
  const page = await listOrders(ctx, {
    ...filter,
    tab: searching ? null : tab,
    grouped: true,
  });
  const names = await ctx.db
    .prepare(
      `SELECT DISTINCT json_extract(destination_json, '$.company') AS company
       FROM loads
       WHERE json_extract(destination_json, '$.company') IS NOT NULL
       ORDER BY company`,
    )
    .all();
  return {
    ...page,
    counts: await countTabs(ctx, filter, today),
    today,
    tomorrow,
    weekEnd,
    scope: searching ? "all" : "tab",
    tab,
    receivers: names.map((row) => String(row.company)).filter(Boolean),
  };
}

export async function listAllOrders(ctx: PortalContext, receiverCompany?: string | null): Promise<CustomerOrder[]> {
  const where = receiverCompany
    ? `WHERE (
        LOWER(json_extract(destination_json, '$.company')) = LOWER(?)
        OR EXISTS (
          SELECT 1 FROM json_each(stops_json) AS stop
          WHERE LOWER(json_extract(stop.value, '$.kind')) = 'drop'
            AND LOWER(json_extract(stop.value, '$.place.company')) = LOWER(?)
        )
      )`
    : "";
  const rows = (await ctx.db
    .prepare(`${LIST_SQL_HEAD} ${where} ORDER BY ship_date IS NULL, ship_date ASC`)
    .all(...(receiverCompany ? [receiverCompany, receiverCompany] : []))) as unknown as LoadRow[];
  return Promise.all(rows.map((row) => rowToOrder(ctx, row, false)));
}

export async function getOrder(ctx: PortalContext, id: string, receiverCompany?: string | null): Promise<CustomerOrder | null> {
  const row = (await ctx.db.prepare(`${LIST_SQL_HEAD} WHERE id = ?`).get(id)) as LoadRow | undefined;
  if (!row) return null;
  if (receiverCompany && !deliversTo(row, receiverCompany)) return null;
  return rowToOrder(ctx, row, true);
}

export async function getOrderByToken(ctx: PortalContext, token: string): Promise<CustomerOrder | null> {
  const row = (await ctx.db.prepare(`${LIST_SQL_HEAD} WHERE tracking_token = ?`).get(token)) as LoadRow | undefined;
  if (!row) return null;
  return rowToOrder(ctx, row, false);
}

export async function orderStats(ctx: PortalContext, receiverCompany?: string | null): Promise<OrderStats> {
  const where = receiverCompany
    ? `WHERE (
        LOWER(json_extract(destination_json, '$.company')) = LOWER(?)
        OR EXISTS (
          SELECT 1 FROM json_each(stops_json) AS stop
          WHERE LOWER(json_extract(stop.value, '$.kind')) = 'drop'
            AND LOWER(json_extract(stop.value, '$.place.company')) = LOWER(?)
        )
      )`
    : "";
  const rows = await ctx.db
    .prepare(`SELECT portal_status, COUNT(*) AS n FROM loads ${where} GROUP BY portal_status`)
    .all(...(receiverCompany ? [receiverCompany, receiverCompany] : []));
  const stats: OrderStats = { total: 0, being_prepared: 0, ready_to_ship: 0, shipped: 0, cancelled: 0 };
  for (const row of rows) {
    const count = Number(row.n);
    stats.total += count;
    const status = String(row.portal_status);
    if (status in stats) stats[status as PortalStatus] = count;
  }
  return stats;
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

function routeFrom(input: { origin?: OrderInput["origin"]; destination?: OrderInput["destination"]; stops?: OrderInput["stops"] }) {
  const stops =
    input.stops && input.stops.length > 0
      ? input.stops
      : input.origin && input.destination
        ? legacyStops(input.origin, input.destination)
        : [];
  try {
    return resolvedRoute({ stops });
  } catch (error) {
    throw new PortalError(error instanceof Error ? error.message : "Add at least one pickup and one drop.");
  }
}

export async function submitOrder(ctx: PortalContext, input: OrderInput, actor: Session): Promise<{
  order: CustomerOrder;
}> {
  if (actor.viewAs) throw new PortalError("View-as is read-only. Switch back to Select view to change anything.", 403);
  if (!canAddLoads(actor)) throw new PortalError("This account can view loads but cannot add them.", 403);
  const now = ctx.now().toISOString();
  const id = randomUUID();
  const token = randomBytes(24).toString("base64url");
  const portalStatus = input.portalStatus ?? "being_prepared";
  const trackingStage = advanceStage("submitted", portalStatus);
  const timeline = timelineThrough(trackingStage, now);
  const drafted = routeFrom(input);
  const seePricing = canSeePricing(actor);
  const customerCost = seePricing ? input.customerCost : undefined;
  const rateReason = seePricing ? input.rateReason : undefined;
  let route = drafted;
  await withTransaction(ctx.db, async () => {
    const syncedStops = await syncStopLocations(ctx, drafted.stops, actor.name, input.stops ?? []);
    route = resolvedRoute({ stops: syncedStops });
    await ctx.db
      .prepare(
        `INSERT INTO loads (
           id, sales_order_number, load_number, portal_status, tracking_stage, timeline_json,
           origin_json, destination_json, stops_json, truck_type, transit, ship_date, ship_time,
           must_deliver_date, truck_eta, latest_eta, tracking_token, customer_cost_cents,
           rate_reason, comments, created_by, created_at, updated_at, pending_review_count
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0
         )`,
      )
      .run(
        id,
        input.salesOrderNumber,
        null,
        portalStatus,
        trackingStage,
        JSON.stringify(timeline),
        JSON.stringify(route.origin),
        JSON.stringify(route.destination),
        JSON.stringify(route.stops),
        input.truckType ?? null,
        input.transit ?? null,
        input.shipDate ?? null,
        input.shipTime ?? null,
        input.mustDeliverDate ?? null,
        input.truckEta ?? null,
        token,
        customerCost == null ? null : Math.round(customerCost * 100),
        rateReason ?? null,
        input.comments ?? "",
        actor.name,
        now,
        now,
      );
  });
  const order = await getOrder(ctx, id);
  if (!order) throw new PortalError("The order could not be saved", 500);
  return { order };
}

export async function updateOrder(ctx: PortalContext, id: string, patch: OrderPatch, actor: Session): Promise<CustomerOrder> {
  if (actor.viewAs) throw new PortalError("View-as is read-only. Switch back to Select view to change anything.", 403);
  if (!canAddLoads(actor)) throw new PortalError("This account can view loads but cannot change them.", 403);
  const existing = (await ctx.db.prepare(`${LIST_SQL_HEAD} WHERE id = ?`).get(id)) as LoadRow | undefined;
  if (!existing) throw new PortalError("Order not found", 404);
  const current = await rowToOrder(ctx, existing, false);
  const portalStatus = patch.portalStatus ?? current.portalStatus;
  const trackingStage = advanceStage(current.trackingStage, portalStatus);
  const timeline =
    trackingStage === current.trackingStage ? current.timeline : timelineThrough(trackingStage, ctx.now().toISOString());
  const drafted = patch.stops
    ? routeFrom({ stops: patch.stops })
    : routeFrom({
        stops: current.stops.map((stop, index) => {
          const firstPickup = current.stops.findIndex((item) => item.kind === "pickup");
          let lastDrop = -1;
          current.stops.forEach((item, itemIndex) => {
            if (item.kind === "drop") lastDrop = itemIndex;
          });
          if (patch.origin && index === firstPickup) return { ...stop, place: patch.origin };
          if (patch.destination && index === lastDrop) return { ...stop, place: patch.destination };
          return stop;
        }),
      });
  const now = ctx.now().toISOString();
  const seePricing = canSeePricing(actor);
  let route = drafted;
  await withTransaction(ctx.db, async () => {
    const syncedStops = await syncStopLocations(ctx, drafted.stops, actor.name, patch.stops ?? drafted.stops, current.stops);
    route = resolvedRoute({ stops: syncedStops });
    await ctx.db
    .prepare(
      `UPDATE loads SET
         sales_order_number = ?, portal_status = ?, tracking_stage = ?, timeline_json = ?,
         origin_json = ?, destination_json = ?, stops_json = ?, truck_type = ?, transit = ?, ship_date = ?,
         ship_time = ?, must_deliver_date = ?, truck_eta = ?, customer_cost_cents = ?,
         rate_reason = ?, comments = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      patch.salesOrderNumber ?? current.salesOrderNumber,
      portalStatus,
      trackingStage,
      JSON.stringify(timeline),
      JSON.stringify(route.origin),
      JSON.stringify(route.destination),
      JSON.stringify(route.stops),
      patch.truckType === undefined ? current.truckType : patch.truckType,
      patch.transit === undefined ? current.transit : patch.transit,
      patch.shipDate === undefined ? current.shipDate : patch.shipDate,
      patch.shipTime === undefined ? current.shipTime : patch.shipTime,
      patch.mustDeliverDate === undefined ? current.mustDeliverDate : patch.mustDeliverDate,
      patch.truckEta === undefined ? current.truckEta : patch.truckEta,
      !seePricing || patch.customerCost === undefined
        ? existing.customer_cost_cents
        : patch.customerCost == null
          ? null
          : Math.round(patch.customerCost * 100),
      (!seePricing || patch.rateReason === undefined ? current.rateReason : patch.rateReason) ?? null,
      patch.comments === undefined ? current.comments : patch.comments,
      now,
      id,
    );
  });
  void actor;
  const updated = await getOrder(ctx, id);
  if (!updated) throw new PortalError("Order not found", 404);
  return updated;
}

export function demoTrackingToken(loadNumber: string): string {
  return createHash("sha256").update(`emit-demo:${loadNumber}`).digest("base64url");
}
