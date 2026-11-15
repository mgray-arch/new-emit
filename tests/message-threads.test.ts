import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as receiverRoute } from "@/app/api/r/[token]/route";
import { GET as listMessagesRoute, POST as postMessageRoute } from "@/app/api/messages/route";
import { POST as markReadRoute } from "@/app/api/messages/read/route";
import { GET as unreadRoute } from "@/app/api/messages/unread/route";
import type { PortalContext } from "@/lib/db";
import { migrateMessageThreads } from "@/lib/db";
import { messageReplyText } from "@/lib/message-notify";
import { loadOwnerMatchesUser } from "@/lib/messages";
import type { Session } from "@/lib/types";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "@/tests/helpers";

let ctx: PortalContext;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["SLACK_MESSAGES_WEBHOOK_URL", "SLACK_BOT_TOKEN", "SLACK_MESSAGES_CHANNEL_ID", "MESSAGE_NOTIFY_EMAILS"];
const BOT_TOKEN = "xoxb-test-token-0123456789";
const CHANNEL = "C0MESSAGES1";

beforeAll(async () => {
  ctx = await seededPortal();
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  await ctx.db
    .prepare(
      `INSERT INTO users (id, email, name, role, permission, profile, active, password_epoch, chat_enabled, created_at)
       VALUES
         ('emit-threads', 'threads.on@emit.example', 'Casey Emit', 'customer', 'add', NULL, 1, 0, 1, '2026-10-14T18:00:00.000Z'),
         ('emit-other', 'threads.other@emit.example', 'Riley Emit', 'customer', 'add', NULL, 1, 0, 1, '2026-10-14T18:00:00.000Z'),
         ('sales-threads', 'sales.threads@emit.example', 'Sarah Sales', 'customer', 'view', 'sales', 1, 0, 1, '2026-10-14T18:00:00.000Z'),
         ('loader-threads', 'loader.threads@emit.example', 'Lee Loader', 'customer', 'view', 'loader', 1, 0, 1, '2026-10-14T18:00:00.000Z')`,
    )
    .run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
});

