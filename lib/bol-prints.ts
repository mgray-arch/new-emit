import { createHash, randomUUID } from "node:crypto";
import type { PortalContext } from "@/lib/db";
import { withTransaction } from "@/lib/db";
import { PortalError } from "@/lib/http";
import { readStoredBytes } from "@/lib/storage";

/**
 * A print is a record that someone opened an uploaded BOL through the Print button.
 * The portal does not generate a BOL. View, Download, and the browser print dialog
 * are not recorded — only POST /api/orders/:id/bol/print writes a row.
 * Version numbers are per load, not per file.
 */

export interface CarrierIdentity {
  carrierName: string | null;
  carrierMc: string | null;
  driverName: string | null;
}

export interface BolPrintRecord {
  version: number;
  printedAt: string;
  printedByName: string;
  carrierName: string | null;
  carrierMc: string | null;
  driverName: string | null;
  documentId: string;
}

export interface BolPrintSummary extends BolPrintRecord {
  reprint: boolean;
  reasons: Array<"carrier_changed" | "bol_updated">;
  bolRemoved: boolean;
}

interface PrintRow {
  version: number;
  printed_at: string;
  printed_by_name: string;
  carrier_name: string | null;
  carrier_mc: string | null;
  driver_name: string | null;
  document_id: string;
  bol_fingerprint: string;
}

function fingerprint(documentId: string, bytes: Uint8Array): string {
  return `${documentId}:${createHash("sha256").update(bytes).digest("hex")}`;
}

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function sameIdentity(printed: PrintRow, current: CarrierIdentity): boolean {
  return (
    norm(printed.carrier_name) === norm(current.carrierName) &&
    norm(printed.carrier_mc) === norm(current.carrierMc) &&
    norm(printed.driver_name) === norm(current.driverName)
  );
}

function toRecord(row: PrintRow): BolPrintRecord {
  return {
    version: Number(row.version),
    printedAt: row.printed_at,
    printedByName: row.printed_by_name,
    carrierName: row.carrier_name,
    carrierMc: row.carrier_mc,
    driverName: row.driver_name,
    documentId: row.document_id,
  };
}

async function newestBol(ctx: PortalContext, loadId: string): Promise<{ id: string; fingerprint: string } | null> {
  const row = await ctx.db
    .prepare(
      `SELECT id, storage_key FROM customer_documents
       WHERE load_id = ? AND kind = 'bol'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(loadId);
  if (!row) return null;
  try {
    const bytes = await readStoredBytes(String(row.storage_key));
    return { id: String(row.id), fingerprint: fingerprint(String(row.id), bytes) };
  } catch {
    return null;
  }
}

export async function bolPrintState(
  ctx: PortalContext,
  loadId: string,
  current: CarrierIdentity,
  options: { history?: boolean } = {},
): Promise<{ summary: BolPrintSummary | null; history: BolPrintRecord[] }> {
  const rows = (await ctx.db
    .prepare(
      `SELECT version, printed_at, printed_by_name, carrier_name, carrier_mc, driver_name, document_id, bol_fingerprint
       FROM bol_prints WHERE load_id = ? ORDER BY version DESC`,
    )
    .all(loadId)) as unknown as PrintRow[];
  if (!rows.length) return { summary: null, history: [] };
  const last = rows[0];
  const newest = await newestBol(ctx, loadId);
  const reasons: Array<"carrier_changed" | "bol_updated"> = [];
  if (!sameIdentity(last, current)) reasons.push("carrier_changed");
  const bolRemoved = !newest;
  if (!newest || newest.id !== last.document_id || newest.fingerprint !== last.bol_fingerprint) {
    reasons.push("bol_updated");
  }
  const summary: BolPrintSummary = {
    ...toRecord(last),
    reprint: reasons.length > 0,
    reasons,
    bolRemoved,
  };
  return { summary, history: options.history ? rows.map(toRecord) : [] };
}

export async function recordBolPrint(
  ctx: PortalContext,
  input: {
    loadId: string;
    documentId: string;
    printedById: string;
    printedByName: string;
    carrier: CarrierIdentity;
  },
): Promise<{ version: number; reprint: boolean; reasons: Array<"carrier_changed" | "bol_updated">; documentUrl: string }> {
  const doc = await ctx.db
    .prepare(`SELECT id, load_id, kind, storage_key FROM customer_documents WHERE id = ?`)
    .get(input.documentId);
  if (!doc || String(doc.load_id) !== input.loadId || doc.kind !== "bol") {
    throw new PortalError("That BOL is not on this load.", 404);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readStoredBytes(String(doc.storage_key));
  } catch {
    throw new PortalError("That BOL file is no longer available.", 404);
  }
  const printFingerprint = fingerprint(input.documentId, bytes);
  const before = await bolPrintState(ctx, input.loadId, input.carrier);
  let version = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      version = await withTransaction(ctx.db, async () => {
        const row = await ctx.db.prepare(`SELECT MAX(version) AS v FROM bol_prints WHERE load_id = ?`).get(input.loadId);
        const next = Number(row?.v ?? 0) + 1;
        await ctx.db
          .prepare(
            `INSERT INTO bol_prints (
               id, load_id, document_id, version, printed_at, printed_by_id, printed_by_name,
               carrier_name, carrier_mc, driver_name, bol_fingerprint
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            input.loadId,
            input.documentId,
            next,
            ctx.now().toISOString(),
            input.printedById,
            input.printedByName.trim() || "Unknown",
            input.carrier.carrierName,
            input.carrier.carrierMc,
            input.carrier.driverName,
            printFingerprint,
          );
        return next;
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < 7 && /UNIQUE|transaction within a transaction|Nested transactions|database is locked|SQLITE_BUSY/i.test(message)) {
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  if (!version) throw new PortalError("The print could not be recorded.", 500);
  return {
    version,
    reprint: before.summary?.reprint === true,
    reasons: before.summary?.reasons ?? [],
    documentUrl: `/api/documents/${input.documentId}`,
  };
}
