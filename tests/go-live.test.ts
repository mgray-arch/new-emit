import { beforeAll, describe, expect, it } from "vitest";
import { POST as changePassword } from "@/app/api/account/password/route";
import { PATCH as patchUser } from "@/app/api/admin/users/[id]/route";
import { GET as listUsers, POST as createUser } from "@/app/api/admin/users/route";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as listOrdersRoute, POST as createOrderRoute } from "@/app/api/orders/route";
import { GET as getOrderRoute, PATCH as patchOrder } from "@/app/api/orders/[id]/route";
import { assertNoCarrierFields } from "@/lib/customer-view";
import { demoSeedEnabled, openDatabase, type PortalContext } from "@/lib/db";
import { applyDemoSeed } from "@/lib/portal";
import { getOrder, syncSelectLoadNumberFromSam } from "@/lib/orders";
import { hashPassword, loginWithPassword } from "@/lib/passwords";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;

function setNodeEnv(value: string | undefined) {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
}

beforeAll(async () => {
  ctx = await seededPortal();
});

const orderBody = {
  salesOrderNumber: "SO-LIVE-1",
  origin: { company: "EMIT Technologies", address1: "2437 Allen Avenue", city: "Sheridan", state: "WY", postalCode: "82801" },
  destination: { company: "Kodiak Gas Services", address1: "6801 Brooklyn Court", city: "Oklahoma City", state: "OK", postalCode: "73132" },
  shipDate: "2026-10-22",
  customerCost: 1800,
};

function post(url: string, cookie: string | null, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", host: "portal.test" };
  if (cookie) headers.cookie = cookie;
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

function sessionFrom(response: Response): string {
  const pair = (response.headers.get("set-cookie") ?? "").split(";")[0];
  if (!pair.startsWith("portal_session=")) throw new Error("missing session cookie");
  return pair;
}

describe("Select load numbers", () => {
  it("stays pending until a Select admin enters the SAM number", async () => {
    const customer = await sessionCookie(customerSession());
    const admin = await sessionCookie(adminSession());
    const created = await createOrderRoute(post("http://portal.test/api/orders", customer, orderBody));
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.order.loadNumber).toBeNull();
    expect(body.confirmation).toBeUndefined();
    expectNoSecrets(body);
    assertNoCarrierFields(body.order);

    const denied = await patchOrder(
      new Request(`http://portal.test/api/orders/${body.order.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: customer, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({ loadNumber: "458934-1" }),
      }),
      { params: Promise.resolve({ id: body.order.id }) },
    );
    expect(denied.status).toBe(403);
    expect((await getOrder(ctx, body.order.id))?.loadNumber).toBeNull();

    const invalid = await patchOrder(
      new Request(`http://portal.test/api/orders/${body.order.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: admin, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({ loadNumber: "load-1" }),
      }),
      { params: Promise.resolve({ id: body.order.id }) },
    );
    expect(invalid.status).toBe(400);

    const assigned = await patchOrder(
      new Request(`http://portal.test/api/orders/${body.order.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: admin, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({ loadNumber: "458934 - 1" }),
      }),
      { params: Promise.resolve({ id: body.order.id }) },
    );
    expect(assigned.status).toBe(200);
    const assignedBody = await assigned.json();
    expect(assignedBody.order.loadNumber).toBe("458934-1");
    expect(assignedBody.order.loadNumberSource).toBeUndefined();
    expectNoSecrets(assignedBody);
    assertNoCarrierFields(assignedBody.order);
    const source = await ctx.db.prepare(`SELECT load_number_source FROM loads WHERE id = ?`).get(body.order.id);
    expect(source?.load_number_source).toBe("manual");

    const visible = await getOrderRoute(new Request(`http://portal.test/api/orders/${body.order.id}`, { headers: { cookie: customer } }), {
      params: Promise.resolve({ id: body.order.id }),
    });
    expect((await visible.json()).order.loadNumber).toBe("458934-1");

    const other = await createOrderRoute(
      post("http://portal.test/api/orders", customer, { ...orderBody, salesOrderNumber: "SO-LIVE-2" }),
    );
    const otherId = (await other.json()).order.id as string;
    const duplicate = await patchOrder(
      new Request(`http://portal.test/api/orders/${otherId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: admin, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({ loadNumber: "900196-1" }),
      }),
      { params: Promise.resolve({ id: otherId }) },
    );
    expect(duplicate.status).toBe(409);
    expect((await getOrder(ctx, otherId))?.loadNumber).toBeNull();

    const cleared = await patchOrder(
      new Request(`http://portal.test/api/orders/${body.order.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: admin, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({ loadNumber: "" }),
      }),
      { params: Promise.resolve({ id: body.order.id }) },
    );
    expect((await cleared.json()).order.loadNumber).toBeNull();
  });

  it("can be filled later from a SAM payload without copying carrier pay", async () => {
    const customer = await sessionCookie(customerSession());
    const created = await createOrderRoute(
      post("http://portal.test/api/orders", customer, { ...orderBody, salesOrderNumber: "SO-SAM-SYNC" }),
    );
    const order = (await created.json()).order;
    await expect(
      syncSelectLoadNumberFromSam(ctx, order.id, { loads: [{ loadNumber: "not-a-load", carrierPay: 8765.43 }] }, adminSession()),
    ).rejects.toThrow(/SAM did not return/);
    expect((await getOrder(ctx, order.id))?.loadNumber).toBeNull();

    const synced = await syncSelectLoadNumberFromSam(
      ctx,
      order.id,
      {
        customerRate: 1800,
        carrierCost: 8765.43,
        loads: [{ loadNumber: "458934-2", carrierPay: 8765.43, carrierRate: 400, carrier_name: "BLACKHAWK" }],
      },
      adminSession(),
    );
    expect(synced.loadNumber).toBe("458934-2");
    expectNoSecrets(synced);
    assertNoCarrierFields(synced);
    expect(JSON.stringify(synced)).not.toMatch(/carrierPay|carrierRate|carrier_name/);
    const source = await ctx.db.prepare(`SELECT load_number_source FROM loads WHERE id = ?`).get(order.id);
    expect(source?.load_number_source).toBe("sam");
  });
});

