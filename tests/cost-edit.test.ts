import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as ask } from "@/app/api/ask/route";
import { PATCH as patchCost } from "@/app/api/orders/[id]/cost/route";
import { GET as getOrderRoute, PATCH as patchOrder } from "@/app/api/orders/[id]/route";
import { GET as exportOrders } from "@/app/api/orders/export/route";
import { GET as listOrdersRoute, POST as createOrderRoute } from "@/app/api/orders/route";
import { GET as publicTrack } from "@/app/api/track/[token]/route";
import CostField from "@/components/cost-field";
import LoadForm, { emptyDraft, payloadFromDraft } from "@/components/load-form";
import { answerQuestion } from "@/lib/assistant";
import { findRateField } from "@/lib/carrier-notice";
import { costHistoryText, parseCustomerCost } from "@/lib/cost";
import type { PortalContext } from "@/lib/db";
import { findUserById, sessionFromUser } from "@/lib/passwords";
import { createEmitUser } from "@/lib/users";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;

beforeAll(async () => {
  ctx = await seededPortal();
});

function headers(cookie: string): HeadersInit {
  return { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" };
}

const lane = {
  stops: [
    { kind: "pickup" as const, place: { company: "EMIT", address1: "1 Main", city: "Sheridan", state: "WY", postalCode: "82801", country: "US" } },
    { kind: "drop" as const, place: { company: "Kodiak", address1: "2 Main", city: "Oklahoma City", state: "OK", postalCode: "73132", country: "US" } },
  ],
};

async function createLoad(salesOrderNumber: string, cookie: string) {
  const response = await createOrderRoute(
    new Request("http://portal.test/api/orders", {
      method: "POST",
      headers: headers(cookie),
      body: JSON.stringify({ ...lane, salesOrderNumber }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()).order as { id: string; salesOrderNumber: string; customerCost?: number | null };
}

describe("dollar amounts", () => {
  it("accepts a dollar amount and rejects anything else", () => {
    expect(parseCustomerCost("1500")).toEqual({ cents: 150000 });
    expect(parseCustomerCost("$1,500.50")).toEqual({ cents: 150050 });
    expect(parseCustomerCost(0)).toEqual({ cents: 0 });
    expect(parseCustomerCost("")).toEqual({ cents: null });
    expect(parseCustomerCost(null)).toEqual({ cents: null });
    for (const bad of ["nope", "-5", "1500.999", "1000000.01", "1e3", "$", "15.5.0"]) {
      expect(parseCustomerCost(bad)).toEqual({ error: expect.stringMatching(/dollar amount/) });
    }
    expect(costHistoryText(null, 150000, "Mike Gray (mgray@goselect.com)")).toBe(
      "Cost changed from not set to $1,500.00 by Mike Gray (mgray@goselect.com).",
    );
    expect(payloadFromDraft({ ...emptyDraft(), customerCost: "$1,500.50" }).customerCost).toBe(1500.5);
    expect(() => payloadFromDraft({ ...emptyDraft(), customerCost: "nope" })).toThrow(/dollar amount/);
    expect(payloadFromDraft(emptyDraft(), { includePricing: false })).not.toHaveProperty("customerCost");
    expect(findRateField({ customerCost: 12 })).toBe("customerCost");
    expect(findRateField({ cost: 1 })).toBe("cost");
  });
});

describe("editing EMIT cost", () => {
  it("lets Select set and change the cost, writes History, and returns the new amount on the list", async () => {
    const admin = await sessionCookie(adminSession());
    const order = await createLoad("SO-COST-EDIT", admin);
    expect(order.customerCost).toBeNull();

    const set = await patchCost(
      new Request(`http://portal.test/api/orders/${order.id}/cost`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ customerCost: "$1,500.00" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(set.status).toBe(200);
    const setBody = await set.json();
    expect(setBody.order.customerCost).toBe(1500);
    expect(setBody.order.auditEvents).toEqual([
      expect.objectContaining({
        at: "2026-10-14T18:00:00.000Z",
        kind: "cost",
        text: "Cost changed from not set to $1,500.00 by Mike Gray (mgray@goselect.com).",
      }),
    ]);
    expectNoSecrets(setBody);

    const changed = await patchOrder(
      new Request(`http://portal.test/api/orders/${order.id}`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ customerCost: 1800 }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(changed.status).toBe(200);
    const changedBody = await changed.json();
    expect(changedBody.order.customerCost).toBe(1800);
    expect(changedBody.order.auditEvents.map((event: { text: string }) => event.text)).toEqual([
      "Cost changed from not set to $1,500.00 by Mike Gray (mgray@goselect.com).",
      "Cost changed from $1,500.00 to $1,800.00 by Mike Gray (mgray@goselect.com).",
    ]);

    const again = await patchCost(
      new Request(`http://portal.test/api/orders/${order.id}/cost`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ customerCost: "1800.00" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect((await again.json()).order.auditEvents).toHaveLength(2);

    const listed = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO-COST-EDIT", { headers: { cookie: admin } }));
    expect((await listed.json()).orders[0].customerCost).toBe(1800);

    const detail = await getOrderRoute(new Request(`http://portal.test/api/orders/${order.id}`, { headers: { cookie: admin } }), {
      params: Promise.resolve({ id: order.id }),
    });
    expect((await detail.json()).order.customerCost).toBe(1800);

    const csv = await exportOrders(new Request("http://portal.test/api/orders/export?tab=attention&q=SO-COST-EDIT", { headers: headers(admin) }));
    const csvText = await csv.text();
    expect(csvText).toContain("Cost");
    expect(csvText).toContain("1800.00");

    const asked = await answerQuestion(ctx, "where is SO-COST-EDIT?", adminSession());
    expect(asked.text).toContain("$1,800.00");
    expect(asked.refused).toBe(false);

    const stored = await ctx.db.prepare(`SELECT customer_cost_cents FROM loads WHERE id = ?`).get(order.id);
    expect(stored?.customer_cost_cents).toBe(180000);

    const tokenRow = await ctx.db.prepare(`SELECT tracking_token FROM loads WHERE id = ?`).get(order.id);
    const token = String(tokenRow?.tracking_token);
    const track = await publicTrack(new Request(`http://portal.test/api/track/${token}`), { params: Promise.resolve({ token }) });
    const trackText = await track.text();
    expect(trackText).not.toMatch(/customerCost|1800|\$/);
  });

  it("rejects a bad amount and leaves the stored cost alone", async () => {
    const admin = await sessionCookie(adminSession());
    const order = await createLoad("SO-COST-BAD", admin);
    const before = await ctx.db.prepare(`SELECT customer_cost_cents, audit_log FROM loads WHERE id = ?`).get(order.id);
    for (const customerCost of ["nope", "-5", "1500.999", "1000000.01", 1500.999]) {
      const response = await patchCost(
        new Request(`http://portal.test/api/orders/${order.id}/cost`, {
          method: "PATCH",
          headers: headers(admin),
          body: JSON.stringify({ customerCost }),
        }),
        { params: Promise.resolve({ id: order.id }) },
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/dollar amount/);
      expect(JSON.stringify(body)).not.toMatch(/\$|customerCost/);
    }
    const form = await patchOrder(
      new Request(`http://portal.test/api/orders/${order.id}`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ customerCost: 12.345 }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(form.status).toBe(400);
    const extra = await patchCost(
      new Request(`http://portal.test/api/orders/${order.id}/cost`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ customerCost: 10, carrierPay: 8765.43 }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(extra.status).toBe(400);
    expectNoSecrets(await extra.json());
    const after = await ctx.db.prepare(`SELECT customer_cost_cents, audit_log FROM loads WHERE id = ?`).get(order.id);
    expect(after).toEqual(before);
  });

  it("lets an EMIT admin who can see pricing change the cost without opening the rest of the load", async () => {
    const created = await createEmitUser(ctx, {
      name: "Pat Pricing",
      email: "pat.pricing@emit.example",
      password: "temporary-pass",
      access: "admin",
      permission: "pricing",
    });
    const row = await findUserById(ctx, created.user.id);
    if (!row) throw new Error("pricing user missing");
    const cookie = await sessionCookie(sessionFromUser(row));
    const admin = await sessionCookie(adminSession());
    const order = await createLoad("SO-COST-PRICING", admin);

    const blocked = await patchOrder(
      new Request(`http://portal.test/api/orders/${order.id}`, {
        method: "PATCH",
        headers: headers(cookie),
        body: JSON.stringify({ comments: "Should not save" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(blocked.status).toBe(403);

    const saved = await patchCost(
      new Request(`http://portal.test/api/orders/${order.id}/cost`, {
        method: "PATCH",
        headers: headers(cookie),
        body: JSON.stringify({ customerCost: "990.25" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.order.customerCost).toBe(990.25);
    expect(body.order.auditEvents.at(-1).text).toBe("Cost changed from not set to $990.25 by Pat Pricing (pat.pricing@emit.example).");
    expectNoSecrets(body);
    const stored = await ctx.db.prepare(`SELECT customer_cost_cents, comments FROM loads WHERE id = ?`).get(order.id);
    expect(stored?.customer_cost_cents).toBe(99025);
    expect(stored?.comments).not.toBe("Should not save");
  });

  it("denies Sales, Loader, a regular EMIT user, and view-as", async () => {
    const sales = await createEmitUser(ctx, {
      name: "Sarah Sales",
      email: "sarah.cost@emit.example",
      password: "temporary-pass",
      profile: "sales",
    });
    const loader = await createEmitUser(ctx, {
      name: "Lee Loader",
      email: "lee.cost@emit.example",
      password: "temporary-pass",
      profile: "loader",
    });
    const regularPricing = await createEmitUser(ctx, {
      name: "Rita Regular",
      email: "rita.cost@emit.example",
      password: "temporary-pass",
      access: "regular",
      permission: "pricing",
    });
    const salesRow = await findUserById(ctx, sales.user.id);
    const loaderRow = await findUserById(ctx, loader.user.id);
    const regularRow = await findUserById(ctx, regularPricing.user.id);
    if (!salesRow || !loaderRow || !regularRow) throw new Error("user missing");
    const salesCookie = await sessionCookie(sessionFromUser(salesRow));
    const loaderCookie = await sessionCookie(sessionFromUser(loaderRow));
    const regularCookie = await sessionCookie(sessionFromUser(regularRow));
    const customer = await sessionCookie(customerSession());
    const admin = await sessionCookie(adminSession());
    const order = await createLoad("SO-COST-HIDE", admin);
    await patchCost(
      new Request(`http://portal.test/api/orders/${order.id}/cost`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ customerCost: 1500 }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );

    const hiddenCookies = [salesCookie, loaderCookie, regularCookie, customer, `${admin}; portal_view_as=regular:pricing`];
    for (const cookie of [...hiddenCookies, `${admin}; portal_view_as=admin:full`]) {
      const denied = await patchCost(
        new Request(`http://portal.test/api/orders/${order.id}/cost`, {
          method: "PATCH",
          headers: headers(cookie),
          body: JSON.stringify({ customerCost: 3333 }),
        }),
        { params: Promise.resolve({ id: order.id }) },
      );
      expect(denied.status).toBe(403);
      const deniedBody = await denied.json();
      expect(JSON.stringify(deniedBody)).not.toMatch(/3333|1,?500|\$/);
      expectNoSecrets(deniedBody);
    }

    for (const cookie of hiddenCookies) {
      const listed = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO-COST-HIDE", { headers: { cookie } }));
      const detail = await getOrderRoute(new Request(`http://portal.test/api/orders/${order.id}`, { headers: { cookie } }), {
        params: Promise.resolve({ id: order.id }),
      });
      const csvFile = await exportOrders(new Request("http://portal.test/api/orders/export?tab=active&q=SO-COST-HIDE", { headers: headers(cookie) }));
      const csv = await csvFile.text();
      expect(csv).toContain("SO-COST-HIDE");
      const chat = await ask(
        new Request("http://portal.test/api/ask", {
          method: "POST",
          headers: headers(cookie),
          body: JSON.stringify({ question: "how much does SO-COST-HIDE cost?" }),
        }),
      );
      const bytes = [await listed.text(), await detail.text(), csv, JSON.stringify(await chat.json())].join("\n");
      expect(bytes).not.toMatch(/customerCost|rateReason|customer_cost|1500|3333|\$/);
    }

    const preview = await getOrderRoute(
      new Request(`http://portal.test/api/orders/${order.id}`, { headers: { cookie: `${admin}; portal_view_as=admin:full` } }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect((await preview.json()).order.customerCost).toBe(1500);

    const patched = await patchOrder(
      new Request(`http://portal.test/api/orders/${order.id}`, {
        method: "PATCH",
        headers: headers(customer),
        body: JSON.stringify({ customerCost: 4444, comments: "Notes only" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(patched.status).toBe(200);
    expect("customerCost" in (await patched.json()).order).toBe(false);
    const stored = await ctx.db.prepare(`SELECT customer_cost_cents, comments, audit_log FROM loads WHERE id = ?`).get(order.id);
    expect(stored?.customer_cost_cents).toBe(150000);
    expect(stored?.comments).toBe("Notes only");
    expect(String(stored?.audit_log)).not.toContain("4444");
    expect(String(stored?.audit_log)).toContain("Cost changed from not set to $1,500.00 by Mike Gray (mgray@goselect.com).");

    const local = await answerQuestion(ctx, "what is the cost of SO-COST-HIDE?", { role: "customer", permission: "view", profile: "sales" });
    expect(local.refused).toBe(true);
    expect(local.text).not.toMatch(/\$|1500/);
  });

  it("shows an inline Save on the load page and a cost field on the load form", () => {
    const editor = renderToStaticMarkup(createElement(CostField, { orderId: "load-1", customerCost: null, onUpdated: () => {} }));
    expect(editor).toContain('aria-label="EMIT cost"');
    expect(editor).toContain("Save");
    expect(editor).toContain("What EMIT pays Select for this load.");
    expect(editor).not.toMatch(/carrier pay|carrier rate|rate confirmation/i);

    const form = renderToStaticMarkup(createElement(LoadForm, { draft: emptyDraft(), setDraft: () => {}, sites: [] }));
    expect(form).toContain("EMIT cost (optional)");
    expect(form).toContain('aria-label="EMIT cost"');
    const hidden = renderToStaticMarkup(
      createElement(LoadForm, { draft: emptyDraft(), setDraft: () => {}, sites: [], hideCommercial: true }),
    );
    expect(hidden).not.toContain("EMIT cost");

    const page = readFileSync("app/orders/[id]/page.tsx", "utf8");
    expect(page).toContain("CostField");
    expect(page).toContain("showPricing");
  });
});
