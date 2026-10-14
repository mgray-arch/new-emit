import { createHash, randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import type { PortalContext } from "@/lib/db";
import { safeFilename } from "@/lib/documents";
import { PortalError } from "@/lib/http";
import { sensitiveReason } from "@/lib/sensitive";
import { readStoredBytes, writeStoredBytes } from "@/lib/storage";

const MAX_BYTES = 12 * 1024 * 1024;

export type ImageKind = "jpeg" | "png" | "webp" | "heic";

const MEDIA: Record<ImageKind, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
};

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "heif", "mif1"]);

export function sniffImage(bytes: Uint8Array): ImageKind | "pdf" | "other" {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "pdf";
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(4, 8)).toString("ascii") === "ftyp") {
    const major = Buffer.from(bytes.subarray(8, 12)).toString("ascii").toLowerCase();
    if (HEIC_BRANDS.has(major)) return "heic";
  }
  return "other";
}

function declaredKind(contentType: string | null | undefined): ImageKind | "pdf" | "other" | null {
  if (!contentType) return null;
  const value = contentType.split(";")[0].trim().toLowerCase();
  if (!value) return null;
  if (value === "application/pdf" || value === "application/x-pdf") return "pdf";
  if (value === "image/jpeg" || value === "image/jpg" || value === "image/pjpeg") return "jpeg";
  if (value === "image/png") return "png";
  if (value === "image/webp") return "webp";
  if (value === "image/heic" || value === "image/heif" || value === "image/heic-sequence") return "heic";
  return "other";
}

