import { randomUUID } from "node:crypto";
import type { PortalContext } from "@/lib/db";
import { withTransaction } from "@/lib/db";
import { PortalError } from "@/lib/http";
import { likeContains, OPEN_LOAD_SQL } from "@/lib/orders";
import { chatEnabledFor } from "@/lib/users";
import {
  messageDestinationLabel,
  messagePreview,
  messageThreadUrl,
  notifySelectOfEmitMessage,
  slackBotTarget,
  type MessageNotice,
} from "@/lib/message-notify";
import type {
  LoadOption,
  MessageLoadRef,
  MessageMention,
  MessageView,
  ThreadLatest,
  ThreadLoadRef,
  ThreadSummary,
} from "@/lib/message-types";
import { sensitiveReason } from "@/lib/sensitive";
import type { Session } from "@/lib/types";

/** Columns copied onto a message. Prices and carrier fields are not in this list. */
export const MESSAGE_COLUMNS = `
  id, seq, thread_id, body, author_id, author_name, author_email, author_side,
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
  thread_id: string | null;
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

interface ThreadRow {
  id: string;
  load_id: string | null;
  load_key: string;
  slack_ts: string | null;
  slack_channel: string | null;
  created_at: string;
}

interface LoadLaneRow extends LoadRow {
  owner: string | null;
}

const GENERAL_KEY = "general";

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
  const rows = (await ctx.db.prepare(`SELECT ${LOAD_REF_COLUMNS} FROM loads WHERE ${OPEN_LOAD_SQL}`).all()) as unknown as LoadRow[];
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

/** "My loads" matches the signed-in person's name to loads.owner. "Drew" matches "Drew Martin". */
export function loadOwnerMatchesUser(owner: string | null | undefined, name: string | null | undefined): boolean {
  const raw = owner?.trim() ?? "";
  const person = name?.trim() ?? "";
  if (!raw || !person) return false;
  if (raw.toLowerCase() === person.toLowerCase()) return true;
  const first = person.split(/\s+/)[0]?.toLowerCase() ?? "";
  return first.length >= 3 && first === raw.toLowerCase();
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
    threadId: row.thread_id ?? "",
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

function laneFromLoad(row: LoadLaneRow | undefined, fallback: { loadId: string | null; loadNumber: string | null; salesOrderNumber: string | null }): ThreadLoadRef {
  if (row) {
    const option = toLoadOption(row);
    return {
      ...toLoadRef(option),
      owner: typeof row.owner === "string" && row.owner.trim() ? row.owner.trim() : null,
    };
  }
  return {
    id: fallback.loadId,
    loadNumber: fallback.loadNumber,
    salesOrderNumber: fallback.salesOrderNumber,
    originCity: "",
    originState: "",
    destinationCity: "",
    destinationState: "",
    owner: null,
  };
}

interface BoardRow {
  id: string;
  load_id: string | null;
  load_key: string;
  message_id: string;
  seq: number;
  body: string;
  author_id: string;
  author_name: string;
  author_side: string;
  message_at: string;
  load_number: string | null;
  sales_order_number: string | null;
  message_count: number;
}

export interface ThreadListFilter {
  q?: string;
  unread?: boolean;
  mine?: boolean;
  side?: "emit" | "select" | null;
}

function searchHit(thread: ThreadSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (thread.kind === "general" && "general".includes(q)) return true;
  const load = thread.load;
  const haystack = [
    load?.salesOrderNumber,
    load?.loadNumber,
    load?.originCity,
    load?.originState,
    load?.destinationCity,
    load?.destinationState,
    load?.owner,
    thread.latest.authorName,
    thread.latest.preview,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n")
    .toLowerCase();
  return haystack.includes(q);
}

export async function listThreads(ctx: PortalContext, session: Session, filter: ThreadListFilter = {}): Promise<{ threads: ThreadSummary[] }> {
  await assertCanRead(ctx, session);
  const rows = (await ctx.db
    .prepare(
      `SELECT t.id, t.load_id, t.load_key,
              m.id AS message_id, m.seq, m.body, m.author_id, m.author_name, m.author_side, m.created_at AS message_at,
              m.load_number, m.sales_order_number,
              (SELECT COUNT(*) FROM messages c WHERE c.thread_id = t.id) AS message_count
       FROM message_threads t
       JOIN messages m ON m.thread_id = t.id
       WHERE m.seq = (SELECT MAX(seq) FROM messages WHERE thread_id = t.id)`,
    )
    .all()) as unknown as BoardRow[];
  const loadIds = [...new Set(rows.map((row) => row.load_id).filter((id): id is string => Boolean(id && id.trim())))];
  const lanes = new Map<string, LoadLaneRow>();
  if (loadIds.length) {
    const placeholders = loadIds.map(() => "?").join(", ");
    const laneRows = (await ctx.db
      .prepare(`SELECT ${LOAD_REF_COLUMNS}, owner FROM loads WHERE id IN (${placeholders})`)
      .all(...loadIds)) as unknown as LoadLaneRow[];
    for (const lane of laneRows) lanes.set(lane.id, lane);
  }
  const unreadRows = (await ctx.db
    .prepare(
      `SELECT m.thread_id AS thread_id, COUNT(*) AS n
       FROM messages m
       LEFT JOIN message_thread_reads r ON r.thread_id = m.thread_id AND r.user_id = ?
       WHERE m.author_id <> ?
         AND m.seq > COALESCE(r.read_seq, 0)
       GROUP BY m.thread_id`,
    )
    .all(session.userId, session.userId)) as unknown as Array<{ thread_id: string; n: number }>;
  const unreadByThread = new Map(unreadRows.map((row) => [row.thread_id, Number(row.n)]));

  let threads = rows.map((row): ThreadSummary => {
    const side = row.author_side === "select" ? "select" : "emit";
    const latest: ThreadLatest = {
      id: row.message_id,
      preview: messagePreview(row.body),
      authorName: row.author_name,
      side,
      createdAt: row.message_at,
      mine: row.author_id === session.userId,
    };
    const general = row.load_key === GENERAL_KEY && !row.load_id;
    return {
      id: row.id,
      kind: general ? "general" : "load",
      load: general
        ? null
        : laneFromLoad(row.load_id ? lanes.get(row.load_id) : undefined, {
            loadId: row.load_id,
            loadNumber: row.load_number,
            salesOrderNumber: row.sales_order_number,
          }),
      latest,
      unread: unreadByThread.get(row.id) ?? 0,
      messageCount: Number(row.message_count),
    };
  });

  const query = filter.q?.trim() ?? "";
  if (query) threads = threads.filter((thread) => searchHit(thread, query));
  if (filter.unread) threads = threads.filter((thread) => thread.unread > 0);
  if (filter.mine) threads = threads.filter((thread) => loadOwnerMatchesUser(thread.load?.owner, session.name));
  if (filter.side === "emit" || filter.side === "select") threads = threads.filter((thread) => thread.latest.side === filter.side);
  threads.sort((left, right) => {
    const leftUnread = left.unread > 0 ? 1 : 0;
    const rightUnread = right.unread > 0 ? 1 : 0;
    if (leftUnread !== rightUnread) return rightUnread - leftUnread;
    return right.latest.createdAt.localeCompare(left.latest.createdAt) || right.latest.id.localeCompare(left.latest.id);
  });
  return { threads };
}

export async function getThread(
  ctx: PortalContext,
  session: Session,
  input: { threadId?: string | null; loadId?: string | null; beforeSeq?: number | null },
): Promise<{ thread: ThreadSummary | null; messages: MessageView[]; hasMore: boolean; load: ThreadLoadRef | null }> {
  await assertCanRead(ctx, session);
  const threadId = input.threadId?.trim() || null;
  const loadId = input.loadId?.trim() || null;
  let thread: ThreadRow | undefined;
  if (threadId) {
    thread = (await ctx.db
      .prepare(`SELECT id, load_id, load_key, slack_ts, slack_channel, created_at FROM message_threads WHERE id = ?`)
      .get(threadId)) as ThreadRow | undefined;
    if (!thread) throw new PortalError("That thread is not in this portal.", 404);
  } else if (loadId) {
    thread = (await ctx.db
      .prepare(`SELECT id, load_id, load_key, slack_ts, slack_channel, created_at FROM message_threads WHERE load_key = ?`)
      .get(loadId)) as ThreadRow | undefined;
  } else {
    throw new PortalError("Choose a thread.", 400);
  }

  let requestedLoad: ThreadLoadRef | null = null;
  if (loadId) {
    const lane = (await ctx.db.prepare(`SELECT ${LOAD_REF_COLUMNS}, owner FROM loads WHERE id = ? AND ${OPEN_LOAD_SQL}`).get(loadId)) as
      | LoadLaneRow
      | undefined;
    if (!lane && !thread) throw new PortalError("That load is not in this portal.", 404);
    if (lane) requestedLoad = laneFromLoad(lane, { loadId, loadNumber: lane.load_number, salesOrderNumber: lane.sales_order_number });
  }

  if (!thread) return { thread: null, messages: [], hasMore: false, load: requestedLoad };

  const beforeSeq = input.beforeSeq ?? null;
  const rows = (await ctx.db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE thread_id = ? AND (? IS NULL OR seq < ?)
       ORDER BY seq DESC
       LIMIT ?`,
    )
    .all(thread.id, beforeSeq, beforeSeq, PAGE_LIMIT + 1)) as unknown as MessageRow[];
  const hasMore = rows.length > PAGE_LIMIT;
  const page = rows.slice(0, PAGE_LIMIT).reverse();
  const loads = await loadCatalog(ctx);
  const board = await listThreads(ctx, session);
  const summary = board.threads.find((item) => item.id === thread.id) ?? null;
  return {
    thread: summary,
    messages: page.map((row) => presentMessage(row, session, loads)),
    hasMore,
    load: summary?.load ?? requestedLoad,
  };
}

