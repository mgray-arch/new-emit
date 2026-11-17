import { timingSafeEqual } from "node:crypto";
import { parseStageEvents, stageHistoryText } from "@/lib/build-status";
import { findBotLoad } from "@/lib/bot-documents";
import type { PortalContext } from "@/lib/db";
import { withTransaction } from "@/lib/db";
import { PortalError } from "@/lib/http";
import { OPEN_LOAD_SQL, timelineThrough } from "@/lib/orders";
import { TRACKING_STAGES, type PortalStatus, type TrackingStage } from "@/lib/types";

/** Events an integration may record. Coordinates are not an event. */
export const DELIVERY_EVENTS = ["delivered", "departure", "arrival_completed"] as const;
export type DeliveryEvent = (typeof DELIVERY_EVENTS)[number];

const MIN_SECRET = 16;

/**
 * A file already stored for this load whose name says it is a proof of delivery.
 * Bot uploads also count through document_uploads.doc_type = 'pod', even when the name does not.
 */
export function filenameLooksLikePod(filename: string): boolean {
  const name = filename.trim().toLowerCase();
  if (!name) return false;
  return (
    name.startsWith("pod") ||
    name.includes("-pod") ||
    name.includes("_pod") ||
    name.includes(" pod") ||
    name.includes("proof of delivery") ||
    name.includes("proof-of-delivery")
  );
}

function podFilenameSql(column: string): string {
  return `(
    instr(lower(${column}), '-pod') > 0
    OR instr(lower(${column}), '_pod') > 0
    OR instr(lower(${column}), ' pod') > 0
    OR lower(${column}) LIKE 'pod%'
    OR instr(lower(${column}), 'proof of delivery') > 0
    OR instr(lower(${column}), 'proof-of-delivery') > 0
  )`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A drop with a recorded arrival or departure. A blank or broken stop list is not a signal. */
export function dropHasDeliveryTime(stopsJson: unknown): boolean {
  if (typeof stopsJson !== "string" || !stopsJson.trim()) return false;
  try {
    const parsed = JSON.parse(stopsJson) as unknown;
    if (!Array.isArray(parsed)) return false;
    return parsed.some((item) => {
      if (!item || typeof item !== "object") return false;
      const stop = item as { kind?: unknown; schedule?: { arrivedAt?: unknown; departedAt?: unknown } | null };
      if (stop.kind !== "drop" || !stop.schedule) return false;
      return Boolean(text(stop.schedule.departedAt) || text(stop.schedule.arrivedAt));
    });
  } catch {
    return false;
  }
}

/**
 * Reliable delivery evidence already on the load.
 * A tracking ping, a share link, or a raw position is not evidence.
 * A manual undo blocks the file, stop, and tracking-stage evidence until a newer
 * integration event is recorded.
 */
function rowHasDeliverySignal(row: Record<string, unknown>): boolean {
  const held = text(row.delivery_held_at);
  const signal = text(row.delivery_signal_at);
  if (signal && (!held || signal > held)) return true;
  if (held) return false;
  if (row.tracking_stage === "delivered") return true;
  if (Number(row.has_pod) === 1) return true;
  return dropHasDeliveryTime(row.stops_json);
}

function tokenMatches(presented: string, expected: string): boolean {
  const actual = Buffer.from(presented);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length) {
    timingSafeEqual(wanted, wanted);
    return false;
  }
  return timingSafeEqual(actual, wanted);
}

/** Vercel sends `Authorization: Bearer $CRON_SECRET` when that variable is set. A short or missing secret never matches. */
export function cronAuthorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET ?? "";
  const header = req.headers.get("authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (expected.length < MIN_SECRET) {
    const standIn = "x".repeat(MIN_SECRET);
    tokenMatches(presented || standIn, standIn);
    return false;
  }
  return tokenMatches(presented, expected);
}

function isTrackingStage(value: string): value is TrackingStage {
  return (TRACKING_STAGES as readonly string[]).includes(value);
}

