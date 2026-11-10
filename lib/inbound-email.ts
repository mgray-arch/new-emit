import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { coverLoadFromReleasedBol } from "@/lib/bol-coverage";
import type { PortalContext } from "@/lib/db";
import { withTransaction } from "@/lib/db";
import {
  MAX_UPLOAD_BYTES,
  safeFilename,
  screenUpload,
  sniffUpload,
  storeScreenedUpload,
  type ScreenedUploadPage,
} from "@/lib/documents";
import { PortalError } from "@/lib/http";
import { salesOrderMatchKeys } from "@/lib/load-import";
import { parseLegacySalesOrders } from "@/lib/sales-orders";
import { textFromBolBytes } from "@/lib/sam-bol";
import { parseSelectLoadNumber } from "@/lib/select-load";
import { redactSensitiveText, sensitiveReason } from "@/lib/sensitive";
import { writeStoredBytes } from "@/lib/storage";
import type { InboundEmailLog } from "@/lib/types";

/** Recorded on files this webhook stores. */
export const INBOUND_UPLOADER = "Inbound email";

/** Signed webhook posts accepted from one IP in the window below. Failures count too. */
export const INBOUND_EMAIL_LIMIT = 60;
export const INBOUND_EMAIL_WINDOW_MS = 60 * 1000;

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const DEFAULT_ALLOWED_SENDERS = ["goselect.com"];

export type InboundOutcome =
  | "released"
  | "held"
  | "unmatched"
  | "ambiguous"
  | "rejected_sender"
  | "duplicate"
  | "no_attachment";

export interface InboundLoad {
  id: string;
  loadNumber: string | null;
  salesOrderNumber: string;
}

export type InboundMatch =
  | { status: "matched"; load: InboundLoad }
  | { status: "unmatched" }
  | { status: "ambiguous" };

export interface InboundAttachmentInput {
  filename: string;
  contentType: string;
  disposition?: string | null;
  bytes: Uint8Array;
  /** Set when the provider reported a size and the bytes were not downloaded. */
  declaredSize?: number;
}

export interface InboundEmailInput {
  providerId: string;
  from: string;
  subject: string;
  attachments: InboundAttachmentInput[];
}

export interface InboundEmailResult {
  outcome: InboundOutcome;
  duplicate: boolean;
  loadNumber: string | null;
  salesOrderNumber: string;
  released: number;
  heldForReview: number;
}

interface SignatureHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/** Domains and full addresses that may file a BOL. Unset means goselect.com only. */
export function inboundAllowedSenders(): string[] {
  const raw = process.env.INBOUND_EMAIL_ALLOWED_SENDERS;
  if (raw == null || raw.trim() === "") return [...DEFAULT_ALLOWED_SENDERS];
  const list = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  return list.length > 0 ? list : [...DEFAULT_ALLOWED_SENDERS];
}

/** Mailbox only. Display names are dropped. */
export function senderAddress(from: string): string {
  const trimmed = from.trim();
  const angle = trimmed.match(/<([^<>\s]+@[^<>\s]+)>/);
  const raw = (angle?.[1] ?? trimmed).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return "";
  return raw.slice(0, 200);
}

/** A domain entry allows that domain and its subdomains. A full address allows only that mailbox. */
export function senderAllowed(from: string, allowlist = inboundAllowedSenders()): boolean {
  const address = senderAddress(from);
  if (!address) return false;
  const domain = address.split("@")[1] ?? "";
  return allowlist.some((entry) => {
    const item = entry.trim().toLowerCase();
    if (!item || item.includes("/") || item.includes(" ")) return false;
    if (item.includes("@")) return item === address;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(item)) return false;
    return domain === item || domain.endsWith(`.${item}`);
  });
}