export async function unreadCount(ctx: PortalContext, session: Session): Promise<number> {
  await assertCanRead(ctx, session);
  const row = await ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages m
       WHERE m.author_id <> ?
         AND m.seq > COALESCE((
           SELECT read_seq FROM message_thread_reads WHERE user_id = ? AND thread_id = m.thread_id
         ), 0)`,
    )
    .get(session.userId, session.userId);
  return Number(row?.n ?? 0);
}

async function markThreadRead(ctx: PortalContext, userId: string, threadId: string): Promise<void> {
  await ctx.db
    .prepare(
      `INSERT INTO message_thread_reads (user_id, thread_id, read_seq)
       VALUES (?, ?, COALESCE((SELECT MAX(seq) FROM messages WHERE thread_id = ?), 0))
       ON CONFLICT(user_id, thread_id) DO UPDATE SET read_seq = excluded.read_seq`,
    )
    .run(userId, threadId, threadId);
}

/** Mark one thread, or every thread when threadId is omitted. */
export async function markMessagesRead(ctx: PortalContext, session: Session, threadId?: string | null): Promise<void> {
  await assertCanWrite(ctx, session);
  const id = threadId?.trim() || null;
  if (id) {
    const thread = await ctx.db.prepare(`SELECT id FROM message_threads WHERE id = ?`).get(id);
    if (!thread) throw new PortalError("That thread is not in this portal.", 404);
    await markThreadRead(ctx, session.userId, id);
    return;
  }
  const threads = await ctx.db.prepare(`SELECT id FROM message_threads`).all();
  await withTransaction(ctx.db, async () => {
    for (const thread of threads) {
      if (typeof thread.id === "string" && thread.id) await markThreadRead(ctx, session.userId, thread.id);
    }
  });
}

export async function searchMessageLoads(ctx: PortalContext, session: Session, query: string, includeId: string | null): Promise<LoadOption[]> {
  await assertCanRead(ctx, session);
  const q = query.trim();
  const rows = q
    ? ((await ctx.db
        .prepare(
          `SELECT ${LOAD_REF_COLUMNS} FROM loads
           WHERE ${OPEN_LOAD_SQL}
             AND (IFNULL(load_number, '') LIKE ? ESCAPE '\\'
              OR sales_order_number LIKE ? ESCAPE '\\'
              OR origin_json LIKE ? ESCAPE '\\'
              OR destination_json LIKE ? ESCAPE '\\')
           ORDER BY updated_at DESC
           LIMIT 30`,
        )
        .all(likeContains(q), likeContains(q), likeContains(q), likeContains(q))) as unknown as LoadRow[])
    : ((await ctx.db
        .prepare(`SELECT ${LOAD_REF_COLUMNS} FROM loads WHERE ${OPEN_LOAD_SQL} ORDER BY updated_at DESC LIMIT 30`)
        .all()) as unknown as LoadRow[]);
  const loads = rows.map(toLoadOption);
  if (includeId && !loads.some((load) => load.id === includeId)) {
    const extra = (await ctx.db.prepare(`SELECT ${LOAD_REF_COLUMNS} FROM loads WHERE id = ? AND ${OPEN_LOAD_SQL}`).get(includeId)) as
      | LoadRow
      | undefined;
    if (extra) loads.unshift(toLoadOption(extra));
  }
  return loads;
}

/** Owner and destination for the Slack note. A bad row does not block the message. */
async function loadSlackFacts(
  ctx: PortalContext,
  loadId: string | null,
): Promise<{ destination: string; owner: string | null }> {
  if (!loadId) return { destination: "", owner: null };
  try {
    const row = await ctx.db.prepare(`SELECT owner, destination_json, stops_json FROM loads WHERE id = ?`).get(loadId);
    if (!row) return { destination: "", owner: null };
    return {
      destination: messageDestinationLabel(
        typeof row.destination_json === "string" ? row.destination_json : null,
        typeof row.stops_json === "string" ? row.stops_json : null,
      ),
      owner: typeof row.owner === "string" ? row.owner : null,
    };
  } catch {
    return { destination: "", owner: null };
  }
}

async function requireLoad(ctx: PortalContext, loadId: string): Promise<LoadOption> {
  const row = (await ctx.db.prepare(`SELECT ${LOAD_REF_COLUMNS} FROM loads WHERE id = ? AND ${OPEN_LOAD_SQL}`).get(loadId)) as LoadRow | undefined;
  if (!row) throw new PortalError("That load is not in this portal.", 400);
  return toLoadOption(row);
}

async function threadByKey(ctx: PortalContext, loadKey: string): Promise<ThreadRow | undefined> {
  return (await ctx.db
    .prepare(`SELECT id, load_id, load_key, slack_ts, slack_channel, created_at FROM message_threads WHERE load_key = ?`)
    .get(loadKey)) as ThreadRow | undefined;
}

async function ensureThread(ctx: PortalContext, load: LoadOption | null, createdAt: string): Promise<ThreadRow> {
  const loadKey = load?.id ?? GENERAL_KEY;
  const existing = await threadByKey(ctx, loadKey);
  if (existing) return existing;
  const id = randomUUID();
  try {
    await ctx.db
      .prepare(`INSERT INTO message_threads (id, load_id, load_key, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, load?.id ?? null, loadKey, createdAt);
  } catch {
    const again = await threadByKey(ctx, loadKey);
    if (again) return again;
    throw new PortalError("The thread could not be saved.", 500);
  }
  return { id, load_id: load?.id ?? null, load_key: loadKey, slack_ts: null, slack_channel: null, created_at: createdAt };
}

