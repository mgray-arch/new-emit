import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PATCH as patchUser } from "@/app/api/admin/users/[id]/route";
import { POST as createUser } from "@/app/api/admin/users/route";
import { GET as meRoute } from "@/app/api/me/route";
import { GET as listMessagesRoute, POST as postMessageRoute } from "@/app/api/messages/route";
import { GET as loadOptionsRoute } from "@/app/api/messages/loads/route";
import { POST as markReadRoute } from "@/app/api/messages/read/route";
import { GET as unreadRoute } from "@/app/api/messages/unread/route";
import type { PortalContext } from "@/lib/db";
import {
  messageDestinationLabel,
  messageEmailDraft,
  messageNoticeText,
  messageOwnerLine,
  messagePreview,
  notifySelectOfEmitMessage,
  MESSAGE_PREVIEW_LIMIT,
} from "@/lib/message-notify";
import { splitMessageMentions } from "@/lib/message-types";
import { LOAD_REF_COLUMNS, MESSAGE_COLUMNS, messageAccess, messageBlockedReason } from "@/lib/messages";
import type { Session } from "@/lib/types";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "@/tests/helpers";

let ctx: PortalContext;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "SLACK_MESSAGES_WEBHOOK_URL",
  "SLACK_BOT_TOKEN",
  "SLACK_MESSAGES_CHANNEL_ID",
  "SLACK_USER_ID_DREW",
  "SLACK_USER_ID_AINSLEY",
  "MESSAGE_NOTIFY_EMAILS",
  "AI_API_KEY",
  "AI_BASE_URL",
];

