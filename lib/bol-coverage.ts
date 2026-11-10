import type { PortalContext } from "@/lib/db";
import { applyLoadStatus } from "@/lib/load-builder";
import { parseSamBol } from "@/lib/sam-bol";
import { sensitiveReason } from "@/lib/sensitive";

/**
 * A released BOL covers the load. The carrier company and MC are written through
 * the same assignment path as the SAM status callback, which moves Confirmed to
 * Booked. A missing SAM load number is taken from the BOL header.
 * Held pages are not passed here. Pay, rates, and rate confirmations are not stored.
 */
export async function coverLoadFromReleasedBol(ctx: PortalContext, loadId: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || sensitiveReason(trimmed)) return;
  const parsed = parseSamBol(trimmed);
  if (!parsed.loadNumber && !parsed.carrierName && !parsed.carrierMc) return;

  const row = await ctx.db.prepare(`SELECT id, load_number FROM loads WHERE id = ?`).get(loadId);
  if (!row) return;

  let loadNumber: string | undefined;
  const current = row.load_number == null ? "" : String(row.load_number).trim();
  if (!current && parsed.loadNumber) {
    const taken = await ctx.db
      .prepare(`SELECT id FROM loads WHERE load_number = ? AND id != ?`)
      .get(parsed.loadNumber, loadId);
    if (!taken) loadNumber = parsed.loadNumber;
  }

  const name = parsed.carrierName ?? "";
  const mc = parsed.carrierMc && /^\d{1,8}$/.test(parsed.carrierMc) ? parsed.carrierMc : "";
  const carrier =
    name || mc
      ? {
          name,
          mc,
          nameProvided: Boolean(name),
          mcProvided: Boolean(mc),
        }
      : null;
  if (!loadNumber && !carrier) return;
  await applyLoadStatus(ctx, { orderId: loadId, loadNumber, carrier });
}
