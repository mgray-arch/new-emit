import { randomUUID } from "node:crypto";
import type { PortalContext } from "@/lib/db";

export interface BolPage {
  id: string;
  filename: string;
  mediaType: string;
  createdAt: string;
}

/** Pages of the newest uploaded BOL. Rate confirmations are not in this list. */
export function latestBolPages(pages: BolPage[]): BolPage[] {
  if (!pages.length) return [];
  const newest = pages[pages.length - 1];
  return pages.filter((page) => page.createdAt === newest.createdAt && page.filename === newest.filename);
}

export async function listBolPages(ctx: PortalContext, loadId: string): Promise<BolPage[]> {
  const rows = await ctx.db
    .prepare(
      `SELECT id, filename, media_type, created_at
       FROM customer_documents
       WHERE load_id = ? AND kind = 'bol'
       ORDER BY created_at, rowid`,
    )
    .all(loadId);
  const pages = rows.map((row) => ({
    id: String(row.id),
    filename: String(row.filename),
    mediaType: String(row.media_type),
    createdAt: String(row.created_at),
  }));
  return latestBolPages(pages);
}

/** One row per time someone opens the uploaded BOL to print. Screen prints are not recorded. */
export async function recordBolPrint(ctx: PortalContext, input: { loadId: string; documentId: string; userId: string }): Promise<void> {
  if (!input.loadId || !input.documentId || !input.userId) return;
  await ctx.db
    .prepare(`INSERT INTO bol_prints (id, load_id, document_id, printed_by, printed_at) VALUES (?, ?, ?, ?, ?)`)
    .run(randomUUID(), input.loadId, input.documentId, input.userId, ctx.now().toISOString());
}

export async function countBolPrints(ctx: PortalContext, loadId: string): Promise<number> {
  const row = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM bol_prints WHERE load_id = ?`).get(loadId);
  return Number(row?.n ?? 0);
}