async function loadIdForSignal(
  ctx: PortalContext,
  input: { orderId?: string | null; loadNumber?: string | null; salesOrderNumber?: string | null },
): Promise<string> {
  const orderId = input.orderId?.trim() ?? "";
  if (orderId) {
    const row = await ctx.db.prepare(`SELECT id FROM loads WHERE id = ? AND ${OPEN_LOAD_SQL}`).get(orderId);
    if (!row) throw new PortalError("No portal load with that id.", 404);
    if (input.loadNumber?.trim() || input.salesOrderNumber?.trim()) {
      const match = await findBotLoad(ctx, { loadNumber: input.loadNumber, salesOrderNumber: input.salesOrderNumber });
      if (match.id !== orderId) throw new PortalError("That id is not the same load.", 409);
    }
    return orderId;
  }
  const match = await findBotLoad(ctx, { loadNumber: input.loadNumber, salesOrderNumber: input.salesOrderNumber });
  return match.id;
}

/**
 * Record a delivery event. This does not change the portal status and does not
 * move a load to In Transit. The morning job reads the event.
 */
export async function recordDeliverySignal(
  ctx: PortalContext,
  input: { orderId?: string | null; loadNumber?: string | null; salesOrderNumber?: string | null; event: DeliveryEvent },
): Promise<{ orderId: string; portalStatus: string; event: DeliveryEvent }> {
  const id = await loadIdForSignal(ctx, input);
  const now = ctx.now().toISOString();
  await ctx.db
    .prepare(
      `UPDATE loads SET delivery_signal_at = ?, delivery_signal_kind = ?, updated_at = ? WHERE id = ? AND ${OPEN_LOAD_SQL}`,
    )
    .run(now, input.event, now, id);
  const row = await ctx.db.prepare(`SELECT portal_status, tracking_stage FROM loads WHERE id = ?`).get(id);
  return {
    orderId: id,
    portalStatus: String(row?.portal_status ?? ""),
    event: input.event,
  };
}

export interface DeliveryRun {
  delivered: number;
  loadIds: string[];
}

/**
 * Move In Transit loads to Delivered when a delivery signal is on file.
 * Does not touch Being Prepared, Ready to Ship, Cancelled, or deleted loads.
 * Does not use a tracking ping or a position.
 */
export async function promoteDeliveredLoads(ctx: PortalContext): Promise<DeliveryRun> {
  const podOnFile = `
    EXISTS (SELECT 1 FROM document_uploads AS upload WHERE upload.load_id = loads.id AND lower(upload.doc_type) = 'pod')
    OR EXISTS (SELECT 1 FROM customer_documents AS doc WHERE doc.load_id = loads.id AND ${podFilenameSql("doc.filename")})
    OR EXISTS (SELECT 1 FROM internal_documents AS held WHERE held.load_id = loads.id AND ${podFilenameSql("held.filename")})`;
  const rows = (
    await ctx.db
      .prepare(
        `SELECT id, portal_status, tracking_stage, stage_log, stops_json, delivery_signal_at, delivery_held_at,
                CASE WHEN ${podOnFile} THEN 1 ELSE 0 END AS has_pod
         FROM loads
         WHERE ${OPEN_LOAD_SQL}
           AND portal_status IN ('in_transit', 'shipped')`,
      )
      .all()
  ).filter(rowHasDeliverySignal);
  const now = ctx.now().toISOString();
  const loadIds: string[] = [];
  await withTransaction(ctx.db, async () => {
    for (const row of rows) {
      const id = String(row.id);
      const from: PortalStatus = "in_transit";
      const currentStage = isTrackingStage(String(row.tracking_stage ?? "")) ? (String(row.tracking_stage) as TrackingStage) : "in_transit";
      const nextStage: TrackingStage = TRACKING_STAGES.indexOf("delivered") > TRACKING_STAGES.indexOf(currentStage) ? "delivered" : currentStage;
      const timeline = nextStage === "delivered" && currentStage !== "delivered" ? JSON.stringify(timelineThrough("delivered", now)) : null;
      const events = parseStageEvents(typeof row.stage_log === "string" ? row.stage_log : null);
      events.push({ at: now, from, to: "delivered", text: stageHistoryText(from, "delivered") });
      const saved = await ctx.db
        .prepare(
          `UPDATE loads
             SET portal_status = 'delivered',
                 tracking_stage = ?,
                 timeline_json = COALESCE(?, timeline_json),
                 stage_log = ?,
                 delivery_held_at = NULL,
                 updated_at = ?
           WHERE id = ? AND ${OPEN_LOAD_SQL} AND portal_status IN ('in_transit', 'shipped')`,
        )
        .run(nextStage, timeline, JSON.stringify(events), now, id);
      if (saved.changes > 0) loadIds.push(id);
    }
  });
  return { delivered: loadIds.length, loadIds };
}
