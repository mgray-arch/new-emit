import { randomUUID } from "node:crypto";
import type { PortalContext } from "@/lib/db";
import { withTransaction } from "@/lib/db";
import { PortalError } from "@/lib/http";
import { likeContains } from "@/lib/orders";
import { chatEnabledFor } from "@/lib/users";
import {
  messagePreview,
  messageThreadUrl,
  notifySelectOfEmitMessage,
  type MessageNotice,
} from "@/lib/message-notify";
import type { LoadOption, MessageLoadRef, MessageMention, MessageView } from "@/lib/message-types";
import { sensitiveReason } from "@/lib/sensitive";
import type { Session } from "@/lib/types";

/** Columns copied onto a message. Prices and carrier fields are not in this list. */
export const MESSAGE_COLUMNS = `
  id, seq, body, author_id, author_name, author_email, author_side,
  load_id, load_number, sales_order_number, created_at
`;

/** Load fields a message may show. City and state are read out of the place JSON and the rest is dropped. */
export const LOAD_REF_COLUMNS = `id, sales_order_number, load_number, origin_json, destination_json`;

const FIELD_LEAK =
  /carrier[_-]pay|carrier[_-]rates?|carrier[_-]costs?|rate[_-]conf|staff[_-]notes|line[_-]haul|quick[_-]pay/i;

const TOKEN_RE = /[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*/g;
const PAGE_LIMIT = 100;

interface MessageRow {
  id: string;
  seq: number;
  body: string;
  author_id: string;
  author_name: string;
  author_email: string;
  author_side: string;
  load_id: string | null;
  load_number: string | null;
  sales_order_number: string | null;
  created_at: string;
}

interface LoadRow {
  id: string;
  sales_order_number: string;
  load_number: string | null;
  origin_json: string;
  destination_json: string;
}

export type MessageAccess = "read" | "write" | "none";

/** EMIT portal users and Select staff. View-as can read and cannot post. */
export function messageAccess(session: Session): MessageAccess {
  const role = session.role;
  const member = role === "admin" || role === "customer" || role === "emit_viewer" || role === "emit_admin";
  if (!member) return "none";
  if (session.viewAs) return "read";
  return "write";
}

export function messageBlockedReason(body: string): string | null {
  if (FIELD_LEAK.test(body)) return "Message includes a carrier-pay field.";
  return sensitiveReason(body);
}

export function cleanMessageBody(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

async function assertCanRead(ctx: PortalContext, session: Session): Promise<void> {
  if (messageAccess(session) === "none") throw new PortalError("Forbidden", 403);
  if (!(await chatEnabledFor(ctx, session))) throw new PortalError("Chat is turned off for this account.", 403);
}

async function assertCanWrite(ctx: PortalContext, session: Session): Promise<void> {
  await assertCanRead(ctx, session);
  if (messageAccess(session) !== "write") {
    throw new PortalError("View-as is read-only. Switch back to Select view to change anything.", 403);
  }
}

function placePart(json: string, key: "city" | "state"): string {
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    return typeof value[key] === "string" ? value[key] : "";
  } catch {
    return "";
  }
}

function toLoadOption(row: LoadRow): LoadOption {
  return {
    id: row.id,
    loadNumber: row.load_number?.trim() || null,
    salesOrderNumber: row.sales_order_number,
    originCity: placePart(row.origin_json, "city"),
    originState: placePart(row.origin_json, "state"),
    destinationCity: placePart(row.destination_json, "city"),
    destinationState: placePart(row.destination_json, "state"),
  };
}

function toLoadRef(load: LoadOption): MessageLoadRef {
  return {
    id: load.id,
    loadNumber: load.loadNumber,
    salesOrderNumber: load.salesOrderNumber,
    originCity: load.originCity,
    originState: load.originState,
    destinationCity: load.destinationCity,
    destinationState: load.destinationState,
  };
}

async function loadCatalog(ctx: PortalContext): Promise<LoadOption[]> {
  const rows = (await ctx.db.prepare(`SELECT ${LOAD_REF_COLUMNS} FROM loads`).all()) as unknown as LoadRow[];
  return rows.map(toLoadOption);
}

function mentionIndex(loads: LoadOption[]): Map<string, LoadOption | "ambiguous"> {
  const index = new Map<string, LoadOption | "ambiguous">();
  const add = (token: string | null, load: LoadOption) => {
    const key = token?.trim().toLowerCase() ?? "";
    if (key.length < 3) return;
    const existing = index.get(key);
    if (!existing) index.set(key, load);
    else if (existing !== "ambiguous" && existing.id !== load.id) index.set(key, "ambiguous");
  };
  for (const load of loads) {
    add(load.loadNumber, load);
    add(load.salesOrderNumber, load);
  }
  return index;
}

export function mentionsInBody(body: string, loads: LoadOption[]): Array<MessageMention & { index: number; load: LoadOption }> {
  const index = mentionIndex(loads);
  const found: Array<MessageMention & { index: number; load: LoadOption }> = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(TOKEN_RE)) {
    const token = match[0];
    if (token.length < 3) continue;
    const load = index.get(token.toLowerCase());
    if (!load || load === "ambiguous") continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ token, orderId: load.id, index: match.index ?? 0, load });
  }
  return found;
}

