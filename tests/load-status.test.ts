import { createElement } from "react";
import { readFileSync, existsSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as samCallback } from "@/app/api/integrations/sam-load/route";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { GET as listOrdersRoute, POST as createOrderRoute } from "@/app/api/orders/route";
import BuildStatus from "@/components/build-status";
import CarrierBadge from "@/components/carrier-badge";
import CarrierCallout from "@/components/carrier-callout";
import OrderHistory from "@/components/order-history";
import UpdateBanner from "@/components/update-banner";
import { GET as updatesRoute } from "@/app/api/updates/route";
import { buildStatusLabel } from "@/lib/build-status";
import { attentionReasons } from "@/lib/load-list";
import { findRateField, historyText, sameCarrier } from "@/lib/carrier-notice";
import { carrierBadgeLabel, updateBannerText } from "@/lib/carrier-seen";
import { documentPrintHtml } from "@/lib/document-print";
import type { PortalContext } from "@/lib/db";
import type { CustomerOrder } from "@/lib/types";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

const SECRET = "status-secret-0123456789";

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
  delete process.env.EMAIL_FROM;
  delete process.env.EMAIL_API_KEY;
  delete process.env.EMAIL_API_URL;
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
        notices: [{ at: "2026-11-03T16:00:00.000Z", kind: "assigned", text: "Carrier assigned: Northline Freight. MC 445566." }],
      }),
    );
    expect(history).toContain("History");
    expect(history).toContain("Northline Freight");
    expect(history).toContain("445566");
    expect(history).toContain('dateTime="2026-11-03T16:00:00.000Z"');
    expect(history).not.toMatch(/pay|rate|\$|email/i);
    const callout = renderToStaticMarkup(
      createElement(CarrierCallout, {
        haul: { company: "Northline Freight", mc: "445566", at: "2026-11-03T16:00:00.000Z", kind: "assigned" },
        badge: "assigned",
      }),
    );
    expect(callout).toContain("Northline Freight");
    expect(callout).toContain("MC 445566");
    expect(callout).toContain("Carrier assigned");
    expect(callout).not.toMatch(/pay|rate|\$/i);
    expect(renderToStaticMarkup(createElement(CarrierBadge, { kind: "changed" }))).toContain("Carrier changed");
    expect(renderToStaticMarkup(createElement(UpdateBanner, { count: 2 }))).toContain("2 orders updated since your last visit");
    expect(renderToStaticMarkup(createElement(UpdateBanner, { count: 0 }))).toBe("");
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

