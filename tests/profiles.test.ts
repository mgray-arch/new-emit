import { beforeAll, describe, expect, it } from "vitest";
import { PATCH as updateUser } from "@/app/api/admin/users/[id]/route";
import { POST as createUser } from "@/app/api/admin/users/route";
import { POST as ask } from "@/app/api/ask/route";
import { POST as uploadDocument } from "@/app/api/orders/[id]/documents/route";
import { GET as exportOrders } from "@/app/api/orders/export/route";
import { GET as getOrderRoute, PATCH as patchOrder } from "@/app/api/orders/[id]/route";
import { GET as listOrdersRoute, POST as createOrderRoute } from "@/app/api/orders/route";
import { GET as messagesRoute } from "@/app/api/messages/route";
import { answerQuestion, buildModelRequest } from "@/lib/assistant";
import { presentCustomerOrder } from "@/lib/customer-view";
import type { PortalContext } from "@/lib/db";
import { findUserById, sessionFromUser } from "@/lib/passwords";
import { canSeePricing } from "@/lib/types";
import { createEmitUser } from "@/lib/users";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;

beforeAll(async () => {
  ctx = await seededPortal();
});

function headers(cookie: string, json = false): HeadersInit {
  return { cookie, host: "portal.test", origin: "http://portal.test", ...(json ? { "content-type": "application/json" } : {}) };
}

const lane = {
  stops: [
    { kind: "pickup" as const, place: { company: "EMIT", address1: "1 Main", city: "Sheridan", state: "WY", postalCode: "82801", country: "US" } },
    { kind: "drop" as const, place: { company: "Kodiak", address1: "2 Main", city: "Oklahoma City", state: "OK", postalCode: "73132", country: "US" } },
  ],
};

