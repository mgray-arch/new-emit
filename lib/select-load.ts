import type { PortalContext } from "@/lib/db";
import { withTransaction } from "@/lib/db";
import { PortalError } from "@/lib/http";
import { getOrder } from "@/lib/orders";
import type { CustomerOrder } from "@/lib/types";

/**
 * The Select (SAM) load number stored on a portal order.
 *
 * The portal does not invent one. A Select admin types the number after building
 * the load in SAM. A future SAM sync should call assignSelectLoadNumber with
 * source "sam" (or syncSelectLoadNumberFromSam) and the number SAM returned.
 * Until either of those happens the column stays null and EMIT sees "Pending".
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
