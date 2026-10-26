import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PATCH as setLoadNumber } from "@/app/api/admin/orders/[id]/load-number/route";
import { PATCH as setTrackingLink } from "@/app/api/admin/orders/[id]/tracking-link/route";
import { POST as resetPassword } from "@/app/api/admin/users/[id]/password/route";
import { PATCH as patchUser } from "@/app/api/admin/users/[id]/route";
import { GET as listUsers, POST as createUser } from "@/app/api/admin/users/route";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as providers } from "@/app/api/auth/providers/route";
import { GET as me } from "@/app/api/me/route";
import { POST as changePassword } from "@/app/api/me/password/route";
import { GET as getOrderRoute, PATCH as patchOrder } from "@/app/api/orders/[id]/route";
import { GET as receiverPortal } from "@/app/api/r/[token]/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { demoSeedEnabled, openDatabase, useTestPortal, type PortalContext } from "@/lib/db";
import { seedIfEmpty } from "@/lib/portal";
import { LOGIN_EMAIL_LIMIT } from "@/lib/passwords";
import { createReceiver } from "@/lib/receivers";
import { parseSelectLoadNumber, syncSelectLoadNumberFromSam, syncTrackingLinkFromSam } from "@/lib/select-load";
import { parseTrackingLink } from "@/lib/tracking-link";
import { portalPublicUrl } from "@/lib/public-url";
import { adminSession, customerSession, sessionCookie } from "./helpers";

let ctx: PortalContext;
const savedEnv = {
  DEMO_SEED: process.env.DEMO_SEED,
  NODE_ENV: process.env.NODE_ENV,
  PORTAL_PUBLIC_URL: process.env.PORTAL_PUBLIC_URL,
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL_URL: process.env.VERCEL_URL,
  VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ALLOW_PASSWORD_LOGIN: process.env.ALLOW_PASSWORD_LOGIN,
};

beforeAll(async () => {
  ctx = {
    db: await openDatabase(":memory:"),
    now: () => new Date(),
  };
  useTestPortal(ctx);
});

