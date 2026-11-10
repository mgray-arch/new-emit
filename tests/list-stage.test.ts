import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import ReceiverLinkPage from "@/app/r/[token]/page";
import { PATCH as patchOrderRoute } from "@/app/api/orders/[id]/route";
import { GET as listOrdersRoute, POST as createOrderRoute } from "@/app/api/orders/route";
import PortalStatusControl from "@/components/portal-status-control";
import StatusPill from "@/components/status-pill";
import type { PortalContext } from "@/lib/db";
import { listStageChoice } from "@/lib/load-stage";
import { displayStatus } from "@/lib/load-list";
import { findUserById, sessionFromUser } from "@/lib/passwords";
import { createReceiver } from "@/lib/receivers";
import type { CustomerOrder } from "@/lib/types";
import { createEmitUser } from "@/lib/users";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  ctx = await seededPortal();
  savedEnv.SLACK_NEW_LOADS_WEBHOOK_URL = process.env.SLACK_NEW_LOADS_WEBHOOK_URL;
  delete process.env.SLACK_NEW_LOADS_WEBHOOK_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SLACK_NEW_LOADS_WEBHOOK_URL;
});

afterAll(() => {
  if (savedEnv.SLACK_NEW_LOADS_WEBHOOK_URL === undefined) delete process.env.SLACK_NEW_LOADS_WEBHOOK_URL;
  else process.env.SLACK_NEW_LOADS_WEBHOOK_URL = savedEnv.SLACK_NEW_LOADS_WEBHOOK_URL;
});

function headers(cookie?: string): HeadersInit {
  return {
    "content-type": "application/json",
    host: "portal.test",
    origin: "http://portal.test",
    ...(cookie ? { cookie } : {}),
  };
}

const lane = {
  origin: { company: "EMIT ALLEN", address1: "2437 Allen Avenue", city: "Sheridan", state: "WY", postalCode: "82801", country: "US" },
  destination: { company: "Receiver", address1: "100 Market", city: "Houston", state: "TX", postalCode: "77002", country: "US" },
};

function menu(props: Partial<Parameters<typeof PortalStatusControl>[0]> = {}) {
  return createElement(PortalStatusControl, {
    status: "being_prepared",
    salesOrderNumber: "SO123454TEST",
    canChange: true,
    confirming: false,
    busy: false,
    onPick: () => {},
    onConfirm: () => {},
    onCancel: () => {},
    ...props,
  });
}