describe("Sales and Loader cannot see cost", () => {
  it("rejects pricing permissions and strips cost from every read and write", async () => {
    expect(canSeePricing({ role: "emit_admin", permission: "full", profile: "sales" })).toBe(false);
    expect(canSeePricing({ role: "emit_admin", permission: "full", profile: "loader" })).toBe(false);
    expect(canSeePricing({ role: "emit_admin", permission: "full" })).toBe(true);

    const admin = await sessionCookie(adminSession());
    const denied = await createUser(
      new Request("http://portal.test/api/admin/users", {
        method: "POST",
        headers: headers(admin, true),
        body: JSON.stringify({ name: "Sales Full", email: "sales-full@emit.example", password: "temporary-pass", profile: "sales", permission: "full" }),
      }),
    );
    expect(denied.status).toBe(400);

    const sales = await createEmitUser(ctx, {
      name: "Sarah Sales",
      email: "sarah.sales@emit.example",
      password: "temporary-pass",
      profile: "sales",
      permission: "add",
      chatEnabled: true,
    });
    const loader = await createEmitUser(ctx, {
      name: "Lee Loader",
      email: "lee.loader@emit.example",
      password: "temporary-pass",
      profile: "loader",
      chatEnabled: true,
    });
    const salesRow = await findUserById(ctx, sales.user.id);
    const loaderRow = await findUserById(ctx, loader.user.id);
    if (!salesRow || !loaderRow) throw new Error("profile user missing");
    const salesCookie = await sessionCookie(sessionFromUser(salesRow));
    const loaderCookie = await sessionCookie(sessionFromUser(loaderRow));

    const priced = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(await sessionCookie(adminSession()), true),
        body: JSON.stringify({ ...lane, salesOrderNumber: "SO-PROFILE-COST", customerCost: 1500, rateReason: "Team" }),
      }),
    );
    expect(priced.status).toBe(201);
    const orderId = (await priced.json()).order.id as string;

    for (const cookie of [salesCookie, loaderCookie]) {
      const list = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO-PROFILE-COST", { headers: headers(cookie) }));
      const one = await getOrderRoute(new Request(`http://portal.test/api/orders/${orderId}`, { headers: headers(cookie) }), {
        params: Promise.resolve({ id: orderId }),
      });
      const csv = await exportOrders(new Request("http://portal.test/api/orders/export?tab=history&q=SO-PROFILE-COST", { headers: headers(cookie) }));
      const chat = await ask(
        new Request("http://portal.test/api/ask", {
          method: "POST",
          headers: headers(cookie, true),
          body: JSON.stringify({ question: "how much does SO-PROFILE-COST cost?" }),
        }),
      );
      const thread = await messagesRoute(new Request("http://portal.test/api/messages", { headers: headers(cookie) }));
      const chatBody = await chat.json();
      const bytes = [await list.text(), await one.text(), await csv.text(), JSON.stringify(chatBody), await thread.text()].join("\n");
      expect(bytes).not.toMatch(/customerCost|rateReason|customer_cost|1500|\$/);
      expect(chatBody.refused).toBe(true);
    }

    const salesWrite = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(salesCookie, true),
        body: JSON.stringify({ ...lane, salesOrderNumber: "SO-SALES-NEW", customerCost: 2222, rateReason: "Team" }),
      }),
    );
    expect(salesWrite.status).toBe(201);
    const salesOrder = (await salesWrite.json()).order;
    expect(salesOrder.customerCost).toBeUndefined();
    const stored = await ctx.db.prepare(`SELECT customer_cost_cents, rate_reason FROM loads WHERE id = ?`).get(salesOrder.id);
    expect(stored).toMatchObject({ customer_cost_cents: null, rate_reason: null });

    const patched = await patchOrder(
      new Request(`http://portal.test/api/orders/${orderId}`, {
        method: "PATCH",
        headers: headers(salesCookie, true),
        body: JSON.stringify({ customerCost: 3333, rateReason: "Weather", comments: "No price here" }),
      }),
      { params: Promise.resolve({ id: orderId }) },
    );
    expect(patched.status).toBe(200);
    const still = await ctx.db.prepare(`SELECT customer_cost_cents FROM loads WHERE id = ?`).get(orderId);
    expect(still?.customer_cost_cents).toBe(150000);

    const loaderCreate = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(loaderCookie, true),
        body: JSON.stringify({ ...lane, salesOrderNumber: "SO-LOADER-NO" }),
      }),
    );
    expect(loaderCreate.status).toBe(403);

    const form = new FormData();
    form.set("file", new File([new TextEncoder().encode("Freight list\nPieces: 2\n")], "loader-bol.txt", { type: "text/plain" }));
    form.set("slot", "bol");
    const uploaded = await uploadDocument(
      new Request(`http://portal.test/api/orders/${orderId}/documents`, { method: "POST", headers: headers(loaderCookie), body: form }),
      { params: Promise.resolve({ id: orderId }) },
    );
    expect(uploaded.status).toBe(200);

    const promoted = await updateUser(
      new Request(`http://portal.test/api/admin/users/${sales.user.id}`, {
        method: "PATCH",
        headers: headers(admin, true),
        body: JSON.stringify({ permission: "full" }),
      }),
      { params: Promise.resolve({ id: sales.user.id }) },
    );
    expect(promoted.status).toBe(400);

    const local = await answerQuestion(ctx, "what's the rate on SO-PROFILE-COST?", { role: "customer", permission: "add", profile: "sales" });
    expect(local.refused).toBe(true);
    expect(local.text).not.toMatch(/\$|1500/);
    const carrierQuestion = await answerQuestion(ctx, "who's the carrier on SO-PROFILE-COST?", { role: "customer", permission: "add", profile: "loader" });
    expect(carrierQuestion.refused).toBe(true);
    expect(carrierQuestion.text).toMatch(/don't have access/i);
    expect(carrierQuestion.text).not.toMatch(/ACME|123456/);
    const request = buildModelRequest("where is SO-PROFILE-COST?", [{ ...salesOrder, carrierName: "ACME Trucking", carrierMc: "123", driverName: "Pat", customerCost: 1500, bolPrint: { version: 1, printedAt: "", printedByName: "", carrierName: "ACME", carrierMc: "123", driverName: "Pat", documentId: "x", reprint: false, reasons: [], bolRemoved: false } } as never], { includePricing: false });
    expect(request.messages[1].content).not.toMatch(/ACME|carrierName|customerCost|1500|bolPrint/);

    const hidden = presentCustomerOrder(
      { ...salesOrder, customerCost: 1500, rateReason: "Team", carrierName: "ACME", carrierMc: "123", driverName: "Pat" },
      { role: "customer", permission: "add", profile: "sales" },
    );
    expect(hidden.customerCost).toBeUndefined();
    expect(hidden.carrierName).toBe("ACME");
    expectNoSecrets(hidden);
  });
});
