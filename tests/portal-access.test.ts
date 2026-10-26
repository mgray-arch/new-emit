import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as microsoftCallback } from "@/app/api/auth/microsoft/callback/route";
import { POST as buildLoad } from "@/app/api/admin/orders/[id]/build/route";
import { PATCH as patchUser, } from "@/app/api/admin/users/[id]/route";
import { GET as listUsers, POST as createUser } from "@/app/api/admin/users/route";
import { POST as samCallback } from "@/app/api/integrations/sam-load/route";
import { GET as getOrderRoute, } from "@/app/api/orders/[id]/route";
import { GET as listOrdersRoute, POST as createOrderRoute } from "@/app/api/orders/route";
import { PATCH as patchLocation } from "@/app/api/locations/[id]/route";
import { POST as changePassword } from "@/app/api/me/password/route";
import { POST as setViewAs } from "@/app/api/view-as/route";
import { presentCustomerOrder } from "@/lib/customer-view";
import type { PortalContext } from "@/lib/db";
import { loadBuilderPayload } from "@/lib/load-builder";
import { samLoadUrl } from "@/lib/sam-link";
import type { CustomerOrder, Session } from "@/lib/types";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

const SECRET = "builder-secret-0123456789";
const WEBHOOK = "https://builder.test/hooks/load";

let ctx: PortalContext;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  ctx = await seededPortal();
  for (const key of ["LOAD_BUILDER_WEBHOOK_URL", "LOAD_BUILDER_SECRET", "SAM_LOAD_URL_TEMPLATE", "AZURE_AD_TENANT_ID", "AZURE_AD_CLIENT_ID", "AZURE_AD_CLIENT_SECRET"]) {
    savedEnv[key] = process.env[key];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.LOAD_BUILDER_WEBHOOK_URL = WEBHOOK;
  process.env.LOAD_BUILDER_SECRET = SECRET;
  process.env.SAM_LOAD_URL_TEMPLATE = "https://sam.example/loads/{loadNumber}";
});

