import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { PortalContext } from "@/lib/db";
import { ingestDocument, safeFilename } from "@/lib/documents";
import { PortalError } from "@/lib/http";
import { parseSelectLoadNumber } from "@/lib/select-load";

/** Recorded on every file this endpoint stores. */
export const BOT_UPLOADER = "Select bot";

const MIN_KEY_LENGTH = 16;

function tokenMatches(presented: string, expected: string): boolean {
  const actual = Buffer.from(presented);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length) {
    timingSafeEqual(wanted, wanted);
    return false;
  }
  return timingSafeEqual(actual, wanted);
}

/** Bearer key only. A session cookie is not enough, and a short or missing key never matches. */
export function botKeyMatches(req: Request): boolean {
  const expected = process.env.BOT_UPLOAD_KEY ?? "";
  const header = req.headers.get("authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (expected.length < MIN_KEY_LENGTH) {
    const standIn = "x".repeat(MIN_KEY_LENGTH);
    tokenMatches(presented || standIn, standIn);
    return false;
  }
  return tokenMatches(presented, expected);
}

/** Uploads accepted from one IP in the window below. Failures count too. */
export const BOT_UPLOAD_LIMIT = 60;
export const BOT_UPLOAD_WINDOW_MS = 60 * 1000;

const DOC_TYPES = ["bol", "pod", "photo"] as const;
export type BotDocType = (typeof DOC_TYPES)[number];

export function parseBotDocType(value: string): BotDocType {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "bol";
  if ((DOC_TYPES as readonly string[]).includes(trimmed)) return trimmed as BotDocType;
  throw new PortalError("doc_type must be bol, pod, or photo.");
}

export function parseBotLoadNumber(value: string): string {
  const parsed = parseSelectLoadNumber(value);
  if (!parsed) throw new PortalError("Enter a Select load number like 458934-1.");
  return parsed;
}

/** One row is the load. Zero is a 404. More than one is a conflict, not a guess. */
export function assertOneLoad(rows: Array<{ id: string }>, loadNumber: string): { id: string } {
  if (rows.length === 0) throw new PortalError(`No load with Select load number ${loadNumber}.`, 404);
  if (rows.length > 1) {
    throw new PortalError(`Select load number ${loadNumber} matches more than one load.`, 409);
  }
  return rows[0];
}

function slotFor(docType: BotDocType): "attachment" | "bol" {
  return docType === "bol" ? "bol" : "attachment";
}

export async function consumeBotUpload(
  ctx: PortalContext,
  ip: string,
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const bucket = `bot-upload:${ip.slice(0, 80) || "unknown"}`;
  const start = new Date(ctx.now().getTime() - BOT_UPLOAD_WINDOW_MS).toISOString();
  const row = await ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE bucket = ? AND created_at >= ?`)
    .get(bucket, start);
  if (Number(row?.n ?? 0) >= BOT_UPLOAD_LIMIT) {
    return { allowed: false, retryAfterSeconds: Math.ceil(BOT_UPLOAD_WINDOW_MS / 1000) };
  }
  await ctx.db
    .prepare(`INSERT INTO login_attempts (id, bucket, created_at) VALUES (?, ?, ?)`)
    .run(randomUUID(), bucket, ctx.now().toISOString());
  await ctx.db.prepare(`DELETE FROM login_attempts WHERE bucket = ? AND created_at < ?`).run(bucket, start);
  return { allowed: true };
}

export interface BotUploadResult {
  loadNumber: string;
  docType: BotDocType;
  sha256: string;
  uploadedBy: string;
  duplicate: boolean;
  released: number;
  heldForReview: number;
}

interface UploadRow {
  sha256: string;
  doc_type: string;
  uploaded_by: string;
  released_count: number;
  held_count: number;
}

function fromRow(loadNumber: string, row: UploadRow, duplicate: boolean): BotUploadResult {
  const docType = (DOC_TYPES as readonly string[]).includes(row.doc_type) ? (row.doc_type as BotDocType) : "bol";
  return {
    loadNumber,
    docType,
    sha256: String(row.sha256),
    uploadedBy: String(row.uploaded_by),
    duplicate,
    released: Number(row.released_count),
    heldForReview: Number(row.held_count),
  };
}

export async function ingestBotDocument(
  ctx: PortalContext,
  input: { loadNumber: string; filename: string; bytes: Uint8Array; docType: BotDocType },
): Promise<BotUploadResult> {
  const loadNumber = parseBotLoadNumber(input.loadNumber);
  const matches = await ctx.db.prepare(`SELECT id FROM loads WHERE load_number = ?`).all(loadNumber);
  const load = assertOneLoad(
    matches.map((row) => ({ id: String(row.id) })),
    loadNumber,
  );
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const existing = await ctx.db
    .prepare(
      `SELECT sha256, doc_type, uploaded_by, released_count, held_count
       FROM document_uploads WHERE load_id = ? AND sha256 = ?`,
    )
    .get(load.id, sha256);
  if (existing) return fromRow(loadNumber, existing as unknown as UploadRow, true);

  const screened = await ingestDocument(ctx, {
    loadId: load.id,
    filename: input.filename,
    bytes: input.bytes,
    slot: slotFor(input.docType),
    uploadedBy: BOT_UPLOADER,
  });
  const createdAt = ctx.now().toISOString();
  try {
    await ctx.db
      .prepare(
        `INSERT INTO document_uploads (
           id, load_id, sha256, filename, doc_type, uploaded_by, released_count, held_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        load.id,
        sha256,
        safeFilename(input.filename),
        input.docType,
        BOT_UPLOADER,
        screened.releasedIds.length,
        screened.heldIds.length,
        createdAt,
      );
  } catch (error) {
    if (!String(error).includes("UNIQUE")) throw error;
    const winner = await ctx.db
      .prepare(
        `SELECT sha256, doc_type, uploaded_by, released_count, held_count
         FROM document_uploads WHERE load_id = ? AND sha256 = ?`,
      )
      .get(load.id, sha256);
    if (winner) return fromRow(loadNumber, winner as unknown as UploadRow, true);
    throw error;
  }
  return {
    loadNumber,
    docType: input.docType,
    sha256,
    uploadedBy: BOT_UPLOADER,
    duplicate: false,
    released: screened.releasedIds.length,
    heldForReview: screened.heldIds.length,
  };
}
