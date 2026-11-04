import type { PortalContext } from "@/lib/db";
import { PortalError } from "@/lib/http";
import { sensitiveReason } from "@/lib/sensitive";
import type { TrackingEvent } from "@/lib/types";

/**
 * A public share link stored from the portal or the email bot. Only http(s) URLs are stored.
 * Load Builder must use `parseCustomerShareUrl`: https on customer.goselect.com/tracking/ only.
 */

export const TRACKING_LINK_MAX = 2000;
const SHARE_HOST = "customer.goselect.com";

export function parseTrackingLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > TRACKING_LINK_MAX) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return trimmed;
}

/** SAM's public customer share URL. https only, and only that host and /tracking path. */
export function parseCustomerShareUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > TRACKING_LINK_MAX) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.hostname.toLowerCase() !== SHARE_HOST) return null;
  const path = url.pathname.toLowerCase();
  if (path !== "/tracking" && !path.startsWith("/tracking/")) return null;
  if (sensitiveReason(trimmed)) return null;
  return url.toString();
}

export function parseTrackingEvents(raw: unknown): TrackingEvent[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const events: TrackingEvent[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const text = typeof row.text === "string" ? row.text.trim() : "";
      const at = typeof row.at === "string" ? row.at : "";
      if (!text || !at || sensitiveReason(text)) continue;
      events.push({ at, text });
    }
    return events;
  } catch {
    return [];
  }
}

export function latestTrackingAt(events: TrackingEvent[] | null | undefined): string | null {
  if (!events?.length) return null;
  return events[events.length - 1]?.at ?? null;
}

/** True when this person has not opened the order since tracking started or the link changed. */
export function trackingIsUnseen(at: string | null, seenAt: string | null | undefined): boolean {
  if (!at) return false;
  if (seenAt && seenAt >= at) return false;
  return true;
}

export interface TrackingStart {
  id: string;
  at: string;
}

export async function trackingStartEvents(ctx: PortalContext): Promise<TrackingStart[]> {
  const rows = await ctx.db
    .prepare(
      `SELECT id, tracking_event_log FROM loads WHERE tracking_event_log IS NOT NULL AND trim(tracking_event_log) != ''`,
    )
    .all();
  const events: TrackingStart[] = [];
  for (const row of rows) {
    const at = latestTrackingAt(parseTrackingEvents(row.tracking_event_log));
    if (!at) continue;
    events.push({ id: String(row.id), at });
  }
  return events;
}

/**
 * Store a customer.goselect.com tracking link from Load Builder.
 * The same URL again does not add another History line. Pay is not stored.
 */
export async function recordCustomerShareLink(
  ctx: PortalContext,
  orderId: string,
  trackingUrl: string,
): Promise<"started" | "updated" | "unchanged"> {
  const parsed = parseCustomerShareUrl(trackingUrl);
  if (!parsed) {
    throw new PortalError("tracking_url must be an https link on customer.goselect.com/tracking/.");
  }
  const row = await ctx.db.prepare(`SELECT tracking_link, tracking_event_log FROM loads WHERE id = ?`).get(orderId);
  if (!row) throw new PortalError("Order not found", 404);
  const current = typeof row.tracking_link === "string" ? row.tracking_link : "";
  if (current === parsed) return "unchanged";
  const events = parseTrackingEvents(row.tracking_event_log);
  const now = ctx.now().toISOString();
  events.push({ at: now, text: current ? "Tracking link updated." : "Tracking started." });
  const updated = await ctx.db
    .prepare(
      `UPDATE loads SET tracking_link = ?, tracking_link_source = 'sam', tracking_event_log = ?, updated_at = ? WHERE id = ?`,
    )
    .run(parsed, JSON.stringify(events), now, orderId);
  if (!updated.changes) throw new PortalError("Order not found", 404);
  return current ? "updated" : "started";
}