afterAll(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function headers(cookie: string): HeadersInit {
  return { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" };
}

async function cookieFor(session: Session, viewAs?: string): Promise<string> {
  const sessionPart = await sessionCookie(session);
  return viewAs ? `${sessionPart}; portal_view_as=${viewAs}` : sessionPart;
}

const lane = {
  origin: { company: "EMIT ALLEN", address1: "2437 Allen Avenue", city: "Sheridan", state: "WY", postalCode: "82801" },
  destination: { company: "Johnson Thermal", address1: "100 Market", city: "Denver", state: "CO", postalCode: "80202" },
};

async function createLoad(salesOrderNumber: string, cookie: string) {
  const response = await createOrderRoute(
    new Request("http://portal.test/api/orders", {
      method: "POST",
      headers: headers(cookie),
      body: JSON.stringify({ salesOrderNumber, ...lane, customerCost: 1750, comments: "Portal build" }),
    }),
  );
  const body = await response.json();
  return { status: response.status, order: body.order as CustomerOrder, error: body.error as string | undefined };
}

describe("EMIT permissions and view-as", () => {
  it("strips pricing, review counts, and SAM build fields unless the effective role may see them", () => {
    const stored = {
      id: "1",
      salesOrderNumber: "SO2196",
      loadNumber: "900196-1",
      portalStatus: "shipped",
      trackingStage: "in_transit",
      customerCost: 1500,
      rateReason: "Team",
      pendingReviewCount: 4,
      samBuildStatus: "building",
      samBuildError: "nope",
      samBuildAt: "2026-10-14T18:00:00.000Z",
      samUrl: "https://sam.example/loads/900196-1",
      carrierPay: 8765.43,
      comments: "",
      createdBy: "M. Gray",
      enteredByName: "Jane Doe",
      enteredByEmail: "jane@emit.example",
      createdAt: "2026-10-14T18:00:00.000Z",
      updatedAt: "2026-10-14T18:00:00.000Z",
      attachmentCount: 0,
      bolCount: 0,
      documents: [],
      timeline: [],
      stops: [],
      origin: lane.origin,
      destination: lane.destination,
    } as unknown as CustomerOrder;
    for (const role of ["customer", "emit_viewer", "emit_admin"]) {
      const view = presentCustomerOrder(stored, role);
      expect(view.enteredByName).toBe("Jane Doe");
      expect(view.enteredByEmail).toBe("jane@emit.example");
      expect(view.pendingReviewCount).toBeUndefined();
      expect(JSON.stringify(view)).not.toMatch(/samBuild|samUrl|pendingReviewCount|carrierPay|8765/);
      expectNoSecrets(view);
    }
    for (const permission of ["view", "add", "pricing", "full"] as const) {
      const view = presentCustomerOrder(stored, {
        role: permission === "full" ? "emit_admin" : "customer",
        permission,
      });
      expect(view.enteredByName).toBe("Jane Doe");
      expect(view.enteredByEmail).toBe("jane@emit.example");
      expect(view.pendingReviewCount).toBeUndefined();
      expect(view.samBuildStatus).toBeUndefined();
      if (permission === "full") expect(view.customerCost).toBe(1500);
      else expect(view.customerCost).toBeUndefined();
      expect(JSON.stringify(view)).not.toMatch(/carrierPay|carrier_pay|8765/);
    }
    expect(presentCustomerOrder(stored, "customer").customerCost).toBeUndefined();
    expect(presentCustomerOrder(stored, "emit_viewer").customerCost).toBeUndefined();
    expect(presentCustomerOrder(stored, "emit_admin").customerCost).toBe(1500);
    const pricingOnly = presentCustomerOrder(stored, { role: "customer", permission: "pricing" });
    expect(pricingOnly.customerCost).toBeUndefined();
    expect("rateReason" in pricingOnly).toBe(false);
    expect(JSON.stringify(pricingOnly)).not.toMatch(/carrierPay|carrier_pay|8765|customerCost|rateReason/);
    expect(presentCustomerOrder(stored, { role: "emit_admin", permission: "view" }).customerCost).toBeUndefined();
    const preview = presentCustomerOrder(stored, { role: "admin", viewAs: { access: "regular", permission: "pricing" } });
    expect(preview.enteredByName).toBe("Jane Doe");
    expect(preview.enteredByEmail).toBe("jane@emit.example");
    expect(preview.customerCost).toBeUndefined();
    expect("rateReason" in preview).toBe(false);
    expect(preview.pendingReviewCount).toBeUndefined();
    expect(preview.samBuildStatus).toBeUndefined();
    expect(JSON.stringify(preview)).not.toMatch(/carrierPay|carrier_pay|8765/);
    const viewOnlyPreview = presentCustomerOrder(stored, { role: "admin", viewAs: { access: "admin", permission: "view" } });
    expect(viewOnlyPreview.enteredByEmail).toBe("jane@emit.example");
    expect(viewOnlyPreview.customerCost).toBeUndefined();
    expect(viewOnlyPreview.pendingReviewCount).toBeUndefined();
    const select = presentCustomerOrder(stored, "admin");
    expect(select.customerCost).toBe(1500);
    expect(select.pendingReviewCount).toBe(4);
    expect(select.samBuildStatus).toBe("building");
    expect("carrierPay" in select).toBe(false);
  });

  it("lets only a Select admin preview an EMIT role, and the server uses that role", async () => {
    const admin = await cookieFor(adminSession());
    const asCustomer = await cookieFor(adminSession(), "customer");
    const asFull = await cookieFor(adminSession(), "emit_admin");
    const asViewer = await cookieFor(adminSession(), "emit_viewer");
    const forged = await cookieFor(customerSession(), "emit_admin");

    const hidden = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO2196", { headers: { cookie: asCustomer } }));
    const hiddenOrder = (await hidden.json()).orders[0];
    expect("customerCost" in hiddenOrder).toBe(false);
    expect("samBuildStatus" in hiddenOrder).toBe(false);
    expect("pendingReviewCount" in hiddenOrder).toBe(false);
    expectNoSecrets(hiddenOrder);

    const full = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO2196", { headers: { cookie: asFull } }));
    const fullOrder = (await full.json()).orders[0];
    expect(fullOrder.customerCost).toBe(1500);
    expect("pendingReviewCount" in fullOrder).toBe(false);
    expect("samBuildStatus" in fullOrder).toBe(false);

    const viewerCreate = await createLoad("SO-VIEW-AS", asViewer);
    expect(viewerCreate.status).toBe(403);

    const staffCreate = await createLoad("SO-AS-STAFF", asCustomer);
    expect(staffCreate.status).toBe(403);
    const asPricing = await cookieFor(adminSession(), "regular:pricing");
    const pricingList = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO2196", { headers: { cookie: asPricing } }));
    const pricingOrder = (await pricingList.json()).orders[0];
    expect("customerCost" in pricingOrder).toBe(false);
    expect("rateReason" in pricingOrder).toBe(false);
    expect(JSON.stringify(pricingOrder)).not.toMatch(/carrierPay|carrier_pay|8765|customerCost|rateReason|1,?500/);
    expect((await createLoad("SO-AS-PRICE", asPricing)).status).toBe(403);
    expect((await createLoad("SO-AS-FULL", asFull)).status).toBe(403);

    const stillHidden = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO2196", { headers: { cookie: forged } }));
    expect("customerCost" in (await stillHidden.json()).orders[0]).toBe(false);

    const select = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO2196", { headers: { cookie: admin } }));
    expect((await select.json()).orders[0].customerCost).toBe(1500);

    const denied = await setViewAs(
      new Request("http://portal.test/api/view-as", {
        method: "POST",
        headers: headers(await cookieFor(customerSession())),
        body: JSON.stringify({ role: "emit_admin" }),
      }),
    );
    expect(denied.status).toBe(403);

    const switched = await setViewAs(
      new Request("http://portal.test/api/view-as", {
        method: "POST",
        headers: headers(admin),
        body: JSON.stringify({ role: "emit_viewer" }),
      }),
    );
    expect(switched.status).toBe(200);
    expect(switched.headers.get("set-cookie")).toMatch(/portal_view_as=regular%3Aview/);

    const users = await listUsers(new Request("http://portal.test/api/admin/users", { headers: { cookie: asFull } }));
    expect(users.status).toBe(403);
  });

  it("lets Select assign one EMIT permission, and only those emails can sign in", async () => {
    const admin = await cookieFor(adminSession());
    const created = await createUser(
      new Request("http://portal.test/api/admin/users", {
        method: "POST",
        headers: headers(admin),
        body: JSON.stringify({
          name: "New Person",
          email: "new.person@emit.example",
          password: "View-only-1",
          permission: "view",
        }),
      }),
    );
    expect(created.status).toBe(201);
    const createdUser = (await created.json()).user;
    expect(createdUser.permission).toBe("view");
    expect(createdUser.emitAdmin).toBe(false);
    expect(createdUser.role).toBeUndefined();

    const unknown = await login(
      new Request("http://portal.test/api/auth/login", {
        method: "POST",
        headers: headers("portal_session=none"),
        body: JSON.stringify({ email: "stranger@emit.example", password: "View-only-1" }),
      }),
    );
    expect(unknown.status).toBe(401);

    const signedIn = await login(
      new Request("http://portal.test/api/auth/login", {
        method: "POST",
        headers: headers("portal_session=none"),
        body: JSON.stringify({ email: "new.person@emit.example", password: "View-only-1" }),
      }),
    );
    expect(signedIn.status).toBe(200);
    expect((await signedIn.json()).role).toBe("customer");
    const viewerCookie = signedIn.headers.get("set-cookie")?.split(";")[0] ?? "";

    const blocked = await createLoad("SO-NO-VIEW", viewerCookie);
    expect(blocked.status).toBe(403);
    const noPrice = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO2196", { headers: { cookie: viewerCookie } }));
    expect("customerCost" in (await noPrice.json()).orders[0]).toBe(false);

    const full = await patchUser(
      new Request(`http://portal.test/api/admin/users/${createdUser.id}`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ permission: "full" }),
      }),
      { params: Promise.resolve({ id: createdUser.id }) },
    );
    expect((await full.json()).user.permission).toBe("full");
    const priced = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO2196", { headers: { cookie: viewerCookie } }));
    const pricedOrder = (await priced.json()).orders[0];
    expect("customerCost" in pricedOrder).toBe(false);
    expect("rateReason" in pricedOrder).toBe(false);

    const add = await patchUser(
      new Request(`http://portal.test/api/admin/users/${createdUser.id}`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ permission: "add" }),
      }),
      { params: Promise.resolve({ id: createdUser.id }) },
    );
    expect((await add.json()).user).toMatchObject({ permission: "add", emitAdmin: false });
    const added = await createLoad("SO-CAN-ADD", viewerCookie);
    expect(added.status).toBe(201);
    expect("customerCost" in added.order).toBe(false);

    const emitAdmin = await cookieFor({ userId: "emit-admin-1", email: "lead@emit.example", name: "EMIT Lead", role: "emit_admin" });
    const forbidden = await listUsers(new Request("http://portal.test/api/admin/users", { headers: { cookie: emitAdmin } }));
    expect(forbidden.status).toBe(403);

    const listed = await listUsers(new Request("http://portal.test/api/admin/users", { headers: { cookie: admin } }));
    const row = (await listed.json()).users.find((user: { email: string }) => user.email === "viewer@emit.example");
    expect(row.permission).toBe("view");
    expect(row.role).toBeUndefined();
  });

  it("hides EMIT's price from a regular user with see pricing, and blocks every view-as write", async () => {
    const admin = await cookieFor(adminSession());
    const created = await createUser(
      new Request("http://portal.test/api/admin/users", {
        method: "POST",
        headers: headers(admin),
        body: JSON.stringify({
          name: "Price Person",
          email: "price.person@emit.example",
          password: "See-price-1",
          access: "regular",
          permission: "pricing",
        }),
      }),
    );
    expect(created.status).toBe(201);
    const createdUser = (await created.json()).user;
    expect(createdUser).toMatchObject({ access: "regular", permission: "pricing", emitAdmin: false });

    const signedIn = await login(
      new Request("http://portal.test/api/auth/login", {
        method: "POST",
        headers: headers("portal_session=none"),
        body: JSON.stringify({ email: "price.person@emit.example", password: "See-price-1" }),
      }),
    );
    const cookie = signedIn.headers.get("set-cookie")?.split(";")[0] ?? "";
    const listed = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO2196", { headers: { cookie } }));
    const order = (await listed.json()).orders[0];
    expect("customerCost" in order).toBe(false);
    expect("rateReason" in order).toBe(false);
    expect(JSON.stringify(order)).not.toMatch(/carrierPay|carrier_pay|carrierCost|8765|pendingReviewCount|samBuild|customerCost|rateReason|1,?500/);
    expect((await createLoad("SO-PRICE-NO", cookie)).status).toBe(403);

    const stranger = await login(
      new Request("http://portal.test/api/auth/login", {
        method: "POST",
        headers: headers("portal_session=none"),
        body: JSON.stringify({ email: "not-approved@emit.example", password: "See-price-1" }),
      }),
    );
    expect(stranger.status).toBe(401);

    const preview = await cookieFor(adminSession(), "admin:full");
    const password = await changePassword(
      new Request("http://portal.test/api/me/password", {
        method: "POST",
        headers: headers(preview),
        body: JSON.stringify({ currentPassword: "Emit-Demo-2026", newPassword: "Another-pass-1" }),
      }),
    );
    expect(password.status).toBe(403);
    const location = await patchLocation(
      new Request("http://portal.test/api/locations/loc-1", {
        method: "PATCH",
        headers: headers(preview),
        body: JSON.stringify({ company: "Changed" }),
      }),
      { params: Promise.resolve({ id: "loc-1" }) },
    );
    expect(location.status).toBe(403);

    const emit = await setViewAs(
      new Request("http://portal.test/api/view-as", {
        method: "POST",
        headers: headers(cookie),
        body: JSON.stringify({ access: "admin", permission: "full" }),
      }),
    );
    expect(emit.status).toBe(403);
  });

  it("clears the view-as cookie on logout", async () => {
    const response = await logout();
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.startsWith("portal_session="))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith("portal_view_as="))).toBe(true);
  });
});

