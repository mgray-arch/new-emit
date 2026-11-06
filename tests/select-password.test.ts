import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST as createEmitUser } from "@/app/api/admin/users/route";
import { GET as listStaff, POST as createStaff } from "@/app/api/admin/staff/route";
import { POST as resetStaffPassword } from "@/app/api/admin/staff/[id]/password/route";
import { POST as passwordLogin } from "@/app/api/auth/login/route";
import { GET as providers } from "@/app/api/auth/providers/route";
import { POST as selectSetup } from "@/app/api/auth/select-setup/route";
import type { PortalContext } from "@/lib/db";
import { adminSession, customerSession, seededPortal, sessionCookie } from "./helpers";

const SETUP_KEY = "setup-key-0123456789";
const NEW_PASSWORD = "harbor-light-19";

let ctx: PortalContext;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  ctx = await seededPortal();
  for (const key of ["SELECT_SETUP_KEY", "SELECT_ADMIN_EMAILS"]) saved[key] = process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function headers(cookie = "", extra?: Record<string, string>): HeadersInit {
  return { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test", ...extra };
}

function login(email: string, password: string) {
  return passwordLogin(
    new Request("http://portal.test/api/auth/login", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ email, password }),
    }),
  );
}

describe("Select password sign-in", () => {
  it("removes Google sign-in and lets a seeded Select admin use email and password", async () => {
    expect(existsSync("app/api/auth/google/route.ts")).toBe(false);
    expect(existsSync("app/api/auth/google/callback/route.ts")).toBe(false);
    const page = readFileSync("app/login/page.tsx", "utf8");
    expect(page).not.toMatch(/Sign in with Google|api\/auth\/google/);
    expect(page).toMatch(/Email and password/);
    const listed = await providers(new Request("http://portal.test/api/auth/providers"));
    const payload = await listed.json();
    expect(payload.password).toBe(true);
    expect(payload.google).toBeUndefined();
    expect(payload.selectSetup).toBe(false);

    const emit = await login("m.gray@emit.example", "Emit-Demo-2026");
    expect(emit.status).toBe(200);
    expect((await emit.json()).role).toBe("customer");

    const select = await login("mgray@goselect.com", "Emit-Demo-2026");
    expect(select.status).toBe(200);
    const body = await select.json();
    expect(body.role).toBe("admin");
    expect(body.email).toBe("mgray@goselect.com");
  });

  it("sets the first Select password from the setup key, then an admin can add and reset staff", async () => {
    process.env.SELECT_ADMIN_EMAILS = "mgray@goselect.com,dmartin@goselect.com,ainsley@goselect.com";
    delete process.env.SELECT_SETUP_KEY;
    const closed = await selectSetup(
      new Request("http://portal.test/api/auth/select-setup", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ email: "ainsley@goselect.com", password: NEW_PASSWORD, setupKey: SETUP_KEY }),
      }),
    );
    expect(closed.status).toBe(404);

    process.env.SELECT_SETUP_KEY = "short";
    expect((await providers(new Request("http://portal.test/api/auth/providers"))).status).toBe(200);
    expect((await (await providers(new Request("http://portal.test/api/auth/providers"))).json()).selectSetup).toBe(false);

    process.env.SELECT_SETUP_KEY = SETUP_KEY;
    expect((await (await providers(new Request("http://portal.test/api/auth/providers"))).json()).selectSetup).toBe(true);

    const rejected = await selectSetup(
      new Request("http://portal.test/api/auth/select-setup", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ email: "ainsley@goselect.com", password: NEW_PASSWORD, setupKey: "wrong-key-0123456789" }),
      }),
    );
    expect(rejected.status).toBe(401);
    expect(await ctx.db.prepare(`SELECT id FROM users WHERE email = ?`).get("ainsley@goselect.com")).toBeUndefined();

    const emitAddress = await selectSetup(
      new Request("http://portal.test/api/auth/select-setup", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ email: "m.gray@emit.example", password: NEW_PASSWORD, setupKey: SETUP_KEY }),
      }),
    );
    expect(emitAddress.status).toBe(400);

    const claimed = await selectSetup(
      new Request("http://portal.test/api/auth/select-setup", {
        method: "POST",
        headers: headers("", { authorization: `Bearer ${SETUP_KEY}` }),
        body: JSON.stringify({ email: "ainsley@goselect.com", password: NEW_PASSWORD, name: "Ainsley" }),
      }),
    );
    expect(claimed.status).toBe(200);
    const claimedBody = await claimed.json();
    expect(claimedBody).toEqual({ ok: true, email: "ainsley@goselect.com", created: true });
    expect(JSON.stringify(claimedBody)).not.toContain(NEW_PASSWORD);
    const stored = await ctx.db.prepare(`SELECT role, password_hash FROM users WHERE email = ?`).get("ainsley@goselect.com");
    expect(stored?.role).toBe("admin");
    expect(String(stored?.password_hash)).toMatch(/^\$2[aby]\$/);
    expect(String(stored?.password_hash)).not.toContain(NEW_PASSWORD);

    const signedIn = await login("ainsley@goselect.com", NEW_PASSWORD);
    expect(signedIn.status).toBe(200);
    expect((await signedIn.json()).role).toBe("admin");

    const emitCookie = await sessionCookie(customerSession());
    const forbidden = await createStaff(
      new Request("http://portal.test/api/admin/staff", {
        method: "POST",
        headers: headers(emitCookie),
        body: JSON.stringify({ name: "Other", email: "other@goselect.com", password: NEW_PASSWORD }),
      }),
    );
    expect(forbidden.status).toBe(403);

    const admin = await sessionCookie(adminSession());
    const notListed = await createStaff(
      new Request("http://portal.test/api/admin/staff", {
        method: "POST",
        headers: headers(admin),
        body: JSON.stringify({ name: "Other", email: "other@goselect.com", password: NEW_PASSWORD }),
      }),
    );
    expect(notListed.status).toBe(400);

    const emitUser = await createEmitUser(
      new Request("http://portal.test/api/admin/users", {
        method: "POST",
        headers: headers(admin),
        body: JSON.stringify({ name: "Mike", email: "mgray@goselect.com", password: NEW_PASSWORD }),
      }),
    );
    expect(emitUser.status).toBe(400);

    const replaced = "second-harbor-19";
    const drew = await ctx.db.prepare(`SELECT id FROM users WHERE email = ?`).get("dmartin@goselect.com");
    await ctx.db.prepare(`UPDATE users SET password_hash = NULL WHERE id = ?`).run(String(drew?.id));
    const reset = await resetStaffPassword(
      new Request(`http://portal.test/api/admin/staff/${drew?.id}/password`, {
        method: "POST",
        headers: headers(admin),
        body: JSON.stringify({ password: replaced }),
      }),
      { params: Promise.resolve({ id: String(drew?.id) }) },
    );
    expect(reset.status).toBe(200);
    expect(JSON.stringify(await reset.json())).not.toContain(replaced);
    const drewLogin = await login("dmartin@goselect.com", replaced);
    expect(drewLogin.status).toBe(200);
    expect((await drewLogin.json()).role).toBe("admin");

    const listed = await listStaff(new Request("http://portal.test/api/admin/staff", { headers: headers(admin) }));
    const names = (await listed.json()).staff.map((person: { email: string }) => person.email);
    expect(names).toContain("ainsley@goselect.com");
    expect(names).toContain("mgray@goselect.com");
  });
});
