import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { DatabaseSync } from "node:sqlite";
import type { PortalContext } from "@/lib/db";
import { withTransaction } from "@/lib/db";
import { sensitiveReason } from "@/lib/sensitive";
import type { CustomerDocument, ReviewItem } from "@/lib/types";
import { PortalError } from "@/lib/http";

export type ScreenDecision = "pass" | "block" | "uncertain";

export function screenPageText(text: string | null | undefined): { decision: ScreenDecision; reason: string } {
  if (text == null) {
    return { decision: "uncertain", reason: "No text could be extracted from this page." };
  }
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length < 20) {
    return { decision: "uncertain", reason: "Too little text to confirm this page is safe to show EMIT." };
  }
  const reason = sensitiveReason(trimmed);
  if (reason) return { decision: "block", reason };
  return { decision: "pass", reason: "No rate-confirmation signals found." };
}

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 25;

export function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() || "document";
  const cleaned = base.replace(/[^\w.\- ()]+/g, "_").slice(0, 80);
  return cleaned || "document";
}

function sniff(bytes: Uint8Array, filename: string): "pdf" | "png" | "jpeg" | "text" | "other" {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (filename.toLowerCase().endsWith(".txt") && !bytes.includes(0)) return "text";
  return "other";
}

/** Best-effort text pull for simple uncompressed PDF pages (pdf-lib output). */
export function extractPdfLiteralText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const parts: string[] = [];
  const pattern = /\((?:\\\)|\\.|[^\\)])*\)\s*Tj/g;
  for (const match of raw.match(pattern) ?? []) {
    const inner = match.replace(/\)\s*Tj$/, "").slice(1);
    parts.push(
      inner
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "")
        .replace(/\\\(/g, "(")
        .replace(/\\\)/g, ")")
        .replace(/\\\\/g, "\\"),
    );
  }
  return parts.join("\n");
}

async function splitPdf(bytes: Uint8Array): Promise<Uint8Array[]> {
  const src = await PDFDocument.load(bytes);
  const count = src.getPageCount();
  if (count > MAX_PAGES) {
    throw new PortalError(`PDFs are limited to ${MAX_PAGES} pages`);
  }
  const pages: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const doc = await PDFDocument.create();
    const [page] = await doc.copyPages(src, [index]);
    doc.addPage(page);
    pages.push(await doc.save());
  }
  return pages;
}

async function textForPdf(original: Uint8Array, pageBytes: Uint8Array[]): Promise<Array<string | null>> {
  const literals = pageBytes.map((page) => {
    const text = extractPdfLiteralText(page).trim();
    return text || null;
  });
  try {
    const { extractText } = await import("unpdf");
    const result = await extractText(original, { mergePages: false });
    const texts = Array.isArray(result.text) ? result.text : [];
    return pageBytes.map((_, index) => {
      const fromPdf = texts[index]?.trim() ? texts[index] : "";
      const fromLiteral = literals[index] ?? "";
      const combined = [fromPdf, fromLiteral].filter(Boolean).join("\n").trim();
      return combined || null;
    });
  } catch {
    return literals;
  }
}