function presentMessage(row: MessageRow, session: Session, loads: LoadOption[]): MessageView {
  const byId = new Map(loads.map((load) => [load.id, load]));
  const mentions = mentionsInBody(row.body, loads).map(({ token, orderId }) => ({ token, orderId }));
  const live = row.load_id ? byId.get(row.load_id) : undefined;
  let load: MessageLoadRef | null = null;
  if (live) load = toLoadRef(live);
  else if (row.load_id || row.load_number || row.sales_order_number) {
    load = {
      id: null,
      loadNumber: row.load_number,
      salesOrderNumber: row.sales_order_number,
      originCity: "",
      originState: "",
      destinationCity: "",
      destinationState: "",
    };
  }
  const side = row.author_side === "select" ? "select" : "emit";
  return {
    id: row.id,
    seq: Number(row.seq),
    body: row.body,
    createdAt: row.created_at,
    authorName: row.author_name,
    authorEmail: row.author_email,
    side,
    mine: row.author_id === session.userId,
    load,
    mentions,
  };
}

export async function listMessages(
  ctx: PortalContext,
  session: Session,
  beforeSeq: number | null,
): Promise<{ messages: MessageView[]; hasMore: boolean }> {
  await assertCanRead(ctx, session);
  const rows = (await ctx.db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE (? IS NULL OR seq < ?)
       ORDER BY seq DESC
       LIMIT ?`,
    )
    .all(beforeSeq, beforeSeq, PAGE_LIMIT + 1)) as unknown as MessageRow[];
  const hasMore = rows.length > PAGE_LIMIT;
  const page = rows.slice(0, PAGE_LIMIT).reverse();
  const loads = await loadCatalog(ctx);
  return { messages: page.map((row) => presentMessage(row, session, loads)), hasMore };
}

export async function unreadCount(ctx: PortalContext, session: Session): Promise<number> {
  await assertCanRead(ctx, session);
  const row = await ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
       WHERE seq > COALESCE((SELECT read_seq FROM message_reads WHERE user_id = ?), 0)
         AND author_id <> ?`,
    )
    .get(session.userId, session.userId);
  return Number(row?.n ?? 0);
}

export async function markMessagesRead(ctx: PortalContext, session: Session): Promise<void> {
  await assertCanWrite(ctx, session);
  await ctx.db
    .prepare(
      `INSERT INTO message_reads (user_id, read_seq)
       VALUES (?, COALESCE((SELECT MAX(seq) FROM messages), 0))
       ON CONFLICT(user_id) DO UPDATE SET read_seq = excluded.read_seq`,
    )
    .run(session.userId);
}