describe("EMIT password accounts", () => {
  it("lets EMIT sign in with a password when demo seed and the old break-glass flag are off", async () => {
    const previousNode = process.env.NODE_ENV;
    const previousSeed = process.env.DEMO_SEED;
    const previousAllow = process.env.ALLOW_PASSWORD_LOGIN;
    process.env.DEMO_SEED = "false";
    delete process.env.ALLOW_PASSWORD_LOGIN;
    try {
      const response = await login(
        post("http://portal.test/api/auth/login", null, { email: "m.gray@emit.example", password: "Emit-Demo-2026" }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.role).toBe("customer");
      expect(body.mustChangePassword).toBe(false);

      setNodeEnv("production");
      const direct = await loginWithPassword(ctx, "m.gray@emit.example", "Emit-Demo-2026", "203.0.113.4");
      expect(direct.ok).toBe(true);
    } finally {
      setNodeEnv(previousNode);
      if (previousSeed === undefined) delete process.env.DEMO_SEED;
      else process.env.DEMO_SEED = previousSeed;
      if (previousAllow === undefined) delete process.env.ALLOW_PASSWORD_LOGIN;
      else process.env.ALLOW_PASSWORD_LOGIN = previousAllow;
    }
  });

  it("lets a Select admin create, reset, and deactivate an EMIT user", async () => {
    const admin = await sessionCookie(adminSession());
    const customer = await sessionCookie(customerSession());
    const forbidden = await createUser(post("http://portal.test/api/admin/users", customer, { name: "Nope", email: "nope@emit.example" }));
    expect(forbidden.status).toBe(403);

    const selectStaff = await createUser(
      post("http://portal.test/api/admin/users", admin, { name: "Mike", email: "mgray@goselect.com", generatePassword: true }),
    );
    expect(selectStaff.status).toBe(400);

    const created = await createUser(
      post("http://portal.test/api/admin/users", admin, { name: "Pat EMIT", email: "pat@emit.example", generatePassword: true }),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.user.email).toBe("pat@emit.example");
    expect(createdBody.user.active).toBe(true);
    expect(createdBody.user.mustChangePassword).toBe(true);
    expect(createdBody.temporaryPassword).toMatch(/^[A-Za-z0-9]+(-[A-Za-z0-9]+){3}$/);
    expect(JSON.stringify(createdBody)).not.toMatch(/\$2[aby]\$/);
    expectNoSecrets(createdBody);

    const listed = await listUsers(new Request("http://portal.test/api/admin/users", { headers: { cookie: admin } }));
    const listedBody = await listed.json();
    expect(listedBody.users.some((user: { email: string }) => user.email === "pat@emit.example")).toBe(true);
    expect(JSON.stringify(listedBody)).not.toMatch(/\$2[aby]\$|temporaryPassword/);

    const signedIn = await login(
      post("http://portal.test/api/auth/login", null, { email: "pat@emit.example", password: createdBody.temporaryPassword }),
    );
    expect(signedIn.status).toBe(200);
    expect((await signedIn.json()).mustChangePassword).toBe(true);
    const cookie = sessionFrom(signedIn);
    const changed = await changePassword(
      post("http://portal.test/api/account/password", cookie, {
        currentPassword: createdBody.temporaryPassword,
        newPassword: "Emit-staff-2026",
      }),
    );
    expect(changed.status).toBe(200);
    const oldPassword = await login(
      post("http://portal.test/api/auth/login", null, { email: "pat@emit.example", password: createdBody.temporaryPassword }),
    );
    expect(oldPassword.status).toBe(401);
    const newPassword = await login(
      post("http://portal.test/api/auth/login", null, { email: "pat@emit.example", password: "Emit-staff-2026" }),
    );
    expect(newPassword.status).toBe(200);
    expect((await newPassword.json()).mustChangePassword).toBe(false);

    const reset = await patchUser(
      new Request(`http://portal.test/api/admin/users/${createdBody.user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: admin, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({ password: "Another-pass-2026" }),
      }),
      { params: Promise.resolve({ id: createdBody.user.id }) },
    );
    expect(reset.status).toBe(200);
    expect((await reset.json()).temporaryPassword).toBe("Another-pass-2026");
    const resetLogin = await login(
      post("http://portal.test/api/auth/login", null, { email: "pat@emit.example", password: "Another-pass-2026" }),
    );
    expect(resetLogin.status).toBe(200);

    const deactivated = await patchUser(
      new Request(`http://portal.test/api/admin/users/${createdBody.user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: admin, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({ active: false }),
      }),
      { params: Promise.resolve({ id: createdBody.user.id }) },
    );
    expect(deactivated.status).toBe(200);
    const blockedLogin = await login(
      post("http://portal.test/api/auth/login", null, { email: "pat@emit.example", password: "Another-pass-2026" }),
    );
    expect(blockedLogin.status).toBe(403);
    const stale = await listOrdersRoute(
      new Request("http://portal.test/api/orders", { headers: { cookie: sessionFrom(resetLogin) } }),
    );
    expect(stale.status).toBe(401);
  });

  it("locks an email after repeated failures and unlocks when the window passes", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await login(
        post("http://portal.test/api/auth/login", null, { email: "missing@emit.example", password: "wrong-password" }),
      );
      expect(response.status).toBe(401);
    }
    const locked = await login(
      post("http://portal.test/api/auth/login", null, { email: "missing@emit.example", password: "wrong-password" }),
    );
    expect(locked.status).toBe(429);
    const otherAddress = await login(
      new Request("http://portal.test/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "portal.test",
          "x-forwarded-for": "203.0.113.50",
        },
        body: JSON.stringify({ email: "missing@emit.example", password: "still-wrong" }),
      }),
    );
    expect(otherAddress.status).toBe(429);

    let now = new Date("2026-10-21T12:00:00Z");
    const local: PortalContext = { db: await openDatabase(":memory:"), now: () => now };
    await local.db
      .prepare(
        `INSERT INTO users (id, email, name, role, password_hash, active, must_change_password, created_at)
         VALUES (?, ?, ?, 'customer', ?, 1, 0, ?)`,
      )
      .run("user-lock", "lock@emit.example", "Lock", hashPassword("correct-horse-1"), now.toISOString());
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await loginWithPassword(local, "lock@emit.example", "nope", "203.0.113.9");
      expect(failed.ok).toBe(false);
    }
    const stillLocked = await loginWithPassword(local, "lock@emit.example", "correct-horse-1", "203.0.113.9");
    expect(stillLocked).toMatchObject({ ok: false, status: 429 });
    now = new Date(now.getTime() + 16 * 60 * 1000);
    const allowed = await loginWithPassword(local, "lock@emit.example", "correct-horse-1", "203.0.113.9");
    expect(allowed.ok).toBe(true);

    for (let index = 0; index < 20; index += 1) {
      await local.db
        .prepare(`INSERT INTO login_attempts (id, email, ip, created_at) VALUES (?, ?, ?, ?)`)
        .run(`ip-${index}`, `other${index}@example.com`, "198.51.100.10", now.toISOString());
    }
    const ipLocked = await loginWithPassword(local, "fresh@emit.example", "correct-horse-1", "198.51.100.10");
    expect(ipLocked).toMatchObject({ ok: false, status: 429 });
  });
});

describe("production seed", () => {
  it("leaves the database empty when DEMO_SEED is false", async () => {
    const previousSeed = process.env.DEMO_SEED;
    const previousNode = process.env.NODE_ENV;
    try {
      process.env.DEMO_SEED = "false";
      setNodeEnv("development");
      expect(demoSeedEnabled()).toBe(false);
      setNodeEnv("production");
      expect(demoSeedEnabled()).toBe(false);
      delete process.env.DEMO_SEED;
      expect(demoSeedEnabled()).toBe(false);
      process.env.DEMO_SEED = "false";
      const db = await openDatabase(":memory:");
      await applyDemoSeed({ db, now: () => new Date("2026-10-21T00:00:00Z") });
      const users = await db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
      const loads = await db.prepare(`SELECT COUNT(*) AS n FROM loads`).get();
      expect(Number(users?.n)).toBe(0);
      expect(Number(loads?.n)).toBe(0);
    } finally {
      if (previousSeed === undefined) delete process.env.DEMO_SEED;
      else process.env.DEMO_SEED = previousSeed;
      setNodeEnv(previousNode);
    }
  });
});