export async function postMessage(
  ctx: PortalContext,
  session: Session,
  input: { body: string; loadId?: string | null; threadId?: string | null },
): Promise<MessageView> {
  await assertCanWrite(ctx, session);
  const body = cleanMessageBody(input.body);
  if (!body) throw new PortalError("Write a message.", 400);
  if (body.length > 2000) throw new PortalError("Keep the message under 2000 characters.", 400);
  if (messageBlockedReason(body)) {
    throw new PortalError("Messages can't include carrier pay, carrier rates, or rate confirmations.", 400);
  }

  const requestedThread = input.threadId?.trim() || null;
  const requestedId = input.loadId?.trim() || null;
  const catalog = await loadCatalog(ctx);
  const mentions = mentionsInBody(body, catalog);

  let attached: LoadOption | null = null;
  let existingThread: ThreadRow | null = null;
  if (requestedThread) {
    const thread = (await ctx.db
      .prepare(`SELECT id, load_id, load_key, slack_ts, slack_channel, created_at FROM message_threads WHERE id = ?`)
      .get(requestedThread)) as ThreadRow | undefined;
    if (!thread) throw new PortalError("That thread is not in this portal.", 404);
    existingThread = thread;
    if (thread.load_id) {
      const live = catalog.find((load) => load.id === thread.load_id) ?? null;
      attached = live ?? (await requireLoad(ctx, thread.load_id).catch(() => null));
      if (!attached) {
        const snapshot = (await ctx.db
          .prepare(
            `SELECT load_id, load_number, sales_order_number FROM messages WHERE thread_id = ? AND load_id IS NOT NULL ORDER BY seq DESC LIMIT 1`,
          )
          .get(thread.id)) as { load_id: string; load_number: string | null; sales_order_number: string | null } | undefined;
        attached = snapshot
          ? {
              id: snapshot.load_id,
              loadNumber: snapshot.load_number,
              salesOrderNumber: snapshot.sales_order_number ?? "",
              originCity: "",
              originState: "",
              destinationCity: "",
              destinationState: "",
            }
          : null;
      }
    }
  } else {
    const explicit = requestedId ? await requireLoad(ctx, requestedId) : null;
    attached = explicit ?? mentions[0]?.load ?? null;
  }

  const id = randomUUID();
  const createdAt = ctx.now().toISOString();
  const side = session.role === "admin" ? "select" : "emit";
  const authorName = session.name.trim().slice(0, 200) || "Portal user";
  const authorEmail = session.email.trim().toLowerCase().slice(0, 200);

  const saved = await withTransaction(ctx.db, async () => {
    const thread = existingThread ?? (await ensureThread(ctx, attached, createdAt));
    const current = await ctx.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS n FROM messages`).get();
    const next = Number(current?.n ?? 0) + 1;
    await ctx.db
      .prepare(
        `INSERT INTO messages (
           id, seq, thread_id, body, author_id, author_name, author_email, author_side,
           load_id, load_number, sales_order_number, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        next,
        thread.id,
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
    return { seq: next, thread };
  });

  const message = presentMessage(
    {
      id,
      seq: saved.seq,
      thread_id: saved.thread.id,
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
    const facts = await loadSlackFacts(ctx, attached?.id ?? null);
    const parentTs = saved.thread.slack_ts?.trim() || null;
    const notice: MessageNotice = {
      authorName,
      authorEmail,
      loadNumber: message.load?.loadNumber ?? null,
      salesOrderNumber: message.load?.salesOrderNumber ?? null,
      destination: facts.destination,
      owner: facts.owner,
      preview: messagePreview(body),
      threadUrl: messageThreadUrl(process.env, { loadId: attached?.id ?? null, threadId: saved.thread.id }),
      slackThreadTs: parentTs,
    };
    const posted = await notifySelectOfEmitMessage(notice);
    const channel = slackBotTarget()?.channel ?? null;
    if (posted.mode === "bot" && posted.ts && channel) {
      await ctx.db
        .prepare(
          `UPDATE message_threads SET slack_ts = ?, slack_channel = ?
           WHERE id = ? AND (slack_ts IS NULL OR trim(slack_ts) = '')`,
        )
        .run(posted.ts, channel, saved.thread.id);
    }
  }

  return message;
}