export async function searchMessageLoads(ctx: PortalContext, session: Session, query: string, includeId: string | null): Promise<LoadOption[]> {
  await assertCanRead(ctx, session);
  const q = query.trim();
  const rows = q
    ? ((await ctx.db
        .prepare(
          `SELECT ${LOAD_REF_COLUMNS} FROM loads
           WHERE IFNULL(load_number, '') LIKE ? ESCAPE '\\'
              OR sales_order_number LIKE ? ESCAPE '\\'
              OR origin_json LIKE ? ESCAPE '\\'
              OR destination_json LIKE ? ESCAPE '\\'
           ORDER BY updated_at DESC
           LIMIT 30`,
        )
        .all(likeContains(q), likeContains(q), likeContains(q), likeContains(q))) as unknown as LoadRow[])
    : ((await ctx.db
        .prepare(`SELECT ${LOAD_REF_COLUMNS} FROM loads ORDER BY updated_at DESC LIMIT 30`)
        .all()) as unknown as LoadRow[]);
  const loads = rows.map(toLoadOption);
  if (includeId && !loads.some((load) => load.id === includeId)) {
    const extra = (await ctx.db.prepare(`SELECT ${LOAD_REF_COLUMNS} FROM loads WHERE id = ?`).get(includeId)) as
      | LoadRow
      | undefined;
    if (extra) loads.unshift(toLoadOption(extra));
  }
  return loads;
}

async function requireLoad(ctx: PortalContext, loadId: string): Promise<LoadOption> {
  const row = (await ctx.db.prepare(`SELECT ${LOAD_REF_COLUMNS} FROM loads WHERE id = ?`).get(loadId)) as LoadRow | undefined;
  if (!row) throw new PortalError("That load is not in this portal.", 400);
  return toLoadOption(row);
}

export async function postMessage(
  ctx: PortalContext,
  session: Session,
  input: { body: string; loadId?: string | null },
): Promise<MessageView> {
  await assertCanWrite(ctx, session);
  const body = cleanMessageBody(input.body);
  if (!body) throw new PortalError("Write a message.", 400);
  if (body.length > 2000) throw new PortalError("Keep the message under 2000 characters.", 400);
  if (messageBlockedReason(body)) {
    throw new PortalError("Messages can't include carrier pay, carrier rates, or rate confirmations.", 400);
  }

  const requestedId = input.loadId?.trim() || null;
  const catalog = await loadCatalog(ctx);
  const explicit = requestedId ? await requireLoad(ctx, requestedId) : null;
  const mentions = mentionsInBody(body, catalog);
  const attached = explicit ?? mentions[0]?.load ?? null;

  const id = randomUUID();
  const createdAt = ctx.now().toISOString();
  const side = session.role === "admin" ? "select" : "emit";
  const authorName = session.name.trim().slice(0, 200) || "Portal user";
  const authorEmail = session.email.trim().toLowerCase().slice(0, 200);

  const seq = await withTransaction(ctx.db, async () => {
    const current = await ctx.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS n FROM messages`).get();
    const next = Number(current?.n ?? 0) + 1;
    await ctx.db
      .prepare(
        `INSERT INTO messages (
           id, seq, body, author_id, author_name, author_email, author_side,
           load_id, load_number, sales_order_number, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        next,
        body,
        session.userId,
        authorName,
        authorEmail,
        side,
        attached?.id ?? null,
        attached?.loadNumber ?? null,
        attached?.salesOrderNumber ?? null,
        createdAt,
      );
    return next;
  });

  const message = presentMessage(
    {
      id,
      seq,
      body,
      author_id: session.userId,
      author_name: authorName,
      author_email: authorEmail,
      author_side: side,
      load_id: attached?.id ?? null,
      load_number: attached?.loadNumber ?? null,
      sales_order_number: attached?.salesOrderNumber ?? null,
      created_at: createdAt,
    },
    session,
    catalog,
  );

  if (side === "emit") {
    const notice: MessageNotice = {
      authorName,
      authorEmail,
      loadNumber: message.load?.loadNumber ?? null,
      salesOrderNumber: message.load?.salesOrderNumber ?? null,
      preview: messagePreview(body),
      threadUrl: messageThreadUrl(),
    };
    await notifySelectOfEmitMessage(notice);
  }

  return message;
}
