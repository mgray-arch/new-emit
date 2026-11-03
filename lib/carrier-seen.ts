import { parseOrderNotices } from "@/lib/build-status";
import type { PortalContext } from "@/lib/db";
import type { CustomerOrder, OrderNotice } from "@/lib/types";

export type CarrierBadge = "assigned" | "changed";

export function carrierBadgeLabel(kind: CarrierBadge): string {
  return kind === "changed" ? "Carrier changed" : "Carrier assigned";
}

/** Banner copy. Zero is not shown. One uses the singular. */
export function updateBannerText(count: number): string {
  const n = Math.max(0, Math.floor(count));
  return n === 1 ? "1 order updated since your last visit" : `${n} orders updated since your last visit`;
}

export function latestNotice(notices: OrderNotice[] | null | undefined): OrderNotice | null {
  if (!notices?.length) return null;
  return notices[notices.length - 1] ?? null;
}

/** A badge stays until this user has a seen time at or after the latest carrier update. */
export function badgeFor(
  latest: { at: string; kind: CarrierBadge } | null,
  seenAt: string | null | undefined,
): CarrierBadge | null {
  if (!latest?.at) return null;
  if (seenAt && seenAt >= latest.at) return null;
  return latest.kind;
}

export function badgeForOrder(order: Pick<CustomerOrder, "id" | "notices">, seen: Map<string, string>): CarrierBadge | null {
  const latest = latestNotice(order.notices);
  if (!latest) return null;
  return badgeFor({ at: latest.at, kind: latest.kind }, seen.get(order.id) ?? null);
}

interface CarrierEvent {
  id: string;
  at: string;
  kind: CarrierBadge;
}

export async function seenMap(ctx: PortalContext, userId: string): Promise<Map<string, string>> {
  const rows = await ctx.db.prepare(`SELECT load_id, seen_at FROM order_seen WHERE user_id = ?`).all(userId);
  const map = new Map<string, string>();
  for (const row of rows) map.set(String(row.load_id), String(row.seen_at));
  return map;
}

/** Latest carrier update on each load that has one. Loads with no history are omitted. */
export async function carrierEvents(ctx: PortalContext): Promise<CarrierEvent[]> {
  const rows = await ctx.db
    .prepare(
      `SELECT id, carrier_notice_log FROM loads WHERE carrier_notice_log IS NOT NULL AND trim(carrier_notice_log) != ''`,
    )
    .all();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const latest = latestNotice(parseOrderNotices(typeof row.carrier_notice_log === "string" ? row.carrier_notice_log : null));
    if (!latest?.at) continue;
    events.push({ id: String(row.id), at: latest.at, kind: latest.kind });
  }
  return events;
}

export function unseenLoadIds(events: CarrierEvent[], seen: Map<string, string>): string[] {
  return events.filter((event) => badgeFor(event, seen.get(event.id) ?? null)).map((event) => event.id);
}

export async function countUnseen(ctx: PortalContext, userId: string): Promise<number> {
  const [events, seen] = await Promise.all([carrierEvents(ctx), seenMap(ctx, userId)]);
  return unseenLoadIds(events, seen).length;
}

/** Remember that this user opened the update. An older stamp does not move the mark backward. */
export async function markCarrierSeen(ctx: PortalContext, userId: string, loadId: string, seenAt: string): Promise<void> {
  if (!userId || !loadId || !seenAt) return;
  await ctx.db
    .prepare(
      `INSERT INTO order_seen (user_id, load_id, seen_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, load_id) DO UPDATE SET seen_at = excluded.seen_at
       WHERE excluded.seen_at > order_seen.seen_at`,
    )
    .run(userId, loadId, seenAt);
}