beforeAll(async () => {
  ctx = await seededPortal();
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  await ctx.db
    .prepare(
      `INSERT INTO users (id, email, name, role, permission, active, password_epoch, chat_enabled, created_at)
       VALUES
         ('customer-1', 'chat.on@emit.example', 'Chat On', 'customer', 'add', 1, 0, 1, '2026-10-14T18:00:00.000Z'),
         ('viewer-1', 'chat.viewer@emit.example', 'View Only', 'emit_viewer', 'view', 1, 0, 1, '2026-10-14T18:00:00.000Z')`,
    )
    .run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function headers(cookie: string, json = false): HeadersInit {
  return {
    cookie,
    host: "portal.test",
    origin: "http://portal.test",
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function emitViewer(): Session {
  return { userId: "viewer-1", email: "viewer@emit.example", name: "View Only", role: "emit_viewer", permission: "view" };
}

function drew(): Session {
  return { userId: "admin-2", email: "dmartin@goselect.com", name: "Drew Martin", role: "admin" };
}

async function messageCount(): Promise<number> {
  const row = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get();
  return Number(row?.n ?? 0);
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

describe("message authorization", () => {
  it("treats only EMIT roles and Select as members, and view-as as read-only", () => {
    expect(messageAccess(customerSession())).toBe("write");
    expect(messageAccess(emitViewer())).toBe("write");
    expect(messageAccess({ userId: "lead", email: "lead@emit.example", name: "Lead", role: "emit_admin" })).toBe("write");
    expect(messageAccess(adminSession())).toBe("write");
    expect(messageAccess({ ...adminSession(), role: "customer", viewAs: { access: "regular", permission: "view" } })).toBe("read");
    expect(messageAccess({ ...customerSession(), role: "receiver" as Session["role"] })).toBe("none");
  });

  it("rejects anonymous callers, the bot key, and a deactivated EMIT user", async () => {
    const missing = await listMessagesRoute(new Request("http://portal.test/api/messages"));
    expect(missing.status).toBe(401);
    const bot = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer bot-upload-key-0123456789",
          host: "portal.test",
          origin: "http://portal.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: "Bot should not post" }),
      }),
    );
    expect(bot.status).toBe(401);

    await ctx.db
      .prepare(
        `INSERT INTO users (id, email, name, role, permission, active, password_epoch, created_at)
         VALUES ('gone-1', 'gone@emit.example', 'Gone', 'customer', 'add', 0, 0, '2026-10-14T18:00:00.000Z')`,
      )
      .run();
    const gone = await sessionCookie({
      userId: "gone-1",
      email: "gone@emit.example",
      name: "Gone",
      role: "customer",
      passwordEpoch: 0,
    });
    const blocked = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(gone, true),
        body: JSON.stringify({ body: "I was deactivated" }),
      }),
    );
    expect(blocked.status).toBe(401);
    expect(await messageCount()).toBe(0);
  });

  it("keeps one thread for EMIT and Select, and blocks view-as writes and other origins", async () => {
    const emit = await sessionCookie(customerSession());
    const viewer = await sessionCookie(emitViewer());
    const select = await sessionCookie(adminSession());
    const otherSelect = await sessionCookie(drew());
    const before = await messageCount();

    const cross = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: {
          cookie: emit,
          host: "portal.test",
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: "Posted from another site" }),
      }),
    );
    expect(cross.status).toBe(403);

    const created = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(emit, true),
        body: JSON.stringify({ body: "Can someone confirm the dock?" }),
      }),
    );
    expect(created.status).toBe(201);
    const posted = (await created.json()).message;
    expect(posted.side).toBe("emit");
    expect(posted.mine).toBe(true);
    expect(posted.load).toBeNull();

    const asViewer = await listMessagesRoute(new Request("http://portal.test/api/messages", { headers: headers(viewer) }));
    const asSelect = await listMessagesRoute(new Request("http://portal.test/api/messages", { headers: headers(select) }));
    const asDrew = await listMessagesRoute(new Request("http://portal.test/api/messages", { headers: headers(otherSelect) }));
    expect(asViewer.status).toBe(200);
    const viewerBody = await asViewer.json();
    const selectBody = await asSelect.json();
    const drewBody = await asDrew.json();
    expect(viewerBody.threads).toHaveLength(1);
    expect(viewerBody.threads[0].kind).toBe("general");
    expect(viewerBody.threads[0].latest.id).toBe(posted.id);
    expect(selectBody.threads[0].latest.id).toBe(posted.id);
    expect(drewBody.threads[0].latest.id).toBe(posted.id);
    const opened = await listMessagesRoute(
      new Request(`http://portal.test/api/messages?thread=${viewerBody.threads[0].id}`, { headers: headers(viewer) }),
    );
    const openedBody = await opened.json();
    expect(openedBody.messages.map((message: { id: string }) => message.id)).toEqual([posted.id]);
    expect(openedBody.messages[0].mine).toBe(false);
    expect(openedBody.messages[0].side).toBe("emit");
    expect(openedBody.messages[0].threadId).toBe(viewerBody.threads[0].id);

    const preview = `${select}; portal_view_as=regular:view`;
    const looked = await listMessagesRoute(new Request("http://portal.test/api/messages", { headers: headers(preview) }));
    expect(looked.status).toBe(200);
    expect((await looked.json()).threads).toHaveLength(1);
    const denied = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(preview, true),
        body: JSON.stringify({ body: "View-as must not write" }),
      }),
    );
    expect(denied.status).toBe(403);
    const ignoredCookie = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(`${emit}; portal_view_as=admin:full`, true),
        body: JSON.stringify({ body: "EMIT cannot become Select by cookie" }),
      }),
    );
    expect(ignoredCookie.status).toBe(201);
    expect((await ignoredCookie.json()).message.side).toBe("emit");
    expect(await messageCount()).toBe(before + 2);
  });
});

