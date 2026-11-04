import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST as passwordLogin } from "@/app/api/auth/login/route";
import { GET as currentUser } from "@/app/api/me/route";
import { GET as listOrdersRoute } from "@/app/api/orders/route";
import { POST as selectSetup } from "@/app/api/auth/select-setup/route";
import type { PortalContext } from "@/lib/db";
import { setPasswordHash } from "@/lib/passwords";
import { seededPortal } from "./helpers";

const PASSWORD = "harbor-light-19";
const SETUP_KEY = "setup-key-0123456789";

let ctx: PortalContext;
let mikeId = "";
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  ctx = await seededPortal();
  for (const key of ["SELECT_SETUP_KEY", "SELECT_ADMIN_EMAILS"]) saved[key] = process.env[key];
  const row = await ctx.db.prepare(`SELECT id FROM users WHERE email = ?`).get("mgray@goselect.com");
  mikeId = String(row?.id ?? "");
  if (!mikeId) throw new Error("Seeded Select admin is missing");
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function headers(cookie = ""): HeadersInit {
  return { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" };
}

function login(email: string, password: string, cookie = "") {
  return passwordLogin(
    new Request("http://portal.test/api/auth/login", {
      method: "POST",
      headers: headers(cookie),
      body: JSON.stringify({ email, password }),
    }),
  );
}

async function resetMike(role: "admin" | "customer", email = "mgray@goselect.com") {
  await ctx.db
    .prepare(`UPDATE users SET role = ?, permission = ?, email = ?, active = 1 WHERE id = ?`)
    .run(role, role === "admin" ? null : "add", email, mikeId);
  await setPasswordHash(ctx, mikeId, PASSWORD);
}

function sessionCookie(response: Response): string {
  const cookies = response.headers.getSetCookie();
  const session = cookies.find((cookie) => cookie.startsWith("portal_session="));
  if (!session) throw new Error("login did not set a session");
  return session.split(";")[0];
}

describe("Select admin session after password sign-in", () => {
  it("keeps a listed admin when the stored email and SELECT_ADMIN_EMAILS differ by case and spaces", async () => {
    process.env.SELECT_ADMIN_EMAILS = " MGray@goselect.com , dmartin@goselect.com ";
    await resetMike("admin", " MGray@goselect.com ");
    const signedIn = await login("mgray@goselect.com", PASSWORD, "portal_view_as=regular:view");
    expect(signedIn.status).toBe(200);
    const body = await signedIn.json();
    expect(body.role).toBe("admin");
    expect(body.email).toBe("mgray@goselect.com");
    const cleared = signedIn.headers.getSetCookie().some((cookie) => /^portal_view_as=;/.test(cookie) && /Max-Age=0/i.test(cookie));
    expect(cleared).toBe(true);

    const me = await currentUser(
      new Request("http://portal.test/api/me", { headers: headers(sessionCookie(signedIn)) }),
    );
    expect(me.status).toBe(200);
    const profile = await me.json();
    expect(profile.role).toBe("admin");
    expect(profile.actorRole).toBe("admin");
    expect(profile.viewAs).toBeNull();
    const stored = await ctx.db.prepare(`SELECT email, role FROM users WHERE id = ?`).get(mikeId);
    expect(stored).toEqual({ email: "mgray@goselect.com", role: "admin" });
  });

  it("promotes a listed address that was stored as an EMIT user and then loads orders", async () => {
    process.env.SELECT_ADMIN_EMAILS = "mgray@goselect.com,dmartin@goselect.com";
    await resetMike("customer");
    const signedIn = await login("mgray@goselect.com", PASSWORD);
    expect(signedIn.status).toBe(200);
    expect((await signedIn.json()).role).toBe("admin");
    const stored = await ctx.db.prepare(`SELECT role, permission FROM users WHERE id = ?`).get(mikeId);
    expect(stored).toEqual({ role: "admin", permission: null });

    const me = await currentUser(
      new Request("http://portal.test/api/me", { headers: headers(sessionCookie(signedIn)) }),
    );
    const profile = await me.json();
    expect(profile.role).toBe("admin");
    expect(profile.actorRole).toBe("admin");

    const orders = await listOrdersRoute(
      new Request("http://portal.test/api/orders?page=1&pageSize=25", {
        headers: headers(sessionCookie(signedIn)),
      }),
    );
    const board = await orders.json();
    expect(orders.status, JSON.stringify(board)).toBe(200);
    expect(board.tab).toBe("attention");
    expect(board.orders.length).toBeGreaterThan(0);
    expect(JSON.stringify(board)).not.toMatch(/carrierPay|carrier_pay|staffNotes/);
  });

  it("sets the password on a listed EMIT row by promoting it, and leaves a real EMIT user alone", async () => {
    process.env.SELECT_ADMIN_EMAILS = "mgray@goselect.com,dmartin@goselect.com";
    process.env.SELECT_SETUP_KEY = SETUP_KEY;
    await resetMike("customer");
    const claimed = await selectSetup(
      new Request("http://portal.test/api/auth/select-setup", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ email: "MGray@goselect.com", password: PASSWORD, setupKey: SETUP_KEY }),
      }),
    );
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ ok: true, email: "mgray@goselect.com", created: false });
    expect((await ctx.db.prepare(`SELECT role FROM users WHERE id = ?`).get(mikeId))?.role).toBe("admin");

    const emit = await login("m.gray@emit.example", "Emit-Demo-2026");
    expect(emit.status).toBe(200);
    expect((await emit.json()).role).toBe("customer");
    const emitRow = await ctx.db.prepare(`SELECT role FROM users WHERE email = ?`).get("m.gray@emit.example");
    expect(emitRow?.role).toBe("customer");
  });

  it("lists loads when stage_log is missing and a row has unreadable JSON", async () => {
    process.env.SELECT_ADMIN_EMAILS = "mgray@goselect.com,dmartin@goselect.com";
    await resetMike("admin");
    const signedIn = await login("mgray@goselect.com", PASSWORD);
    await ctx.db.prepare(`UPDATE loads SET timeline_json = ?, origin_json = ? WHERE timeline_json IS NOT NULL`).run("not-json", "{");
    await ctx.db.exec(`ALTER TABLE loads DROP COLUMN stage_log`);
    const orders = await listOrdersRoute(
      new Request("http://portal.test/api/orders?page=1&pageSize=25", {
        headers: headers(sessionCookie(signedIn)),
      }),
    );
    const board = await orders.json();
    expect(orders.status, JSON.stringify(board)).toBe(200);
    expect(board.orders.length).toBeGreaterThan(0);
    const columns = (await ctx.db.prepare(`PRAGMA table_info(loads)`).all()).map((column) => String(column.name));
    expect(columns).toContain("stage_log");
  });
});