/** Subject stored for Select. Carrier-pay language and dollar amounts are not kept. */
export function logSubject(subject: string): string {
  const trimmed = subject.replace(/\$\s?\d[\d,]*(?:\.\d{2})?/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
  if (!trimmed || sensitiveReason(trimmed)) return "Bill of lading email";
  const redacted = redactSensitiveText(trimmed);
  return redacted || "Bill of lading email";
}

function signingKey(secret: string): Buffer | null {
  const trimmed = secret.trim();
  if (trimmed.length < 16) return null;
  const encoded = trimmed.startsWith("whsec_") ? trimmed.slice("whsec_".length) : trimmed;
  if (encoded.length < 16) return null;
  const key = Buffer.from(encoded, "base64");
  if (key.length < 16) return null;
  return key;
}

/**
 * Svix signature used by Resend inbound webhooks.
 * Missing secret, missing headers, a stale timestamp, or a bad signature is false.
 */
export function verifyInboundWebhook(input: {
  payload: string;
  headers: SignatureHeaders;
  secret: string;
  now?: Date;
}): boolean {
  const key = signingKey(input.secret);
  if (!key) return false;
  const id = input.headers.id?.trim() ?? "";
  const timestamp = input.headers.timestamp?.trim() ?? "";
  const signature = input.headers.signature?.trim() ?? "";
  if (!id || !timestamp || !signature) return false;
  if (id.length > 200 || timestamp.length > 20 || signature.length > 2000) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (!Number.isFinite(seconds) || Math.abs(now - seconds) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${input.payload}`).digest();
  for (const part of signature.split(" ")) {
    const comma = part.indexOf(",");
    if (comma <= 0) continue;
    const version = part.slice(0, comma);
    const value = part.slice(comma + 1);
    if (version !== "v1" || !value) continue;
    const given = Buffer.from(value, "base64");
    if (given.length !== expected.length) {
      timingSafeEqual(expected, expected);
      continue;
    }
    if (timingSafeEqual(given, expected)) return true;
  }
  return false;
}

function isYearMonth(year: string, month: string): boolean {
  if (year.length !== 4) return false;
  const y = Number(year);
  const m = Number(month);
  return y >= 1990 && y <= 2100 && m >= 1 && m <= 12;
}

/** Select load numbers such as 467862-1. Labeled mode ignores bare numbers. Dates are not load numbers. */
export function loadNumbersIn(text: string, mode: "any" | "labeled" = "any"): string[] {
  const source = text.replace(/\u00a0/g, " ");
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (order: string, sequence: string) => {
    const value = parseSelectLoadNumber(`${order}-${sequence}`);
    if (!value || seen.has(value)) return;
    seen.add(value);
    found.push(value);
  };
  const labeled = /(?:load|bol)\s*#\s*:?\s*(\d{4,10})\s*-\s*(\d{1,3})(?!\d)/gi;
  for (const match of source.matchAll(labeled)) push(match[1] ?? "", match[2] ?? "");
  if (mode === "labeled") return found;
  const bare = /(\d{4,10})-(\d{1,3})(?!\d)/g;
  for (const match of source.matchAll(bare)) {
    const end = (match.index ?? 0) + match[0].length;
    if (source[end] === "-") continue;
    if (isYearMonth(match[1] ?? "", match[2] ?? "")) continue;
    push(match[1] ?? "", match[2] ?? "");
  }
  return found;
}

/** SO-2582 and the S0-2583 typo. The token is normalized to an SO- prefix. */
export function salesOrderTokens(text: string): string[] {
  const source = text.toUpperCase().replace(/\u00a0/g, " ");
  const found: string[] = [];
  const seen = new Set<string>();
  const pattern = /\bS[O0](?:\s*[-#:]\s*|\s+)?([0-9][0-9A-Z._/#-]*)/gi;
  for (const match of source.matchAll(pattern)) {
    const body = (match[1] ?? "").replace(/[.,;:]+$/g, "");
    if (body.length < 3 || body.length > 40) continue;
    if (!/^[0-9][0-9A-Z._/#-]*$/.test(body)) continue;
    const token = `SO-${body}`;
    if (seen.has(token)) continue;
    seen.add(token);
    found.push(token);
  }
  return found;
}

function soKeys(token: string): string[] {
  const folded = token.trim().toUpperCase().replace(/\s+/g, "").replace(/^S0/, "SO");
  if (!folded) return [];
  const keys = new Set<string>();
  for (const key of salesOrderMatchKeys(folded)) keys.add(key);
  const unhyphen = folded.replace(/^SO-/, "SO");
  for (const key of salesOrderMatchKeys(unhyphen)) keys.add(key);
  if (unhyphen.length >= 3) keys.add(unhyphen);
  return [...keys].filter((key) => key.length >= 3 && key.length <= 80);
}

export function salesOrdersEquivalent(left: string, right: string): boolean {
  const keys = new Set(soKeys(left));
  if (keys.size === 0) return false;
  return soKeys(right).some((key) => keys.has(key));
}

function asLoad(row: Record<string, unknown>): InboundLoad {
  const loadNumber = row.load_number == null || String(row.load_number).trim() === "" ? null : String(row.load_number);
  return {
    id: String(row.id),
    loadNumber,
    salesOrderNumber: String(row.sales_order_number ?? ""),
  };
}

async function decideNumbers(ctx: PortalContext, numbers: string[]): Promise<InboundMatch | "none"> {
  if (numbers.length === 0) return "none";
  const placeholders = numbers.map(() => "?").join(", ");
  const rows = (
    await ctx.db
      .prepare(`SELECT id, load_number, sales_order_number FROM loads WHERE load_number IN (${placeholders})`)
      .all(...numbers)
  ).map((row) => asLoad(row));
  const groups = numbers.map((number) => rows.filter((row) => row.loadNumber === number));
  if (groups.every((group) => group.length === 0)) return "none";
  if (groups.some((group) => group.length !== 1)) return { status: "ambiguous" };
  const ids = new Set(groups.map((group) => group[0]?.id));
  if (ids.size !== 1 || !groups[0]?.[0]) return { status: "ambiguous" };
  return { status: "matched", load: groups[0][0] };
}

function storedSalesOrderValues(row: Record<string, unknown>): string[] {
  const values = parseLegacySalesOrders(row.sales_order_number == null ? "" : String(row.sales_order_number));
  const raw = row.sales_order_number == null ? "" : String(row.sales_order_number).trim();
  if (raw) values.push(raw);
  if (row.sales_orders_json) {
    try {
      const parsed = JSON.parse(String(row.sales_orders_json));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object" && typeof (item as { number?: unknown }).number === "string") {
            values.push((item as { number: string }).number);
          }
        }
      }
    } catch {
      /* A bad JSON column does not match. */
    }
  }
  return values;
}

async function matchSalesOrders(ctx: PortalContext, tokens: string[]): Promise<InboundMatch> {
  if (tokens.length === 0) return { status: "unmatched" };
  const needles = [...new Set(tokens.flatMap((token) => soKeys(token)))].slice(0, 40);
  if (needles.length === 0) return { status: "unmatched" };
  const clause = needles
    .map(
      () =>
        `(UPPER(IFNULL(sales_order_number, '')) LIKE ? ESCAPE '\\' OR UPPER(IFNULL(sales_orders_json, '')) LIKE ? ESCAPE '\\')`,
    )
    .join(" OR ");
  const args = needles.flatMap((needle) => {
    const pattern = `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    return [pattern, pattern];
  });
  const rows = await ctx.db
    .prepare(`SELECT id, load_number, sales_order_number, sales_orders_json FROM loads WHERE ${clause}`)
    .all(...args);
  const matchedByToken = tokens.map(() => new Set<string>());
  const loads = new Map<string, InboundLoad>();
  for (const row of rows) {
    const load = asLoad(row);
    loads.set(load.id, load);
    const stored = storedSalesOrderValues(row);
    tokens.forEach((token, index) => {
      if (stored.some((value) => salesOrdersEquivalent(token, value))) matchedByToken[index]?.add(load.id);
    });
  }
  const ids = new Set<string>();
  for (const set of matchedByToken) for (const id of set) ids.add(id);
  if (ids.size === 0) return { status: "unmatched" };
  if (ids.size > 1) return { status: "ambiguous" };
  const id = [...ids][0];
  if (!id || matchedByToken.some((set) => !set.has(id))) return { status: "ambiguous" };
  const load = loads.get(id);
  if (!load) return { status: "unmatched" };
  return { status: "matched", load };
}

