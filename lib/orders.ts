import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SqlArg } from "@/lib/db";
import type { PortalContext } from "@/lib/db";
import { CUSTOMER_LOAD_COLUMNS, withTransaction } from "@/lib/db";
import { buildStatusLabel, parseOrderNotices, parseStageEvents, stageHistoryText } from "@/lib/build-status";
import { parseTrackingEvents } from "@/lib/tracking-link";
import { serializeCustomerOrder, trackingUrlFor } from "@/lib/customer-view";
import { addDaysISO, denverDate, weekRange } from "@/lib/dates";
import type { LoadTab, LoadTabCounts } from "@/lib/load-list";
import { listCustomerDocuments } from "@/lib/documents";
import { PortalError } from "@/lib/http";
import { deleteStoredBytes } from "@/lib/storage";
import type { CustomerOrder, PortalStatus, Session, StageEvent, TimelineEvent, TrackingStage } from "@/lib/types";
import { STAGE_LABEL, TRACKING_STAGES, canAddLoads, canSeePricing } from "@/lib/types";
import { syncStopLocations } from "@/lib/locations";
import { assignLoadOwner, type LoadOwner } from "@/lib/load-owner";
import { notifyNewLoad, notifyReadyToShip } from "@/lib/slack-new-load";
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
  /**
   * Select staff get the Needs Attention list. EMIT and view-as pass false so those
   * loads stay on Active or Delivered and the attention count is omitted.
   */
  includeAttention?: boolean;
  /** Group by pickup date. The dashboard uses this. Other callers keep the older order. */
  grouped?: boolean;
  /** Internal. The CSV export asks for every matching row. */
  exportAll?: boolean;
  /** Limit the list to these load ids. An empty list matches nothing. */
  ids?: string[] | null;
  /** Skip the tab filter so a carrier-update list can include every list. */
  acrossTabs?: boolean;
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
  slack_notified_at: string | null;
  carrier_notice_log: string | null;
  stage_log: string | null;
  tracking_event_log: string | null;
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

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function placeFromColumn(value: unknown): { company: string; address1: string; city: string; state: string; postalCode: string; country: string } {
  const parsed = parseJsonColumn(value);
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const text = (key: string) => (typeof record[key] === "string" ? record[key] : "");
  return {
    company: text("company"),
    address1: text("address1"),
    city: text("city"),
    state: text("state"),
    postalCode: text("postalCode"),
    country: text("country") || "US",
  };
}