describe("chat stays off until Select enables it", () => {
  it("rejects reads and posts for an EMIT user, and leaves Select staff on", async () => {
    const seeded = (await ctx.db.prepare(`SELECT id, chat_enabled FROM users WHERE email = ?`).get("m.gray@emit.example")) as {
      id: string;
      chat_enabled: number;
    };
    expect(Number(seeded.chat_enabled)).toBe(0);
    const off = await sessionCookie({
      userId: seeded.id,
      email: "m.gray@emit.example",
      name: "M. Gray",
      role: "customer",
      permission: "add",
      passwordEpoch: 0,
    });
    const select = await sessionCookie(adminSession());
    const before = await messageCount();

    const listed = await listMessagesRoute(new Request("http://portal.test/api/messages", { headers: headers(off) }));
    const posted = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(off, true),
        body: JSON.stringify({ body: "Should not store while chat is off" }),
      }),
    );
    const unread = await unreadRoute(new Request("http://portal.test/api/messages/unread", { headers: headers(off) }));
    const loads = await loadOptionsRoute(new Request("http://portal.test/api/messages/loads", { headers: headers(off) }));
    const marked = await markReadRoute(
      new Request("http://portal.test/api/messages/read", { method: "POST", headers: headers(off) }),
    );
    for (const response of [listed, posted, unread, loads, marked]) {
      expect(response.status).toBe(403);
      expect((await response.json()).error).toMatch(/turned off/i);
    }
    expect(await messageCount()).toBe(before);
    const stored = JSON.stringify(await ctx.db.prepare(`SELECT body FROM messages`).all());
    expect(stored).not.toContain("Should not store while chat is off");

    const selectList = await listMessagesRoute(new Request("http://portal.test/api/messages", { headers: headers(select) }));
    expect(selectList.status).toBe(200);
    const selectPost = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(select, true),
        body: JSON.stringify({ body: "Select can write while EMIT chat is off" }),
      }),
    );
    expect(selectPost.status).toBe(201);

    const meOff = await meRoute(new Request("http://portal.test/api/me", { headers: headers(off) }));
    expect((await meOff.json()).chatEnabled).toBe(false);
    const meSelect = await meRoute(new Request("http://portal.test/api/me", { headers: headers(select) }));
    expect((await meSelect.json()).chatEnabled).toBe(true);
    const preview = await meRoute(
      new Request("http://portal.test/api/me", { headers: headers(`${select}; portal_view_as=regular:view`) }),
    );
    expect((await preview.json()).chatEnabled).toBe(true);

    const turnedOn = await patchUser(
      new Request(`http://portal.test/api/admin/users/${seeded.id}`, {
        method: "PATCH",
        headers: headers(select, true),
        body: JSON.stringify({ chatEnabled: true }),
      }),
      { params: Promise.resolve({ id: seeded.id }) },
    );
    expect(turnedOn.status).toBe(200);
    expect((await turnedOn.json()).user.chatEnabled).toBe(true);
    const allowed = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(off, true),
        body: JSON.stringify({ body: "Chat is on now" }),
      }),
    );
    expect(allowed.status).toBe(201);
    expect((await (await meRoute(new Request("http://portal.test/api/me", { headers: headers(off) }))).json()).chatEnabled).toBe(true);

    const turnedOff = await patchUser(
      new Request(`http://portal.test/api/admin/users/${seeded.id}`, {
        method: "PATCH",
        headers: headers(select, true),
        body: JSON.stringify({ chatEnabled: false }),
      }),
      { params: Promise.resolve({ id: seeded.id }) },
    );
    expect((await turnedOff.json()).user.chatEnabled).toBe(false);
    const blockedAgain = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(off, true),
        body: JSON.stringify({ body: "Should not store after chat is turned off" }),
      }),
    );
    expect(blockedAgain.status).toBe(403);
    const bodies = JSON.stringify(await ctx.db.prepare(`SELECT body FROM messages`).all());
    expect(bodies).toContain("Chat is on now");
    expect(bodies).not.toContain("Should not store after chat is turned off");

    const created = await createUser(
      new Request("http://portal.test/api/admin/users", {
        method: "POST",
        headers: headers(select, true),
        body: JSON.stringify({ name: "No Chat", email: "no.chat@emit.example", password: "Temp-pass-1" }),
      }),
    );
    expect(created.status).toBe(201);
    expect((await created.json()).user.chatEnabled).toBe(false);
    const createdOn = await createUser(
      new Request("http://portal.test/api/admin/users", {
        method: "POST",
        headers: headers(select, true),
        body: JSON.stringify({
          name: "Yes Chat",
          email: "yes.chat@emit.example",
          password: "Temp-pass-1",
          chatEnabled: true,
        }),
      }),
    );
    expect((await createdOn.json()).user.chatEnabled).toBe(true);
  });
});