/** A 1×1 PNG. Optional tEXt is how tests and the demo embed a rate-confirmation phrase. */
export function solidPng(red: number, green: number, blue: number, text?: string): Uint8Array {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.from([0, red, green, blue]);
  const parts = [signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw))];
  if (text) parts.push(pngChunk("tEXt", Buffer.concat([Buffer.from("Comment\0"), Buffer.from(text)])));
  parts.push(pngChunk("IEND", Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(parts));
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function printableStrings(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const runs = raw.match(/[\x20-\x7e]{8,}/g) ?? [];
  return runs.join("\n").slice(0, 20_000);
}

export function photoHoldReason(input: {
  filename: string;
  source: string;
  subject?: string | null;
  bytes: Uint8Array;
}): string | null {
  return sensitiveReason([input.filename, input.source, input.subject ?? "", printableStrings(input.bytes)].join("\n"));
}

export interface CarrierPhoto {
  id: string;
  loadId: string;
  filename: string;
  mediaType: string;
  source: string;
  subject: string | null;
  receivedAt: string;
  createdAt: string;
  held: boolean;
  holdReason: string | null;
}

export interface IngestPhotoInput {
  loadNumber: string;
  filename: string;
  bytes: Uint8Array;
  source: string;
  receivedAt: string;
  subject?: string | null;
  declaredType?: string | null;
}

export interface IngestPhotoResult {
  id: string;
  loadId: string;
  loadNumber: string;
  sha256: string;
  mediaType: string;
  source: string;
  receivedAt: string;
  duplicate: boolean;
  visibleToCustomer: boolean;
  heldReason: string | null;
}

function classify(input: IngestPhotoInput): ImageKind {
  if (input.bytes.byteLength === 0) throw new PortalError("That image is empty");
  if (input.bytes.byteLength > MAX_BYTES) throw new PortalError("Images must be 12 MB or smaller");
  const filename = input.filename.toLowerCase();
  if (filename.endsWith(".pdf") || filename.endsWith(".doc") || filename.endsWith(".docx")) {
    throw new PortalError("PDFs and documents are not accepted on the carrier photo path.", 415);
  }
  const declared = declaredKind(input.declaredType);
  if (declared === "pdf") {
    throw new PortalError("PDFs and documents are not accepted on the carrier photo path.", 415);
  }
  const sniffed = sniffImage(input.bytes);
  if (sniffed === "pdf") {
    throw new PortalError("PDFs and documents are not accepted on the carrier photo path.", 415);
  }
  if (sniffed === "other") {
    throw new PortalError("Only jpg, png, heic, and webp images are accepted.", 415);
  }
  if (declared && declared !== "other" && declared !== sniffed) {
    throw new PortalError("File contents do not match the declared image type.", 415);
  }
  if (declared === "other") {
    throw new PortalError("Only jpg, png, heic, and webp images are accepted.", 415);
  }
  return sniffed;
}

interface PhotoRow {
  id: string;
  load_id: string;
  sha256: string;
  filename: string;
  media_type: string;
  source: string;
  subject: string | null;
  received_at: string;
  created_at: string;
  held: number;
  hold_reason: string | null;
}

function toPhoto(row: PhotoRow): CarrierPhoto {
  return {
    id: row.id,
    loadId: row.load_id,
    filename: row.filename,
    mediaType: row.media_type,
    source: row.source,
    subject: row.subject,
    receivedAt: row.received_at,
    createdAt: row.created_at,
    held: row.held === 1,
    holdReason: row.hold_reason,
  };
}

export async function ingestCarrierPhoto(ctx: PortalContext, input: IngestPhotoInput): Promise<IngestPhotoResult> {
  const loadNumber = input.loadNumber.trim();
  if (!loadNumber) throw new PortalError("SAM load number is required");
  const source = input.source.trim();
  if (!source || source.length > 200) throw new PortalError("Source is required and must be 200 characters or less");
  const received = new Date(input.receivedAt);
  if (Number.isNaN(received.getTime())) throw new PortalError("receivedAt must be an ISO-8601 timestamp");
  const subject = input.subject?.trim() ? input.subject.trim().slice(0, 500) : null;
  const kind = classify(input);
  const filename = safeFilename(input.filename);
  const mediaType = MEDIA[kind];
  const heldReason = photoHoldReason({ filename, source, subject, bytes: input.bytes });
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const load = await ctx.db.prepare(`SELECT id, load_number FROM loads WHERE load_number = ?`).get(loadNumber);
  if (!load) throw new PortalError(`No load with SAM load number ${loadNumber}.`, 404);

  const existing = await ctx.db
    .prepare(
      `SELECT id, sha256, media_type, source, received_at, held, hold_reason
       FROM carrier_photos WHERE load_id = ? AND sha256 = ?`,
    )
    .get(String(load.id), sha256);
  if (existing) {
    return {
      id: String(existing.id),
      loadId: String(load.id),
      loadNumber: String(load.load_number),
      sha256: String(existing.sha256),
      mediaType: String(existing.media_type),
      source: String(existing.source),
      receivedAt: String(existing.received_at),
      duplicate: true,
      visibleToCustomer: existing.held !== 1,
      heldReason: existing.hold_reason == null ? null : String(existing.hold_reason),
    };
  }
  const id = randomUUID();
  const createdAt = ctx.now().toISOString();
  const storageKey = await writeStoredBytes(`carrier-photos/${id}`, input.bytes, mediaType);
  await ctx.db
    .prepare(
      `INSERT INTO carrier_photos (
         id, load_id, sha256, filename, media_type, source, subject, received_at, created_at, held, hold_reason, storage_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      String(load.id),
      sha256,
      filename,
      mediaType,
      source,
      subject,
      received.toISOString(),
      createdAt,
      heldReason ? 1 : 0,
      heldReason,
      storageKey,
    );
  return {
    id,
    loadId: String(load.id),
    loadNumber: String(load.load_number),
    sha256,
    mediaType,
    source,
    receivedAt: received.toISOString(),
    duplicate: false,
    visibleToCustomer: !heldReason,
    heldReason,
  };
}

const LIST_SQL = `
SELECT id, load_id, sha256, filename, media_type, source, subject, received_at, created_at, held, hold_reason
FROM carrier_photos
`;

export async function listCarrierPhotos(ctx: PortalContext, loadId: string, includeHeld: boolean): Promise<CarrierPhoto[]> {
  const where = includeHeld ? "WHERE load_id = ?" : "WHERE load_id = ? AND held = 0";
  const rows = await ctx.db.prepare(`${LIST_SQL} ${where} ORDER BY received_at ASC, created_at ASC`).all(loadId);
  return rows.map((row) => toPhoto(row as unknown as PhotoRow));
}

export async function readCarrierPhoto(ctx: PortalContext, id: string): Promise<(CarrierPhoto & { bytes: Uint8Array }) | null> {
  const row = await ctx.db
    .prepare(
      `SELECT id, load_id, sha256, filename, media_type, source, subject, received_at, created_at, held, hold_reason, storage_key
       FROM carrier_photos WHERE id = ?`,
    )
    .get(id);
  if (!row) return null;
  if (!Object.values(MEDIA).includes(String(row.media_type))) return null;
  const photo = toPhoto(row as unknown as PhotoRow);
  return { ...photo, bytes: await readStoredBytes(String(row.storage_key)) };
}