describe("build load in SAM", () => {
  it("posts an allowlisted payload and stores the number the bot sends back", async () => {
    delete process.env.LOAD_BUILDER_WEBHOOK_URL;
    const admin = await cookieFor(adminSession());
    const pending = await createLoad("SO-NO-HOOK", admin);
    const missing = await buildLoad(
      new Request(`http://portal.test/api/admin/orders/${pending.order.id}/build`, { method: "POST", headers: headers(admin) }),
      { params: Promise.resolve({ id: pending.order.id }) },
    );
    expect(missing.status).toBe(503);
    const untouched = await ctx.db.prepare(`SELECT sam_build_status FROM loads WHERE id = ?`).get(pending.order.id);
    expect(untouched?.sam_build_status).toBeNull();

    process.env.LOAD_BUILDER_WEBHOOK_URL = WEBHOOK;
    process.env.LOAD_BUILDER_SECRET = "short";
    const shortKey = await buildLoad(
      new Request(`http://portal.test/api/admin/orders/${pending.order.id}/build`, { method: "POST", headers: headers(admin) }),
      { params: Promise.resolve({ id: pending.order.id }) },
    );
    expect(shortKey.status).toBe(503);

    process.env.LOAD_BUILDER_SECRET = SECRET;
    let payload: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body));
      expect(url).toBe(WEBHOOK);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${SECRET}`);
      return new Response("accepted", { status: 202 });
    });
    const started = await buildLoad(
      new Request(`http://portal.test/api/admin/orders/${pending.order.id}/build`, { method: "POST", headers: headers(admin) }),
      { params: Promise.resolve({ id: pending.order.id }) },
    );
    expect(started.status).toBe(200);
    expect((await started.json()).order.samBuildStatus).toBe("building");
    expect(payload).toMatchObject({ salesOrderNumber: "SO-NO-HOOK", customerCost: 1750 });
    expect(JSON.stringify(payload)).not.toMatch(/carrierPay|carrierCost|carrier_name|staffNotes/);
    expect(JSON.stringify(loadBuilderPayload({ ...pending.order, carrierPay: 8765.43 } as CustomerOrder))).not.toMatch(/carrierPay|8765/);

    const again = await buildLoad(
      new Request(`http://portal.test/api/admin/orders/${pending.order.id}/build`, { method: "POST", headers: headers(admin) }),
      { params: Promise.resolve({ id: pending.order.id }) },
    );
    expect(again.status).toBe(409);

    const asCustomer = await cookieFor(adminSession(), "customer");
    const hiddenBuild = await buildLoad(
      new Request(`http://portal.test/api/admin/orders/${pending.order.id}/build`, { method: "POST", headers: headers(asCustomer) }),
      { params: Promise.resolve({ id: pending.order.id }) },
    );
    expect(hiddenBuild.status).toBe(403);

    const refused = await samCallback(
      new Request("http://portal.test/api/integrations/sam-load", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: pending.order.id, loadNumber: "458940-1" }),
      }),
    );
    expect(refused.status).toBe(401);

    const saved = await samCallback(
      new Request("http://portal.test/api/integrations/sam-load", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ salesOrderNumber: "SO-NO-HOOK", loadNumber: "458940-1" }),
      }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      orderId: pending.order.id,
      salesOrderNumber: "SO-NO-HOOK",
      loadNumber: "458940-1",
    });
    const source = await ctx.db.prepare(`SELECT load_number_source, sam_build_status FROM loads WHERE id = ?`).get(pending.order.id);
    expect(source).toMatchObject({ load_number_source: "sam", sam_build_status: null });

    const same = await samCallback(
      new Request("http://portal.test/api/integrations/sam-load", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ orderId: pending.order.id, loadNumber: "458940-1" }),
      }),
    );
    expect(same.status).toBe(200);

    const clash = await samCallback(
      new Request("http://portal.test/api/integrations/sam-load", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ orderId: pending.order.id, loadNumber: "458941-1" }),
      }),
    );
    expect(clash.status).toBe(409);

    const viewer = await cookieFor({ userId: "viewer-1", email: "viewer@emit.example", name: "View Only", role: "emit_viewer" });
    const emitView = await getOrderRoute(new Request(`http://portal.test/api/orders/${pending.order.id}`, { headers: { cookie: viewer } }), {
      params: Promise.resolve({ id: pending.order.id }),
    });
    const emitOrder = (await emitView.json()).order;
    expect(emitOrder.loadNumber).toBe("458940-1");
    expect("samUrl" in emitOrder).toBe(false);
    expect("customerCost" in emitOrder).toBe(false);
    expectNoSecrets(emitOrder);

    const selectView = await getOrderRoute(new Request(`http://portal.test/api/orders/${pending.order.id}`, { headers: { cookie: admin } }), {
      params: Promise.resolve({ id: pending.order.id }),
    });
    expect((await selectView.json()).order.samUrl).toBe("https://sam.example/loads/458940-1");
    expect(samLoadUrl("458940-1")).toBe("https://sam.example/loads/458940-1");
    delete process.env.SAM_LOAD_URL_TEMPLATE;
    expect(samLoadUrl("458940-1")).toBeNull();
  });

  it("records a bot failure and does not invent a load number", async () => {
    const admin = await cookieFor(adminSession());
    const pending = await createLoad("SO-BOT-FAIL", admin);
    vi.stubGlobal("fetch", async () => new Response("no", { status: 500 }));
    const failed = await buildLoad(
      new Request(`http://portal.test/api/admin/orders/${pending.order.id}/build`, { method: "POST", headers: headers(admin) }),
      { params: Promise.resolve({ id: pending.order.id }) },
    );
    expect(failed.status).toBe(502);
    const body = await failed.json();
    expect(body.order.samBuildStatus).toBe("failed");
    expect(body.order.loadNumber).toBeNull();
    expect(body.order.samBuildError).toMatch(/500/);

    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    const retry = await buildLoad(
      new Request(`http://portal.test/api/admin/orders/${pending.order.id}/build`, { method: "POST", headers: headers(admin) }),
      { params: Promise.resolve({ id: pending.order.id }) },
    );
    expect(retry.status).toBe(502);
    expect((await retry.json()).order.samBuildError).toMatch(/did not answer/);
  });
});