describe("carrier assignment in the portal", () => {
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

  it("shows a written-back SAM number on the board instead of Pending", async () => {
    const order = await createLoad("TEST TEST TEST");
    await ctx.db.prepare(`UPDATE loads SET must_deliver_date = ? WHERE id = ?`).run("2026-10-01", order.id);
    const posted = await postStatus({ salesOrderNumber: "TEST TEST TEST", loadNumber: "466318-1" });
    expect(posted.status).toBe(200);
    expect(await posted.json()).toMatchObject({
      orderId: order.id,
      salesOrderNumber: "TEST TEST TEST",
      loadNumber: "466318-1",
    });

    const cookie = await sessionCookie(adminSession());
    const listed = await listOrdersRoute(
      new Request("http://portal.test/api/orders?q=TEST%20TEST%20TEST&pageSize=20", { headers: headers(cookie) }),
    );
    expect(listed.status).toBe(200);
    const body = await listed.json();
    const row = body.orders.find((item: CustomerOrder) => item.id === order.id);
    expect(row.salesOrderNumber).toBe("TEST TEST TEST");
    expect(row.loadNumber).toBe("466318-1");
    expect(row.buildStatus).toBe("Built in SAM: 466318-1");
    expect(attentionReasons(row, body.today)).not.toContain("Pending Select load number");
    expect(attentionReasons(row, body.today)).toContain("Past due");

    const detail = await getOrderRoute(new Request(`http://portal.test/api/orders/${order.id}`, { headers: headers(cookie) }), {
      params: Promise.resolve({ id: order.id }),
    });
    const detailOrder = (await detail.json()).order as CustomerOrder;
    expect(detailOrder.loadNumber).toBe("466318-1");
    expect(detailOrder.salesOrderNumber).toBe("TEST TEST TEST");
    expect(detailOrder.buildStatus).toBe("Built in SAM: 466318-1");
  });

  it("stores the carrier with no mail configuration and does not call a mail API", async () => {
    const order = await createLoad("SO-NO-MAIL");
    delete process.env.EMAIL_FROM;
    delete process.env.EMAIL_API_KEY;
    delete process.env.EMAIL_API_URL;
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      throw new Error("mail is not used");
    });
    const assigned = await postStatus({ orderId: order.id, carrierName: "Northline Freight", mcNumber: "445566" });
    expect(assigned.status).toBe(200);
    expect((await assigned.json()).notice).toBe("assigned");
    expect(calls).toBe(0);
    const row = await ctx.db.prepare(`SELECT carrier_name, carrier_mc, carrier_notice_log FROM loads WHERE id = ?`).get(order.id);
    expect(row?.carrier_name).toBe("Northline Freight");
    expect(row?.carrier_mc).toBe("445566");
    expect(String(row?.carrier_notice_log)).toContain("Carrier assigned");
    expect(String(row?.carrier_notice_log)).not.toMatch(/email|pay|rate|\$/i);
  });

  it("records the first assignment and a change once each, and shows a badge until that user opens the order", async () => {
    const order = await createLoad("SO-CARRIER");
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response("no", { status: 500 });
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

    const assigned = await postStatus({ orderId: order.id, carrierName: "Northline Freight", mcNumber: "MC 445566" });
    expect(assigned.status).toBe(200);
    expect((await assigned.json()).notice).toBe("assigned");

    const duplicate = await postStatus({ orderId: order.id, carrierName: " northline   freight ", mcNumber: "mc-445566" });
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).notice).toBe("unchanged");

    const changed = await postStatus({ orderId: order.id, carrierName: "Red Mesa Transport", mcNumber: "778899" });
    expect(changed.status).toBe(200);
    expect((await changed.json()).notice).toBe("changed");
    expect(calls).toBe(0);

    const submitter = await sessionCookie(customerSession());
    const viewer = await sessionCookie({
      userId: "emit-viewer-1",
      email: "viewer@emit.example",
      name: "View Only",
      role: "emit_viewer",
      permission: "view",
    });

    const before = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO-CARRIER", { headers: headers(submitter) }));
    const beforeBody = await before.json();
    const beforeRow = beforeBody.orders.find((item: CustomerOrder) => item.id === order.id);
    expect(beforeRow.carrierBadge).toBe("changed");
    expect(beforeRow.haulCallout.company).toBe("Red Mesa Transport");
    expect(beforeRow.haulCallout.mc).toBe("778899");
    expect(beforeBody.updatedCount).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(beforeRow.haulCallout) + JSON.stringify(beforeRow.notices)).not.toMatch(/pay|rate|\$|email|gate code/i);
    expect(JSON.stringify(beforeRow)).not.toMatch(/"carrier_name"|"carrier_mc"|carrierPay/);

    const other = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO-CARRIER", { headers: headers(viewer) }));
    const otherRow = (await other.json()).orders.find((item: CustomerOrder) => item.id === order.id);
    expect(otherRow.carrierBadge).toBe("changed");

    const detail = await getOrderRoute(new Request(`http://portal.test/api/orders/${order.id}`, { headers: headers(submitter) }), {
      params: Promise.resolve({ id: order.id }),
    });
    const seen = (await detail.json()).order as CustomerOrder;
    expect(seen.buildStatus).toBe("Built in SAM: 459100-1");
    expect(seen.notices?.map((notice) => notice.kind)).toEqual(["assigned", "changed"]);
    expect(seen.notices?.[0].text).toContain("Carrier assigned: Northline Freight");
    expect(seen.notices?.[0].text).toContain("MC 445566");
    expect(seen.notices?.[0].at).toBeTruthy();
    expect(seen.notices?.[1].text).toContain("Carrier changed from Northline Freight");
    expect(seen.notices?.[1].text).toContain("Red Mesa Transport");
    expect(seen.notices?.[1].text).toContain("MC 778899");
    expect(seen.haulCallout?.company).toBe("Red Mesa Transport");
    expect(seen.haulCallout?.mc).toBe("778899");
    expect(seen.carrierBadge).toBe("changed");
    expect(seen.customerCost).toBeUndefined();
    expect("samBuildStatus" in seen).toBe(false);
    expectNoSecrets(seen);
    expect(JSON.stringify(seen.notices) + JSON.stringify(seen.haulCallout)).not.toMatch(/email|\$|pay|rate/i);
    expect(JSON.stringify(seen)).not.toMatch(/"carrier_name"|carrierPay/);

    const after = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO-CARRIER", { headers: headers(submitter) }));
    const afterBody = await after.json();
    const cleared = afterBody.orders.find((item: CustomerOrder) => item.id === order.id);
    expect(cleared.carrierBadge).toBeUndefined();
    expect(cleared.haulCallout.company).toBe("Red Mesa Transport");

    const still = await listOrdersRoute(new Request("http://portal.test/api/orders?updated=1", { headers: headers(viewer) }));
    const stillBody = await still.json();
    expect(stillBody.orders.some((item: CustomerOrder) => item.id === order.id)).toBe(true);
    expect(stillBody.orders.find((item: CustomerOrder) => item.id === order.id).carrierBadge).toBe("changed");

    const hidden = await listOrdersRoute(new Request("http://portal.test/api/orders?updated=1", { headers: headers(submitter) }));
    const hiddenBody = await hidden.json();
    expect(hiddenBody.orders.some((item: CustomerOrder) => item.id === order.id)).toBe(false);

    const banner = await updatesRoute(new Request("http://portal.test/api/updates", { headers: headers(viewer) }));
    expect(banner.status).toBe(200);
    expect((await banner.json()).count).toBeGreaterThanOrEqual(1);
    const quiet = await updatesRoute(new Request("http://portal.test/api/updates", { headers: headers(submitter) }));
    const quietCount = (await quiet.json()).count as number;
    const viewerCount = (await (await updatesRoute(new Request("http://portal.test/api/updates", { headers: headers(viewer) }))).json()).count as number;
    expect(viewerCount).toBeGreaterThan(quietCount);
  });
});

