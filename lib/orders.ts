import { bolPrintState } from "@/lib/bol-prints";
import { normalizeCarrierMc, normalizeCarrierName, normalizeDriverName } from "@/lib/carrier";
import {
  joinSalesOrders,
  parseLegacySalesOrders,
  resolveSalesOrders,
  SALES_ORDER_MATCH_SQL,
  salesOrderLineErrors,
  salesOrderMatchArgs,
  storedSalesOrders,
  type SalesOrderLine,
} from "@/lib/sales-orders";
import { nextSuffix } from "@/lib/so-suffix";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SqlArg } from "@/lib/db";
import type { PortalContext } from "@/lib/db";
import { CUSTOMER_LOAD_COLUMNS, withTransaction } from "@/lib/db";
import { serializeCustomerOrder, trackingUrlFor } from "@/lib/customer-view";
import { addDaysISO, denverDate, weekRange } from "@/lib/dates";
import type { LoadTab, LoadTabCounts } from "@/lib/load-list";
import { listCustomerDocuments } from "@/lib/documents";
import { PortalError } from "@/lib/http";
import { deleteStoredBytes } from "@/lib/storage";
import type { CustomerOrder, PortalStatus, Session, TimelineEvent, TrackingStage } from "@/lib/types";
import { STAGE_LABEL, TRACKING_STAGES, canAddLoads, canEditLoad, canSeePricing, type Stop } from "@/lib/types";
import { syncStopLocations } from "@/lib/locations";
import { assignLoadOwner, type LoadOwner } from "@/lib/load-owner";
import { notifyNewLoad } from "@/lib/slack-new-load";
import { legacyStops, resolvedRoute } from "@/lib/stops";
import type { OrderInput, OrderPatch } from "@/lib/validate";

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
  /**
   * Select staff get the Needs Attention list. EMIT and view-as pass false so those
   * loads stay on Active or Delivered and the attention count is omitted.
   */
  includeAttention?: boolean;
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
  sales_orders_json?: string | null;
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
  entered_by_name: string | null;
  entered_by_email: string | null;
  owner: string | null;
  owner_needs_check: number | null;
  created_at: string;
  updated_at: string;
  pending_review_count: number;
  attachment_count: number;
  bol_count: number;
  sam_build_status: string | null;
  sam_build_error: string | null;
  sam_build_at: string | null;
  carrier_name: string | null;
  carrier_mc: string | null;
  driver_name: string | null;
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
  const stops = parseStops(row);
  const salesOrders = storedSalesOrders(row.sales_orders_json, row.sales_order_number, stops);
  const order = serializeCustomerOrder({
    id: row.id,
    salesOrderNumber: salesOrders.length ? joinSalesOrders(salesOrders) : row.sales_order_number,
    salesOrders,
    loadNumber: row.load_number,
    portalStatus: row.portal_status,
    trackingStage: row.tracking_stage,
    timeline: JSON.parse(row.timeline_json),
    origin: JSON.parse(row.origin_json),
    destination: JSON.parse(row.destination_json),
    stops,
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
    enteredByName: row.entered_by_name,
    enteredByEmail: row.entered_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachmentCount: row.attachment_count ?? 0,
    bolCount: row.bol_count ?? 0,
    pendingReviewCount: row.pending_review_count ?? 0,
    documents: withDocuments ? await listCustomerDocuments(ctx, row.id) : [],
    carrierName: row.carrier_name ?? null,
    carrierMc: row.carrier_mc ?? null,
    driverName: row.driver_name ?? null,
  }, { includeEnteredBy: true, includeCarrier: true });
  const status = row.sam_build_status === "building" || row.sam_build_status === "failed" ? row.sam_build_status : null;
  const owner = row.owner === "Drew" || row.owner === "Ainsley" ? row.owner : null;
  const prints = await bolPrintState(
    ctx,
    row.id,
    { carrierName: row.carrier_name ?? null, carrierMc: row.carrier_mc ?? null, driverName: row.driver_name ?? null },
    { history: withDocuments },
  );
  return {
    ...order,
    owner,
    ownerNeedsCheck: Number(row.owner_needs_check) === 1,
    samBuildStatus: status,
    samBuildError: row.sam_build_error || null,
    samBuildAt: row.sam_build_at || null,
    bolPrint: prints.summary,
    ...(withDocuments ? { bolPrints: prints.history } : {}),
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

function includeAttentionList(filter: { includeAttention?: boolean }): boolean {
  return filter.includeAttention !== false;
}

/** EMIT has no attention bucket. A request for that tab is the active list. */
function resolvedTab(tab: LoadTab, includeAttention: boolean): LoadTab {
  if (!includeAttention && tab === "attention") return "active";
  return tab;
}

function tabClause(tab: LoadTab, today: string, includeAttention = true): { sql: string; params: SqlArg[] } {
  const reasons = attentionReasonSql();
  const list = resolvedTab(tab, includeAttention);
  if (list === "history") {
    return {
      sql: `(portal_status = 'cancelled' OR (tracking_stage = 'delivered' AND ${DELIVERED_ON} < date(?, '-6 days')))`,
      params: [today],
    };
  }
  if (!includeAttention) {
    if (list === "delivered") {
      return {
        sql: `(portal_status != 'cancelled' AND tracking_stage = 'delivered' AND ${DELIVERED_ON} >= date(?, '-6 days'))`,
        params: [today],
      };
    }
    return {
      sql: `(portal_status != 'cancelled' AND tracking_stage != 'delivered')`,
      params: [],
    };
  }
  if (list === "attention") {
    return {
      sql: `(portal_status != 'cancelled' AND NOT (tracking_stage = 'delivered' AND ${DELIVERED_ON} < date(?, '-6 days')) AND ${reasons.sql})`,
      params: [today, ...reasons.params(today)],
    };
  }
  if (list === "delivered") {
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
    const tab = tabClause(filter.tab, today, includeAttentionList(filter));
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
      `(sales_order_number LIKE ? ESCAPE '\\' OR load_number LIKE ? ESCAPE '\\' OR origin_json LIKE ? ESCAPE '\\' OR destination_json LIKE ? ESCAPE '\\' OR IFNULL(stops_json, '') LIKE ? ESCAPE '\\' OR IFNULL(carrier_name, '') LIKE ? ESCAPE '\\' OR IFNULL(carrier_mc, '') LIKE ? ESCAPE '\\' OR IFNULL(driver_name, '') LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like, like, like, like, like, like);
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
  counts: LoadTabCounts;
  today: string;
  tomorrow: string;
  weekEnd: string;
  scope: "tab" | "all";
  tab: LoadTab;
  receivers: string[];
}

async function countTabs(ctx: PortalContext, filter: OrderFilter, today: string): Promise<LoadTabCounts> {
  const includeAttention = includeAttentionList(filter);
  const tabs: LoadTab[] = includeAttention
    ? ["attention", "active", "delivered", "history"]
    : ["active", "delivered", "history"];
  const pieces = tabs.map((tab) => {
    const clause = tabClause(tab, today, includeAttention);
    return { sql: `SUM(CASE WHEN ${clause.sql} THEN 1 ELSE 0 END) AS ${tab}`, params: clause.params };
  });
  const where = buildWhere({ ...filter, tab: null }, today);
  const row = await ctx.db
    .prepare(`SELECT ${pieces.map((piece) => piece.sql).join(", ")} FROM loads ${where.sql}`)
    .get(...pieces.flatMap((piece) => piece.params), ...where.params);
  const counts: LoadTabCounts = {
    active: Number(row?.active ?? 0),
    delivered: Number(row?.delivered ?? 0),
    history: Number(row?.history ?? 0),
  };
  if (includeAttention) counts.attention = Number(row?.attention ?? 0);
  return counts;
}

/** Dashboard list. A search ignores the selected tab so one box finds any load. */
export async function listBoard(ctx: PortalContext, filter: OrderFilter & { tab?: LoadTab | null }): Promise<LoadBoard> {
  const today = denverDate(ctx.now());
  const tomorrow = addDaysISO(today, 1);
  const { end: weekEnd } = weekRange(ctx.now());
  const includeAttention = includeAttentionList(filter);
  const tab: LoadTab = resolvedTab(filter.tab ?? (includeAttention ? "attention" : "active"), includeAttention);
  const searching = Boolean(filter.q && filter.q.trim());
  const page = await listOrders(ctx, {
    ...filter,
    includeAttention,
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

function collectStoredNumbers(salesOrderNumber: string | null, salesOrdersJson: string | null): string[] {
  const numbers: string[] = [];
  if (salesOrdersJson) {
    try {
      const parsed = JSON.parse(salesOrdersJson);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.number === "string") numbers.push(item.number);
        }
      }
    } catch {
      /* the string column still counts */
    }
  }
  numbers.push(...parseLegacySalesOrders(salesOrderNumber));
  return numbers;
}

/** Every SO already on a load that shares this base, including cancelled loads. */
export async function salesOrdersSharingBase(ctx: PortalContext, raw: string): Promise<string[]> {
  const base = nextSuffix(raw, []).base;
  if (!base) return [];
  const escaped = base.replace(/[\\%_]/g, (char) => `\\${char}`);
  const like = `%${escaped}%`;
  const rows = await ctx.db
    .prepare(
      `SELECT sales_order_number, sales_orders_json FROM loads
       WHERE UPPER(sales_order_number) LIKE ? ESCAPE '\\'
          OR UPPER(IFNULL(sales_orders_json, '')) LIKE ? ESCAPE '\\'`,
    )
    .all(like, like);
  const numbers: string[] = [];
  for (const row of rows) {
    numbers.push(...collectStoredNumbers(String(row.sales_order_number ?? ""), row.sales_orders_json == null ? null : String(row.sales_orders_json)));
  }
  return numbers;
}

export async function nextSalesOrderSuffix(ctx: PortalContext, raw: string) {
  return nextSuffix(raw, await salesOrdersSharingBase(ctx, raw));
}

export interface SalesOrderWarning {
  number: string;
  message: string;
}

/**
 * Other loads, including cancelled ones, may already use an SO. That does not block the save.
 * The caller can show the warning and still keep the new row.
 */
export async function salesOrderDuplicateWarnings(
  ctx: PortalContext,
  lines: SalesOrderLine[],
  exceptLoadId?: string,
): Promise<SalesOrderWarning[]> {
  const warnings: SalesOrderWarning[] = [];
  for (const line of lines) {
    const params = salesOrderMatchArgs(line.number);
    const row = await ctx.db
      .prepare(`SELECT id FROM loads WHERE ${SALES_ORDER_MATCH_SQL}${exceptLoadId ? " AND id <> ?" : ""} LIMIT 1`)
      .get(...params, ...(exceptLoadId ? [exceptLoadId] : []));
    if (!row) continue;
    warnings.push({ number: line.number, message: `${line.number} is already on another load.` });
  }
  return warnings;
}

export interface CopyDraftLine {
  number: string;
  stopId: string | null;
  suggestion: string | null;
  highestInUse: string | null;
  tooLong: boolean;
}

export interface CopyDraft {
  copiedFromId: string;
  portalStatus: "being_prepared";
  stops: Stop[];
  truckType: string | null;
  transit: string | null;
  shipDate: string | null;
  shipTime: string | null;
  mustDeliverDate: string | null;
  truckEta: string | null;
  comments: string;
  salesOrders: CopyDraftLine[];
}

/** Prefill for a new load. New stop ids, suggested SOs, no documents, cost, load number, or tracking link. */
export async function copyDraft(ctx: PortalContext, id: string): Promise<CopyDraft> {
  const order = await getOrder(ctx, id);
  if (!order) throw new PortalError("Order not found", 404);
  const idMap = new Map<string, string>();
  const stops = order.stops.map((stop) => {
    const nextId = randomUUID();
    idMap.set(stop.id, nextId);
    return { ...stop, id: nextId };
  });
  const salesOrders: CopyDraftLine[] = [];
  for (const line of order.salesOrders) {
    const next = await nextSalesOrderSuffix(ctx, line.number);
    const stopId = line.stopId ? (idMap.get(line.stopId) ?? null) : null;
    salesOrders.push({
      number: next.suggestion ?? "",
      stopId,
      suggestion: next.suggestion,
      highestInUse: next.highestInUse,
      tooLong: next.tooLong,
    });
  }
  return {
    copiedFromId: order.id,
    portalStatus: "being_prepared",
    stops,
    truckType: order.truckType,
    transit: order.transit,
    shipDate: order.shipDate,
    shipTime: order.shipTime,
    mustDeliverDate: order.mustDeliverDate,
    truckEta: order.truckEta,
    comments: order.comments,
    salesOrders,
  };
}

/** SO lines from the new list, or from the older single string, tied to the saved drops. */
function salesOrdersFor(
  input: { salesOrders?: Array<{ number: string; stopId?: string | null }>; salesOrderNumber?: string },
  stops: Stop[],
): SalesOrderLine[] {
  const lines = input.salesOrders ?? parseLegacySalesOrders(input.salesOrderNumber).map((number) => ({ number, stopId: null }));
  const resolved = resolveSalesOrders(lines, stops);
  if (resolved.length === 0) throw new PortalError("Sales order number is required.");
  return resolved;
}

export async function submitOrder(ctx: PortalContext, input: OrderInput, actor: Session): Promise<{
  order: CustomerOrder;
  warnings: SalesOrderWarning[];
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
  let copiedFromId: string | null = null;
  if (input.copiedFromId) {
    const source = await ctx.db.prepare(`SELECT id FROM loads WHERE id = ?`).get(input.copiedFromId);
    copiedFromId = source ? input.copiedFromId : null;
  }
  let route = drafted;
  let salesOrders: SalesOrderLine[] = [];
  let warnings: SalesOrderWarning[] = [];
  await withTransaction(ctx.db, async () => {
    const syncedStops = await syncStopLocations(ctx, drafted.stops, actor.name, input.stops ?? []);
    route = resolvedRoute({ stops: syncedStops });
    salesOrders = salesOrdersFor(input, route.stops);
    warnings = await salesOrderDuplicateWarnings(ctx, salesOrders);
    const assignment = assignLoadOwner({
      destinationState: route.destination.state,
      equipment: input.truckType,
    });
    await ctx.db
      .prepare(
        `INSERT INTO loads (
           id, sales_order_number, load_number, portal_status, tracking_stage, timeline_json,
           origin_json, destination_json, stops_json, sales_orders_json, truck_type, transit, ship_date, ship_time,
           must_deliver_date, truck_eta, latest_eta, tracking_token, customer_cost_cents,
           rate_reason, comments, created_by, entered_by_name, entered_by_email, owner, owner_needs_check, created_at, updated_at, copied_from_id, pending_review_count
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0
         )`,
      )
      .run(
        id,
        joinSalesOrders(salesOrders),
        null,
        portalStatus,
        trackingStage,
        JSON.stringify(timeline),
        JSON.stringify(route.origin),
        JSON.stringify(route.destination),
        JSON.stringify(route.stops),
        JSON.stringify(salesOrders),
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
        actor.name.trim() || null,
        actor.email.trim() || null,
        assignment.owner,
        assignment.needsCheck ? 1 : 0,
        now,
        now,
        copiedFromId,
      );
  });
  const order = await getOrder(ctx, id);
  if (!order) throw new PortalError("The order could not be saved", 500);
  await notifyNewLoad(order, { name: actor.name, email: actor.email });
  return { order, warnings };
}

export async function updateOrder(
  ctx: PortalContext,
  id: string,
  patch: OrderPatch,
  actor: Session,
): Promise<{ order: CustomerOrder; warnings: SalesOrderWarning[] }> {
  if (actor.viewAs) throw new PortalError("View-as is read-only. Switch back to Select view to change anything.", 403);
  if (!canEditLoad(actor)) throw new PortalError("This account can view loads but cannot change them.", 403);
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
  let warnings: SalesOrderWarning[] = [];
  await withTransaction(ctx.db, async () => {
    const syncedStops = await syncStopLocations(ctx, drafted.stops, actor.name, patch.stops ?? drafted.stops, current.stops);
    route = resolvedRoute({ stops: syncedStops });
    const touched = patch.salesOrders !== undefined || patch.salesOrderNumber !== undefined;
    const salesOrders = touched ? salesOrdersFor(patch, route.stops) : resolveSalesOrders(current.salesOrders, route.stops);
    if (salesOrders.length === 0) throw new PortalError("Sales order number is required.");
    if (patch.salesOrders) {
      const problems = salesOrderLineErrors(patch.salesOrders, route.stops, { required: true });
      if (problems.length) throw new PortalError(problems[0]);
    }
    if (touched) warnings = await salesOrderDuplicateWarnings(ctx, salesOrders, id);
    await ctx.db
    .prepare(
      `UPDATE loads SET
         sales_order_number = ?, sales_orders_json = ?, portal_status = ?, tracking_stage = ?, timeline_json = ?,
         origin_json = ?, destination_json = ?, stops_json = ?, truck_type = ?, transit = ?, ship_date = ?,
         ship_time = ?, must_deliver_date = ?, truck_eta = ?, customer_cost_cents = ?,
         rate_reason = ?, comments = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      joinSalesOrders(salesOrders),
      JSON.stringify(salesOrders),
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
  return { order: updated, warnings };
}

/**
 * Removes one portal order and the rows that belong to it: stops (stored on the
 * order), documents, photos, and their stored bytes. It does not call SAM or Load Builder.
 */
export async function deleteOrder(ctx: PortalContext, id: string): Promise<void> {
  const existing = await ctx.db.prepare(`SELECT id FROM loads WHERE id = ?`).get(id);
  if (!existing) throw new PortalError("Order not found", 404);

  const locators = (
    await Promise.all([
      ctx.db.prepare(`SELECT storage_key FROM customer_documents WHERE load_id = ?`).all(id),
      ctx.db.prepare(`SELECT storage_key FROM internal_documents WHERE load_id = ?`).all(id),
      ctx.db.prepare(`SELECT storage_key FROM carrier_photos WHERE load_id = ?`).all(id),
    ])
  )
    .flat()
    .map((row) => String(row.storage_key ?? ""))
    .filter((locator) => locator.length > 0);

  for (const locator of locators) {
    await deleteStoredBytes(locator);
  }

  await withTransaction(ctx.db, async () => {
    await ctx.db.prepare(`DELETE FROM bol_prints WHERE load_id = ?`).run(id);
    await ctx.db.prepare(`DELETE FROM customer_documents WHERE load_id = ?`).run(id);
    await ctx.db.prepare(`DELETE FROM internal_documents WHERE load_id = ?`).run(id);
    await ctx.db.prepare(`DELETE FROM document_uploads WHERE load_id = ?`).run(id);
    await ctx.db.prepare(`DELETE FROM carrier_photos WHERE load_id = ?`).run(id);
    const removed = await ctx.db.prepare(`DELETE FROM loads WHERE id = ?`).run(id);
    if (!removed.changes) throw new PortalError("Order not found", 404);
  });
}

/** Select staff set who is hauling the load. Pay is not a field. Blank clears a value and counts as a change. */
export async function setLoadCarrier(
  ctx: PortalContext,
  id: string,
  input: { carrierName?: string | null; carrierMc?: string | null; driverName?: string | null },
): Promise<CustomerOrder> {
  const existing = await ctx.db
    .prepare(`SELECT id, carrier_name, carrier_mc, driver_name FROM loads WHERE id = ?`)
    .get(id);
  if (!existing) throw new PortalError("Order not found", 404);
  const carrierName = input.carrierName === undefined ? ((existing.carrier_name as string | null) ?? null) : normalizeCarrierName(input.carrierName);
  const carrierMc = input.carrierMc === undefined ? ((existing.carrier_mc as string | null) ?? null) : normalizeCarrierMc(input.carrierMc);
  const driverName = input.driverName === undefined ? ((existing.driver_name as string | null) ?? null) : normalizeDriverName(input.driverName);
  const changed =
    (existing.carrier_name ?? null) !== carrierName ||
    (existing.carrier_mc ?? null) !== carrierMc ||
    (existing.driver_name ?? null) !== driverName;
  if (changed) {
    const now = ctx.now().toISOString();
    await ctx.db
      .prepare(
        `UPDATE loads SET carrier_name = ?, carrier_mc = ?, driver_name = ?, carrier_updated_at = ?, bol_changed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(carrierName, carrierMc, driverName, now, now, now, id);
  }
  const order = await getOrder(ctx, id);
  if (!order) throw new PortalError("Order not found", 404);
  return order;
}

/** Select staff change the owner. This does not post to Slack. */
export async function setLoadOwner(ctx: PortalContext, id: string, owner: LoadOwner): Promise<CustomerOrder> {
  const updated = await ctx.db
    .prepare(`UPDATE loads SET owner = ?, owner_needs_check = 0, updated_at = ? WHERE id = ?`)
    .run(owner, ctx.now().toISOString(), id);
  if (!updated.changes) throw new PortalError("Order not found", 404);
  const order = await getOrder(ctx, id);
  if (!order) throw new PortalError("Order not found", 404);
  return order;
}

export function demoTrackingToken(loadNumber: string): string {
  return createHash("sha256").update(`emit-demo:${loadNumber}`).digest("base64url");
}
