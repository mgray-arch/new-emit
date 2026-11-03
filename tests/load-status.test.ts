import { createElement } from "react";
import { readFileSync, existsSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as samCallback } from "@/app/api/integrations/sam-load/route";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { GET as listOrdersRoute, POST as createOrderRoute } from "@/app/api/orders/route";
import BuildStatus from "@/components/build-status";
import OrderHistory from "@/components/order-history";
import { buildStatusLabel } from "@/lib/build-status";
import { carrierEmail, findRateField, sameCarrier } from "@/lib/carrier-notice";
import type { PortalContext } from "@/lib/db";
import type { CustomerOrder } from "@/lib/types";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

const SECRET = "status-secret-0123456789";
const EMAIL_KEY = "email-key-0123456789abcd";

let ctx: PortalContext;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  ctx = await seededPortal();
  for (const key of ["LOAD_BUILDER_SECRET", "LOAD_STATUS_WEBHOOK_SECRET", "EMAIL_FROM", "EMAIL_API_KEY", "EMAIL_API_URL", "SLACK_NEW_LOADS_WEBHOOK_URL"]) {
    savedEnv[key] = process.env[key];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.LOAD_BUILDER_SECRET = SECRET;
  delete process.env.LOAD_STATUS_WEBHOOK_SECRET;
  process.env.EMAIL_FROM = "portal@select.example";
  process.env.EMAIL_API_KEY = EMAIL_KEY;
  process.env.EMAIL_API_URL = "https://email.test/send";
  delete process.env.SLACK_NEW_LOADS_WEBHOOK_URL;
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

const lane = {
  origin: { company: "EMIT ALLEN", address1: "2437 Allen Avenue", city: "Sheridan", state: "WY", postalCode: "82801" },
  destination: { company: "Johnson Thermal", address1: "100 Market", city: "Houston", state: "TX", postalCode: "77002" },
  shipDate: "2026-11-10",
  mustDeliverDate: "2026-11-12",
  truckType: "Flatbed",
};

async function createLoad(salesOrderNumber: string): Promise<CustomerOrder> {
  const cookie = await sessionCookie(customerSession());
  const response = await createOrderRoute(
    new Request("http://portal.test/api/orders", {
      method: "POST",
      headers: headers(cookie),
      body: JSON.stringify({ salesOrderNumber, ...lane, customerCost: 2400, comments: "Leave the gate code at the desk." }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()).order as CustomerOrder;
}

function postStatus(body: unknown, secret: string | null = SECRET) {
  const headersInit: Record<string, string> = { "content-type": "application/json" };
  if (secret) headersInit.authorization = `Bearer ${secret}`;
  return samCallback(
    new Request("http://portal.test/api/integrations/sam-load", {
      method: "POST",
      headers: headersInit,
      body: JSON.stringify(body),
    }),
  );
}

describe("build status label", () => {
  it("names Slack only after a note is accepted, and the SAM number after that", () => {
    expect(buildStatusLabel(null, null)).toBeNull();
    expect(buildStatusLabel("", "")).toBeNull();
    expect(buildStatusLabel(null, "2026-11-03T16:00:00.000Z")).toBe("Sent to Slack");
    expect(buildStatusLabel("458934-1", "2026-11-03T16:00:00.000Z")).toBe("Built in SAM: 458934-1");
    expect(buildStatusLabel("458934-1", null)).toBe("Built in SAM: 458934-1");
  });

  it("renders the label as text and does not render a build button", () => {
    const sent = renderToStaticMarkup(createElement(BuildStatus, { status: "Sent to Slack" }));
    const built = renderToStaticMarkup(createElement(BuildStatus, { status: "Built in SAM: 458934-1" }));
    expect(sent).toContain("Sent to Slack");
    expect(sent).toContain('data-build-status="sent"');
    expect(built).toContain("Built in SAM: 458934-1");
    expect(built).toContain('data-build-status="built"');
    expect(sent + built).not.toMatch(/<button|Build load in SAM|Building in SAM/);
    expect(renderToStaticMarkup(createElement(BuildStatus, { status: null }))).toBe("");
    const history = renderToStaticMarkup(
      createElement(OrderHistory, {
        notices: [{ at: "2026-11-03T16:00:00.000Z", kind: "assigned", text: "New carrier assignment email sent to m.gray@emit.example. Carrier: Northline Freight. MC 445566." }],
      }),
    );
    expect(history).toContain("History");
    expect(history).toContain("Northline Freight");
    expect(history).toContain("445566");
    expect(history).not.toMatch(/pay|rate|\$/i);
  });

  it("removes the SAM build control from the list and the load page", () => {
    expect(existsSync("app/api/admin/orders/[id]/build/route.ts")).toBe(false);
    expect(existsSync("components/sam-build-button.tsx")).toBe(false);
    for (const file of ["components/dashboard.tsx", "app/orders/[id]/page.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("Build load in SAM");
      expect(source).not.toContain("SamBuildButton");
      expect(source).not.toMatch(/\/build[`"']/);
      expect(source).toContain("BuildStatus");
    }
    expect(readFileSync("app/orders/[id]/page.tsx", "utf8")).toContain("OrderHistory");
  });
});

describe("carrier assignment email", () => {
  it("rejects rate fields and does not store them", async () => {
    const order = await createLoad("SO-RATE-NO");
    expect(findRateField({ carrierPay: 1 })).toBe("carrierPay");
    expect(findRateField({ stops: [{ carrierRate: 9 }] })).toBe("carrierRate");
    const refused = await postStatus({
      orderId: order.id,
      carrierName: "BLACKHAWK HAULING LLC",
      mcNumber: "998877",
      carrierPay: 8765.43,
      customerCost: 2400,
    });
    expect(refused.status).toBe(400);
    expectNoSecrets(await refused.json());
    const nested = await postStatus({
      salesOrderNumber: "SO-RATE-NO",
      carrierName: "Northline Freight",
      stops: [{ rateConfirmation: "rate con" }],
    });
    expect(nested.status).toBe(400);
    const row = await ctx.db.prepare(`SELECT carrier_name, carrier_mc, carrier_notice_log, customer_cost_cents FROM loads WHERE id = ?`).get(order.id);
    expect(row?.carrier_name ?? null).toBeNull();
    expect(row?.carrier_mc ?? null).toBeNull();
    expect(row?.carrier_notice_log ?? null).toBeNull();
    expect(row?.customer_cost_cents ?? null).toBeNull();
  });

  it("does not store a carrier when email is not configured or the send fails", async () => {
    const order = await createLoad("SO-MAIL-DOWN");
    delete process.env.EMAIL_API_KEY;
    const unconfigured = await postStatus({ orderId: order.id, carrierName: "Northline Freight", mcNumber: "445566" });
    expect(unconfigured.status).toBe(503);
    process.env.EMAIL_API_KEY = EMAIL_KEY;
    vi.stubGlobal("fetch", async () => new Response("no", { status: 500 }));
    const bounced = await postStatus({ orderId: order.id, carrierName: "Northline Freight", mcNumber: "445566" });
    expect(bounced.status).toBe(503);
    const row = await ctx.db.prepare(`SELECT carrier_name, carrier_notice_log FROM loads WHERE id = ?`).get(order.id);
    expect(row?.carrier_name ?? null).toBeNull();
    expect(row?.carrier_notice_log ?? null).toBeNull();
  });

  it("emails on the first assignment, again when the carrier changes, and not when the same carrier is resent", async () => {
    const order = await createLoad("SO-CARRIER");
    const calls: Array<{ url: string; auth: string; body: { from: string; to: string[]; subject: string; text: string } }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        auth: headers.get("authorization") ?? "",
        body: JSON.parse(String(init?.body)),
      });
      return new Response("ok", { status: 200 });
    });

    const noSecret = await postStatus({ orderId: order.id, loadNumber: "459100-1" }, null);
    expect(noSecret.status).toBe(401);

    delete process.env.LOAD_BUILDER_SECRET;
    process.env.LOAD_STATUS_WEBHOOK_SECRET = SECRET;
    const numbered = await postStatus({ salesOrderNumber: "SO-CARRIER", loadNumber: "459100-1" });
    expect(numbered.status).toBe(200);
    expect(await numbered.json()).toEqual({
      orderId: order.id,
      salesOrderNumber: "SO-CARRIER",
      loadNumber: "459100-1",
    });
    expect(calls).toHaveLength(0);

    const assigned = await postStatus({ orderId: order.id, carrierName: "Northline Freight", mcNumber: "MC 445566" });
    expect(assigned.status).toBe(200);
    expect((await assigned.json()).notice).toBe("assigned");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://email.test/send");
    expect(calls[0].auth).toBe(`Bearer ${EMAIL_KEY}`);
    expect(calls[0].body.from).toBe("portal@select.example");
    expect(calls[0].body.to).toEqual(["m.gray@emit.example"]);
    expect(calls[0].body.subject).toBe("Carrier assigned for SO-CARRIER");
    expect(calls[0].body.text).toContain("SO number: SO-CARRIER");
    expect(calls[0].body.text).toContain(`Order: ${order.id}`);
    expect(calls[0].body.text).toContain("Select load: 459100-1");
    expect(calls[0].body.text).toContain("Pickup: Sheridan, WY on 2026-11-10");
    expect(calls[0].body.text).toContain("Delivery: Houston, TX on 2026-11-12");
    expect(calls[0].body.text).toContain("Carrier: Northline Freight");
    expect(calls[0].body.text).toContain("MC: 445566");
    expect(calls[0].body.text).toContain("This is a new carrier assignment.");
    expect(calls[0].body.text).not.toMatch(/pay|rate|\$|2400|gate code/i);

    const duplicate = await postStatus({ orderId: order.id, carrierName: " northline   freight ", mcNumber: "mc-445566" });
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).notice).toBe("unchanged");
    expect(calls).toHaveLength(1);

    const changed = await postStatus({ orderId: order.id, carrierName: "Red Mesa Transport", mcNumber: "778899" });
    expect(changed.status).toBe(200);
    expect((await changed.json()).notice).toBe("changed");
    expect(calls).toHaveLength(2);
    expect(calls[1].body.subject).toBe("Carrier changed for SO-CARRIER");
    expect(calls[1].body.text).toContain("The assigned carrier changed.");
    expect(calls[1].body.text).toContain("Carrier: Red Mesa Transport");
    expect(calls[1].body.text).toContain("MC: 778899");
    expect(calls[1].body.text).not.toMatch(/pay|rate|\$|2400|gate code/i);
    expect(JSON.stringify(calls[1].body)).not.toMatch(/carrierPay|carrier_pay|customerCost|rateReason/);

    const viewer = await sessionCookie({
      userId: "emit-viewer-1",
      email: "viewer@emit.example",
      name: "View Only",
      role: "emit_viewer",
      permission: "view",
    });
    const detail = await getOrderRoute(new Request(`http://portal.test/api/orders/${order.id}`, { headers: headers(viewer) }), {
      params: Promise.resolve({ id: order.id }),
    });
    const seen = (await detail.json()).order as CustomerOrder;
    expect(seen.buildStatus).toBe("Built in SAM: 459100-1");
    expect(seen.notices?.map((notice) => notice.kind)).toEqual(["assigned", "changed"]);
    expect(seen.notices?.[0].text).toContain("New carrier assignment email sent to m.gray@emit.example");
    expect(seen.notices?.[0].text).toContain("Northline Freight");
    expect(seen.notices?.[0].text).toContain("445566");
    expect(seen.notices?.[1].text).toContain("Carrier change email sent");
    expect(seen.notices?.[1].text).toContain("Red Mesa Transport");
    expect(seen.customerCost).toBeUndefined();
    expect("samBuildStatus" in seen).toBe(false);
    expectNoSecrets(seen);

    const listed = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO-CARRIER", { headers: headers(viewer) }));
    const row = (await listed.json()).orders.find((item: CustomerOrder) => item.id === order.id);
    expect(row.buildStatus).toBe("Built in SAM: 459100-1");
    expect(row.notices).toHaveLength(2);
    expectNoSecrets(row);
  });
});

describe("carrier email copy", () => {
  it("describes a first assignment without a price", () => {
    expect(sameCarrier({ name: "Northline Freight", mc: "445566" }, { name: "northline freight", mc: "MC 445566" })).toBe(true);
    const mail = carrierEmail({
      kind: "assigned",
      salesOrderNumber: "SO-1",
      orderId: "order-1",
      loadNumber: null,
      originCity: "Sheridan",
      originState: "WY",
      destinationCity: "Houston",
      destinationState: "TX",
      shipDate: "2026-11-10",
      mustDeliverDate: "2026-11-12",
      carrierName: "Northline Freight",
      mc: "445566",
    });
    expect(mail.subject).toBe("Carrier assigned for SO-1");
    expect(mail.text).toContain("This is a new carrier assignment.");
    expect(mail.text).toContain("Select load: Pending");
    expect(mail.text).not.toMatch(/pay|rate|\$/i);
  });
});