afterEach(() => {
  restore("DEMO_SEED", savedEnv.DEMO_SEED);
  restore("NODE_ENV", savedEnv.NODE_ENV);
  restore("PORTAL_PUBLIC_URL", savedEnv.PORTAL_PUBLIC_URL);
  restore("VERCEL_ENV", savedEnv.VERCEL_ENV);
  restore("VERCEL_URL", savedEnv.VERCEL_URL);
  restore("VERCEL_PROJECT_PRODUCTION_URL", savedEnv.VERCEL_PROJECT_PRODUCTION_URL);
  restore("ALLOW_PASSWORD_LOGIN", savedEnv.ALLOW_PASSWORD_LOGIN);
});

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function headers(cookie: string): HeadersInit {
  return { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" };
}

const route = {
  origin: { company: "EMIT Technologies", address1: "2437 Allen Avenue", city: "Sheridan", state: "WY", postalCode: "82801" },
  destination: { company: "Kodiak Gas Services", address1: "6801 Brooklyn Court", city: "Oklahoma City", state: "OK", postalCode: "73132" },
};

describe("production sign-in and an empty database", () => {
  it("does not seed users or the demo password when DEMO_SEED is false", async () => {
    process.env.DEMO_SEED = "false";
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    expect(demoSeedEnabled()).toBe(false);
    delete process.env.DEMO_SEED;
    expect(demoSeedEnabled()).toBe(false);
    process.env.DEMO_SEED = "false";
    const empty: PortalContext = { db: await openDatabase(":memory:"), now: () => new Date() };
    await seedIfEmpty(empty);
    const users = await empty.db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
    const loads = await empty.db.prepare(`SELECT COUNT(*) AS n FROM loads`).get();
    expect(Number(users?.n)).toBe(0);
    expect(Number(loads?.n)).toBe(0);
    const hint = await providers(new Request("http://portal.test/api/auth/providers"));
    expect((await hint.json()).demoHint).toBeNull();
  });

  it("does not seed production, and an empty preview says how to turn the test account on", async () => {
    process.env.DEMO_SEED = "true";
    process.env.VERCEL_ENV = "production";
    const empty: PortalContext = { db: await openDatabase(":memory:"), now: () => new Date() };
    await seedIfEmpty(empty);
    expect(Number((await empty.db.prepare(`SELECT COUNT(*) AS n FROM users`).get())?.n)).toBe(0);

    process.env.VERCEL_ENV = "preview";
    process.env.DEMO_SEED = "false";
    useTestPortal(empty);
    try {
      const response = await login(
        new Request("http://portal.test/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json", host: "portal.test", origin: "http://portal.test" },
          body: JSON.stringify({ email: "m.gray@emit.example", password: "Emit-Demo-2026" }),
        }),
      );
      expect(response.status).toBe(503);
      expect((await response.json()).error).toMatch(/no accounts/);
      const listed = await providers(new Request("http://portal.test/api/auth/providers"));
      const payload = await listed.json();
      expect(payload.google).toBe(false);
      expect(payload.setup.join(" ")).toMatch(/DEMO_SEED/);
    } finally {
      useTestPortal(ctx);
    }
  });

  it("names a missing AUTH_SECRET or Turso URL instead of a generic failure", async () => {
    const previousSecret = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    try {
      const response = await login(
        new Request("http://portal.test/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json", host: "portal.test", origin: "http://portal.test" },
          body: JSON.stringify({ email: "m.gray@emit.example", password: "Emit-Demo-2026" }),
        }),
      );
      expect(response.status).toBe(503);
      expect((await response.json()).error).toMatch(/AUTH_SECRET/);
    } finally {
      if (previousSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = previousSecret;
    }

    process.env.VERCEL = "1";
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    try {
      const listed = await providers(new Request("http://portal.test/api/auth/providers"));
      expect((await listed.json()).setup.join(" ")).toMatch(/TURSO_DATABASE_URL/);
      const page = readFileSync("app/login/page.tsx", "utf8");
      expect(page).toMatch(/Google sign-in isn't set up/);
      expect(page).toMatch(/EMIT staff/);
      expect(page).toMatch(/Select staff/);
    } finally {
      delete process.env.VERCEL;
    }
  });

  it("keeps password sign-in on with no break-glass flag and no Gmail sender", async () => {
    expect(existsSync("lib/email.ts")).toBe(false);
    const loginSource = readFileSync("app/api/auth/login/route.ts", "utf8");
    expect(loginSource).not.toMatch(/ALLOW_PASSWORD_LOGIN|passwordLoginAllowed|DEMO_SEED/);
    const lib = readdirSync("lib")
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(path.join("lib", name), "utf8"))
      .join("\n");
    expect(lib).not.toMatch(/gmail\.googleapis|GMAIL_CLIENT|GMAIL_REFRESH|EMAIL_FROM|sendOrderConfirmation|nextLoadNumber/);
    process.env.DEMO_SEED = "false";
    delete process.env.ALLOW_PASSWORD_LOGIN;
    const admin = await sessionCookie(adminSession());
    const created = await createUser(
      new Request("http://portal.test/api/admin/users", {
        method: "POST",
        headers: headers(admin),
        body: JSON.stringify({ name: "Pat Hale", email: "pat.hale@emit.example", password: "yard-door-19" }),
      }),
    );
    expect(created.status).toBe(201);
    const signedIn = await login(
      new Request("http://portal.test/api/auth/login", {
        method: "POST",
        headers: headers(""),
        body: JSON.stringify({ email: "pat.hale@emit.example", password: "yard-door-19" }),
      }),
    );
    expect(signedIn.status).toBe(200);
    expect((await signedIn.json()).role).toBe("customer");
  });

  it("locks an email after repeated failures, deactivates users, and lets them change a password", async () => {
    const admin = await sessionCookie(adminSession());
    const created = await createUser(
      new Request("http://portal.test/api/admin/users", {
        method: "POST",
        headers: headers(admin),
        body: JSON.stringify({ name: "Casey Ng", email: "casey.ng@emit.com", generatePassword: true }),
      }),
    );
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.temporaryPassword).toMatch(/^[A-Za-z0-9]{16}$/);
    const userId = body.user.id as string;

    const stranger = await createUser(
      new Request("http://portal.test/api/admin/users", {
        method: "POST",
        headers: headers(admin),
        body: JSON.stringify({ name: "Nope", email: "stranger@example.com", password: "yard-door-19" }),
      }),
    );
    expect(stranger.status).toBe(400);
    const selectAddress = await createUser(
      new Request("http://portal.test/api/admin/users", {
        method: "POST",
        headers: headers(admin),
        body: JSON.stringify({ name: "Mike", email: "mgray@goselect.com", password: "yard-door-19" }),
      }),
    );
    expect(selectAddress.status).toBe(400);

    const customerCookie = await sessionCookie(customerSession());
    const forbidden = await listUsers(new Request("http://portal.test/api/admin/users", { headers: { cookie: customerCookie } }));
    expect(forbidden.status).toBe(403);

    let lastStatus = 0;
    for (let attempt = 0; attempt < LOGIN_EMAIL_LIMIT; attempt += 1) {
      const failed = await login(
        new Request("http://portal.test/api/auth/login", {
          method: "POST",
          headers: { ...headers(""), "x-forwarded-for": "203.0.113.10" },
          body: JSON.stringify({ email: "casey.ng@emit.com", password: "wrong-password" }),
        }),
      );
      lastStatus = failed.status;
    }
    expect(lastStatus).toBe(429);
    const locked = await login(
      new Request("http://portal.test/api/auth/login", {
        method: "POST",
        headers: { ...headers(""), "x-forwarded-for": "203.0.113.10" },
        body: JSON.stringify({ email: "casey.ng@emit.com", password: body.temporaryPassword }),
      }),
    );
    expect(locked.status).toBe(429);

    const reset = await resetPassword(
      new Request(`http://portal.test/api/admin/users/${userId}/password`, {
        method: "POST",
        headers: headers(admin),
        body: JSON.stringify({ password: "new-yard-door" }),
      }),
      { params: Promise.resolve({ id: userId }) },
    );
    expect(reset.status).toBe(200);
    const signedIn = await login(
      new Request("http://portal.test/api/auth/login", {
        method: "POST",
        headers: { ...headers(""), "x-forwarded-for": "203.0.113.20" },
        body: JSON.stringify({ email: "casey.ng@emit.com", password: "new-yard-door" }),
      }),
    );
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.get("set-cookie")?.split(";")[0] ?? "";
    const changed = await changePassword(
      new Request("http://portal.test/api/me/password", {
        method: "POST",
        headers: headers(cookie),
        body: JSON.stringify({ currentPassword: "new-yard-door", newPassword: "newer-yard-door" }),
      }),
    );
    expect(changed.status).toBe(200);
    const stale = await me(new Request("http://portal.test/api/me", { headers: { cookie } }));
    expect(stale.status).toBe(401);
    const fresh = changed.headers.get("set-cookie")?.split(";")[0] ?? "";
    const stillIn = await me(new Request("http://portal.test/api/me", { headers: { cookie: fresh } }));
    expect(stillIn.status).toBe(200);

    const off = await patchUser(
      new Request(`http://portal.test/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ active: false }),
      }),
      { params: Promise.resolve({ id: userId }) },
    );
    expect((await off.json()).user.active).toBe(false);
    const blocked = await login(
      new Request("http://portal.test/api/auth/login", {
        method: "POST",
        headers: { ...headers(""), "x-forwarded-for": "203.0.113.30" },
        body: JSON.stringify({ email: "casey.ng@emit.com", password: "newer-yard-door" }),
      }),
    );
    expect(blocked.status).toBe(403);
  });
});

describe("Select load numbers", () => {
  it("accepts a SAM-style number and rejects anything else", () => {
    expect(parseSelectLoadNumber("458934-1")).toBe("458934-1");
    expect(parseSelectLoadNumber(" 900196-1 ")).toBe("900196-1");
    expect(parseSelectLoadNumber("458934")).toBeNull();
    expect(parseSelectLoadNumber("LOAD-1")).toBeNull();
    expect(parseSelectLoadNumber("12-1")).toBeNull();
  });

  it("leaves a new order pending until an admin enters the SAM number", async () => {
    const customer = await sessionCookie(customerSession());
    const created = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(customer),
        body: JSON.stringify({ salesOrderNumber: "SO-LIVE-1", ...route, loadNumber: "111111-1" }),
      }),
    );
    const order = (await created.json()).order;
    expect(order.loadNumber).toBeNull();

    const sneaky = await patchOrder(
      new Request(`http://portal.test/api/orders/${order.id}`, {
        method: "PATCH",
        headers: headers(customer),
        body: JSON.stringify({ loadNumber: "458934-1" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect((await sneaky.json()).order.loadNumber).toBeNull();
    const denied = await setLoadNumber(
      new Request(`http://portal.test/api/admin/orders/${order.id}/load-number`, {
        method: "PATCH",
        headers: headers(customer),
        body: JSON.stringify({ loadNumber: "458934-1" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(denied.status).toBe(403);

    const admin = await sessionCookie(adminSession());
    const bad = await setLoadNumber(
      new Request(`http://portal.test/api/admin/orders/${order.id}/load-number`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ loadNumber: "not-a-load" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(bad.status).toBe(400);

    const saved = await setLoadNumber(
      new Request(`http://portal.test/api/admin/orders/${order.id}/load-number`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ loadNumber: "458934-1" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect((await saved.json()).order.loadNumber).toBe("458934-1");
    const seen = await getOrderRoute(new Request(`http://portal.test/api/orders/${order.id}`, { headers: { cookie: customer } }), {
      params: Promise.resolve({ id: order.id }),
    });
    expect((await seen.json()).order.loadNumber).toBe("458934-1");

    const second = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(customer),
        body: JSON.stringify({ salesOrderNumber: "SO-LIVE-2", ...route }),
      }),
    );
    const other = (await second.json()).order;
    const duplicate = await setLoadNumber(
      new Request(`http://portal.test/api/admin/orders/${other.id}/load-number`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ loadNumber: "458934-1" }),
      }),
      { params: Promise.resolve({ id: other.id }) },
    );
    expect(duplicate.status).toBe(400);

    const synced = await syncSelectLoadNumberFromSam(ctx, other.id, {
      loads: [{ loadNumber: "458935-1", carrierCost: 8765.43 }],
    });
    expect(synced.loadNumber).toBe("458935-1");
    expect("carrierCost" in synced).toBe(false);
    expect(JSON.stringify(synced)).not.toMatch(/carrierCost|8765\.43|8,765/);
    const source = await ctx.db.prepare(`SELECT load_number_source FROM loads WHERE id = ?`).get(other.id);
    expect(source?.load_number_source).toBe("sam");
    const unchanged = await syncSelectLoadNumberFromSam(ctx, other.id, { loads: [{ transitStatus: "Open" }] });
    expect(unchanged.loadNumber).toBe("458935-1");

    const cleared = await setLoadNumber(
      new Request(`http://portal.test/api/admin/orders/${order.id}/load-number`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ loadNumber: "" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect((await cleared.json()).order.loadNumber).toBeNull();
  });

  it("stores a public tracking link an admin pastes, and a future SAM sync can fill the same field", async () => {
    expect(parseTrackingLink("javascript:alert(1)")).toBeNull();
    expect(parseTrackingLink("data:text/html,hi")).toBeNull();
    expect(parseTrackingLink("https://macropoint.example/share/abc")).toBe("https://macropoint.example/share/abc");

    const customer = await sessionCookie(customerSession());
    const receiverRecord = await createReceiver(ctx, { company: "Enchanted Rock LLC", contactEmails: ["ops@enchantedrock.example"] });
    const created = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(customer),
        body: JSON.stringify({
          salesOrderNumber: "SO-TRACK-1",
          origin: route.origin,
          destination: { company: "Enchanted Rock LLC", address1: "1", city: "Cypress", state: "TX", postalCode: "77429" },
        }),
      }),
    );
    const order = (await created.json()).order;
    expect(order.trackingLink).toBeNull();
    const denied = await setTrackingLink(
      new Request(`http://portal.test/api/admin/orders/${order.id}/tracking-link`, {
        method: "PATCH",
        headers: headers(customer),
        body: JSON.stringify({ trackingLink: "https://macropoint.example/share/abc" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(denied.status).toBe(403);

    const admin = await sessionCookie(adminSession());
    const bad = await setTrackingLink(
      new Request(`http://portal.test/api/admin/orders/${order.id}/tracking-link`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ trackingLink: "javascript:alert(1)" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(bad.status).toBe(400);

    const saved = await setTrackingLink(
      new Request(`http://portal.test/api/admin/orders/${order.id}/tracking-link`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ trackingLink: "https://macropoint.example/share/abc" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect((await saved.json()).order.trackingLink).toBe("https://macropoint.example/share/abc");
    const seen = await getOrderRoute(new Request(`http://portal.test/api/orders/${order.id}`, { headers: { cookie: customer } }), {
      params: Promise.resolve({ id: order.id }),
    });
    const seenBody = await seen.json();
    expect(seenBody.order.trackingLink).toBe("https://macropoint.example/share/abc");
    expect("customerCost" in seenBody.order).toBe(false);

    const receiver = await receiverPortal(new Request(`http://portal.test/api/r/${receiverRecord.token}`), {
      params: Promise.resolve({ token: receiverRecord.token }),
    });
    const match = (await receiver.json()).loads.find((load: { salesOrderNumber: string }) => load.salesOrderNumber === "SO-TRACK-1");
    expect(match.trackingLink).toBe("https://macropoint.example/share/abc");
    expect(match.customerCost).toBeUndefined();

    const synced = await syncTrackingLinkFromSam(ctx, order.id, {
      loads: [{ tracking: { shareUrl: "https://macropoint.example/share/next" }, carrierCost: 8765.43 }],
    });
    expect(synced.trackingLink).toBe("https://macropoint.example/share/next");
    expect(JSON.stringify(synced)).not.toMatch(/carrierCost|8765/);
    const source = await ctx.db.prepare(`SELECT tracking_link_source FROM loads WHERE id = ?`).get(order.id);
    expect(source?.tracking_link_source).toBe("sam");
    const unchanged = await syncTrackingLinkFromSam(ctx, order.id, { loads: [{ transitStatus: "Open" }] });
    expect(unchanged.trackingLink).toBe("https://macropoint.example/share/next");

    const cleared = await setTrackingLink(
      new Request(`http://portal.test/api/admin/orders/${order.id}/tracking-link`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ trackingLink: "" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect((await cleared.json()).order.trackingLink).toBeNull();
  });

  it("keeps an existing load number when an older database is opened", async () => {
    const file = path.join(tmpdir(), `emit-migrate-${Date.now()}.db`);
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE loads (
        id TEXT PRIMARY KEY,
        sales_order_number TEXT NOT NULL,
        load_number TEXT NOT NULL UNIQUE,
        portal_status TEXT NOT NULL,
        tracking_stage TEXT NOT NULL,
        timeline_json TEXT NOT NULL,
        origin_json TEXT NOT NULL,
        destination_json TEXT NOT NULL,
        truck_type TEXT,
        transit TEXT,
        ship_date TEXT,
        ship_time TEXT,
        must_deliver_date TEXT,
        truck_eta TEXT,
        latest_eta TEXT,
        tracking_token TEXT NOT NULL UNIQUE,
        customer_cost_cents INTEGER,
        rate_reason TEXT,
        comments TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pending_review_count INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO loads (
        id, sales_order_number, load_number, portal_status, tracking_stage, timeline_json,
        origin_json, destination_json, tracking_token, comments, created_by, created_at, updated_at
      ) VALUES (
        'old-1', 'SO-OLD', '458900-1', 'being_prepared', 'submitted', '[]',
        '{"company":"EMIT","address1":"1","city":"Sheridan","state":"WY","postalCode":"82801","country":"US"}',
        '{"company":"Kodiak","address1":"2","city":"Oklahoma City","state":"OK","postalCode":"73132","country":"US"}',
        'token-old-1', '', 'M. Gray', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
      );
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('customer', 'admin')),
        password_hash TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE customer_documents (
        id TEXT PRIMARY KEY,
        load_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        filename TEXT NOT NULL,
        media_type TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE internal_documents (
        id TEXT PRIMARY KEY,
        load_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        screen_result TEXT NOT NULL,
        screen_reason TEXT NOT NULL,
        review_status TEXT NOT NULL,
        filename TEXT NOT NULL,
        media_type TEXT NOT NULL,
        page_index INTEGER NOT NULL,
        page_count INTEGER NOT NULL,
        text_excerpt TEXT,
        storage_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    raw.close();
    const upgraded = await openDatabase(file);
    const load = await upgraded.prepare(`SELECT load_number, load_number_source FROM loads WHERE id = ?`).get("old-1");
    expect(load?.load_number).toBe("458900-1");
    expect(load?.load_number_source).toBeNull();
    await upgraded.prepare(`INSERT INTO loads (
      id, sales_order_number, load_number, portal_status, tracking_stage, timeline_json,
      origin_json, destination_json, tracking_token, comments, created_by, created_at, updated_at
    ) VALUES ('old-2', 'SO-NEW', NULL, 'being_prepared', 'submitted', '[]', '{}', '{}', 'token-old-2', '', 'M. Gray', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')`).run();
    const pending = await upgraded.prepare(`SELECT load_number FROM loads WHERE id = ?`).get("old-2");
    expect(pending?.load_number).toBeNull();
    const columns = (await upgraded.prepare(`PRAGMA table_info(users)`).all()) as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["active", "password_epoch", "chat_enabled"]));
    const fresh = await upgraded.prepare(`SELECT chat_enabled FROM users WHERE email = ?`).get("lead@emit.example");
    if (!fresh) {
      await upgraded
        .prepare(`INSERT INTO users (id, email, name, role, created_at) VALUES ('u-chat', 'chat.off@emit.example', 'Off', 'customer', '2026-10-02T00:00:00.000Z')`)
        .run();
    }
    const chatFlag = await upgraded
      .prepare(`SELECT chat_enabled FROM users WHERE email IN ('lead@emit.example', 'chat.off@emit.example')`)
      .get();
    expect(Number(chatFlag?.chat_enabled ?? 0)).toBe(0);
    const loadColumns = (await upgraded.prepare(`PRAGMA table_info(loads)`).all()) as Array<{ name: string }>;
    expect(loadColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["tracking_link", "tracking_link_source", "sam_build_status", "sam_build_error", "sam_build_at", "owner", "owner_needs_check"]),
    );
    const customerDocs = (await upgraded.prepare(`PRAGMA table_info(customer_documents)`).all()) as Array<{ name: string }>;
    const internalDocs = (await upgraded.prepare(`PRAGMA table_info(internal_documents)`).all()) as Array<{ name: string }>;
    expect(customerDocs.map((column) => column.name)).toContain("uploaded_by");
    expect(internalDocs.map((column) => column.name)).toContain("uploaded_by");
    expect(await upgraded.prepare(`SELECT name FROM sqlite_master WHERE name = 'document_uploads'`).get()).toBeTruthy();
    await upgraded
      .prepare(`INSERT INTO users (id, email, name, role, created_at) VALUES ('u-emit', 'lead@emit.example', 'Lead', 'emit_admin', '2026-10-02T00:00:00.000Z')`)
      .run();
    const emitAdmin = await upgraded.prepare(`SELECT role FROM users WHERE id = ?`).get("u-emit");
    expect(emitAdmin?.role).toBe("emit_admin");
    await upgraded
      .prepare(`INSERT INTO users (id, email, name, role, created_at) VALUES ('u-view', 'viewer@emit.example', 'View', 'emit_viewer', '2026-10-02T00:00:00.000Z')`)
      .run();
    const viewer = await upgraded.prepare(`SELECT role FROM users WHERE id = ?`).get("u-view");
    expect(viewer?.role).toBe("emit_viewer");
    rmSync(file, { force: true });
  });

  it("builds public links from the custom domain", () => {
    process.env.PORTAL_PUBLIC_URL = "https://portal.example.com/";
    expect(portalPublicUrl()).toBe("https://portal.example.com");
    delete process.env.PORTAL_PUBLIC_URL;
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "portal.example.com";
    process.env.VERCEL_URL = "emit-portal-abc123.vercel.app";
    expect(portalPublicUrl()).toBe("https://portal.example.com");
  });
});