/**
 * Subject and filename load numbers win. A miss falls through to a labeled number in the
 * text, then to sales orders. Several orders is ambiguous, not a guess.
 */
export async function matchInboundOrder(
  ctx: PortalContext,
  input: { subject: string; filename: string; text: string },
): Promise<InboundMatch> {
  const named = [...new Set([...loadNumbersIn(input.subject, "any"), ...loadNumbersIn(input.filename, "any")])];
  const namedDecision = await decideNumbers(ctx, named);
  if (namedDecision !== "none") return namedDecision;
  if (named.length === 0) {
    const labeled = loadNumbersIn(input.text, "labeled");
    const labeledDecision = await decideNumbers(ctx, labeled);
    if (labeledDecision !== "none") return labeledDecision;
  }
  const tokens = [
    ...new Set([...salesOrderTokens(input.subject), ...salesOrderTokens(input.filename), ...salesOrderTokens(input.text)]),
  ];
  return matchSalesOrders(ctx, tokens);
}

/** A SAM bill of lading names itself and its BOL number, and does not read as carrier pay. */
export function recognizableBolText(text: string): boolean {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length < 20) return false;
  if (sensitiveReason(text)) return false;
  if (!/bill\s+of\s+lading/i.test(text)) return false;
  return /(?:bol|load)\s*#\s*:?\s*\d{4,10}\s*-\s*\d{1,3}(?!\d)/i.test(text);
}

