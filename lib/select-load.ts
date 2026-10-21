import type { PortalContext } from "@/lib/db";
import { withTransaction } from "@/lib/db";
import { PortalError } from "@/lib/http";
import { getOrder } from "@/lib/orders";
import { parseTrackingLink } from "@/lib/tracking-link";
import type { CustomerOrder } from "@/lib/types";

/**
 * The Select (SAM) load number stored on a portal order.
 *
 * The portal does not invent one. A Select admin types the number after building
 * the load in SAM. A future SAM sync should call assignSelectLoadNumber with
 * source "sam" (or syncSelectLoadNumberFromSam) and the number SAM returned.
 * Until either of those happens the column stays null and EMIT sees "Pending".
 *
 * The public tracking share link (SAM / MacroPoint) is the same kind of field:
 * assignTrackingLink for a Select admin, syncTrackingLinkFromSam for a future sync.
 * It is not the portal's own /track page.
 */

/** Loose SAM shape: order id, a dash, load sequence. Example: 458934-1. */
export const SELECT_LOAD_NUMBER = /^\d{4,10}-\d{1,3}$/;

export type LoadNumberSource = "admin" | "sam";

export function parseSelectLoadNumber(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!SELECT_LOAD_NUMBER.test(trimmed)) return null;
  return trimmed;
}

function loadNumberFromRecord(record: Record<string, unknown>): unknown {
  if ("loadNumber" in record) return record.loadNumber;
  const loads = record.loads;
  if (Array.isArray(loads) && loads[0] && typeof loads[0] === "object") {
    return (loads[0] as Record<string, unknown>).loadNumber;
  }
  const load = record.load;
  if (load && typeof load === "object") return (load as Record<string, unknown>).loadNumber;
  return undefined;
}

/** Read a real SAM load number off a TMS payload. Null when SAM has not assigned one, or the value is not a load number. */
export function selectLoadNumberFromSam(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  return parseSelectLoadNumber(loadNumberFromRecord(raw as Record<string, unknown>));
}

async function requireOrder(ctx: PortalContext, orderId: string): Promise<CustomerOrder> {
  const order = await getOrder(ctx, orderId);
  if (!order) throw new PortalError("Order not found", 404);
  return order;
}

/**
 * Store the Select load number. Pass an empty string as an admin to clear it
 * back to pending. SAM sync should pass a parsed number and source "sam";
 * it does not clear a number when SAM has not assigned one yet.
 */
export async function assignSelectLoadNumber(
  ctx: PortalContext,
  orderId: string,
  loadNumber: string,
  source: LoadNumberSource,
): Promise<CustomerOrder> {
  const raw = loadNumber.trim();
  if (!raw) {
    if (source !== "admin") throw new PortalError("SAM did not return a load number.");
    const cleared = await ctx.db
      .prepare(`UPDATE loads SET load_number = NULL, load_number_source = NULL, updated_at = ? WHERE id = ?`)
      .run(ctx.now().toISOString(), orderId);
    if (!cleared.changes) throw new PortalError("Order not found", 404);
    return requireOrder(ctx, orderId);
  }
  const parsed = parseSelectLoadNumber(raw);
  if (!parsed) throw new PortalError("Enter a Select load number like 458934-1.");
  try {
    await withTransaction(ctx.db, async () => {
      const taken = await ctx.db.prepare(`SELECT id FROM loads WHERE load_number = ? AND id != ?`).get(parsed, orderId);
      if (taken) throw new PortalError("That Select load number is already on another order.");
      const updated = await ctx.db
        .prepare(`UPDATE loads SET load_number = ?, load_number_source = ?, updated_at = ? WHERE id = ?`)
        .run(parsed, source, ctx.now().toISOString(), orderId);
      if (!updated.changes) throw new PortalError("Order not found", 404);
    });
  } catch (error) {
    if (error instanceof PortalError) throw error;
    if (String(error).includes("UNIQUE")) throw new PortalError("That Select load number is already on another order.");
    throw error;
  }
  return requireOrder(ctx, orderId);
}

/**
 * Future SAM sync entry point. When the payload has a real load number, store it.
 * When it does not, leave whatever is already on the order (including pending).
 */
export async function syncSelectLoadNumberFromSam(
  ctx: PortalContext,
  orderId: string,
  samPayload: unknown,
): Promise<CustomerOrder> {
  const loadNumber = selectLoadNumberFromSam(samPayload);
  if (!loadNumber) return requireOrder(ctx, orderId);
  return assignSelectLoadNumber(ctx, orderId, loadNumber, "sam");
}

function shareUrlFromRecord(record: Record<string, unknown>, nested = false): unknown {
  const tracking = record.tracking;
  if (tracking && typeof tracking === "object" && typeof (tracking as Record<string, unknown>).shareUrl === "string") {
    return (tracking as Record<string, unknown>).shareUrl;
  }
  if (typeof record.shareUrl === "string") return record.shareUrl;
  if (typeof record.trackingLink === "string") return record.trackingLink;
  if (nested) return undefined;
  const loads = record.loads;
  if (Array.isArray(loads) && loads[0] && typeof loads[0] === "object") {
    return shareUrlFromRecord(loads[0] as Record<string, unknown>, true);
  }
  const load = record.load;
  if (load && typeof load === "object") return shareUrlFromRecord(load as Record<string, unknown>, true);
  return undefined;
}

/** Read a public share URL off a TMS payload. Null when SAM has not published one, or the value is not an http(s) URL. */
export function trackingLinkFromSam(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  return parseTrackingLink(shareUrlFromRecord(raw as Record<string, unknown>));
}

/**
 * Store the public tracking link. Pass an empty string as an admin to clear it.
 * SAM sync should pass a parsed URL and source "sam". It does not clear a link
 * when SAM has not published one yet.
 */
export async function assignTrackingLink(
  ctx: PortalContext,
  orderId: string,
  trackingLink: string,
  source: LoadNumberSource,
): Promise<CustomerOrder> {
  const raw = trackingLink.trim();
  if (!raw) {
    if (source !== "admin") throw new PortalError("SAM did not return a tracking link.");
    const cleared = await ctx.db
      .prepare(`UPDATE loads SET tracking_link = NULL, tracking_link_source = NULL, updated_at = ? WHERE id = ?`)
      .run(ctx.now().toISOString(), orderId);
    if (!cleared.changes) throw new PortalError("Order not found", 404);
    return requireOrder(ctx, orderId);
  }
  const parsed = parseTrackingLink(raw);
  if (!parsed) throw new PortalError("Paste an http or https tracking link.");
  const updated = await ctx.db
    .prepare(`UPDATE loads SET tracking_link = ?, tracking_link_source = ?, updated_at = ? WHERE id = ?`)
    .run(parsed, source, ctx.now().toISOString(), orderId);
  if (!updated.changes) throw new PortalError("Order not found", 404);
  return requireOrder(ctx, orderId);
}

/**
 * Future SAM sync entry point for the MacroPoint / SAM public share link.
 * When the payload has one, store it. When it does not, leave the current link.
 */
export async function syncTrackingLinkFromSam(
  ctx: PortalContext,
  orderId: string,
  samPayload: unknown,
): Promise<CustomerOrder> {
  const trackingLink = trackingLinkFromSam(samPayload);
  if (!trackingLink) return requireOrder(ctx, orderId);
  return assignTrackingLink(ctx, orderId, trackingLink, "sam");
}