describe("carrier pay stays out of the thread", () => {
  it("rejects carrier pay, rate confirmations, and field names, and stores none of them", async () => {
    expect(MESSAGE_COLUMNS.toLowerCase()).not.toMatch(/carrier|customer_cost|rate_reason|staff_notes/);
    expect(LOAD_REF_COLUMNS.toLowerCase()).not.toMatch(/carrier|customer_cost|rate_reason|staff_notes/);
    const source = readFileSync("lib/messages.ts", "utf8") + readFileSync("lib/message-notify.ts", "utf8");
    expect(source).not.toMatch(/assistant|AI_API_KEY|customer_cost|carrier_pay/);
    expect(messageBlockedReason("Carrier pay is $8,765.43")).toMatch(/carrier pay/i);
    expect(messageBlockedReason("See the rate confirmation")).toMatch(/rate confirmation/i);
    expect(messageBlockedReason("carrier_pay is set")).toMatch(/field/i);

    const emit = await sessionCookie(customerSession());
    const before = await messageCount();
    for (const body of [
      "Carrier pay is $8,765.43 to BLACKHAWK HAULING LLC.",
      "Please send the rate confirmation.",
      "carrier_rate is $8,765.43",
      "staff_notes say pay the carrier",
    ]) {
      const response = await postMessageRoute(
        new Request("http://portal.test/api/messages", {
          method: "POST",
          headers: headers(emit, true),
          body: JSON.stringify({ body }),
        }),
      );
      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.error).toMatch(/carrier pay|rate confirmation/i);
      expectNoSecrets(payload);
      expect(JSON.stringify(payload)).not.toMatch(/BLACKHAWK|8765/);
    }
    expect(await messageCount()).toBe(before);
    const stored = JSON.stringify(await ctx.db.prepare(`SELECT body FROM messages`).all());
    expect(stored).not.toMatch(/BLACKHAWK|8765|carrier_pay|rate confirmation/i);
  });

  it("links a portal load without any price, cost, or carrier field", async () => {
    const load = (await ctx.db
      .prepare(`SELECT id, load_number, sales_order_number FROM loads WHERE sales_order_number = ?`)
      .get("SO2196")) as { id: string; load_number: string; sales_order_number: string };
    const other = (await ctx.db
      .prepare(`SELECT id FROM loads WHERE sales_order_number = ?`)
      .get("SO2981")) as { id: string };
    const emit = await sessionCookie(customerSession());
    const missing = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(emit, true),
        body: JSON.stringify({ body: "About a load that is not ours", loadId: "not-a-real-load" }),
      }),
    );
    expect(missing.status).toBe(400);

    const created = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(emit, true),
        body: JSON.stringify({ body: "Dock question for 900196-1", loadId: load.id }),
      }),
    );
    expect(created.status).toBe(201);
    const message = (await created.json()).message;
    expect(message.load).toMatchObject({
      id: load.id,
      loadNumber: "900196-1",
      salesOrderNumber: "SO2196",
    });
    expect(message.load.id).not.toBe(other.id);
    expect(message.mentions).toEqual([{ token: "900196-1", orderId: load.id }]);
    expectNoSecrets(message);
    const keys = new Set<string>();
    walkKeys(message, keys);
    for (const key of keys) {
      expect(key).not.toMatch(/carrier|customerCost|rateReason|staffNote|margin|comments/i);
    }
    expect(JSON.stringify(message)).not.toContain("1500");

    const linked = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(emit, true),
        body: JSON.stringify({ body: "Checking SO2196 and also 900181-1 today" }),
      }),
    );
    const auto = (await linked.json()).message;
    expect(auto.load.salesOrderNumber).toBe("SO2196");
    expect(auto.mentions.map((mention: { token: string }) => mention.token).sort()).toEqual(["900181-1", "SO2196"]);
    expectNoSecrets(auto);

    const options = await loadOptionsRoute(
      new Request(`http://portal.test/api/messages/loads?q=900196-1&include=${load.id}`, { headers: headers(emit) }),
    );
    const listed = await options.json();
    expect(listed.loads[0]).toMatchObject({ id: load.id, loadNumber: "900196-1", salesOrderNumber: "SO2196" });
    const optionKeys = new Set<string>();
    walkKeys(listed, optionKeys);
    for (const key of optionKeys) expect(key).not.toMatch(/carrier|customerCost|rateReason|staffNote|margin/i);
    expectNoSecrets(listed);

    const parts = splitMessageMentions("See SO2196 now", [{ token: "SO2196", orderId: load.id }]);
    expect(parts).toEqual([
      { text: "See ", orderId: null },
      { text: "SO2196", orderId: load.id },
      { text: " now", orderId: null },
    ]);
    expect(splitMessageMentions("SO21960", [{ token: "SO2196", orderId: load.id }])).toEqual([
      { text: "SO21960", orderId: null },
    ]);
  });

  it("has no carrier columns on the message tables", async () => {
    for (const table of ["messages", "message_threads", "message_thread_reads"]) {
      const columns = (await ctx.db.prepare(`PRAGMA table_info(${table})`).all()) as Array<{ name: string }>;
      for (const column of columns) {
        expect(column.name.toLowerCase()).not.toMatch(/carrier|customer_cost|rate_reason|staff_notes/);
      }
    }
  });
});

