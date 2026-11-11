import { coverLoadFromReleasedBol } from "@/lib/bol-coverage";
import { classifyCustomerUpload } from "@/lib/customer-upload";
import type { PortalContext } from "@/lib/db";
import { storeScreenedUpload } from "@/lib/documents";
import { PortalError } from "@/lib/http";
import { deleteStoredBytes, readStoredBytes } from "@/lib/storage";

/** Written on the new row so a repair is not confused with the original upload. */
export const REFILE_ACTOR = "Select refile";

export interface RefileTarget {
  id: string;
  loadId: string;
  filename: string;
  kind: "attachment" | "bol";
}

export interface RefileOutcome {
  documentId: string;
  loadId: string;
  filename: string;
  applied: boolean;
  slot: "attachment" | "bol";
  held: boolean;
  blocked: boolean;
  releasedCount: number;
  heldCount: number;
  parsedLoadNumber: string | null;
  parsedCarrierName: string | null;
  parsedCarrierMc: string | null;
  currentLoadNumber: string | null;
  note: string;
}

interface AttachmentRow {
  id: string;
  load_id: string;
  kind: string;
  filename: string;
  storage_key: string;
}

function asTarget(row: Record<string, unknown>): RefileTarget {
  return {
    id: String(row.id),
    loadId: String(row.load_id),
    filename: String(row.filename),
    kind: row.kind === "bol" ? "bol" : "attachment",
  };
}

/** Attachment rows for one document id, or every row with this filename on the load. */
export async function findRefileTargets(
  ctx: PortalContext,
  input: { documentId?: string | null; loadId?: string | null; filename?: string | null },
): Promise<RefileTarget[]> {
  if (input.documentId?.trim()) {
    const row = await ctx.db
      .prepare(`SELECT id, load_id, kind, filename FROM customer_documents WHERE id = ?`)
      .get(input.documentId.trim());
    return row ? [asTarget(row)] : [];
  }
  const loadId = input.loadId?.trim() ?? "";
  const filename = input.filename?.trim() ?? "";
  if (!loadId || !filename) return [];
  const rows = await ctx.db
    .prepare(`SELECT id, load_id, kind, filename FROM customer_documents WHERE load_id = ? AND filename = ? ORDER BY created_at ASC, rowid ASC`)
    .all(loadId, filename);
  return rows.map((row) => asTarget(row));
}

function noteFor(classified: { slot: "attachment" | "bol"; held: boolean; blocked: boolean }, apply: boolean): string {
  if (classified.blocked || classified.held) {
    return apply
      ? "Removed from EMIT and held for review."
      : "Would remove it from EMIT and hold it for review. Nothing was written.";
  }
  if (classified.slot === "bol") {
    return apply
      ? "Filed as the BOL and filled the load from the header."
      : "Would file it as the BOL and fill the load from the header. Nothing was written.";
  }
  return "Left it as an attachment. It is not a bill of lading, and the screen still passes.";
}

/**
 * Run one customer-visible attachment through the same screen as a new upload.
 * A bill of lading is stored as a BOL and fills the load. A rate confirmation
 * or an unclear page is taken off EMIT and held for review. Dry-run writes nothing.
 */
export async function refileCustomerAttachment(
  ctx: PortalContext,
  documentId: string,
  apply: boolean,
): Promise<RefileOutcome> {
  const row = (await ctx.db
    .prepare(`SELECT id, load_id, kind, filename, storage_key FROM customer_documents WHERE id = ?`)
    .get(documentId)) as AttachmentRow | undefined;
  if (!row) throw new PortalError("That file is not on a load.", 404);
  if (row.kind !== "attachment") throw new PortalError("That file is already a BOL.", 409);

  const bytes = await readStoredBytes(String(row.storage_key));
  const classified = await classifyCustomerUpload(String(row.filename), bytes, "attachment");
  const load = await ctx.db.prepare(`SELECT load_number FROM loads WHERE id = ?`).get(String(row.load_id));
  const currentLoadNumber =
    load?.load_number == null || String(load.load_number).trim() === "" ? null : String(load.load_number);
  const base: RefileOutcome = {
    documentId: String(row.id),
    loadId: String(row.load_id),
    filename: String(row.filename),
    applied: false,
    slot: classified.slot,
    held: classified.held,
    blocked: classified.blocked,
    releasedCount: 0,
    heldCount: 0,
    parsedLoadNumber: classified.parsed.loadNumber,
    parsedCarrierName: classified.parsed.carrierName,
    parsedCarrierMc: classified.parsed.carrierMc,
    currentLoadNumber,
    note: noteFor(classified, false),
  };
  const shouldWrite = classified.slot === "bol" || classified.held || classified.blocked;
  if (!apply || !shouldWrite) return base;

  const stored = await storeScreenedUpload(ctx, {
    loadId: String(row.load_id),
    filename: String(row.filename),
    slot: classified.slot,
    uploadedBy: REFILE_ACTOR,
    pages: classified.pages,
  });
  if (classified.slot === "bol" && stored.releasedIds.length > 0) {
    await coverLoadFromReleasedBol(ctx, String(row.load_id), stored.releasedTexts.join("\n"));
  }
  await deleteStoredBytes(String(row.storage_key));
  await ctx.db.prepare(`DELETE FROM customer_documents WHERE id = ?`).run(String(row.id));
  return {
    ...base,
    applied: true,
    releasedCount: stored.releasedIds.length,
    heldCount: stored.heldIds.length,
    note: noteFor(classified, true),
  };
}
