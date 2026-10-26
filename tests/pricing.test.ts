import { beforeAll, describe, expect, it } from "vitest";
import { GET as reviewQueue } from "@/app/api/admin/review/route";
import { PATCH as patchUser } from "@/app/api/admin/users/[id]/route";
import { GET as listUsers } from "@/app/api/admin/users/route";
import { POST as ask } from "@/app/api/ask/route";
import { GET as getOrderRoute, PATCH as patchOrder } from "@/app/api/orders/[id]/route";
import { GET as exportOrders } from "@/app/api/orders/export/route";
import { GET as listOrdersRoute, POST as createOrderRoute } from "@/app/api/orders/route";
import { answerQuestion, buildModelRequest } from "@/lib/assistant";
import { presentCustomerOrder, serializeCustomerOrder } from "@/lib/customer-view";
import { listAllOrders } from "@/lib/orders";
import { upsertExternalUser } from "@/lib/passwords";
import type { PortalContext } from "@/lib/db";
import type { Session } from "@/lib/types";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;

beforeAll(async () => {
  ctx = await seededPortal();
});

function emitAdminSession(): Session {
  return { userId: "emit-admin-1", email: "lead@emit.example", name: "EMIT Lead", role: "emit_admin" };
}

function headers(cookie: string): HeadersInit {
  return { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" };
}

const pricedOrder = {
  id: "1",
  salesOrderNumber: "SO2196",
  loadNumber: "900196-1",
  portalStatus: "shipped",
  trackingStage: "in_transit",
  customerCost: 1500,
  rateReason: "Team",
  carrierPay: 8765.43,
  carrierName: "BLACKHAWK HAULING LLC",
  staffNotes: "INTERNAL-ONLY-SENTINEL",
};

describe("pricing follows the EMIT admin role", () => {
  it("omits pricing keys from the customer allowlist", () => {
    const hidden = serializeCustomerOrder(pricedOrder, { includePricing: false });
    expect("customerCost" in hidden).toBe(false);
    expect("rateReason" in hidden).toBe(false);
    expect(JSON.stringify(hidden)).not.toMatch(/customerCost|rateReason|1500/);
    expectNoSecrets(hidden);
    expect(serializeCustomerOrder(pricedOrder).customerCost).toBe(1500);
    expect(presentCustomerOrder(serializeCustomerOrder(pricedOrder), "customer").customerCost).toBeUndefined();
    expect(presentCustomerOrder(serializeCustomerOrder(pricedOrder), "emit_admin").customerCost).toBe(1500);
    expect(presentCustomerOrder(serializeCustomerOrder(pricedOrder), "admin").customerCost).toBe(1500);
    const request = buildModelRequest("what is the cost?", [serializeCustomerOrder(pricedOrder)], { includePricing: false });
    expect(request.messages[1].content).not.toMatch(/customerCost|rateReason|1500/);
    expect(request.messages[0].content.toLowerCase()).toContain("do not have carrier pay");
    expect(request.messages[0].content.toLowerCase()).toContain("cannot see customer pricing");
    const visible = buildModelRequest("what is the cost?", [{ ...serializeCustomerOrder(pricedOrder), carrierPay: 8765.43 } as never], {
      includePricing: true,
    });
    expect(visible.messages[1].content).toContain("customerCost");
    expectNoSecrets(visible);
  });

  it("strips pricing from list, detail, create, and update for a regular EMIT user", async () => {
    const customer = await sessionCookie(customerSession());
    const emitAdmin = await sessionCookie(emitAdminSession());
    const listed = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO2196", { headers: { cookie: customer } }));
    const customerBody = await listed.json();
    expect(customerBody.orders[0].salesOrderNumber).toBe("SO2196");
    expect("customerCost" in customerBody.orders[0]).toBe(false);
    expect("rateReason" in customerBody.orders[0]).toBe(false);
    expectNoSecrets(customerBody);

    const hero = (await listAllOrders(ctx)).find((order) => order.salesOrderNumber === "SO2196")!;
    expect(hero.customerCost).toBe(1500);
    const detail = await getOrderRoute(new Request(`http://portal.test/api/orders/${hero.id}`, { headers: { cookie: customer } }), {
      params: Promise.resolve({ id: hero.id }),
    });
    const detailBody = await detail.json();
    expect("customerCost" in detailBody.order).toBe(false);

    const cleared = await patchOrder(
      new Request(`http://portal.test/api/orders/${hero.id}`, {
        method: "PATCH",
        headers: headers(customer),
        body: JSON.stringify({ customerCost: null, rateReason: null, comments: hero.comments }),
      }),
      { params: Promise.resolve({ id: hero.id }) },
    );
    expect(cleared.status).toBe(200);
    expect("customerCost" in (await cleared.json()).order).toBe(false);
    const still = (await listAllOrders(ctx)).find((order) => order.id === hero.id)!;
    expect(still.customerCost).toBe(1500);

    const adminView = await getOrderRoute(new Request(`http://portal.test/api/orders/${hero.id}`, { headers: { cookie: emitAdmin } }), {
      params: Promise.resolve({ id: hero.id }),
    });
    const adminBody = await adminView.json();
    expect(adminBody.order.customerCost).toBe(1500);
    expectNoSecrets(adminBody);

    const created = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(emitAdmin),
        body: JSON.stringify({
          salesOrderNumber: "SO-EMIT-ADMIN",
          origin: { company: "EMIT Technologies", address1: "2437 Allen Avenue", city: "Sheridan", state: "WY", postalCode: "82801" },
          destination: { company: "Kodiak Gas Services", address1: "6801 Brooklyn Court", city: "Oklahoma City", state: "OK", postalCode: "73132" },
          customerCost: 1325,
          rateReason: "Capacity",
          carrierPay: 8765.43,
          staffNotes: "INTERNAL-ONLY-SENTINEL",
        }),
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.order.customerCost).toBe(1325);
    expect(createdBody.order.rateReason).toBe("Capacity");
    expectNoSecrets(createdBody);

    const denied = await reviewQueue(new Request("http://portal.test/api/admin/review", { headers: { cookie: emitAdmin } }));
    expect(denied.status).toBe(403);
  });

  it("keeps pricing out of the assistant unless the viewer is an EMIT admin", async () => {
    const hidden = await answerQuestion(ctx, "where is SO2196?", "customer");
    expect(hidden.text).toContain("900196-1");
    expect(hidden.text).not.toMatch(/1,?500|customerCost|\$/);
    expectNoSecrets(hidden);
    const refused = await answerQuestion(ctx, "what is the cost of SO2196?", "customer");
    expect(refused.text).toContain("not available");
    expect(refused.text).not.toMatch(/1,?500/);
    const shown = await answerQuestion(ctx, "where is SO2196?", "emit_admin");
    expect(shown.text).toContain("$1,500.00");
    expectNoSecrets(shown);
    const carrier = await answerQuestion(ctx, "what are you paying the truck on SO2196?", "emit_admin");
    expect(carrier.refused).toBe(true);
    expectNoSecrets(carrier);

    const cookie = await sessionCookie(customerSession());
    const response = await ask(
      new Request("http://portal.test/api/ask", {
        method: "POST",
        headers: headers(cookie),
        body: JSON.stringify({ question: "what is the price of SO2196?" }),
      }),
    );
    const body = await response.json();
    expect(body.text).toContain("not available");
    expect(JSON.stringify(body)).not.toMatch(/1,?500|customerCost/);
    expectNoSecrets(body);
  });

  it("lets a Select admin mark an EMIT user as an EMIT admin without making them a Select admin", async () => {
    const row = (await ctx.db.prepare(`SELECT id, email, name FROM users WHERE email = ?`).get("m.gray@emit.example")) as {
      id: string;
      email: string;
      name: string;
    };
    const admin = await sessionCookie(adminSession());
    const asStaff = await sessionCookie({ userId: row.id, email: row.email, name: row.name, role: "customer" });
    const before = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO2196", { headers: { cookie: asStaff } }));
    expect("customerCost" in (await before.json()).orders[0]).toBe(false);

    const promoted = await patchUser(
      new Request(`http://portal.test/api/admin/users/${row.id}`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ emitAdmin: true }),
      }),
      { params: Promise.resolve({ id: row.id }) },
    );
    expect(promoted.status).toBe(200);
    expect((await promoted.json()).user.emitAdmin).toBe(true);
    const users = await listUsers(new Request("http://portal.test/api/admin/users", { headers: { cookie: admin } }));
    const listed = (await users.json()).users.find((user: { email: string }) => user.email === row.email);
    expect(listed.emitAdmin).toBe(true);
    expect(listed.access).toBe("admin");
    expect(listed.role).toBeUndefined();

    const stillHidden = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO2196", { headers: { cookie: asStaff } }));
    expect("customerCost" in (await stillHidden.json()).orders[0]).toBe(false);

    const priced = await patchUser(
      new Request(`http://portal.test/api/admin/users/${row.id}`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ permission: "pricing" }),
      }),
      { params: Promise.resolve({ id: row.id }) },
    );
    expect((await priced.json()).user).toMatchObject({ emitAdmin: true, permission: "pricing", access: "admin" });
    const after = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO2196", { headers: { cookie: asStaff } }));
    const shown = (await after.json()).orders[0];
    expect(shown.customerCost).toBe(1500);
    expect(JSON.stringify(shown)).not.toMatch(/carrierPay|carrier_pay|8765/);
    const stillBlocked = await reviewQueue(new Request("http://portal.test/api/admin/review", { headers: { cookie: asStaff } }));
    expect(stillBlocked.status).toBe(403);

    const signedIn = await upsertExternalUser(ctx, { email: row.email, name: row.name, role: "customer" });
    expect(signedIn.role).toBe("emit_admin");

    const demoted = await patchUser(
      new Request(`http://portal.test/api/admin/users/${row.id}`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ emitAdmin: false }),
      }),
      { params: Promise.resolve({ id: row.id }) },
    );
    expect((await demoted.json()).user).toMatchObject({ emitAdmin: false, access: "regular", permission: "pricing" });
    const stillPriced = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO2196", { headers: { cookie: asStaff } }));
    const kept = (await stillPriced.json()).orders[0];
    expect("customerCost" in kept).toBe(false);
    expect("rateReason" in kept).toBe(false);
    expect(JSON.stringify(kept)).not.toMatch(/carrierPay|carrier_pay|8765|customerCost|rateReason|1,?500/);
  });

  it("returns no cost fields on a regular EMIT user's load list or detail", async () => {
    const customer = await sessionCookie(customerSession());
    const admin = await sessionCookie(adminSession());
    const emitAdmin = await sessionCookie(emitAdminSession());
    const pricingRow = (await ctx.db.prepare(`SELECT id, email, name FROM users WHERE email = ?`).get("pricing@emit.example")) as {
      id: string;
      email: string;
      name: string;
    };
    const seePricing = await sessionCookie({
      userId: pricingRow.id,
      email: pricingRow.email,
      name: pricingRow.name,
      role: "customer",
      permission: "pricing",
    });
    const hero = (await listAllOrders(ctx)).find((order) => order.salesOrderNumber === "SO2196")!;
    expect(hero.customerCost).toBe(1500);

    const hiddenCookies = [
      customer,
      seePricing,
      `${admin}; portal_view_as=regular:add`,
      `${admin}; portal_view_as=regular:pricing`,
      `${admin}; portal_view_as=regular:full`,
    ];
    for (const cookie of hiddenCookies) {
      const listed = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO2196", { headers: { cookie } }));
      const row = (await listed.json()).orders[0];
      expect(row.salesOrderNumber).toBe("SO2196");
      expect(row).not.toHaveProperty("customerCost");
      expect(row).not.toHaveProperty("rateReason");
      expect(JSON.stringify(row)).not.toMatch(/customerCost|rateReason|\$|1,?500/);
      expectNoSecrets(row);

      const detail = await getOrderRoute(new Request(`http://portal.test/api/orders/${hero.id}`, { headers: { cookie } }), {
        params: Promise.resolve({ id: hero.id }),
      });
      const detailBody = await detail.json();
      expect(detailBody.order).not.toHaveProperty("customerCost");
      expect(detailBody.order).not.toHaveProperty("rateReason");
      expect(JSON.stringify(detailBody)).not.toMatch(/customerCost|rateReason|\$|1,?500/);
      expectNoSecrets(detailBody);

      const csvFile = await exportOrders(
        new Request("http://portal.test/api/orders/export?tab=active&q=SO2196", { headers: headers(cookie) }),
      );
      const csv = await csvFile.text();
      expect(csv).toContain("SO2196");
      expect(csv).not.toMatch(/Cost|Rate reason|1500|\$/);

      const asked = await ask(
        new Request("http://portal.test/api/ask", {
          method: "POST",
          headers: headers(cookie),
          body: JSON.stringify({ question: "where is SO2196?" }),
        }),
      );
      const answer = await asked.json();
      expect(answer.text).toContain("900196-1");
      expect(JSON.stringify(answer)).not.toMatch(/customerCost|rateReason|\$|1,?500/);
      expectNoSecrets(answer);
    }

    for (const cookie of [emitAdmin, admin, `${admin}; portal_view_as=admin:full`]) {
      const listed = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO2196", { headers: { cookie } }));
      const row = (await listed.json()).orders[0];
      expect(row.customerCost).toBe(1500);
      expect(JSON.stringify(row)).not.toMatch(/carrierPay|carrier_pay|8765/);
      const detail = await getOrderRoute(new Request(`http://portal.test/api/orders/${hero.id}`, { headers: { cookie } }), {
        params: Promise.resolve({ id: hero.id }),
      });
      expect((await detail.json()).order.customerCost).toBe(1500);
    }
  });
});