async function rowToOrder(ctx: PortalContext, row: LoadRow, withDocuments: boolean): Promise<CustomerOrder> {
  const order = serializeCustomerOrder({
    id: row.id,
    salesOrderNumber: row.sales_order_number,
    loadNumber: row.load_number,
    portalStatus: row.portal_status,
    trackingStage: row.tracking_stage,
    timeline: parseJsonColumn(row.timeline_json) ?? [],
    origin: placeFromColumn(row.origin_json),
    destination: placeFromColumn(row.destination_json),
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
    enteredByName: row.entered_by_name,
    enteredByEmail: row.entered_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachmentCount: row.attachment_count ?? 0,
    bolCount: row.bol_count ?? 0,
    pendingReviewCount: row.pending_review_count ?? 0,
    documents: withDocuments ? await listCustomerDocuments(ctx, row.id) : [],
  }, { includeEnteredBy: true });
  const status = row.sam_build_status === "building" || row.sam_build_status === "failed" ? row.sam_build_status : null;
  const owner = row.owner === "Drew" || row.owner === "Ainsley" ? row.owner : null;
  const slackNotifiedAt = row.slack_notified_at || null;
  return {
    ...order,
    owner,
    ownerNeedsCheck: Number(row.owner_needs_check) === 1,
    samBuildStatus: status,
    samBuildError: row.sam_build_error || null,
    samBuildAt: row.sam_build_at || null,
    slackNotifiedAt,
    notices: parseOrderNotices(row.carrier_notice_log),
    stageEvents: parseStageEvents(row.stage_log),
    trackingEvents: parseTrackingEvents(row.tracking_event_log),
    buildStatus: buildStatusLabel(order.loadNumber, slackNotifiedAt),
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
    stops: legacyStops(placeFromColumn(row.origin_json), placeFromColumn(row.destination_json)),
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
      `(sales_order_number LIKE ? ESCAPE '\\' OR load_number LIKE ? ESCAPE '\\' OR origin_json LIKE ? ESCAPE '\\' OR destination_json LIKE ? ESCAPE '\\' OR IFNULL(stops_json, '') LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like, like, like);
  }
  if (filter.ids) {
    if (filter.ids.length === 0) {
      clauses.push("1 = 0");
    } else {
      clauses.push(`id IN (${filter.ids.map(() => "?").join(", ")})`);
      params.push(...filter.ids);
    }
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** Newest orders first. Created time is the default order on the loads page. */
function listOrderSql(): string {
  return `ORDER BY loads.created_at DESC, loads.sales_order_number ASC`;
}

export async function listOrders(ctx: PortalContext, filter: OrderFilter = {}): Promise<OrderPage> {
  const cap = filter.exportAll ? 5000 : 50;
  const pageSize = Math.min(cap, Math.max(1, filter.pageSize ?? 8));
  const page = Math.max(1, filter.page ?? 1);
  const today = denverDate(ctx.now());
  const where = buildWhere(filter, today);
  const totalRow = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM loads ${where.sql}`).get(...where.params);
  const rows = (await ctx.db
    .prepare(`${LIST_SQL_HEAD} ${where.sql} ${listOrderSql()} LIMIT ? OFFSET ?`)
    .all(...where.params, pageSize, (page - 1) * pageSize)) as unknown as LoadRow[];
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
  const across = searching || filter.acrossTabs === true;
  const page = await listOrders(ctx, {
    ...filter,
    includeAttention,
    tab: across ? null : tab,
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
    counts: await countTabs(ctx, { ...filter, ids: undefined, acrossTabs: undefined }, today),
    today,
    tomorrow,
    weekEnd,
    scope: across ? "all" : "tab",
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

async function writeStage(ctx: PortalContext, id: string, from: PortalStatus | null, to: PortalStatus, at: string): Promise<void> {
  const row = await ctx.db.prepare(`SELECT stage_log FROM loads WHERE id = ?`).get(id);
  const events: StageEvent[] = parseStageEvents(typeof row?.stage_log === "string" ? row.stage_log : null);
  events.push({ at, from, to, text: stageHistoryText(from, to) });
  await ctx.db.prepare(`UPDATE loads SET stage_log = ? WHERE id = ?`).run(JSON.stringify(events), id);
}

async function markSlack(ctx: PortalContext, id: string, ready: boolean): Promise<void> {
  const now = ctx.now().toISOString();
  if (ready) {
    await ctx.db
      .prepare(
        `UPDATE loads SET slack_ready_at = COALESCE(slack_ready_at, ?), slack_notified_at = COALESCE(slack_notified_at, ?) WHERE id = ?`,
      )
      .run(now, now, id);
    return;
  }
  await ctx.db.prepare(`UPDATE loads SET slack_notified_at = COALESCE(slack_notified_at, ?) WHERE id = ?`).run(now, id);
}

/** Post Ready to Ship once. A later edit does not post it again. */
async function postReadyToShip(ctx: PortalContext, id: string): Promise<void> {
  const row = await ctx.db.prepare(`SELECT slack_ready_at FROM loads WHERE id = ?`).get(id);
  if (row?.slack_ready_at) return;
  const order = await getOrder(ctx, id);
  if (!order) return;
  const posted = await notifyReadyToShip(order);
  if (posted) await markSlack(ctx, id, true);
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
    const assignment = assignLoadOwner({
      destinationCity: route.destination.city,
      destinationState: route.destination.state,
      equipment: input.truckType,
    });
    await ctx.db
      .prepare(
        `INSERT INTO loads (
           id, sales_order_number, load_number, portal_status, tracking_stage, timeline_json,
           origin_json, destination_json, stops_json, truck_type, transit, ship_date, ship_time,
           must_deliver_date, truck_eta, latest_eta, tracking_token, customer_cost_cents,
           rate_reason, comments, created_by, entered_by_name, entered_by_email, owner, owner_needs_check, created_at, updated_at, pending_review_count
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0
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
        actor.name.trim() || null,
        actor.email.trim() || null,
        assignment.owner,
        assignment.needsCheck ? 1 : 0,
        now,
        now,
      );
  });
  await writeStage(ctx, id, null, portalStatus, now);
  const order = await getOrder(ctx, id);
  if (!order) throw new PortalError("The order could not be saved", 500);
  if (portalStatus === "ready_to_ship") {
    await postReadyToShip(ctx, id);
  } else if (portalStatus === "being_prepared") {
    const posted = await notifyNewLoad(order, { name: actor.name, email: actor.email });
    if (posted) await markSlack(ctx, id, false);
  }
  const saved = await getOrder(ctx, id);
  if (!saved) throw new PortalError("The order could not be saved", 500);
  return { order: saved };
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
  if (portalStatus !== current.portalStatus) {
    await writeStage(ctx, id, current.portalStatus, portalStatus, now);
  }
  if (portalStatus === "ready_to_ship") await postReadyToShip(ctx, id);
  void actor;
  const updated = await getOrder(ctx, id);
  if (!updated) throw new PortalError("Order not found", 404);
  return updated;
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
    await ctx.db.prepare(`DELETE FROM customer_documents WHERE load_id = ?`).run(id);
    await ctx.db.prepare(`DELETE FROM internal_documents WHERE load_id = ?`).run(id);
    await ctx.db.prepare(`DELETE FROM document_uploads WHERE load_id = ?`).run(id);
    await ctx.db.prepare(`DELETE FROM carrier_photos WHERE load_id = ?`).run(id);
    const removed = await ctx.db.prepare(`DELETE FROM loads WHERE id = ?`).run(id);
    if (!removed.changes) throw new PortalError("Order not found", 404);
  });
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