describe("carrier history copy", () => {
  it("describes an assignment and a change without a price or an email", () => {
    expect(sameCarrier({ name: "Northline Freight", mc: "445566" }, { name: "northline freight", mc: "MC 445566" })).toBe(true);
    const assigned = historyText("assigned", { name: "Northline Freight", mc: "445566" }, { name: "", mc: "" });
    expect(assigned).toBe("Carrier assigned: Northline Freight. MC 445566.");
    expect(assigned).not.toMatch(/pay|rate|\$|email/i);
    const changed = historyText(
      "changed",
      { name: "Red Mesa Transport", mc: "778899" },
      { name: "Northline Freight", mc: "445566" },
    );
    expect(changed).toContain("Carrier changed from Northline Freight (MC 445566) to Red Mesa Transport");
    expect(changed).not.toMatch(/pay|rate|\$|email/i);
    expect(carrierBadgeLabel("assigned")).toBe("Carrier assigned");
    expect(carrierBadgeLabel("changed")).toBe("Carrier changed");
    expect(updateBannerText(1)).toBe("1 order updated since your last visit");
    expect(updateBannerText(4)).toBe("4 orders updated since your last visit");
  });

  it("keeps the phone layout and a print page free of prices", () => {
    const dashboard = readFileSync("components/dashboard.tsx", "utf8");
    const shell = readFileSync("components/shell.tsx", "utf8");
    const css = readFileSync("app/globals.css", "utf8");
    expect(dashboard).toContain("load-row-status");
    expect(dashboard).toContain("CarrierBadge");
    expect(dashboard).toContain("file-btn");
    expect(shell).toContain("bottom-nav");
    expect(shell).toContain("UpdateBanner");
    expect(css).toContain(".bottom-nav");
    expect(css).toMatch(/\.load-row-status\s*\{[^}]*order:\s*-1/);
    expect(readFileSync("components/document-links.tsx", "utf8")).toContain("/print");
    expect(existsSync("lib/email.ts")).toBe(false);
    const page = documentPrintHtml({ src: "/api/documents/doc-1", filename: "bol.pdf", mediaType: "application/pdf" });
    expect(page).toContain("Print");
    expect(page).toContain('src="/api/documents/doc-1"');
    expect(page).toContain("min-height: 48px");
    expect(page).not.toMatch(/pay|rate|\$/i);
    expect(readFileSync("app/orders/[id]/page.tsx", "utf8")).toContain("CarrierCallout");
  });

  it("matches an all-caps sales order, accepts two calls, and stores only a customer tracking link", async () => {
    const order = await createLoad("so-track-me");
    const numbered = await postStatus({ salesOrderNumber: "SO-TRACK-ME", loadNumber: "459200-1" });
    expect(numbered.status).toBe(200);
    expect(await numbered.json()).toMatchObject({ orderId: order.id, loadNumber: "459200-1" });

    const badHost = await postStatus({
      salesOrderNumber: "SO-TRACK-ME",
      tracking_url: "https://evil.example/tracking/abc",
    });
    expect(badHost.status).toBe(400);
    const httpLink = await postStatus({
      sales_order_number: "so-track-me",
      trackingUrl: "http://customer.goselect.com/tracking/abc",
    });
    expect(httpLink.status).toBe(400);
    const wrongPath = await postStatus({
      orderId: order.id,
      tracking_url: "https://customer.goselect.com/loads/abc",
    });
    expect(wrongPath.status).toBe(400);
    const withPay = await postStatus({
      salesOrderNumber: "SO-TRACK-ME",
      tracking_url: "https://customer.goselect.com/tracking/abc",
      carrierPay: 10,
    });
    expect(withPay.status).toBe(400);
    const untouched = await ctx.db.prepare(`SELECT tracking_link, carrier_name FROM loads WHERE id = ?`).get(order.id);
    expect(untouched?.tracking_link ?? null).toBeNull();
    expect(untouched?.carrier_name ?? null).toBeNull();

    const started = await postStatus({
      salesOrderNumber: "SO-TRACK-ME",
      tracking_url: "https://customer.goselect.com/tracking/abc",
    });
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({
      trackingLink: "https://customer.goselect.com/tracking/abc",
      tracking: "started",
    });

    const later = await postStatus({
      salesOrderNumber: "so-track-me",
      carrierName: "Northline Freight",
      mcNumber: "445566",
      tracking_url: "https://customer.goselect.com/tracking/abc",
    });
    expect(later.status).toBe(200);
    const laterBody = await later.json();
    expect(laterBody.notice).toBe("assigned");
    expect(laterBody.tracking).toBe("unchanged");
    expect(laterBody.loadNumber).toBe("459200-1");

    const cookie = await sessionCookie(customerSession());
    const detail = await getOrderRoute(new Request(`http://portal.test/api/orders/${order.id}`, { headers: headers(cookie) }), {
      params: Promise.resolve({ id: order.id }),
    });
    const viewed = (await detail.json()).order as CustomerOrder;
    expect(viewed.trackingLink).toBe("https://customer.goselect.com/tracking/abc");
    expect(viewed.trackingEvents?.map((event) => event.text)).toEqual(["Tracking started."]);
    expect(viewed.trackingBadge).toBe(true);
    expect(JSON.stringify(viewed.trackingEvents)).not.toMatch(/pay|rate|\$/i);

    const listed = await listOrdersRoute(new Request("http://portal.test/api/orders?q=so-track-me", { headers: headers(cookie) }));
    const row = (await listed.json()).orders.find((item: CustomerOrder) => item.id === order.id);
    expect(row.trackingBadge).toBeUndefined();
    expect(row.trackingLink).toBe("https://customer.goselect.com/tracking/abc");
  });
});