describe("unread counts and Select notification", () => {
  it("counts other people's messages once, including two saved at the same time", async () => {
    const emitCookie = await sessionCookie(customerSession());
    const viewerCookie = await sessionCookie(emitViewer());
    const selectCookie = await sessionCookie(adminSession());

    await markReadRoute(new Request("http://portal.test/api/messages/read", { method: "POST", headers: headers(emitCookie) }));
    await markReadRoute(new Request("http://portal.test/api/messages/read", { method: "POST", headers: headers(selectCookie) }));

    const first = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(emitCookie, true),
        body: JSON.stringify({ body: "First note" }),
      }),
    );
    const second = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(emitCookie, true),
        body: JSON.stringify({ body: "Second note" }),
      }),
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const sameTime = await ctx.db.prepare(`SELECT COUNT(DISTINCT created_at) AS n FROM messages WHERE body IN ('First note', 'Second note')`).get();
    expect(Number(sameTime?.n)).toBe(1);

    expect((await (await unreadRoute(new Request("http://portal.test/api/messages/unread", { headers: headers(emitCookie) }))).json()).count).toBe(0);
    expect((await (await unreadRoute(new Request("http://portal.test/api/messages/unread", { headers: headers(selectCookie) }))).json()).count).toBe(2);
    expect((await (await unreadRoute(new Request("http://portal.test/api/messages/unread", { headers: headers(viewerCookie) }))).json()).count).toBeGreaterThanOrEqual(2);

    const read = await markReadRoute(
      new Request("http://portal.test/api/messages/read", { method: "POST", headers: headers(selectCookie) }),
    );
    expect(read.status).toBe(200);
    expect((await (await unreadRoute(new Request("http://portal.test/api/messages/unread", { headers: headers(selectCookie) }))).json()).count).toBe(0);

    const preview = `${selectCookie}; portal_view_as=regular:view`;
    const previewRead = await markReadRoute(
      new Request("http://portal.test/api/messages/read", { method: "POST", headers: headers(preview) }),
    );
    expect(previewRead.status).toBe(403);

    await markReadRoute(new Request("http://portal.test/api/messages/read", { method: "POST", headers: headers(emitCookie) }));
    const reply = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(selectCookie, true),
        body: JSON.stringify({ body: "Select reply" }),
      }),
    );
    expect((await reply.json()).message.side).toBe("select");
    expect((await (await unreadRoute(new Request("http://portal.test/api/messages/unread", { headers: headers(selectCookie) }))).json()).count).toBe(0);
    expect((await (await unreadRoute(new Request("http://portal.test/api/messages/unread", { headers: headers(emitCookie) }))).json()).count).toBe(1);
  });

  it("notifies Slack with a load number, link, and preview, and does not send the rest", async () => {
    const load = (await ctx.db.prepare(`SELECT id FROM loads WHERE load_number = ?`).get("900196-1")) as { id: string };
    const emit = await sessionCookie(customerSession());
    const select = await sessionCookie(adminSession());
    const tail = "UNIQUE-TAIL-NOT-IN-PREVIEW";
    const body = `Please confirm the dock. ${"x".repeat(400)} ${tail}`;
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response("ok", { status: 200 });
    });
    process.env.SLACK_MESSAGES_WEBHOOK_URL = "https://hooks.slack.example/messages";
    process.env.MESSAGE_NOTIFY_EMAILS = "mike@goselect.com, drew@goselect.com, not-an-email";
    process.env.AI_API_KEY = "sk-test";
    process.env.AI_BASE_URL = "https://ai.example/v1";

    const created = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(emit, true),
        body: JSON.stringify({ body, loadId: load.id }),
      }),
    );
    expect(created.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://hooks.slack.example/messages");
    const text = JSON.parse(calls[0].body).text as string;
    expect(text).toContain("Load 900196-1");
    expect(text).toContain("SO2196");
    expect(text).toContain("Destination: Oklahoma City, OK");
    expect(text).toContain("Owner: <@U0CE02REJCB>");
    expect(text).toContain("http://portal.test/messages");
    expect(text).toContain("Please confirm the dock.");
    expect(text).not.toContain(tail);
    expect(text).not.toMatch(/carrier|8765|1500|\$/);
    expect(calls[0].body).toContain("<@U0CE02REJCB>");
    expect(calls[0].body).not.toContain("\\u003c");
    expect(calls[0].body).not.toContain("&lt;");
    expect(Object.keys(JSON.parse(calls[0].body))).toEqual(["text"]);

    const saved = (await ctx.db.prepare(`SELECT owner, stops_json FROM loads WHERE id = ?`).get(load.id)) as {
      owner: string | null;
      stops_json: string | null;
    };
    await ctx.db.prepare(`UPDATE loads SET owner = ?, stops_json = ? WHERE id = ?`).run(
      "Drew",
      JSON.stringify([
        { kind: "pickup", place: { city: "Sheridan", state: "WY", carrierPay: 8765 } },
        { kind: "drop", place: { city: "Midland", state: "TX", rate: 4.25 } },
        { kind: "drop", place: { city: "Pecos", state: "TX", company: "Final Dock", lineHaul: 1500 } },
      ]),
      load.id,
    );
    calls.length = 0;
    const multi = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(emit, true),
        body: JSON.stringify({ body: "Final stop is Pecos.", loadId: load.id }),
      }),
    );
    expect(multi.status).toBe(201);
    const multiBody = calls[0].body;
    const multiText = JSON.parse(multiBody).text as string;
    expect(multiText).toContain("Destination: Pecos, TX");
    expect(multiText).toContain("Owner: <@U0AGS6MDBL1>");
    expect(multiText).not.toContain("Midland");
    expect(multiText).not.toContain("Oklahoma City");
    expect(multiText).not.toMatch(/8765|1500|4\.25|carrier|lineHaul|\$/);
    expect(multiBody).toContain("<@U0AGS6MDBL1>");
    expect(multiBody).not.toContain("\\u003c");

    await ctx.db.prepare(`UPDATE loads SET owner = ? WHERE id = ?`).run("Mike", load.id);
    calls.length = 0;
    const mike = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(emit, true),
        body: JSON.stringify({ body: "Mike owns this one.", loadId: load.id }),
      }),
    );
    expect(mike.status).toBe(201);
    const mikeText = JSON.parse(calls[0].body).text as string;
    expect(mikeText).toContain("Owner: Mike");
    expect(mikeText).not.toContain("<@");

    await ctx.db.prepare(`UPDATE loads SET owner = NULL, stops_json = ? WHERE id = ?`).run("{", load.id);
    calls.length = 0;
    const blank = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(emit, true),
        body: JSON.stringify({ body: "No owner on this load.", loadId: load.id }),
      }),
    );
    expect(blank.status).toBe(201);
    const blankText = JSON.parse(calls[0].body).text as string;
    expect(blankText).toContain("Owner: unassigned");
    expect(blankText).toContain("Destination: Oklahoma City, OK");
    expect(blankText).not.toContain("<@");
    await ctx.db.prepare(`UPDATE loads SET owner = ?, stops_json = ? WHERE id = ?`).run(saved.owner, saved.stops_json, load.id);
    expect(calls[0].body.length).toBeLessThan(body.length);
    const preview = messagePreview(body);
    expect(preview.length).toBeLessThanOrEqual(MESSAGE_PREVIEW_LIMIT);
    expect(preview).not.toContain(tail);
    const draft = messageEmailDraft({
      authorName: "M. Gray",
      authorEmail: "m.gray@emit.example",
      loadNumber: "900196-1",
      salesOrderNumber: "SO2196",
      preview,
      threadUrl: "http://portal.test/messages",
    });
    expect(draft?.to).toEqual(["mike@goselect.com", "drew@goselect.com"]);
    expect(draft?.subject).toContain("900196-1");
    expect(draft?.text).toContain("http://portal.test/messages");
    expect(draft?.text).not.toContain(tail);
    expect(messageNoticeText({
      authorName: "M. Gray",
      authorEmail: "m.gray@emit.example",
      loadNumber: null,
      salesOrderNumber: null,
      preview: messagePreview("Call the office. Carrier pay is $8,765.43 to BLACKHAWK."),
      threadUrl: "http://portal.test/messages",
    })).not.toMatch(/8765|BLACKHAWK|carrier pay/i);

    calls.length = 0;
    const selectPost = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(select, true),
        body: JSON.stringify({ body: "Select already saw it" }),
      }),
    );
    expect(selectPost.status).toBe(201);
    expect(calls).toHaveLength(0);

    delete process.env.SLACK_MESSAGES_WEBHOOK_URL;
    const quiet = await postMessageRoute(
      new Request("http://portal.test/api/messages", {
        method: "POST",
        headers: headers(emit, true),
        body: JSON.stringify({ body: "No webhook configured" }),
      }),
    );
    expect(quiet.status).toBe(201);
    expect(calls).toHaveLength(0);
    expect(messageEmailDraft({
      authorName: "M. Gray",
      authorEmail: "m.gray@emit.example",
      loadNumber: null,
      salesOrderNumber: null,
      preview: "Hi",
      threadUrl: "/messages",
    }, {})).toBeNull();
  });
});