function mediaTypeFor(kind: "pdf" | "png" | "jpeg" | "text" | "other"): string {
  switch (kind) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "text":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function refreshPending(db: DatabaseSync, loadId: string): void {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM internal_documents WHERE load_id = ? AND review_status = 'pending'`,
  ).get(loadId) as { n: number } | undefined;
  db.prepare(`UPDATE loads SET pending_review_count = ? WHERE id = ?`).run(row?.n ?? 0, loadId);
}

export interface IngestResult {
  releasedIds: string[];
  heldIds: string[];
}

export async function ingestDocument(
  ctx: PortalContext,
  input: { loadId: string; filename: string; bytes: Uint8Array; slot: "attachment" | "bol" },
): Promise<IngestResult> {
  if (input.bytes.byteLength === 0) throw new PortalError("That file is empty");
  if (input.bytes.byteLength > MAX_BYTES) throw new PortalError("Files must be 8 MB or smaller");
  const filename = safeFilename(input.filename);
  const kind = sniff(input.bytes, filename);
  const slot = input.slot === "bol" ? "bol" : "attachment";
  const createdAt = ctx.now().toISOString();

  type Page = { bytes: Uint8Array; text: string | null; mediaType: string };
  let pages: Page[] = [];
  if (kind === "pdf") {
    const split = await splitPdf(input.bytes);
    const texts = await textForPdf(input.bytes, split);
    pages = split.map((bytes, index) => ({ bytes, text: texts[index] ?? null, mediaType: "application/pdf" }));
  } else if (kind === "text") {
    pages = [{ bytes: input.bytes, text: Buffer.from(input.bytes).toString("utf8"), mediaType: "text/plain" }];
  } else {
    pages = [
      {
        bytes: input.bytes,
        text: null,
        mediaType: mediaTypeFor(kind),
      },
    ];
  }

  const releasedIds: string[] = [];
  const heldIds: string[] = [];
  withTransaction(ctx.db, () => {
    pages.forEach((page, index) => {
      const screened = screenPageText(page.text);
      const id = randomUUID();
      if (screened.decision === "pass") {
        ctx.db
          .prepare(
            `INSERT INTO customer_documents (id, load_id, kind, filename, media_type, bytes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, input.loadId, slot, filename, page.mediaType, page.bytes, createdAt);
        releasedIds.push(id);
        return;
      }
      const storedKind = screened.decision === "block" ? "rate_confirmation" : "uncertain";
      ctx.db
        .prepare(
          `INSERT INTO internal_documents (
             id, load_id, kind, screen_result, screen_reason, review_status, filename, media_type,
             page_index, page_count, text_excerpt, bytes, created_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.loadId,
          storedKind,
          screened.decision,
          screened.reason,
          filename,
          page.mediaType,
          index + 1,
          pages.length,
          page.text ? page.text.slice(0, 600) : null,
          page.bytes,
          createdAt,
        );
      heldIds.push(id);
    });
    refreshPending(ctx.db, input.loadId);
  });
  return { releasedIds, heldIds };
}

export const CUSTOMER_DOCUMENT_READ_SQL = `
SELECT id, load_id, kind, filename, media_type, bytes, created_at
FROM customer_documents
WHERE id = ?
`;

export function listCustomerDocuments(ctx: PortalContext, loadId: string): CustomerDocument[] {
  const rows = ctx.db
    .prepare(
      `SELECT id, kind, filename, media_type, created_at
       FROM customer_documents WHERE load_id = ? ORDER BY created_at ASC`,
    )
    .all(loadId) as Array<{ id: string; kind: string; filename: string; media_type: string; created_at: string }>;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind === "bol" ? "bol" : "attachment",
    filename: row.filename,
    mediaType: row.media_type,
    createdAt: row.created_at,
  }));
}

export function readCustomerDocument(
  ctx: PortalContext,
  id: string,
): { id: string; loadId: string; filename: string; mediaType: string; bytes: Uint8Array } | null {
  const row = ctx.db.prepare(CUSTOMER_DOCUMENT_READ_SQL).get(id) as
    | { id: string; load_id: string; filename: string; media_type: string; bytes: Uint8Array }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    loadId: row.load_id,
    filename: row.filename,
    mediaType: allowedMedia(row.media_type),
    bytes: row.bytes,
  };
}

function allowedMedia(value: string): string {
  if (value === "application/pdf" || value === "image/png" || value === "image/jpeg" || value === "text/plain") {
    return value;
  }
  return "application/octet-stream";
}

export function listReviewQueue(ctx: PortalContext): ReviewItem[] {
  const rows = ctx.db
    .prepare(
      `SELECT d.id, d.load_id, d.kind, d.screen_result, d.screen_reason, d.review_status, d.filename,
              d.media_type, d.page_index, d.page_count, d.text_excerpt, d.created_at,
              l.sales_order_number, l.load_number
       FROM internal_documents d
       LEFT JOIN loads l ON l.id = d.load_id
       WHERE d.review_status = 'pending'
       ORDER BY d.created_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    loadId: String(row.load_id),
    salesOrderNumber: String(row.sales_order_number ?? ""),
    loadNumber: String(row.load_number ?? ""),
    kind: String(row.kind),
    screenResult: row.screen_result === "block" ? "block" : "uncertain",
    screenReason: String(row.screen_reason ?? ""),
    reviewStatus: "pending",
    filename: String(row.filename),
    mediaType: String(row.media_type),
    pageIndex: Number(row.page_index),
    pageCount: Number(row.page_count),
    textExcerpt: row.text_excerpt == null ? null : String(row.text_excerpt),
    createdAt: String(row.created_at),
  }));
}

export function reviewDocument(
  ctx: PortalContext,
  id: string,
  action: "approve" | "reject",
  reviewer: string,
  options?: { confirm?: boolean },
): { reviewedBy: string; reviewedAt: string; reviewStatus: "approved" | "rejected" } {
  const row = ctx.db
    .prepare(
      `SELECT id, load_id, review_status, filename, media_type, bytes, kind, screen_result
       FROM internal_documents WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        load_id: string;
        review_status: string;
        filename: string;
        media_type: string;
        bytes: Uint8Array;
        kind: string;
        screen_result: string;
      }
    | undefined;
  if (!row || row.review_status !== "pending") throw new PortalError("That page is not waiting for review", 404);
  if (action === "approve" && row.screen_result === "block" && !options?.confirm) {
    throw new PortalError(
      "Releasing a page flagged as a rate confirmation requires an explicit confirmation.",
      409,
    );
  }
  const now = ctx.now().toISOString();
  withTransaction(ctx.db, () => {
    if (action === "approve") {
      const customerKind = row.kind === "bol" ? "bol" : "attachment";
      ctx.db
        .prepare(
          `INSERT INTO customer_documents (id, load_id, kind, filename, media_type, bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), row.load_id, customerKind, row.filename, row.media_type, row.bytes, now);
    }
    ctx.db
      .prepare(
        `UPDATE internal_documents
         SET review_status = ?, reviewed_at = ?, reviewed_by = ?
         WHERE id = ?`,
      )
      .run(action === "approve" ? "approved" : "rejected", now, reviewer, id);
    refreshPending(ctx.db, row.load_id);
  });
  return {
    reviewedBy: reviewer,
    reviewedAt: now,
    reviewStatus: action === "approve" ? "approved" : "rejected",
  };
}

export function readInternalDocumentFile(
  ctx: PortalContext,
  id: string,
): { filename: string; mediaType: string; bytes: Uint8Array } | null {
  const row = ctx.db
    .prepare(`SELECT filename, media_type, bytes FROM internal_documents WHERE id = ?`)
    .get(id) as { filename: string; media_type: string; bytes: Uint8Array } | undefined;
  if (!row) return null;
  return { filename: row.filename, mediaType: allowedMedia(row.media_type), bytes: row.bytes };
}