describe("Microsoft sign-in", () => {
  it("refuses an email Select has not added and keeps the permission already stored", async () => {
    process.env.AZURE_AD_TENANT_ID = "tenant";
    process.env.AZURE_AD_CLIENT_ID = "client";
    process.env.AZURE_AD_CLIENT_SECRET = "secret";
    const state = "microsoft.preview-state";
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/token")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      return new Response(JSON.stringify({ email: "stranger@emit.example", name: "Stranger" }), { status: 200 });
    });
    const refused = await microsoftCallback(
      new Request(`http://portal.test/api/auth/microsoft/callback?code=abc&state=${state}`, {
        headers: { cookie: `oauth_state=${state}` },
      }),
    );
    expect(refused.status).toBe(302);
    expect(decodeURIComponent(refused.headers.get("location") ?? "")).toMatch(/not on the EMIT list/);
    expect(await ctx.db.prepare(`SELECT id FROM users WHERE email = ?`).get("stranger@emit.example")).toBeUndefined();

    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/token")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      return new Response(JSON.stringify({ email: "viewer@emit.example", name: "View Only" }), { status: 200 });
    });
    const allowed = await microsoftCallback(
      new Request(`http://portal.test/api/auth/microsoft/callback?code=abc&state=${state}`, {
        headers: { cookie: `oauth_state=${state}` },
      }),
    );
    expect(allowed.status).toBe(302);
    expect(allowed.headers.get("location")).toBe("/");
    const role = await ctx.db.prepare(`SELECT role, permission FROM users WHERE email = ?`).get("viewer@emit.example");
    expect(role).toMatchObject({ role: "customer", permission: "view" });
  });
});