function headers(cookie: string, json = false): HeadersInit {
  return {
    cookie,
    host: "portal.test",
    origin: "http://portal.test",
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function emitUser(id: string, email: string, name: string, profile?: "sales" | "loader"): Session {
  return { userId: id, email, name, role: "customer", permission: profile ? "view" : "add", profile: profile ?? null };
}

function drew(): Session {
  return { userId: "drew-threads", email: "dmartin@goselect.com", name: "Drew Martin", role: "admin" };
}

async function loads(limit = 4): Promise<Array<{ id: string; load_number: string | null; sales_order_number: string; owner: string | null }>> {
  return (await ctx.db
    .prepare(`SELECT id, load_number, sales_order_number, owner FROM loads WHERE deleted_at IS NULL ORDER BY sales_order_number LIMIT ?`)
    .all(limit)) as Array<{ id: string; load_number: string | null; sales_order_number: string; owner: string | null }>;
}

async function post(cookie: string, body: string, extra: { loadId?: string | null; threadId?: string | null } = {}) {
  return postMessageRoute(
    new Request("http://portal.test/api/messages", {
      method: "POST",
      headers: headers(cookie, true),
      body: JSON.stringify({ body, ...extra }),
    }),
  );
}

function walkKeys(value: unknown, seen: Set<string>) {
  if (Array.isArray(value)) {
    value.forEach((item) => walkKeys(item, seen));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    seen.add(key);
    walkKeys(child, seen);
  }
}

function assertNoPay(value: unknown) {
  expectNoSecrets(value);
  const keys = new Set<string>();
  walkKeys(value, keys);
  for (const key of keys) {
    expect(key).not.toMatch(/carrier|customerCost|customer_cost|rateReason|rate_reason|staffNote|staff_notes|margin|slackTs|slack_ts|slackChannel|webhook|comments/i);
  }
  const text = JSON.stringify(value);
  expect(text).not.toMatch(/1500|8765|\$|rate confirmation|carrier pay/i);
  expect(text).not.toContain(BOT_TOKEN);
}

describe("message threads", () => {
  it("keeps replies on the load thread and puts a note with no load in General", async () => {
    const [first, second] = await loads(2);
    const cookie = await sessionCookie(emitUser("emit-threads", "threads.on@emit.example", "Casey Emit"));
    const started = await post(cookie, "Dock is open for the morning.", { loadId: first.id });
    expect(started.status).toBe(201);
    const firstMessage = (await started.json()).message;
    const reply = await post(cookie, `Following up, not ${second.load_number}`, { threadId: firstMessage.threadId });
    expect(reply.status).toBe(201);
    const replyMessage = (await reply.json()).message;
    expect(replyMessage.threadId).toBe(firstMessage.threadId);
    expect(replyMessage.load.id).toBe(first.id);
    expect(replyMessage.load.salesOrderNumber).toBe(first.sales_order_number);
    expect(replyMessage.mentions.map((mention: { token: string }) => mention.token)).toContain(second.load_number);

    const other = await post(cookie, "Different load.", { loadId: second.id });
    const otherMessage = (await other.json()).message;
    expect(otherMessage.threadId).not.toBe(firstMessage.threadId);

    const generalA = await post(cookie, "This is not about a load.");
    const generalB = await post(cookie, "Still not about a load.");
    const generalThread = (await generalA.json()).message.threadId as string;
    expect((await generalB.json()).message.threadId).toBe(generalThread);

    const board = await listMessagesRoute(new Request("http://portal.test/api/messages", { headers: headers(cookie) }));
    const listed = await board.json();
    const loadThread = listed.threads.find((thread: { id: string }) => thread.id === firstMessage.threadId);
    const general = listed.threads.find((thread: { id: string }) => thread.id === generalThread);
    expect(loadThread.kind).toBe("load");
    expect(loadThread.load.salesOrderNumber).toBe(first.sales_order_number);
    expect(loadThread.load.loadNumber).toBe(first.load_number);
    expect(loadThread.messageCount).toBe(2);
    expect(general.kind).toBe("general");
    expect(general.load).toBeNull();

    const detail = await listMessagesRoute(
      new Request(`http://portal.test/api/messages?thread=${firstMessage.threadId}`, { headers: headers(cookie) }),
    );
    const opened = await detail.json();
    expect(opened.messages.map((message: { id: string }) => message.id)).toEqual([firstMessage.id, replyMessage.id]);
    expect(opened.messages.every((message: { load: { id: string } }) => message.load.id === first.id)).toBe(true);
    const otherDetail = await listMessagesRoute(
      new Request(`http://portal.test/api/messages?load=${second.id}`, { headers: headers(cookie) }),
    );
    const otherOpened = await otherDetail.json();
    expect(otherOpened.messages.map((message: { id: string }) => message.id)).toEqual([otherMessage.id]);
    assertNoPay(listed);
    assertNoPay(opened);
  });

  it("tracks unread per thread and per person", async () => {
    const rows = await loads(4);
    const third = rows[2];
    const fourth = rows[3];
    const casey = await sessionCookie(emitUser("emit-threads", "threads.on@emit.example", "Casey Emit"));
    const riley = await sessionCookie(emitUser("emit-other", "threads.other@emit.example", "Riley Emit"));
    const select = await sessionCookie(adminSession());
    const before = (await (await unreadRoute(new Request("http://portal.test/api/messages/unread", { headers: headers(riley) }))).json()).count as number;

    const onThird = await post(casey, "Unread on the third load.", { loadId: third.id });
    const onFourth = await post(casey, "Unread on the fourth load.", { loadId: fourth.id });
    const thirdThread = (await onThird.json()).message.threadId as string;
    const fourthThread = (await onFourth.json()).message.threadId as string;
    expect(thirdThread).not.toBe(fourthThread);

    const rileyUnread = (await (await unreadRoute(new Request("http://portal.test/api/messages/unread", { headers: headers(riley) }))).json()).count as number;
    expect(rileyUnread).toBe(before + 2);
    const caseyUnread = (await (await unreadRoute(new Request("http://portal.test/api/messages/unread", { headers: headers(casey) }))).json()).count as number;
    expect(caseyUnread).toBe(0);

    const marked = await markReadRoute(
      new Request("http://portal.test/api/messages/read", {
        method: "POST",
        headers: headers(riley, true),
        body: JSON.stringify({ threadId: thirdThread }),
      }),
    );
    expect(marked.status).toBe(200);
    expect((await (await unreadRoute(new Request("http://portal.test/api/messages/unread", { headers: headers(riley) }))).json()).count).toBe(before + 1);

    const filtered = await listMessagesRoute(new Request("http://portal.test/api/messages?unread=1", { headers: headers(riley) }));
    const unreadThreads = (await filtered.json()).threads as Array<{ id: string; unread: number }>;
    expect(unreadThreads.some((thread) => thread.id === fourthThread)).toBe(true);
    expect(unreadThreads.some((thread) => thread.id === thirdThread)).toBe(false);
    expect(unreadThreads.every((thread) => thread.unread > 0)).toBe(true);
    const ordered = unreadThreads.map((thread) => thread.id);
    const fourthAt = ordered.indexOf(fourthThread);
    expect(fourthAt).toBeGreaterThanOrEqual(0);

    await markReadRoute(new Request("http://portal.test/api/messages/read", { method: "POST", headers: headers(select) }));
    const reply = await post(select, "Select saw the fourth load.", { threadId: fourthThread });
    expect((await reply.json()).message.side).toBe("select");
    expect((await (await unreadRoute(new Request("http://portal.test/api/messages/unread", { headers: headers(select) }))).json()).count).toBe(0);
    expect((await (await unreadRoute(new Request("http://portal.test/api/messages/unread", { headers: headers(riley) }))).json()).count).toBe(before + 2);

    const preview = `${select}; portal_view_as=sales`;
    const previewRead = await markReadRoute(
      new Request("http://portal.test/api/messages/read", {
        method: "POST",
        headers: headers(preview, true),
        body: JSON.stringify({ threadId: fourthThread }),
      }),
    );
    expect(previewRead.status).toBe(403);
  });

  it("filters by search, unread, owner, and the latest side", async () => {
    expect(loadOwnerMatchesUser("Drew", "Drew Martin")).toBe(true);
    expect(loadOwnerMatchesUser("ainsley", "Ainsley Hamilton")).toBe(true);
    expect(loadOwnerMatchesUser("Drew", "Casey Emit")).toBe(false);
    expect(loadOwnerMatchesUser(null, "Drew Martin")).toBe(false);

    const [drewLoad, ainsleyLoad] = await loads(2);
    await ctx.db.prepare(`UPDATE loads SET owner = ? WHERE id = ?`).run("Drew", drewLoad.id);
    await ctx.db.prepare(`UPDATE loads SET owner = ? WHERE id = ?`).run("Ainsley", ainsleyLoad.id);
    const casey = await sessionCookie(emitUser("emit-threads", "threads.on@emit.example", "Casey Emit"));
    const drewCookie = await sessionCookie(drew());
    const select = await sessionCookie(adminSession());

    const drewPost = await post(casey, "Drew owns the pickup question.", { loadId: drewLoad.id });
    const drewThread = (await drewPost.json()).message.threadId as string;
    await post(select, "Select answered Drew's load.", { threadId: drewThread });
    const ainsleyPost = await post(casey, "Ainsley still needs a reply.", { loadId: ainsleyLoad.id });
    const ainsleyThread = (await ainsleyPost.json()).message.threadId as string;

    const bySo = await listMessagesRoute(
      new Request(`http://portal.test/api/messages?q=${encodeURIComponent(drewLoad.sales_order_number.toLowerCase())}`, {
        headers: headers(casey),
      }),
    );
    const soThreads = (await bySo.json()).threads as Array<{ id: string }>;
    expect(soThreads.some((thread) => thread.id === drewThread)).toBe(true);
    expect(soThreads.some((thread) => thread.id === ainsleyThread)).toBe(false);

    const destination = JSON.parse(
      String((await ctx.db.prepare(`SELECT destination_json FROM loads WHERE id = ?`).get(drewLoad.id))?.destination_json),
    ) as { city?: string };
    const city = (destination.city ?? "").trim();
    expect(city.length).toBeGreaterThan(2);
    const byCity = await listMessagesRoute(
      new Request(`http://portal.test/api/messages?q=${encodeURIComponent(city)}`, { headers: headers(casey) }),
    );
    const cityThreads = (await byCity.json()).threads as Array<{ id: string; load: { destinationCity: string; originCity: string } | null }>;
    expect(cityThreads.some((thread) => thread.id === drewThread)).toBe(true);
    expect(
      cityThreads.every((thread) => {
        const load = thread.load;
        const lane = `${load?.originCity ?? ""} ${load?.destinationCity ?? ""} ${load?.originCity ?? ""}`.toLowerCase();
        return lane.includes(city.toLowerCase()) || thread.id === drewThread;
      }),
    ).toBe(true);

    const mine = await listMessagesRoute(new Request("http://portal.test/api/messages?mine=1", { headers: headers(drewCookie) }));
    const mineThreads = (await mine.json()).threads as Array<{ id: string; load: { owner: string } | null }>;
    expect(mineThreads.some((thread) => thread.id === drewThread)).toBe(true);
    expect(mineThreads.some((thread) => thread.id === ainsleyThread)).toBe(false);
    expect(mineThreads.every((thread) => thread.load?.owner === "Drew")).toBe(true);

    const emitSide = await listMessagesRoute(new Request("http://portal.test/api/messages?side=emit", { headers: headers(casey) }));
    const selectSide = await listMessagesRoute(new Request("http://portal.test/api/messages?side=select", { headers: headers(casey) }));
    const emitIds = ((await emitSide.json()).threads as Array<{ id: string; latest: { side: string } }>).map((thread) => thread.id);
    const selectIds = ((await selectSide.json()).threads as Array<{ id: string; latest: { side: string } }>).map((thread) => thread.id);
    expect(emitIds).toContain(ainsleyThread);
    expect(emitIds).not.toContain(drewThread);
    expect(selectIds).toContain(drewThread);
    expect(selectIds).not.toContain(ainsleyThread);
    assertNoPay(mineThreads);
  });
});

describe("thread visibility", () => {
  it("shows every thread to EMIT, including Sales and Loader, and hides the thread from a receiver link", async () => {
    const [load] = await loads(1);
    const casey = await sessionCookie(emitUser("emit-threads", "threads.on@emit.example", "Casey Emit"));
    const riley = await sessionCookie(emitUser("emit-other", "threads.other@emit.example", "Riley Emit"));
    const sales = await sessionCookie(emitUser("sales-threads", "sales.threads@emit.example", "Sarah Sales", "sales"));
    const loader = await sessionCookie(emitUser("loader-threads", "loader.threads@emit.example", "Lee Loader", "loader"));
    const note = await post(casey, "Everyone at EMIT can see this note.", { loadId: load.id });
    const threadId = (await note.json()).message.threadId as string;

    const rileyList = await listMessagesRoute(new Request("http://portal.test/api/messages", { headers: headers(riley) }));
    expect((await rileyList.json()).threads.some((thread: { id: string }) => thread.id === threadId)).toBe(true);

    for (const cookie of [sales, loader]) {
      const listed = await listMessagesRoute(new Request("http://portal.test/api/messages", { headers: headers(cookie) }));
      const detail = await listMessagesRoute(
        new Request(`http://portal.test/api/messages?thread=${threadId}`, { headers: headers(cookie) }),
      );
      expect(listed.status).toBe(200);
      expect(detail.status).toBe(200);
      const listBody = await listed.json();
      const detailBody = await detail.json();
      expect(listBody.threads.some((thread: { id: string }) => thread.id === threadId)).toBe(true);
      expect(detailBody.messages.some((message: { body: string }) => message.body === "Everyone at EMIT can see this note.")).toBe(true);
      assertNoPay(listBody);
      assertNoPay(detailBody);
    }

    const preview = `${await sessionCookie(adminSession())}; portal_view_as=loader`;
    const looked = await listMessagesRoute(new Request("http://portal.test/api/messages", { headers: headers(preview) }));
    expect(looked.status).toBe(200);
    assertNoPay(await looked.json());

    const receiver = (await ctx.db.prepare(`SELECT access_token FROM receivers WHERE access_token IS NOT NULL LIMIT 1`).get()) as {
      access_token: string;
    };
    const secret = "RECEIVER-MUST-NOT-SEE-THIS-NOTE";
    await post(casey, secret, { loadId: load.id });
    const link = await receiverRoute(new Request(`http://portal.test/api/r/${receiver.access_token}`), {
      params: Promise.resolve({ token: receiver.access_token }),
    });
    expect(link.status).toBe(200);
    const linkText = await link.text();
    expect(linkText).not.toContain(secret);
    expect(linkText).not.toContain("Everyone at EMIT can see this note.");
    expect(linkText).not.toMatch(/"messages"|"threadId"|"body"/);

    const page = readFileSync("app/r/[token]/page.tsx", "utf8");
    expect(page).not.toMatch(/messages-panel|message-thread|LoadThread|\/api\/messages/);
    const ui = ["components/messages-panel.tsx", "components/load-thread.tsx", "components/message-thread.tsx"]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(ui).not.toMatch(/\bSAM\b/);
  });
});

describe("migrate existing messages into load threads", () => {
  it("groups six messages across four loads, keeps a general note, and copies read cursors", async () => {
    const before = Number((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get())?.n ?? 0);
    const bodies = ["migrate-1", "migrate-2", "migrate-3", "migrate-4", "migrate-5", "migrate-6", "migrate-general"];
    const synthetic = [
      { id: "mig-load-a", load_number: "mig-a-1", sales_order_number: "MIG-A" },
      { id: "mig-load-b", load_number: "mig-b-1", sales_order_number: "MIG-B" },
      { id: "mig-load-c", load_number: "mig-c-1", sales_order_number: "MIG-C" },
      { id: "mig-load-d", load_number: "mig-d-1", sales_order_number: "MIG-D" },
    ];
    const plan = [
      { body: bodies[0], load: synthetic[0], seq: 910 },
      { body: bodies[1], load: synthetic[0], seq: 911 },
      { body: bodies[2], load: synthetic[1], seq: 912 },
      { body: bodies[3], load: synthetic[1], seq: 913 },
      { body: bodies[4], load: synthetic[2], seq: 914 },
      { body: bodies[5], load: synthetic[3], seq: 915 },
      { body: bodies[6], load: null, seq: 916 },
    ];
    for (const item of plan) {
      await ctx.db
        .prepare(
          `INSERT INTO messages (
             id, seq, thread_id, body, author_id, author_name, author_email, author_side,
             load_id, load_number, sales_order_number, created_at
           ) VALUES (?, ?, NULL, ?, 'someone-else', 'Someone Else', 'else@emit.example', 'emit', ?, ?, ?, '2026-10-14T18:00:00.000Z')`,
        )
        .run(
          `mig-${item.seq}`,
          item.seq,
          item.body,
          item.load?.id ?? null,
          item.load?.load_number ?? null,
          item.load?.sales_order_number ?? null,
        );
    }
    await ctx.db.exec(`CREATE TABLE message_reads (user_id TEXT PRIMARY KEY, read_seq INTEGER NOT NULL)`);
    await ctx.db.prepare(`INSERT INTO message_reads (user_id, read_seq) VALUES ('riley-cursor', 912)`).run();

    await migrateMessageThreads(ctx.db);
    await migrateMessageThreads(ctx.db);

    const after = Number((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get())?.n ?? 0);
    expect(after).toBe(before + plan.length);
    const stored = (await ctx.db
      .prepare(`SELECT id, body, thread_id, load_id, seq FROM messages WHERE id LIKE 'mig-%' ORDER BY seq`)
      .all()) as Array<{ id: string; body: string; thread_id: string; load_id: string | null; seq: number }>;
    expect(stored.map((row) => row.body)).toEqual(bodies);
    expect(stored.every((row) => row.thread_id)).toBe(true);
    const threadFor = (loadId: string | null) => stored.find((row) => row.load_id === loadId)?.thread_id;
    expect(threadFor(synthetic[0].id)).toBe(stored[1].thread_id);
    expect(threadFor(synthetic[1].id)).not.toBe(threadFor(synthetic[0].id));
    expect(new Set(stored.filter((row) => row.load_id).map((row) => row.thread_id)).size).toBe(4);
    const general = stored.find((row) => row.body === "migrate-general");
    expect(general?.load_id ?? null).toBeNull();
    if (!general?.thread_id) throw new Error("general thread missing");
    const generalThread = (await ctx.db.prepare(`SELECT load_id, load_key FROM message_threads WHERE id = ?`).get(general.thread_id)) as {
      load_id: string | null;
      load_key: string;
    };
    expect(generalThread.load_key).toBe("general");
    expect(generalThread.load_id).toBeNull();

    const reads = (await ctx.db
      .prepare(`SELECT thread_id, read_seq FROM message_thread_reads WHERE user_id = 'riley-cursor'`)
      .all()) as Array<{ thread_id: string; read_seq: number }>;
    const readFor = (threadId: string | undefined) => reads.find((row) => row.thread_id === threadId)?.read_seq ?? 0;
    expect(readFor(threadFor(synthetic[0].id))).toBe(911);
    expect(readFor(threadFor(synthetic[1].id))).toBe(912);
    expect(readFor(threadFor(synthetic[2].id))).toBe(0);
    expect(readFor(threadFor(synthetic[3].id))).toBe(0);
    const priorGeneral = await ctx.db
      .prepare(`SELECT MAX(seq) AS n FROM messages WHERE thread_id = ? AND seq <= 912`)
      .get(general.thread_id);
    const generalRead = readFor(general.thread_id);
    expect(generalRead).toBe(Number(priorGeneral?.n ?? 0));
    expect(generalRead).toBeLessThan(916);
    const legacy = await ctx.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_reads'`).get();
    expect(legacy).toBeUndefined();

    const columns = (await ctx.db.prepare(`PRAGMA table_info(messages)`).all()) as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("thread_id");
    for (const table of ["messages", "message_threads", "message_thread_reads"]) {
      const names = (await ctx.db.prepare(`PRAGMA table_info(${table})`).all()) as Array<{ name: string }>;
      for (const column of names) {
        expect(column.name.toLowerCase()).not.toMatch(/carrier|customer_cost|rate_reason|staff_notes/);
      }
    }

    await ctx.db.prepare(`DELETE FROM message_thread_reads WHERE user_id = 'riley-cursor'`).run();
    await ctx.db.prepare(`DELETE FROM messages WHERE id LIKE 'mig-%'`).run();
  });
});

describe("Slack thread replies", () => {
  it("posts the first note with the bot and later notes under thread_ts", async () => {
    const rows = await loads(6);
    const load = rows[4];
    const cookie = await sessionCookie(emitUser("emit-threads", "threads.on@emit.example", "Casey Emit"));
    const calls: Array<{ url: string; body: string; authorization: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      calls.push({ url: String(url), body: String(init?.body ?? ""), authorization });
      const payload = JSON.parse(String(init?.body ?? "{}")) as { thread_ts?: string };
      return new Response(JSON.stringify({ ok: true, ts: payload.thread_ts ? "222.333" : "111.222", channel: CHANNEL }), {
        status: 200,
      });
    });
    process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.SLACK_MESSAGES_CHANNEL_ID = CHANNEL;
    process.env.SLACK_MESSAGES_WEBHOOK_URL = "https://hooks.slack.example/messages";

    const first = await post(cookie, "Please confirm the dock for the bot thread.", { loadId: load.id });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0].authorization).toBe(`Bearer ${BOT_TOKEN}`);
    const parent = JSON.parse(calls[0].body) as { channel: string; text: string; thread_ts?: string };
    expect(parent.channel).toBe(CHANNEL);
    expect(parent.thread_ts).toBeUndefined();
    expect(parent.text).toContain(`Load ${load.load_number}`);
    expect(parent.text).toContain(load.sales_order_number.toUpperCase());
    expect(parent.text).toContain("Destination:");
    expect(parent.text).toContain("Owner:");
    expect(parent.text).toContain("Please confirm the dock");
    expect(parent.text).toContain(`http://portal.test/messages?load=${load.id}`);
    expect(calls[0].body).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(firstBody)).not.toContain(BOT_TOKEN);
    assertNoPay(firstBody);

    const stored = (await ctx.db.prepare(`SELECT slack_ts, slack_channel FROM message_threads WHERE id = ?`).get(firstBody.message.threadId)) as {
      slack_ts: string;
      slack_channel: string;
    };
    expect(stored.slack_ts).toBe("111.222");
    expect(stored.slack_channel).toBe(CHANNEL);

    const second = await post(cookie, "Second note stays under the first Slack post.", { threadId: firstBody.message.threadId });
    expect(second.status).toBe(201);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("https://slack.com/api/chat.postMessage");
    const reply = JSON.parse(calls[1].body) as { thread_ts?: string; text: string };
    expect(reply.thread_ts).toBe("111.222");
    expect(reply.text).toContain("Reply from Casey Emit");
    expect(reply.text).toContain("Second note stays under the first Slack post.");
    expect(reply.text).not.toMatch(/1500|8765|\$|carrier pay|rate confirmation/i);
    expect(calls[1].body).not.toContain(BOT_TOKEN);
    expect(messageReplyText({
      authorName: "Casey Emit",
      authorEmail: "threads.on@emit.example",
      loadNumber: load.load_number,
      salesOrderNumber: load.sales_order_number,
      preview: "Second note",
      threadUrl: "https://portal.example.com/messages",
    })).not.toMatch(/carrier pay|8765|\$/);
  });

  it("falls back to top-level webhook posts when the bot env is unset", async () => {
    const rows = await loads(6);
    const load = rows[5];
    const cookie = await sessionCookie(emitUser("emit-threads", "threads.on@emit.example", "Casey Emit"));
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response("ok", { status: 200 });
    });
    process.env.SLACK_MESSAGES_WEBHOOK_URL = "https://hooks.slack.example/messages";

    const first = await post(cookie, "Webhook parent.", { loadId: load.id });
    expect(first.status).toBe(201);
    const threadId = (await first.json()).message.threadId as string;
    const second = await post(cookie, "Webhook reply is still a top-level post.", { threadId });
    expect(second.status).toBe(201);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe("https://hooks.slack.example/messages");
      const payload = JSON.parse(call.body) as { text?: string; thread_ts?: string };
      expect(Object.keys(payload)).toEqual(["text"]);
      expect(payload.thread_ts).toBeUndefined();
      expect(payload.text).toContain("Destination:");
      expect(payload.text).not.toMatch(/1500|8765|\$/);
    }
    const stored = (await ctx.db.prepare(`SELECT slack_ts FROM message_threads WHERE id = ?`).get(threadId)) as { slack_ts: string | null };
    expect(stored.slack_ts ?? null).toBeNull();

    delete process.env.SLACK_MESSAGES_WEBHOOK_URL;
    process.env.SLACK_BOT_TOKEN = BOT_TOKEN;
    process.env.SLACK_MESSAGES_CHANNEL_ID = "not a channel";
    calls.length = 0;
    const quiet = await post(cookie, "Invalid channel does not call Slack.", { threadId });
    expect(quiet.status).toBe(201);
    expect(calls).toHaveLength(0);
  });
});