/** Rate-con language blocks the file even when a page read failed closed as uncertain. */
function blockPay(pages: ScreenedUploadPage[], text: string): ScreenedUploadPage[] {
  const reason = sensitiveReason(text);
  if (!reason) return pages;
  return pages.map((page) => (page.decision === "block" ? page : { ...page, decision: "block", reason }));
}

function canRelease(pages: ScreenedUploadPage[], text: string): boolean {
  return recognizableBolText(text) && pages.length > 0 && pages.every((page) => page.decision === "pass");
}

function holdPassReason(pages: ScreenedUploadPage[], text: string, match: InboundMatch): string {
  const pay = sensitiveReason(text);
  if (pay) return pay;
  const blocked = pages.find((page) => page.decision === "block");
  if (blocked) return blocked.reason;
  if (match.status === "ambiguous") return "More than one order matched this email, so it was not released.";
  if (match.status === "unmatched") return "No single order matched this email, so it was not released.";
  if (!recognizableBolText(text)) return "Not a recognizable bill of lading, so it stays with Select.";
  return "A page was not clear enough to show EMIT, so the file stays with Select.";
}

function mediaTypeFor(kind: "pdf" | "png" | "jpeg"): string {
  if (kind === "pdf") return "application/pdf";
  if (kind === "png") return "image/png";
  return "image/jpeg";
}

function isInlineLogo(file: InboundAttachmentInput): boolean {
  if ((file.disposition ?? "").toLowerCase() !== "inline") return false;
  if (/bol|lading/i.test(file.filename)) return false;
  return file.contentType.toLowerCase().startsWith("image/");
}

async function uploadExists(ctx: PortalContext, loadId: string, sha256: string): Promise<boolean> {
  const row = await ctx.db.prepare(`SELECT id FROM document_uploads WHERE load_id = ? AND sha256 = ?`).get(loadId, sha256);
  return Boolean(row);
}

async function inboundFileExists(ctx: PortalContext, sha256: string): Promise<boolean> {
  const row = await ctx.db.prepare(`SELECT id FROM inbound_email_files WHERE sha256 = ? LIMIT 1`).get(sha256);
  return Boolean(row);
}