describe("message slack destination and owner", () => {
  const pecosDestination = JSON.stringify({
    company: "Acme Dock",
    address1: "1 Main",
    city: "Pecos",
    state: "tx",
    carrierPay: 8765,
    customerCost: 1500,
    rate: 4.25,
  });
  const singleStops = JSON.stringify([
    { kind: "pickup", place: { city: "Sheridan", state: "WY", carrierPay: 8765 } },
    { kind: "drop", place: { city: "Midland", state: "TX", lineHaul: 1500 } },
  ]);
  const multiStops = JSON.stringify([
    { kind: "pickup", place: { city: "Sheridan", state: "WY" } },
    { kind: "drop", place: { city: "Midland", state: "TX", carrier_pay: 8765, rate: "secret" } },
    { kind: "drop", place: { city: " Pecos ", state: " tx ", company: "Final Dock", lineHaul: 1500 } },
  ]);

  it("mentions Drew and Ainsley, and leaves an unmapped owner as plain text", () => {
    expect(messageOwnerLine("Drew", {})).toBe("Owner: <@U0AGS6MDBL1>");
    expect(messageOwnerLine("Ainsley", {})).toBe("Owner: <@U0CE02REJCB>");
    expect(messageOwnerLine(" drew ", {})).toBe("Owner: <@U0AGS6MDBL1>");
    expect(messageOwnerLine("AINSLEY", {})).toBe("Owner: <@U0CE02REJCB>");
    expect(messageOwnerLine("Drew", { SLACK_USER_ID_DREW: "U0OVERRIDE" })).toBe("Owner: <@U0OVERRIDE>");
    expect(messageOwnerLine("Ainsley", { SLACK_USER_ID_AINSLEY: "W0AINSLEY" })).toBe("Owner: <@W0AINSLEY>");
    expect(messageOwnerLine("Drew", { SLACK_USER_ID_DREW: "not an id" })).toBe("Owner: <@U0AGS6MDBL1>");
    expect(messageOwnerLine("Drew", { SLACK_USER_ID_DREW: "" })).toBe("Owner: <@U0AGS6MDBL1>");
    expect(messageOwnerLine(null, {})).toBe("Owner: unassigned");
    expect(messageOwnerLine("   ", {})).toBe("Owner: unassigned");
    expect(messageOwnerLine("Mike", {})).toBe("Owner: Mike");
    expect(messageOwnerLine("Mike Gray", {})).toBe("Owner: Mike Gray");
    expect(messageOwnerLine("Mike Gray", {})).not.toContain("<@");
  });

  it("formats a single destination from destination_json and a multi-stop load from the final stop", () => {
    expect(messageDestinationLabel(pecosDestination, singleStops)).toBe("Pecos, TX");
    expect(messageDestinationLabel(JSON.stringify({ city: "Midland", state: "TX" }), multiStops)).toBe("Pecos, TX");
    expect(messageDestinationLabel(pecosDestination, null)).toBe("Pecos, TX");
    expect(messageDestinationLabel(JSON.stringify({ city: "Pecos" }), null)).toBe("Pecos");
    expect(messageDestinationLabel(JSON.stringify({ state: "tx" }), null)).toBe("TX");
    expect(messageDestinationLabel("not json", "{")).toBe("");
    expect(messageDestinationLabel(null, null)).toBe("");
    const emptyFinal = JSON.stringify([
      { kind: "pickup", place: { city: "Sheridan", state: "WY" } },
      { kind: "drop", place: { city: "Midland", state: "TX" } },
      { kind: "drop", place: { city: " ", state: "" } },
    ]);
    expect(messageDestinationLabel(pecosDestination, emptyFinal)).toBe("Pecos, TX");
  });

  it("keeps the sales order in caps and leaves pay and rate fields out of the Slack text", async () => {
    const text = messageNoticeText(
      {
        authorName: "M. Gray",
        authorEmail: "m.gray@emit.example",
        loadNumber: "900196-1",
        salesOrderNumber: "so2196",
        destination: messageDestinationLabel(JSON.stringify({ city: "Midland", state: "TX", carrierPay: 8765 }), multiStops),
        owner: "Drew",
        preview: messagePreview("Dock is open. Carrier pay is $8,765.43. Rate confirmation attached."),
        threadUrl: "https://portal.example.com/messages",
      },
      {},
    );
    expect(text).toBe(
      [
        "New portal message from M. Gray (m.gray@emit.example)",
        "Load 900196-1 · SO2196",
        "Destination: Pecos, TX",
        "Owner: <@U0AGS6MDBL1>",
        "Dock is open.",
        "https://portal.example.com/messages",
      ].join("\n"),
    );
    expect(text).not.toMatch(/8765|1500|4\.25|BLACKHAWK|carrier|line haul|\$|\brate\b|Midland|secret/i);

    const unmapped = messageNoticeText(
      {
        authorName: "M. Gray",
        authorEmail: "m.gray@emit.example",
        loadNumber: null,
        salesOrderNumber: null,
        destination: "",
        owner: "Mike",
        preview: "Hi",
        threadUrl: "https://portal.example.com/messages",
      },
      {},
    );
    expect(unmapped).toContain("Destination: not set");
    expect(unmapped).toContain("Owner: Mike");
    expect(unmapped).not.toContain("<@");
    expect(messageNoticeText({
      authorName: "M. Gray",
      authorEmail: "m.gray@emit.example",
      loadNumber: null,
      salesOrderNumber: null,
      preview: "Hi",
      threadUrl: "/messages",
    }, {})).toContain("Owner: unassigned");

    const calls: string[] = [];
    const sent = await notifySelectOfEmitMessage(
      {
        authorName: "M. Gray",
        authorEmail: "m.gray@emit.example",
        loadNumber: "900196-1",
        salesOrderNumber: "SO2196",
        destination: "Pecos, TX",
        owner: "Ainsley",
        preview: "Please confirm the dock.",
        threadUrl: "https://portal.example.com/messages",
      },
      async (_url, init) => {
        calls.push(String(init?.body ?? ""));
        return new Response("ok", { status: 200 });
      },
      { SLACK_MESSAGES_WEBHOOK_URL: "https://hooks.slack.example/messages" },
    );
    expect(sent.slack).toBe(true);
    expect(calls[0]).toContain("<@U0CE02REJCB>");
    expect(calls[0]).not.toContain("\\u003c");
    expect(calls[0]).not.toContain("&lt;");
    expect(JSON.parse(calls[0])).toEqual({
      text: [
        "New portal message from M. Gray (m.gray@emit.example)",
        "Load 900196-1 · SO2196",
        "Destination: Pecos, TX",
        "Owner: <@U0CE02REJCB>",
        "Please confirm the dock.",
        "https://portal.example.com/messages",
      ].join("\n"),
    });

    const failed = await notifySelectOfEmitMessage(
      {
        authorName: "M. Gray",
        authorEmail: "m.gray@emit.example",
        loadNumber: null,
        salesOrderNumber: null,
        owner: "Mike",
        preview: "Hi",
        threadUrl: "/messages",
      },
      async () => {
        throw new Error("slack down");
      },
      { SLACK_MESSAGES_WEBHOOK_URL: "https://hooks.slack.example/messages" },
    );
    expect(failed.slack).toBe(false);
  });
});
