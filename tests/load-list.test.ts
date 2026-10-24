import { beforeAll, describe, expect, it } from "vitest";
import { GET as exportOrders } from "@/app/api/orders/export/route";
import { GET as listOrdersRoute } from "@/app/api/orders/route";
import { attentionReasons, displayStatus, emptyListMessage, fileSummary, loadsToCsv, pickupGroup, simpleStepIndex, tripCaption } from "@/lib/load-list";
import { listBoard, listOrders } from "@/lib/orders";
import type { PortalContext } from "@/lib/db";
import type { CustomerOrder } from "@/lib/types";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;

beforeAll(async () => {
  ctx = await seededPortal();
});

function headers(cookie: string): HeadersInit {
  return { cookie, host: "portal.test", origin: "http://portal.test" };
}

describe("load lists", () => {
  it("groups pickup dates as today, tomorrow, this week, and later", () => {
    const today = "2026-10-14";
    const tomorrow = "2026-10-15";
    const weekEnd = "2026-10-18";
    expect(pickupGroup(null, today, tomorrow, weekEnd)).toBe("unscheduled");
    expect(pickupGroup("2026-10-13", today, tomorrow, weekEnd)).toBe("earlier");
    expect(pickupGroup(today, today, tomorrow, weekEnd)).toBe("today");
    expect(pickupGroup(tomorrow, today, tomorrow, weekEnd)).toBe("tomorrow");
    expect(pickupGroup("2026-10-16", today, tomorrow, weekEnd)).toBe("week");
    expect(pickupGroup("2026-10-19", today, tomorrow, weekEnd)).toBe("later");
  });

  it("names the four attention reasons and ignores a cancelled load", () => {
    const today = "2026-10-14";
    const base = {
      loadNumber: "1-1",
      pendingReviewCount: 0,
      trackingLink: "https://track.example/a",
      trackingStage: "booked" as const,
      mustDeliverDate: "2026-10-16",
      portalStatus: "ready_to_ship" as const,
    };
    expect(attentionReasons({ ...base, loadNumber: null }, today)).toEqual(["Pending Select load number"]);
    expect(attentionReasons({ ...base, pendingReviewCount: 2 }, today)).toEqual(["Files in review"]);
    expect(attentionReasons({ ...base, trackingStage: "in_transit", trackingLink: null }, today)).toEqual(["Missing tracking"]);
    expect(attentionReasons({ ...base, mustDeliverDate: "2026-10-01" }, today)).toEqual(["Past due"]);
    expect(attentionReasons({ ...base, loadNumber: null, portalStatus: "cancelled" }, today)).toEqual([]);
  });

  it("uses plain status pills, file counts, and a four-step timeline", () => {
    const today = "2026-10-14";
    const base = {
      loadNumber: "1-1",
      pendingReviewCount: 0,
      trackingLink: "https://track.example/a",
      trackingStage: "booked" as const,
      mustDeliverDate: "2026-10-16",
      portalStatus: "ready_to_ship" as const,
      attachmentCount: 2,
      bolCount: 0,
    };
    expect(displayStatus(base, today)).toBe("booked");
    expect(displayStatus({ ...base, trackingStage: "in_transit", portalStatus: "shipped" }, today)).toBe("in_transit");
    expect(displayStatus({ ...base, trackingStage: "delivered", portalStatus: "shipped" }, today)).toBe("delivered");
    expect(displayStatus({ ...base, trackingStage: "submitted", portalStatus: "being_prepared", loadNumber: null }, today)).toBe("attention");
    expect(displayStatus({ ...base, trackingStage: "in_transit", trackingLink: null, portalStatus: "shipped" }, today)).toBe("attention");
    expect(displayStatus({ ...base, trackingStage: "in_transit", trackingLink: null, portalStatus: "shipped" }, today, { needsAttention: false })).toBe("in_transit");
    expect(displayStatus({ ...base, trackingStage: "submitted", portalStatus: "being_prepared", loadNumber: null }, today, { needsAttention: false })).toBe("pending");
    expect(displayStatus({ ...base, portalStatus: "cancelled" }, today)).toBe("cancelled");
    expect(fileSummary(base)).toBe("2 files");
    expect(fileSummary({ ...base, attachmentCount: 1, bolCount: 1, pendingReviewCount: 1 })).toBe("2 files, 1 awaiting review");
    expect(fileSummary({ ...base, attachmentCount: 0, bolCount: 0, pendingReviewCount: 0 })).toBe("No files yet");
    expect(fileSummary({ ...base, attachmentCount: 0, bolCount: 0, pendingReviewCount: 1 })).toBe("1 awaiting review");
    expect(simpleStepIndex("submitted")).toBe(0);
    expect(simpleStepIndex("booked")).toBe(1);
    expect(simpleStepIndex("at_pickup")).toBe(2);
    expect(simpleStepIndex("in_transit")).toBe(2);
    expect(simpleStepIndex("delivered")).toBe(3);
    expect(tripCaption("in_transit", false)).toContain("on the road");
    expect(emptyListMessage("attention", false)).toContain("Nothing needs attention");
    expect(emptyListMessage("history", true)).toContain("No loads match");
  });

  it("puts each seeded load in one tab and keeps a 7-day delivered window", async () => {
    const all = await listOrders(ctx, { pageSize: 50 });
    const tabs = await Promise.all(
      (["attention", "active", "delivered", "history"] as const).map((tab) => listOrders(ctx, { tab, pageSize: 50 })),
    );
    const ids = tabs.flatMap((page) => page.orders.map((order) => order.id));
    expect(ids.length).toBe(all.total);
    expect(new Set(ids).size).toBe(all.total);

    const inTab = (tab: (typeof tabs)[number], so: string) => tab.orders.some((order) => order.salesOrderNumber === so);
    expect(inTab(tabs[0], "SO2196")).toBe(true);
    expect(inTab(tabs[0], "SO2981")).toBe(true);
    expect(inTab(tabs[1], "SO4429")).toBe(true);
    expect(inTab(tabs[2], "SO-002722")).toBe(true);
    expect(inTab(tabs[3], "SO4540")).toBe(true);
    expect(inTab(tabs[3], "SO4410")).toBe(true);

    const active = tabs[1];
    const weekIndex = active.orders.findIndex((order) => order.salesOrderNumber === "SO4429");
    const laterIndex = active.orders.findIndex((order) => order.salesOrderNumber === "SO4501");
    expect(weekIndex).toBeGreaterThanOrEqual(0);
    expect(laterIndex).toBeGreaterThan(weekIndex);

    await ctx.db.prepare(`UPDATE loads SET must_deliver_date = ? WHERE sales_order_number = ?`).run("2026-10-08", "SO4540");
    const stillDelivered = await listOrders(ctx, { tab: "delivered", pageSize: 50 });
    expect(stillDelivered.orders.some((order) => order.salesOrderNumber === "SO4540")).toBe(true);
    await ctx.db.prepare(`UPDATE loads SET must_deliver_date = ? WHERE sales_order_number = ?`).run("2026-10-07", "SO4540");
    const moved = await listOrders(ctx, { tab: "history", pageSize: 50 });
    expect(moved.orders.some((order) => order.salesOrderNumber === "SO4540")).toBe(true);
    const notDelivered = await listOrders(ctx, { tab: "delivered", pageSize: 50 });
    expect(notDelivered.orders.some((order) => order.salesOrderNumber === "SO4540")).toBe(false);
  });

  it("searches every tab, filters inside a tab, and pages on the server", async () => {
    const found = await listBoard(ctx, { q: "900196-1", tab: "history", pageSize: 25 });
    expect(found.scope).toBe("all");
    expect(found.orders.some((order) => order.salesOrderNumber === "SO2196")).toBe(true);
    expect((found.counts.attention ?? 0) + found.counts.active + found.counts.delivered + found.counts.history).toBe(found.total);

    const allen = await listOrders(ctx, { tab: "active", pickup: "EMIT ALLEN", pageSize: 50 });
    expect(allen.total).toBeGreaterThan(0);
    expect(allen.orders.every((order) => order.origin.company === "EMIT ALLEN")).toBe(true);

    const rock = await listOrders(ctx, { receiverCompany: "Enchanted Rock LLC", pageSize: 50 });
    expect(rock.orders.length).toBeGreaterThan(0);
    expect(
      rock.orders.every(
        (order) =>
          order.destination.company === "Enchanted Rock LLC" ||
          order.stops.some((stop) => stop.kind === "drop" && stop.place.company === "Enchanted Rock LLC"),
      ),
    ).toBe(true);

    const first = await listOrders(ctx, { tab: "attention", page: 1, pageSize: 2 });
    const second = await listOrders(ctx, { tab: "attention", page: 2, pageSize: 2 });
    expect(first.orders).toHaveLength(2);
    expect(second.orders.every((order) => !first.orders.some((kept) => kept.id === order.id))).toBe(true);
    const capped = await listOrders(ctx, { pageSize: 100 });
    expect(capped.pageSize).toBe(50);

    const cookie = await sessionCookie(customerSession());
    const response = await listOrdersRoute(new Request("http://portal.test/api/orders?q=Oklahoma", { headers: headers(cookie) }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pageSize).toBe(25);
    expect(body.scope).toBe("all");
    expect(body.orders.length).toBeGreaterThan(0);
    expect(body.orders.every((order: CustomerOrder) => !("customerCost" in order))).toBe(true);
    expectNoSecrets(body);
  });

  it("folds Needs Attention into Active or Delivered for EMIT and view-as, and keeps it for Select", async () => {
    const all = await listOrders(ctx, { pageSize: 50 });
    const selectTabs = await Promise.all(
      (["attention", "active", "delivered", "history"] as const).map((tab) => listOrders(ctx, { tab, pageSize: 50 })),
    );
    const emitTabs = await Promise.all(
      (["active", "delivered", "history"] as const).map((tab) =>
        listOrders(ctx, { tab, includeAttention: false, pageSize: 50 }),
      ),
    );
    const emitIds = emitTabs.flatMap((page) => page.orders.map((order) => order.id));
    expect(emitIds).toHaveLength(all.total);
    expect(new Set(emitIds).size).toBe(all.total);

    const emitActive = new Set(emitTabs[0].orders.map((order) => order.id));
    const emitDelivered = new Set(emitTabs[1].orders.map((order) => order.id));
    expect(selectTabs[0].total).toBeGreaterThan(0);
    for (const order of selectTabs[0].orders) {
      expect(order.trackingStage === "delivered" ? emitDelivered.has(order.id) : emitActive.has(order.id)).toBe(true);
    }
    for (const order of selectTabs[1].orders) expect(emitActive.has(order.id)).toBe(true);

    const asked = await listBoard(ctx, { tab: "attention", includeAttention: false, pageSize: 50 });
    expect(asked.tab).toBe("active");
    expect(asked.counts).not.toHaveProperty("attention");
    expect(asked.orders.map((order) => order.id).sort()).toEqual([...emitActive].sort());

    const selectBoard = await listBoard(ctx, { tab: "attention", pageSize: 50 });
    expect(selectBoard.tab).toBe("attention");
    expect(selectBoard.counts.attention).toBe(selectTabs[0].total);

    async function board(cookie: string, query = "tab=attention&page=1&pageSize=50") {
      const response = await listOrdersRoute(new Request(`http://portal.test/api/orders?${query}`, { headers: headers(cookie) }));
      const payload = await response.json();
      expect(response.status, JSON.stringify(payload)).toBe(200);
      return payload;
    }

    const customer = await sessionCookie(customerSession());
    const emitAdmin = await sessionCookie({
      userId: "emit-admin-1",
      email: "lead@emit.example",
      name: "EMIT Lead",
      role: "emit_admin",
    });
    const admin = await sessionCookie(adminSession());
    const asCustomer = await board(customer);
    const asEmitAdmin = await board(emitAdmin);
    const asRegularPreview = await board(`${admin}; portal_view_as=regular:add`);
    const asAdminPreview = await board(`${admin}; portal_view_as=admin:full`);
    for (const payload of [asCustomer, asEmitAdmin, asRegularPreview, asAdminPreview]) {
      expect(payload.tab).toBe("active");
      expect(payload.counts).not.toHaveProperty("attention");
      expect(JSON.stringify(payload)).not.toContain("Needs Attention");
      expect(payload.orders.some((order: CustomerOrder) => order.salesOrderNumber === "SO2196")).toBe(true);
      expect(payload.orders.some((order: CustomerOrder) => order.salesOrderNumber === "SO4429")).toBe(true);
    }
    const implicit = await board(customer, "page=1&pageSize=50");
    expect(implicit.tab).toBe("active");
    expect(implicit.counts).not.toHaveProperty("attention");

    const asSelect = await board(admin);
    expect(asSelect.tab).toBe("attention");
    expect(asSelect.counts.attention).toBeGreaterThan(0);
    expect(asSelect.orders.some((order: CustomerOrder) => order.salesOrderNumber === "SO2196")).toBe(true);
    expect(asSelect.orders.some((order: CustomerOrder) => order.salesOrderNumber === "SO4429")).toBe(false);
    const implicitSelect = await board(admin, "page=1&pageSize=50");
    expect(implicitSelect.tab).toBe("attention");
    expect(implicitSelect.counts.attention).toBe(asSelect.counts.attention);

    const emitFile = await exportOrders(
      new Request("http://portal.test/api/orders/export?tab=attention", { headers: headers(customer) }),
    );
    const emitCsv = await emitFile.text();
    expect(emitCsv).toContain("SO2196");
    expect(emitCsv).toContain("SO4429");
    const selectFile = await exportOrders(
      new Request("http://portal.test/api/orders/export?tab=attention", { headers: headers(admin) }),
    );
    const selectCsv = await selectFile.text();
    expect(selectCsv).toContain("SO2196");
    expect(selectCsv).not.toContain("SO4429");
  });

  it("moves a past-due load and a load with no Select number into Needs Attention", async () => {
    await ctx.db.prepare(`UPDATE loads SET must_deliver_date = ? WHERE sales_order_number = ?`).run("2026-10-01", "SO2981");
    const late = await listOrders(ctx, { tab: "attention", q: "SO2981", pageSize: 10 });
    expect(late.orders.map((order) => order.salesOrderNumber)).toContain("SO2981");
    expect(attentionReasons(late.orders[0], "2026-10-14")).toContain("Past due");

    await ctx.db.prepare(`UPDATE loads SET load_number = NULL WHERE sales_order_number = ?`).run("SO4501");
    const pending = await listOrders(ctx, { tab: "attention", q: "SO4501", pageSize: 10 });
    expect(pending.orders[0]?.salesOrderNumber).toBe("SO4501");
    expect(attentionReasons(pending.orders[0], "2026-10-14")).toContain("Pending Select load number");
  });

  it("exports history as CSV without carrier pay, and without pricing for a regular EMIT user", async () => {
    const sample = {
      salesOrderNumber: "SO,1",
      loadNumber: null,
      portalStatus: "shipped",
      trackingStage: "delivered",
      origin: { company: "EMIT", city: "Sheridan", state: "WY" },
      destination: { company: "Kodiak", city: "Oklahoma City", state: "OK" },
      shipDate: "2026-10-01",
      mustDeliverDate: "2026-10-02",
      truckType: null,
      trackingLink: null,
      comments: "Call ahead",
      customerCost: 1500,
      rateReason: "Team",
    } as CustomerOrder;
    const hidden = loadsToCsv([sample], false);
    expect(hidden.startsWith("Sales order,Select load,")).toBe(true);
    expect(hidden).not.toMatch(/Cost|carrier/i);
    expect(hidden).toContain('"SO,1"');
    const shown = loadsToCsv([sample], true);
    expect(shown).toContain("Cost,Rate reason");
    expect(shown).toContain("1500.00");
    expect(shown).not.toMatch(/carrierPay|carrier_pay/);

    const customer = await sessionCookie(customerSession());
    const staffFile = await exportOrders(
      new Request("http://portal.test/api/orders/export?tab=history", { headers: headers(customer) }),
    );
    expect(staffFile.status).toBe(200);
    expect(staffFile.headers.get("content-type")).toMatch(/text\/csv/);
    const staffCsv = await staffFile.text();
    expect(staffCsv).toContain("SO4540");
    expect(staffCsv).toContain("SO4410");
    expect(staffCsv).not.toMatch(/Cost,|carrierPay|carrier_pay|1320|1400/);
    expectNoSecrets(staffCsv);

    const admin = await sessionCookie(adminSession());
    const adminFile = await exportOrders(
      new Request("http://portal.test/api/orders/export?tab=history&q=SO4540", { headers: headers(admin) }),
    );
    const adminCsv = await adminFile.text();
    expect(adminCsv).toContain("Cost,Rate reason");
    expect(adminCsv).toContain("1320.00");
    expect(adminCsv).not.toMatch(/carrierPay|carrier_pay/);
    expectNoSecrets(adminCsv);
  });
});
