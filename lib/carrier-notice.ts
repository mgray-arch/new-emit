import type { PortalContext } from "@/lib/db";
import { PortalError } from "@/lib/http";
import { timelineThrough } from "@/lib/orders";
import { sensitiveReason } from "@/lib/sensitive";
import type { CustomerOrder } from "@/lib/types";

const RATE_KEY = /pay|rate|margin|cost|price|charge|line[\s_-]*haul|rate[\s_-]*con/i;

export type CarrierNoticeResult = "assigned" | "changed" | "unchanged";

export interface CarrierIdentity {
  name: string;
  mc: string;
}

export interface CarrierUpdate {
  name?: string;
  mc?: string;
  nameProvided: boolean;
  mcProvided: boolean;
}

/** Any object key that names a rate, a price, or a rate confirmation. Nested keys count. */
export function findRateField(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRateField(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (RATE_KEY.test(key)) return key;
    const found = findRateField(child);
    if (found) return found;
  }
  return null;
}

export function normalizeCarrierName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** "MC 445566" and "445566" are the same number. */
export function normalizeMc(value: string): string {
  return value.trim().replace(/^mc[\s#-]*/i, "").replace(/\s+/g, "");
}

export function sameCarrier(left: CarrierIdentity, right: CarrierIdentity): boolean {
  return (
    normalizeCarrierName(left.name).toLowerCase() === normalizeCarrierName(right.name).toLowerCase() &&
    normalizeMc(left.mc).toLowerCase() === normalizeMc(right.mc).toLowerCase()
  );
}

/** History line for the load page. It names the company and MC. It has no pay and it is not an email. */
export function historyText(kind: "assigned" | "changed", next: CarrierIdentity, previous: CarrierIdentity): string {
  const name = next.name || "Name not provided";
  const mc = next.mc ? `MC ${next.mc}` : "MC not provided";
  if (kind === "assigned") return `Carrier assigned: ${name}. ${mc}.`;
  const from = previous.name || "the previous carrier";
  const fromMc = previous.mc ? ` (MC ${previous.mc})` : "";
  return `Carrier changed from ${from}${fromMc} to ${name}. ${mc}.`;
}

interface NoticeEntry {
  at: string;
  kind: "assigned" | "changed";
  text: string;
  company: string;
  mc: string;
}

function parseLog(raw: unknown): NoticeEntry[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is NoticeEntry => {
      if (!item || typeof item !== "object") return false;
      const row = item as Record<string, unknown>;
      return (row.kind === "assigned" || row.kind === "changed") && typeof row.text === "string" && typeof row.at === "string";
    });
  } catch {
    return [];
  }
}

/**
 * Store a new or changed carrier and append a History line.
 * The same carrier again does not write another line. Nothing is emailed.
 * Carrier pay is not a parameter and is not written.
 */
export async function recordCarrierAssignment(
  ctx: PortalContext,
  order: CustomerOrder,
  incoming: CarrierUpdate,
): Promise<CarrierNoticeResult> {
  const row = await ctx.db
    .prepare(`SELECT carrier_name, carrier_mc, carrier_notice_log FROM loads WHERE id = ?`)
    .get(order.id);
  const stored: CarrierIdentity = {
    name: normalizeCarrierName(String(row?.carrier_name ?? "")),
    mc: normalizeMc(String(row?.carrier_mc ?? "")),
  };
  const providedName = incoming.nameProvided ? normalizeCarrierName(incoming.name ?? "") : "";
  const providedMc = incoming.mcProvided ? normalizeMc(incoming.mc ?? "") : "";
  const next: CarrierIdentity = {
    name: providedName || stored.name,
    mc: providedMc || stored.mc,
  };
  if ((!next.name && !next.mc) || sameCarrier(stored, next)) return "unchanged";
  if (sensitiveReason(next.name) || sensitiveReason(next.mc)) {
    throw new PortalError("Carrier details cannot include rates or pay.");
  }

  const kind = stored.name || stored.mc ? "changed" : "assigned";
  const text = historyText(kind, next, stored);
  if (sensitiveReason(text)) {
    throw new PortalError("Carrier details cannot include rates or pay.");
  }
  const now = ctx.now().toISOString();
  const log = parseLog(row?.carrier_notice_log);
  log.push({ at: now, kind, text, company: next.name, mc: next.mc });
  await ctx.db
    .prepare(`UPDATE loads SET carrier_name = ?, carrier_mc = ?, carrier_notice_log = ?, updated_at = ? WHERE id = ?`)
    .run(next.name || null, next.mc || null, JSON.stringify(log), now, order.id);
  await markBookedForCarrier(ctx, order.id, now);
  return kind;
}

/** A recorded carrier is what Booked means. Later stages stay where they are. */
async function markBookedForCarrier(ctx: PortalContext, id: string, at: string): Promise<void> {
  const row = await ctx.db.prepare(`SELECT tracking_stage FROM loads WHERE id = ?`).get(id);
  if (String(row?.tracking_stage ?? "") !== "submitted") return;
  await ctx.db
    .prepare(`UPDATE loads SET tracking_stage = 'booked', timeline_json = ? WHERE id = ?`)
    .run(JSON.stringify(timelineThrough("booked", at)), id);
}