async function recordUpload(
  ctx: PortalContext,
  loadId: string,
  sha256: string,
  filename: string,
  docType: "bol" | "review",
  released: number,
  held: number,
): Promise<void> {
  try {
    await ctx.db
      .prepare(
        `INSERT INTO document_uploads (
           id, load_id, sha256, filename, doc_type, uploaded_by, released_count, held_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), loadId, sha256, filename, docType, INBOUND_UPLOADER, released, held, ctx.now().toISOString());
  } catch (error) {
    if (!String(error).includes("UNIQUE")) throw error;
  }
}

type Inspection =
  | { kind: "skip"; note: string }
  | { kind: "duplicate"; filename: string; match: InboundMatch }
  | {
      kind: "file";
      filename: string;
      sha256: string;
      match: InboundMatch;
      pages: ScreenedUploadPage[];
      text: string;
    };

async function inspectAttachment(ctx: PortalContext, subject: string, file: InboundAttachmentInput): Promise<Inspection> {
  if (isInlineLogo(file)) return { kind: "skip", note: "Ignored an inline image." };
  if ((file.declaredSize ?? 0) > MAX_UPLOAD_BYTES || file.bytes.byteLength > MAX_UPLOAD_BYTES) {
    return { kind: "skip", note: "Skipped an attachment over 8 MB." };
  }
  if (file.bytes.byteLength === 0) return { kind: "skip", note: "Skipped an empty attachment." };
  // PDF libraries can detach the buffer they are given. Keep the caller's copy intact.
  const bytes = new Uint8Array(file.bytes);
  const sniffed = sniffUpload(bytes, file.filename);
  if (sniffed !== "pdf" && sniffed !== "png" && sniffed !== "jpeg") {
    return { kind: "skip", note: "Skipped a file that was not a PDF or image." };
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const layer = await textFromBolBytes(mediaTypeFor(sniffed), bytes);
  let match = await matchInboundOrder(ctx, { subject, filename: file.filename, text: layer });
  if (match.status === "matched") {
    if (await uploadExists(ctx, match.load.id, sha256)) return { kind: "duplicate", filename: file.filename, match };
  } else if (await inboundFileExists(ctx, sha256)) {
    return { kind: "duplicate", filename: file.filename, match };
  }
  let pages: ScreenedUploadPage[];
  try {
    pages = await screenUpload(file.filename, bytes);
  } catch (error) {
    if (error instanceof PortalError) return { kind: "skip", note: "Skipped an attachment that could not be read." };
    throw error;
  }
  const text = [layer, ...pages.map((page) => page.text ?? "")].filter(Boolean).join("\n");
  pages = blockPay(pages, text);
  if (match.status === "unmatched") {
    const again = await matchInboundOrder(ctx, { subject, filename: file.filename, text });
    if (again.status !== "unmatched") match = again;
  }
  if (match.status === "matched" && (await uploadExists(ctx, match.load.id, sha256))) {
    return { kind: "duplicate", filename: file.filename, match };
  }
  return { kind: "file", filename: safeFilename(file.filename), sha256, match, pages, text };
}

interface QueuedPage {
  id: string;
  sha256: string;
  filename: string;
  mediaType: string;
  storageKey: string;
  decision: "block" | "uncertain";
  reason: string;
  pageIndex: number;
  pageCount: number;
}

async function queueUnmatched(file: Extract<Inspection, { kind: "file" }>, reasonForPass: string): Promise<QueuedPage[]> {
  const filename = safeFilename(file.filename);
  const rows: QueuedPage[] = [];
  for (const [index, page] of file.pages.entries()) {
    const decision = page.decision === "block" ? "block" : "uncertain";
    const reason = page.decision === "block" ? page.reason : reasonForPass;
    const id = randomUUID();
    const storageKey = await writeStoredBytes(`inbound-email/${id}`, page.bytes, page.mediaType);
    rows.push({
      id,
      sha256: file.sha256,
      filename,
      mediaType: page.mediaType,
      storageKey,
      decision,
      reason: reason.slice(0, 300),
      pageIndex: index + 1,
      pageCount: file.pages.length,
    });
  }
  return rows;
}

function safeDetail(text: string): string {
  return text.replace(/\$\s?\d[\d,]*(?:\.\d{2})?/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
}

async function insertLog(
  ctx: PortalContext,
  row: {
    id: string;
    providerId: string;
    sender: string;
    subject: string;
    outcome: InboundOutcome;
    load: InboundLoad | null;
    detail: string;
  },
): Promise<boolean> {
  try {
    await ctx.db
      .prepare(
        `INSERT INTO inbound_emails (
           id, provider_id, sender, subject, outcome, load_id, load_number, sales_order_number, detail, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.providerId,
        row.sender,
        row.subject,
        row.outcome,
        row.load?.id ?? null,
        row.load?.loadNumber ?? null,
        row.load?.salesOrderNumber ?? "",
        safeDetail(row.detail),
        ctx.now().toISOString(),
      );
    return true;
  } catch (error) {
    if (!String(error).includes("UNIQUE")) throw error;
    return false;
  }
}

function resultFromLog(row: Record<string, unknown>, duplicate: boolean): InboundEmailResult {
  const outcome = String(row.outcome ?? "held");
  const known: InboundOutcome[] = ["released", "held", "unmatched", "ambiguous", "rejected_sender", "duplicate", "no_attachment"];
  return {
    outcome: (known.includes(outcome as InboundOutcome) ? outcome : "held") as InboundOutcome,
    duplicate,
    loadNumber: row.load_number == null || row.load_number === "" ? null : String(row.load_number),
    salesOrderNumber: String(row.sales_order_number ?? ""),
    released: 0,
    heldForReview: 0,
  };
}

/**
 * File one signed inbound message. Unmatched, ambiguous, rate-con, and unclear
 * files stay on the Select queue. Only a recognizable BOL that passes screening is released.
 */
export async function receiveInboundEmail(ctx: PortalContext, input: InboundEmailInput): Promise<InboundEmailResult> {
  const providerId = input.providerId.trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(providerId)) throw new PortalError("Inbound mail id is not valid.");
  const prior = await ctx.db
    .prepare(`SELECT outcome, load_number, sales_order_number FROM inbound_emails WHERE provider_id = ?`)
    .get(providerId);
  if (prior) return resultFromLog(prior, true);

  const sender = senderAddress(input.from) || "unknown";
  const subject = logSubject(input.subject);
  const emailId = randomUUID();
  if (!senderAllowed(input.from)) {
    const wrote = await insertLog(ctx, {
      id: emailId,
      providerId,
      sender,
      subject,
      outcome: "rejected_sender",
      load: null,
      detail: "Sender is not on the allowlist.",
    });
    if (!wrote) {
      const again = await ctx.db
        .prepare(`SELECT outcome, load_number, sales_order_number FROM inbound_emails WHERE provider_id = ?`)
        .get(providerId);
      if (again) return resultFromLog(again, true);
    }
    return { outcome: "rejected_sender", duplicate: false, loadNumber: null, salesOrderNumber: "", released: 0, heldForReview: 0 };
  }

  const notes: string[] = [];
  const inspections: Inspection[] = [];
  for (const file of input.attachments) {
    const inspection = await inspectAttachment(ctx, input.subject, file);
    if (inspection.kind === "skip") notes.push(inspection.note);
    inspections.push(inspection);
  }
  const files = inspections.filter((item): item is Exclude<Inspection, { kind: "skip" }> => item.kind !== "skip");
  const matchedIds = new Set(
    files.flatMap((item) => (item.match.status === "matched" ? [item.match.load.id] : [])),
  );
  const forceHold = matchedIds.size > 1 || files.some((item) => item.match.status === "ambiguous");

  let released = 0;
  let held = 0;
  let duplicates = 0;
  let filed = 0;
  const queued: QueuedPage[] = [];
  const loads = new Map<string, InboundLoad>();
  for (const item of files) {
    if (item.kind === "duplicate") {
      duplicates += 1;
      if (item.match.status === "matched") loads.set(item.match.load.id, item.match.load);
      continue;
    }
    if (item.match.status === "matched") loads.set(item.match.load.id, item.match.load);
    const holdAll = forceHold || item.match.status !== "matched" || !canRelease(item.pages, item.text);
    if (!holdAll && item.match.status === "matched") {
      const stored = await storeScreenedUpload(ctx, {
        loadId: item.match.load.id,
        filename: item.filename,
        slot: "bol",
        uploadedBy: INBOUND_UPLOADER,
        pages: item.pages,
      });
      await recordUpload(ctx, item.match.load.id, item.sha256, item.filename, "bol", stored.releasedIds.length, stored.heldIds.length);
      if (stored.releasedIds.length > 0) {
        await coverLoadFromReleasedBol(ctx, item.match.load.id, stored.releasedTexts.join("\n"));
      }
      released += stored.releasedIds.length;
      held += stored.heldIds.length;
      filed += stored.releasedIds.length > 0 ? 1 : 0;
      continue;
    }
    if (item.match.status === "matched" && !forceHold) {
      const reason = holdPassReason(item.pages, item.text, item.match);
      const stored = await storeScreenedUpload(ctx, {
        loadId: item.match.load.id,
        filename: item.filename,
        slot: "attachment",
        uploadedBy: INBOUND_UPLOADER,
        pages: item.pages,
        holdPasses: true,
        holdPassReason: reason,
      });
      await recordUpload(ctx, item.match.load.id, item.sha256, item.filename, "review", stored.releasedIds.length, stored.heldIds.length);
      released += stored.releasedIds.length;
      held += stored.heldIds.length;
      continue;
    }
    const reason = holdPassReason(item.pages, item.text, forceHold ? { status: "ambiguous" } : item.match);
    const pages = await queueUnmatched(item, reason);
    queued.push(...pages);
    held += pages.length;
  }

  const onlyLoad = loads.size === 1 ? [...loads.values()][0] ?? null : null;
  let outcome: InboundOutcome = "no_attachment";
  let detail = notes[0] ?? "No PDF or image attachment.";
  if (files.length === 0) {
    outcome = "no_attachment";
  } else if (duplicates === files.length && released === 0 && held === 0) {
    outcome = "duplicate";
    detail = "Already filed.";
  } else if (forceHold) {
    outcome = "ambiguous";
    detail = "More than one order matched, so nothing was released.";
  } else if (released > 0 && held === 0) {
    outcome = "released";
    detail = "Filed as a bill of lading.";
  } else if (released > 0) {
    outcome = "held";
    detail = "Filed a bill of lading. Another file was held for review.";
  } else if (files.every((item) => item.match.status === "unmatched")) {
    outcome = "unmatched";
    const hinted = [...new Set([...loadNumbersIn(input.subject, "any"), ...files.flatMap((item) => loadNumbersIn(item.filename, "any"))])];
    detail = hinted.length === 1 ? `No order matched load ${hinted[0]}.` : "No order matched.";
  } else {
    outcome = "held";
    detail = "Held for Select review.";
  }
  if (filed === 0 && outcome === "released") outcome = "held";

  const createdAt = ctx.now().toISOString();
  let wrote = false;
  try {
    await withTransaction(ctx.db, async () => {
      wrote = await insertLog(ctx, {
        id: emailId,
        providerId,
        sender,
        subject,
        outcome,
        load: forceHold ? null : onlyLoad,
        detail,
      });
      if (!wrote) return;
      for (const page of queued) {
        await ctx.db
          .prepare(
            `INSERT INTO inbound_email_files (
               id, inbound_email_id, sha256, filename, media_type, storage_key, screen_result, screen_reason,
               review_status, page_index, page_count, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          )
          .run(
            page.id,
            emailId,
            page.sha256,
            page.filename,
            page.mediaType,
            page.storageKey,
            page.decision,
            page.reason,
            page.pageIndex,
            page.pageCount,
            createdAt,
          );
      }
    });
  } catch (error) {
    if (!String(error).includes("UNIQUE")) throw error;
    wrote = false;
  }
  if (!wrote) {
    const again = await ctx.db
      .prepare(`SELECT outcome, load_number, sales_order_number FROM inbound_emails WHERE provider_id = ?`)
      .get(providerId);
    if (again) return { ...resultFromLog(again, true), released, heldForReview: held };
    wrote = await insertLog(ctx, {
      id: emailId,
      providerId,
      sender,
      subject,
      outcome,
      load: forceHold ? null : onlyLoad,
      detail,
    });
  }
  return {
    outcome,
    duplicate: outcome === "duplicate",
    loadNumber: forceHold ? null : onlyLoad?.loadNumber ?? null,
    salesOrderNumber: forceHold ? "" : onlyLoad?.salesOrderNumber ?? "",
    released,
    heldForReview: held,
  };
}

export async function listInboundEmails(ctx: PortalContext): Promise<InboundEmailLog[]> {
  const rows = await ctx.db
    .prepare(
      `SELECT id, sender, subject, outcome, load_number, sales_order_number, detail, created_at
       FROM inbound_emails
       ORDER BY created_at DESC
       LIMIT 100`,
    )
    .all();
  return rows.map((row) => ({
    id: String(row.id),
    sender: String(row.sender ?? ""),
    subject: String(row.subject ?? ""),
    outcome: String(row.outcome ?? ""),
    loadNumber: row.load_number == null || row.load_number === "" ? null : String(row.load_number),
    salesOrderNumber: String(row.sales_order_number ?? ""),
    detail: String(row.detail ?? ""),
    createdAt: String(row.created_at ?? ""),
  }));
}

export async function consumeInboundEmail(
  ctx: PortalContext,
  ip: string,
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const bucket = `inbound-email:${ip.slice(0, 80) || "unknown"}`;
  const start = new Date(ctx.now().getTime() - INBOUND_EMAIL_WINDOW_MS).toISOString();
  const row = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE bucket = ? AND created_at >= ?`).get(bucket, start);
  if (Number(row?.n ?? 0) >= INBOUND_EMAIL_LIMIT) {
    return { allowed: false, retryAfterSeconds: Math.ceil(INBOUND_EMAIL_WINDOW_MS / 1000) };
  }
  await ctx.db.prepare(`INSERT INTO login_attempts (id, bucket, created_at) VALUES (?, ?, ?)`).run(randomUUID(), bucket, ctx.now().toISOString());
  await ctx.db.prepare(`DELETE FROM login_attempts WHERE bucket = ? AND created_at < ?`).run(bucket, start);
  return { allowed: true };
}