async function createLoad(salesOrderNumber: string, cookie: string) {
  const response = await createOrderRoute(
    new Request("http://portal.test/api/orders", {
      method: "POST",
      headers: headers(cookie),
      body: JSON.stringify({ salesOrderNumber, ...lane, truckType: "53' Flatbed", shipDate: "2026-11-24", mustDeliverDate: "2026-11-26" }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()).order as CustomerOrder;
}

function patchStatus(id: string, cookie: string | undefined, portalStatus: string) {
  return patchOrderRoute(
    new Request(`http://portal.test/api/orders/${id}`, {
      method: "PATCH",
      headers: headers(cookie),
      body: JSON.stringify({ portalStatus }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("list card stage menu", () => {
  it("asks only when the stage is newly Ready to Ship, and lets the other two apply", () => {
    expect(listStageChoice("being_prepared", "ready_to_ship")).toBe("confirm");
    expect(listStageChoice("shipped", "ready_to_ship")).toBe("confirm");
    expect(listStageChoice("ready_to_ship", "ready_to_ship")).toBe("noop");
    expect(listStageChoice("being_prepared", "being_prepared")).toBe("noop");
    expect(listStageChoice("being_prepared", "shipped")).toBe("apply");
    expect(listStageChoice("ready_to_ship", "shipped")).toBe("apply");
    expect(listStageChoice("shipped", "being_prepared")).toBe("apply");
    expect(listStageChoice("ready_to_ship", "being_prepared")).toBe("apply");
    expect(listStageChoice("being_prepared", "cancelled")).toBe("noop");
    expect(listStageChoice("cancelled", "shipped")).toBe("apply");
  });

  it("replaces the portal stage label with a dropdown and leaves the tracking pill alone", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        menu({ status: "ready_to_ship" }),
        createElement(StatusPill, { status: "booked" }),
      ),
    );
    expect(html.match(/<select/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Stage for SO123454TEST"');
    expect(html).toContain("Being Prepared");
    expect(html).toContain("Ready to Ship");
    expect(html).toContain("Shipped");
    expect(html).not.toContain("Cancelled");
    expect(html).toContain('value="ready_to_ship"');
    expect(html).toContain("Booked");
    expect(html).toContain("status-booked");
    expect(html).not.toMatch(/Slack|Load Builder|\bSAM\b|\bTMS\b|carrier pay|\$/i);

    const locked = renderToStaticMarkup(menu({ canChange: false, status: "ready_to_ship" }));
    expect(locked).not.toContain("<select");
    expect(locked).toContain("Ready to Ship");
    expect(locked).toContain('data-editable="false"');

    const cancelled = renderToStaticMarkup(menu({ status: "cancelled" }));
    expect(cancelled).not.toContain("<select");
    expect(cancelled).toContain("Cancelled");

    const confirm = renderToStaticMarkup(menu({ confirming: true, error: "Could not change the stage" }));
    expect(confirm).toContain("Save as Ready to Ship");
    expect(confirm).toContain("Go back");
    expect(confirm).toContain('value="ready_to_ship"');
    expect(confirm).toContain("Could not change the stage");
    expect(confirm).not.toMatch(/Slack|Load Builder|\bSAM\b|\bTMS\b/i);

    const control = readFileSync("components/portal-status-control.tsx", "utf8");
    const dashboard = readFileSync("components/dashboard.tsx", "utf8");
    const stageChange = dashboard.slice(dashboard.indexOf("function pickListStage"), dashboard.indexOf("async function save"));
    expect(stageChange).toContain("listStageChoice");
    expect(stageChange).toContain('JSON.stringify({ portalStatus: next })');
    expect(stageChange).not.toMatch(/customerCost|carrierPay|rateReason/);
    expect(dashboard).toContain("canChangeStage = allowLoads && !readOnly");
    expect(dashboard).toContain("<PortalStatusControl");
    expect(dashboard).toContain("<StatusPill");
    expect(dashboard.indexOf("<PortalStatusControl")).toBeLessThan(dashboard.indexOf("<StatusPill"));
    expect(control + dashboard).not.toMatch(/Load Builder|\bSAM\b|\bTMS\b/);
    expect(readFileSync("app/r/[token]/page.tsx", "utf8")).not.toContain("PortalStatusControl");
    expect(readFileSync("app/track/[token]/page.tsx", "utf8")).not.toContain("<select");
    expect(readFileSync("app/track/[token]/page.tsx", "utf8")).not.toContain("PortalStatusControl");
  });
});

describe("list card stage change", () => {
  it("follows the existing stage save for EMIT and Select, confirms Ready to Ship once, and blocks everyone else", async () => {
    process.env.SLACK_NEW_LOADS_WEBHOOK_URL = "https://hooks.slack.test/new-loads";
    const posts: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      posts.push(String(init?.body));
      return new Response("ok", { status: 200 });
    });

    const emit = await sessionCookie(customerSession());
    const select = await sessionCookie(adminSession());
    const viewer = await sessionCookie({
      userId: "emit-viewer-list",
      email: "viewer@emit.example",
      name: "View Only",
      role: "emit_viewer",
      permission: "view",
    });
    const salesUser = await createEmitUser(ctx, {
      name: "Sales List",
      email: "sales.list@emit.example",
      password: "temporary-pass",
      profile: "sales",
      permission: "view",
    });
    const loaderUser = await createEmitUser(ctx, {
      name: "Loader List",
      email: "loader.list@emit.example",
      password: "temporary-pass",
      profile: "loader",
      permission: "view",
    });
    const salesRow = await findUserById(ctx, salesUser.user.id);
    const loaderRow = await findUserById(ctx, loaderUser.user.id);
    if (!salesRow || !loaderRow) throw new Error("profile user missing");
    const sales = await sessionCookie(sessionFromUser(salesRow));
    const loader = await sessionCookie(sessionFromUser(loaderRow));
    const preview = `${select}; portal_view_as=${encodeURIComponent("regular:add")}`;

    const order = await createLoad("SO123454TEST", emit);
    expect(order.portalStatus).toBe("being_prepared");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("Order received - Being Prepared");
    expect(posts[0]).not.toContain("Ready to Ship");
    await ctx.db
      .prepare(`UPDATE loads SET customer_cost_cents = ?, load_number = ?, tracking_stage = 'booked', comments = ? WHERE id = ?`)
      .run(175000, "467624-1", "carrier pay 8765.43", order.id);

    const anonymous = await patchStatus(order.id, undefined, "ready_to_ship");
    expect(anonymous.status).toBe(401);
    for (const cookie of [viewer, sales, loader, preview]) {
      const refused = await patchStatus(order.id, cookie, "shipped");
      expect(refused.status).toBe(403);
      expectNoSecrets(await refused.json());
    }
    expect(posts).toHaveLength(1);
    const still = await ctx.db.prepare(`SELECT portal_status, customer_cost_cents, tracking_stage FROM loads WHERE id = ?`).get(order.id);
    expect(still?.portal_status).toBe("being_prepared");
    expect(still?.customer_cost_cents).toBe(175000);
    expect(still?.tracking_stage).toBe("booked");

    const ready = await patchStatus(order.id, emit, "ready_to_ship");
    expect(ready.status).toBe(200);
    const readyOrder = (await ready.json()).order as CustomerOrder;
    expect(readyOrder.portalStatus).toBe("ready_to_ship");
    expect(readyOrder.trackingStage).toBe("booked");
    expect(displayStatus(readyOrder, "2026-11-10", { needsAttention: false })).toBe("booked");
    expect(readyOrder.stageEvents?.at(-1)?.text).toBe("Stage changed from Being Prepared to Ready to Ship.");
    expect(readyOrder.customerCost).toBeUndefined();
    expect(JSON.stringify(readyOrder)).not.toMatch(/8765|1750|carrierPay|carrier_pay|\$/);
    expectNoSecrets(readyOrder);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toContain("Ready to Ship");
    expect(posts[1]).toContain("SO: SO123454TEST");
    expect(posts[1]).not.toMatch(/8765|\$|carrier pay/i);

    const same = await patchStatus(order.id, emit, "ready_to_ship");
    expect(same.status).toBe(200);
    expect(posts).toHaveLength(2);

    const prepared = await patchStatus(order.id, emit, "being_prepared");
    expect(prepared.status).toBe(200);
    const preparedOrder = (await prepared.json()).order as CustomerOrder;
    expect(preparedOrder.portalStatus).toBe("being_prepared");
    expect(preparedOrder.trackingStage).toBe("booked");
    expect(preparedOrder.stageEvents?.at(-1)?.text).toBe("Stage changed from Ready to Ship to Being Prepared.");
    expect(posts).toHaveLength(2);
    expect(posts.filter((post) => post.includes("Ready to Ship"))).toHaveLength(1);

    const again = await patchStatus(order.id, emit, "ready_to_ship");
    expect(again.status).toBe(200);
    expect(posts).toHaveLength(2);

    const shipped = await patchStatus(order.id, select, "shipped");
    expect(shipped.status).toBe(200);
    const shippedOrder = (await shipped.json()).order as CustomerOrder;
    expect(shippedOrder.portalStatus).toBe("shipped");
    expect(shippedOrder.trackingStage).toBe("in_transit");
    expect(shippedOrder.stageEvents?.at(-1)?.text).toBe("Stage changed from Ready to Ship to Shipped.");
    expect(posts).toHaveLength(2);
    expect(JSON.stringify(shippedOrder)).not.toMatch(/8765|carrierPay|carrier_pay/);

    const back = await patchStatus(order.id, emit, "being_prepared");
    expect(back.status).toBe(200);
    expect((await back.json()).order.portalStatus).toBe("being_prepared");
    expect(posts).toHaveLength(2);

    const listed = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO123454TEST", { headers: headers(emit) }));
    expect(listed.status).toBe(200);
    const rows = (await listed.json()).orders as CustomerOrder[];
    expect(rows.find((row) => row.id === order.id)?.portalStatus).toBe("being_prepared");
    expect(JSON.stringify(rows)).not.toMatch(/8765|1750|carrierPay/);

    const stored = await ctx.db.prepare(`SELECT portal_status, customer_cost_cents, slack_ready_at FROM loads WHERE id = ?`).get(order.id);
    expect(stored?.portal_status).toBe("being_prepared");
    expect(stored?.customer_cost_cents).toBe(175000);
    expect(stored?.slack_ready_at).toBeTruthy();

    const receiver = await createReceiver(ctx, { company: "List Dock LLC", contactEmails: [] });
    const delivered = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(emit),
        body: JSON.stringify({
          salesOrderNumber: "SO-LIST-DOCK",
          stops: [
            { kind: "pickup", place: lane.origin },
            { kind: "drop", place: { ...lane.destination, company: "List Dock LLC", city: "Sheridan", state: "WY" } },
          ],
          portalStatus: "ready_to_ship",
        }),
      }),
    );
    expect(delivered.status).toBe(201);
    const page = renderToStaticMarkup(await ReceiverLinkPage({ params: Promise.resolve({ token: receiver.token }) }));
    expect(page).toContain("Ready to Ship");
    expect(page).not.toContain("<select");
    expect(page).not.toContain("Save as Ready to Ship");
    expect(page).not.toMatch(/carrier pay|\$|Load Builder|\bSAM\b|\bTMS\b/i);
  });
});
