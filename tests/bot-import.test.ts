import { beforeAll, describe, expect, it } from "vitest";
import * as importRoute from "@/app/api/integrations/loads/import/route";
import { POST } from "@/app/api/integrations/loads/import/route";
import { POST as createOrder } from "@/app/api/orders/route";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as postTracking } from "@/app/api/integrations/tracking-link/route";
import { BOT_UPLOAD_LIMIT } from "@/lib/bot-documents";
import type { PortalContext } from "@/lib/db";
import { formatEnteredBy } from "@/lib/entered-by";
import { attentionReasons } from "@/lib/load-list";
import {
  mapImportEquipment,
  mapImportStatus,
  salesOrdersMatch,
  storedSalesOrder,
} from "@/lib/load-import";
import { getOrder, listOrders } from "@/lib/orders";
import { appointmentWindow, calendarDate } from "@/lib/stop-schedule";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "@/tests/helpers";

const KEY = "bot-upload-test-key-0123456789";

let ctx: PortalContext;

beforeAll(async () => {
  process.env.BOT_UPLOAD_KEY = KEY;
  ctx = await seededPortal();
});

function post(body: unknown, init?: { key?: string | null; ip?: string; contentType?: string | null }) {
  const headers = new Headers();
  if (init?.key !== null) headers.set("authorization", `Bearer ${init?.key ?? KEY}`);
  headers.set("x-forwarded-for", init?.ip ?? "203.0.113.10");
  if (init?.contentType !== null) headers.set("content-type", init?.contentType ?? "application/json");
  return new Request("http://portal.test/api/integrations/loads/import", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const pickup = {
  sequence: 1,
  type: "Pickup",
  locationName: "EMIT TECHNOLOGIES",
  address1: "2571 North Main Street",
  city: "Sheridan",
  state: "WY",
  postalCode: "82801",
  date: "2026-03-02T12:00:00.000Z",
  time: "0600 MDT",
};

const drop = {
  sequence: 2,
  type: "Delivery",
  locationName: "INTERMOUNTAIN ELECTRONICS - PRICE",
  address: "1676 East Declaration Drive, Price, UT, 84501",
  city: "Price",
  state: "UT",
  postalCode: "84501",
  date: "2026-03-04",
  time: "0800 - 1700",
  arrivalTime: "2026-03-04T18:00:00.000Z",
  departureTime: "2026-03-04T20:15:00.000Z",
};

function sample(overrides: Record<string, unknown> = {}) {
  return {
    selectLoadNumber: "470100-1",
    salesOrderNumber: "SO-68458",
    status: "Completed",
    equipment: "Flatbed",
    customerRate: 1500,
    trackingShareUrl: "https://customer.goselect.com/tracking/example",
    createdAt: "2026-03-02T15:04:00.000Z",
    stops: [pickup, drop],
    ...overrides,
  };
}

async function countLoads(loadNumber: string): Promise<number> {
  const row = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM loads WHERE load_number = ?`).get(loadNumber);
  return Number(row?.n ?? 0);
}

describe("SAM status, equipment, and sales order mapping", () => {
  it("maps SAM transit statuses onto the portal status and tracking stage", () => {
    expect(mapImportStatus("Completed")).toEqual({ portalStatus: "shipped", trackingStage: "delivered" });
    expect(mapImportStatus("Delivered")).toEqual({ portalStatus: "shipped", trackingStage: "delivered" });
    expect(mapImportStatus("complete")).toEqual({ portalStatus: "shipped", trackingStage: "delivered" });
    expect(mapImportStatus("In Transit")).toEqual({ portalStatus: "shipped", trackingStage: "in_transit" });
    expect(mapImportStatus("active")).toEqual({ portalStatus: "shipped", trackingStage: "in_transit" });
    expect(mapImportStatus("Covered")).toEqual({ portalStatus: "ready_to_ship", trackingStage: "booked" });
    expect(mapImportStatus("Dispatched")).toEqual({ portalStatus: "ready_to_ship", trackingStage: "booked" });
    expect(mapImportStatus("Loaded")).toEqual({ portalStatus: "shipped", trackingStage: "at_pickup" });
    expect(mapImportStatus("At Shipper")).toEqual({ portalStatus: "shipped", trackingStage: "at_pickup" });
    expect(mapImportStatus("At Receiver")).toEqual({ portalStatus: "shipped", trackingStage: "in_transit" });
    expect(mapImportStatus("Out for Delivery")).toEqual({ portalStatus: "shipped", trackingStage: "in_transit" });
    expect(mapImportStatus("Open")).toEqual({ portalStatus: "being_prepared", trackingStage: "submitted" });
    expect(mapImportStatus("Cancelled", true)).toEqual({ portalStatus: "cancelled", trackingStage: "submitted" });
    expect(mapImportStatus("Not a status")).toEqual({ error: 'Status "Not a status" is not a SAM transit status.' });
    expect(mapImportStatus("")).toEqual({ error: "Status is required." });
  });

  it("maps known equipment and keeps the raw text otherwise", () => {
    expect(mapImportEquipment("Flatbed")).toBe("Flatbed");
    expect(mapImportEquipment("Flatbed, Hotshot")).toBe("Hot Shot");
    expect(mapImportEquipment("53' Flatbed")).toBe("53' Flatbed");
    expect(mapImportEquipment("F53")).toBe("53' Flatbed");
    expect(mapImportEquipment("Sprinter")).toBe("Sprinter Van");
    expect(mapImportEquipment("Conestoga")).toBe("Conestoga");
    expect(mapImportEquipment("Straight Box Truck")).toBe("Straight Box Truck");
    expect(mapImportEquipment("Power Only")).toBe("Power Only");
    expect(mapImportEquipment("Step Deck")).toBe("Step Deck");
    expect(mapImportEquipment("Flatbed or Stepdeck")).toBe("Flatbed or Stepdeck");
    expect(mapImportEquipment("Straight Van")).toBe("Straight Van");
    expect(mapImportEquipment("53' Van")).toBe("53' Van");
    expect(mapImportEquipment("RGN lowboy")).toBe("RGN lowboy");
    expect(mapImportEquipment("")).toBeNull();
  });

  it("keeps the raw sales order and only folds a single SO number for matching", () => {
    expect(storedSalesOrder("  SO-68458 ").raw).toBe("SO-68458");
    expect(storedSalesOrder("so-1276_1277_2496_2497").raw).toBe("so-1276_1277_2496_2497");
    expect(storedSalesOrder("3109").raw).toBe("3109");
    expect(storedSalesOrder(null).raw).toBe("");
    expect(storedSalesOrder("  So-2737 ").raw).toBe("So-2737");
    expect(salesOrdersMatch("SO-68458", "68458")).toBe(true);
    expect(salesOrdersMatch("so 68458", "SO68458")).toBe(true);
    expect(salesOrdersMatch("SO-001989", "1989")).toBe(false);
    expect(salesOrdersMatch("so-1276_1277_2496_2497", "SO-1276_1277_2496_2497")).toBe(true);
    expect(salesOrdersMatch("so-1276_1277_2496_2497", "1276")).toBe(false);
    expect(salesOrdersMatch("", "68458")).toBe(false);
    expect(calendarDate("2026-10-22T12:00:00.000Z")).toBe("2026-10-22");
    expect(appointmentWindow("0800 - 1700")).toEqual({ start: "08:00", end: "17:00", text: null });
    expect(appointmentWindow("0600 MDT")).toEqual({ start: "06:00", end: null, text: null });
    expect(appointmentWindow("11530").text).toBe("11530");
  });
});

describe("POST /api/integrations/loads/import", () => {
  it("accepts only the bearer key and only POST", async () => {
    const handlers = importRoute as Record<string, unknown>;
    expect(handlers.POST).toEqual(expect.any(Function));
    expect(handlers.GET).toBeUndefined();
    const missing = await POST(post({ dryRun: true, loads: [sample()] }, { key: null, ip: "203.0.113.21" }));
    expect(missing.status).toBe(401);
    const cookie = await sessionCookie(customerSession());
    const sessionOnly = await POST(
      new Request("http://portal.test/api/integrations/loads/import", {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-forwarded-for": "203.0.113.22" },
        body: JSON.stringify({ dryRun: true, loads: [sample()] }),
      }),
    );
    expect(sessionOnly.status).toBe(401);
    const notJson = await POST(post("dryRun=true", { ip: "203.0.113.23", contentType: "text/plain" }));
    expect(notJson.status).toBe(415);
    const word = await POST(post({ dryRun: "true", loads: [sample()] }, { ip: "203.0.113.24" }));
    expect(word.status).toBe(400);
    const tooMany = await POST(post({ dryRun: true, loads: Array.from({ length: 201 }, () => ({})) }, { ip: "203.0.113.25" }));
    expect(tooMany.status).toBe(400);
    expect(await countLoads("470100-1")).toBe(0);
  });

  it("dry-runs without writing, then creates and updates the same Select number", async () => {
    const before = await countLoads("470100-1");
    const preview = await POST(
      post(
        {
          dryRun: true,
          loads: [sample(), sample({ status: "In Transit" })],
        },
        { ip: "203.0.113.30" },
      ),
    );
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody.dryRun).toBe(true);
    expect(previewBody.results.map((item: { action: string }) => item.action)).toEqual(["would create", "would update"]);
    expect(previewBody.summary).toEqual({ "would create": 1, "would update": 1 });
    expect(await countLoads("470100-1")).toBe(before);

    const created = await POST(post({ dryRun: false, loads: [sample({ status: "In Transit", equipment: "Flatbed" })] }, { ip: "203.0.113.31" }));
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.results[0]).toMatchObject({
      action: "created",
      selectLoadNumber: "470100-1",
      salesOrderNumber: "SO-68458",
      portalStatus: "shipped",
      trackingStage: "in_transit",
      truckType: "Flatbed",
    });
    const id = createdBody.results[0].orderId as string;
    expect(await countLoads("470100-1")).toBe(1);

    const updated = await POST(
      post(
        {
          dryRun: false,
          loads: [sample({ status: "Completed", equipment: "Flatbed, Hotshot", trackingShareUrl: "https://customer.goselect.com/tracking/next" })],
        },
        { ip: "203.0.113.32" },
      ),
    );
    const updatedBody = await updated.json();
    expect(updatedBody.results[0]).toMatchObject({
      action: "updated",
      orderId: id,
      portalStatus: "shipped",
      trackingStage: "delivered",
      truckType: "Hot Shot",
    });
    expect(await countLoads("470100-1")).toBe(1);

    const kept = await POST(
      post({ dryRun: false, loads: [sample({ customerRate: undefined, trackingShareUrl: undefined, equipment: undefined })] }, { ip: "203.0.113.33" }),
    );
    expect((await kept.json()).results[0].action).toBe("updated");
    const row = await ctx.db
      .prepare(
        `SELECT source, entered_by_name, entered_by_email, created_by, sales_order_number, customer_cost_cents, truck_type, tracking_link, tracking_link_source, ship_date, ship_time, must_deliver_date, created_at, comments
         FROM loads WHERE load_number = ?`,
      )
      .get("470100-1");
    expect(row).toMatchObject({
      source: "sam-import",
      entered_by_name: "Imported from SAM",
      entered_by_email: null,
      created_by: "Imported from SAM",
      sales_order_number: "SO-68458",
      customer_cost_cents: 150000,
      truck_type: "Hot Shot",
      tracking_link: "https://customer.goselect.com/tracking/next",
      tracking_link_source: "sam-import",
      ship_date: "2026-03-02",
      ship_time: "06:00",
      must_deliver_date: "2026-03-04",
      created_at: "2026-03-02T15:04:00.000Z",
      comments: "",
    });
    expect(formatEnteredBy(String(row?.entered_by_name), null)).toBe("Imported from SAM");
  });

  it("keeps odd sales orders, multi-stop schedules, and raw equipment", async () => {
    const response = await POST(
      post(
        {
          dryRun: false,
          loads: [
            sample({
              selectLoadNumber: "470510-1",
              salesOrderNumber: "so-1276_1277_2496_2497",
              equipment: "Straight Box Truck",
              stops: [
                {
                  sequence: 3,
                  type: "Delivery",
                  locationName: "Second Drop",
                  address1: "2 Second Street",
                  city: "Billings",
                  state: "MT",
                  postalCode: "59101",
                  date: "2026-03-06",
                  time: "11530",
                },
                {
                  sequence: 1,
                  type: "Pickup",
                  locationName: "EMIT TECHNOLOGIES",
                  address1: "2571 North Main Street",
                  city: "Sheridan",
                  state: "WY",
                  postalCode: "82801",
                  date: "2026-03-02T12:00:00.000Z",
                  time: "1600",
                  arrivalTime: "2026-03-02T22:00:00.000Z",
                  departureTime: "2026-03-03T01:00:00.000Z",
                },
                {
                  sequence: 2,
                  kind: "drop",
                  company: "First Drop",
                  address1: "1 First Street",
                  city: "Casper",
                  state: "WY",
                  postalCode: "82601",
                  date: "2026-03-04",
                  appointment: { earliest: "08:00", latest: "12:00" },
                },
              ],
            }),
            sample({
              selectLoadNumber: "470511-1",
              salesOrderNumber: "3109",
              equipment: "Power Only",
              trackingShareUrl: "javascript:alert(1)",
            }),
            sample({
              selectLoadNumber: "470512-1",
              salesOrderNumber: "  So-2737 ",
              equipment: "",
              equipmentCode: "SP",
            }),
            { selectLoadNumber: "470513-1", status: "Completed", stops: [pickup, drop] },
            { selectLoadNumber: "nope", status: "Completed", stops: [pickup, drop] },
          ],
        },
        { ip: "203.0.113.40" },
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results.map((item: { action: string }) => item.action)).toEqual(["created", "created", "created", "created", "error"]);
    expect(JSON.stringify(body.results[1].warnings)).not.toContain("javascript:");
    const multi = await ctx.db.prepare(`SELECT id, sales_order_number, stops_json, truck_type, ship_date, must_deliver_date FROM loads WHERE load_number = ?`).get("470510-1");
    expect(multi?.sales_order_number).toBe("so-1276_1277_2496_2497");
    expect(multi?.truck_type).toBe("Straight Box Truck");
    expect(multi?.ship_date).toBe("2026-03-02");
    expect(multi?.must_deliver_date).toBe("2026-03-06");
    const stops = JSON.parse(String(multi?.stops_json)) as Array<{ kind: string; schedule?: { date?: string; appointmentStart?: string; appointmentEnd?: string; appointmentText?: string; arrivedAt?: string } }>;
    expect(stops.map((stop) => stop.kind)).toEqual(["pickup", "drop", "drop"]);
    expect(stops[0].schedule).toMatchObject({ date: "2026-03-02", appointmentStart: "16:00", arrivedAt: "2026-03-02T22:00:00.000Z" });
    expect(stops[1].schedule).toMatchObject({ date: "2026-03-04", appointmentStart: "08:00", appointmentEnd: "12:00" });
    expect(stops[2].schedule).toMatchObject({ date: "2026-03-06", appointmentText: "11530" });

    const bare = await ctx.db.prepare(`SELECT sales_order_number, truck_type, tracking_link FROM loads WHERE load_number = ?`).get("470511-1");
    expect(bare).toMatchObject({ sales_order_number: "3109", truck_type: "Power Only", tracking_link: null });
    const coded = await ctx.db.prepare(`SELECT sales_order_number, truck_type FROM loads WHERE load_number = ?`).get("470512-1");
    expect(coded).toMatchObject({ sales_order_number: "So-2737", truck_type: "Sprinter Van" });
    const missingSo = await ctx.db.prepare(`SELECT sales_order_number FROM loads WHERE load_number = ?`).get("470513-1");
    expect(missingSo?.sales_order_number).toBe("");
    expect(await countLoads("nope")).toBe(0);

    const customer = await sessionCookie(customerSession());
    const hidden = await getOrderRoute(new Request(`http://portal.test/api/orders/${multi?.id}`, { headers: { cookie: customer } }), {
      params: Promise.resolve({ id: String(multi?.id) }),
    });
    const hiddenBody = await hidden.json();
    expect(hiddenBody.order.truckType).toBe("Straight Box Truck");
    expect(hiddenBody.order.stops).toHaveLength(3);
    expect(hiddenBody.order.stops[1].schedule.appointmentStart).toBe("08:00");
    expect(hiddenBody.order.customerCost).toBeUndefined();
    expect(formatEnteredBy(hiddenBody.order.enteredByName, hiddenBody.order.enteredByEmail)).toBe("Imported from SAM");
    expectNoSecrets(hiddenBody);

    const admin = await sessionCookie(adminSession());
    const shown = await getOrderRoute(new Request(`http://portal.test/api/orders/${multi?.id}`, { headers: { cookie: admin } }), {
      params: Promise.resolve({ id: String(multi?.id) }),
    });
    const shownBody = await shown.json();
    expect(shownBody.order.customerCost).toBe(1500);
    expectNoSecrets(shownBody);
  });

  it("never stores carrier pay, carrier name, MC, or a rate confirmation", async () => {
    const docsBefore = Number((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM customer_documents`).get())?.n ?? 0);
    const response = await POST(
      post(
        {
          dryRun: false,
          loads: [
            {
              ...sample({ selectLoadNumber: "470200-1", salesOrderNumber: "SO-IMPORT-CLEAN", customerRate: 1500 }),
              carrierPay: 8765.43,
              carrierCost: 8765.43,
              carrierRate: 8765.43,
              carrierName: "BLACKHAWK HAULING LLC",
              carrier_name: "BLACKHAWK HAULING LLC",
              mcNumber: "998877",
              mc_number: "998877",
              rateConfirmation: { sentAt: "RATECON-SENTINEL" },
              rate_con: "RATECON-SENTINEL",
              carrier: { name: "BLACKHAWK HAULING LLC", mcNumber: "998877" },
              carrierPayItems: [{ amount: 8765.43, type: "Flat Rate" }],
              documents: [{ id: "doc-1", name: "rate-con.pdf", tag: "Rate Confirmation" }],
              comments: "Pay the carrier 8765.43 BLACKHAWK HAULING LLC MC 998877",
              stops: [pickup, { ...drop, carrierPay: 8765.43, carrierName: "BLACKHAWK HAULING LLC", mcNumber: "998877" }],
            },
          ],
        },
        { ip: "203.0.113.41" },
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results[0].action).toBe("created");
    expectNoSecrets(body);
    const stored = await ctx.db.prepare(`SELECT * FROM loads WHERE load_number = ?`).get("470200-1");
    expectNoSecrets(stored);
    expect(stored?.customer_cost_cents).toBe(150000);
    expect(stored?.comments).toBe("");
    expect(JSON.stringify(stored)).not.toMatch(/carrierPay|carrierName|mcNumber|rateConfirmation|rate_con|998877|BLACKHAWK|RATECON|8765/);
    const tables = await ctx.db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`).all();
    for (const table of tables) {
      expect(String(table.sql ?? "").toLowerCase()).not.toMatch(/carrier_pay|carrier_name|carrier_mc|carrier_cost|carrier_rate/);
    }
    expect(Number((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM customer_documents`).get())?.n ?? 0)).toBe(docsBefore);
  });

  it("links a portal load by sales order and does not overwrite it", async () => {
    const cookie = await sessionCookie(customerSession());
    const created = await createOrder(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({
          salesOrderNumber: "555001",
          stops: [
            { kind: "pickup", place: { company: "EMIT Portal Yard", address1: "900 Portal Lane", city: "Sheridan", state: "WY", postalCode: "82801", country: "US" } },
            { kind: "drop", place: { company: "Kodiak Portal", address1: "901 Portal Road", city: "Casper", state: "WY", postalCode: "82601", country: "US" } },
          ],
          comments: "Entered in the portal",
        }),
      }),
    );
    expect(created.status).toBe(201);
    const portalOrder = (await created.json()).order;
    const before = await ctx.db.prepare(`SELECT stops_json, customer_cost_cents, portal_status, tracking_stage, entered_by_name, source, load_number FROM loads WHERE id = ?`).get(portalOrder.id);

    const preview = await POST(
      post(
        {
          dryRun: true,
          loads: [sample({ selectLoadNumber: "470600-1", salesOrderNumber: "SO-555001", customerRate: 9999, status: "Completed" })],
        },
        { ip: "203.0.113.50" },
      ),
    );
    expect((await preview.json()).results[0]).toMatchObject({ action: "would link", orderId: portalOrder.id, salesOrderNumber: "555001" });
    expect((await ctx.db.prepare(`SELECT load_number FROM loads WHERE id = ?`).get(portalOrder.id))?.load_number).toBeNull();

    const linked = await POST(
      post(
        {
          dryRun: false,
          loads: [
            sample({
              selectLoadNumber: "470600-1",
              salesOrderNumber: "SO-555001",
              customerRate: 9999,
              status: "Completed",
              trackingShareUrl: "https://customer.goselect.com/tracking/linked",
              stops: [
                pickup,
                { ...drop, locationName: "SHOULD NOT STICK", address1: "1 Nowhere", city: "Billings", state: "MT", postalCode: "59101" },
              ],
            }),
          ],
        },
        { ip: "203.0.113.51" },
      ),
    );
    expect((await linked.json()).results[0]).toMatchObject({ action: "linked", orderId: portalOrder.id, unchanged: false });
    const after = await ctx.db
      .prepare(
        `SELECT stops_json, customer_cost_cents, portal_status, tracking_stage, entered_by_name, source, load_number, load_number_source, tracking_link, tracking_link_source, comments
         FROM loads WHERE id = ?`,
      )
      .get(portalOrder.id);
    expect(after?.stops_json).toBe(before?.stops_json);
    expect(after?.customer_cost_cents).toBe(before?.customer_cost_cents);
    expect(after?.portal_status).toBe(before?.portal_status);
    expect(after?.tracking_stage).toBe(before?.tracking_stage);
    expect(after?.entered_by_name).toBe(before?.entered_by_name);
    expect(after?.comments).toBe("Entered in the portal");
    expect(after?.source ?? null).toBeNull();
    expect(after?.load_number).toBe("470600-1");
    expect(after?.load_number_source).toBe("sam-import");
    expect(after?.tracking_link).toBe("https://customer.goselect.com/tracking/linked");
    expect(after?.tracking_link_source).toBe("sam-import");
    expect(await countLoads("470600-1")).toBe(1);
    expect(formatEnteredBy(String(after?.entered_by_name), "m.gray@emit.example")).toBe("M. Gray (m.gray@emit.example)");

    await ctx.db.prepare(`UPDATE loads SET tracking_link = ?, tracking_link_source = 'admin' WHERE id = ?`).run("https://customer.goselect.com/tracking/keep", portalOrder.id);
    const again = await POST(
      post(
        {
          dryRun: false,
          loads: [sample({ selectLoadNumber: "470600-1", salesOrderNumber: "555001", trackingShareUrl: "https://customer.goselect.com/tracking/replace" })],
        },
        { ip: "203.0.113.52" },
      ),
    );
    expect((await again.json()).results[0]).toMatchObject({ action: "linked", unchanged: true });
    const keptLink = await ctx.db.prepare(`SELECT tracking_link, tracking_link_source FROM loads WHERE id = ?`).get(portalOrder.id);
    expect(keptLink).toMatchObject({ tracking_link: "https://customer.goselect.com/tracking/keep", tracking_link_source: "admin" });
    expect(await countLoads("470600-1")).toBe(1);

    const other = await createOrder(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({
          salesOrderNumber: "1276",
          stops: [
            { kind: "pickup", place: { company: "EMIT Other", address1: "902 Other Lane", city: "Sheridan", state: "WY", postalCode: "82801", country: "US" } },
            { kind: "drop", place: { company: "Other Receiver", address1: "903 Other Road", city: "Casper", state: "WY", postalCode: "82601", country: "US" } },
          ],
        }),
      }),
    );
    expect(other.status).toBe(201);
    const compound = await POST(
      post(
        { dryRun: false, loads: [sample({ selectLoadNumber: "470610-1", salesOrderNumber: "so-1276_1277_2496_2497" })] },
        { ip: "203.0.113.53" },
      ),
    );
    expect((await compound.json()).results[0].action).toBe("created");
    expect((await ctx.db.prepare(`SELECT load_number FROM loads WHERE sales_order_number = ?`).get("1276"))?.load_number ?? null).toBeNull();

    const conflict = await POST(
      post(
        { dryRun: false, loads: [sample({ selectLoadNumber: "470600-1", salesOrderNumber: "SO-DIFFERENT" })] },
        { ip: "203.0.113.54" },
      ),
    );
    expect((await conflict.json()).results[0]).toMatchObject({
      action: "error",
      error: "That Select load number is already on a portal load with a different sales order.",
    });
    expect((await ctx.db.prepare(`SELECT stops_json FROM loads WHERE id = ?`).get(portalOrder.id))?.stops_json).toBe(before?.stops_json);
  });

  it("does not flag a delivered import as Missing tracking or Past due", async () => {
    const response = await POST(
      post(
        {
          dryRun: false,
          loads: [
            sample({
              selectLoadNumber: "470300-1",
              salesOrderNumber: "SO-OLD-DONE",
              status: "Completed",
              trackingShareUrl: "",
              stops: [pickup, { ...drop, date: "2026-03-04" }],
            }),
            sample({
              selectLoadNumber: "470301-1",
              salesOrderNumber: "SO-STILL-MOVING",
              status: "In Transit",
              trackingShareUrl: "",
              stops: [
                { ...pickup, date: "2026-09-28" },
                { ...drop, date: "2026-10-01", arrivalTime: null, departureTime: null },
              ],
            }),
            sample({
              selectLoadNumber: "470302-1",
              salesOrderNumber: "SO-RECENT-DONE",
              status: "Delivered",
              trackingShareUrl: "",
              stops: [
                { ...pickup, date: "2026-10-11" },
                { ...drop, date: "2026-10-12", arrivalTime: null, departureTime: null },
              ],
            }),
          ],
        },
        { ip: "203.0.113.60" },
      ),
    );
    const body = await response.json();
    expect(body.results.every((item: { action: string }) => item.action === "created")).toBe(true);

    const old = await getOrder(ctx, body.results[0].orderId);
    expect(attentionReasons(old!, "2026-10-14")).not.toContain("Missing tracking");
    expect(attentionReasons(old!, "2026-10-14")).not.toContain("Past due");
    expect((await listOrders(ctx, { tab: "attention", q: "470300-1", pageSize: 10 })).orders).toHaveLength(0);
    expect((await listOrders(ctx, { tab: "history", q: "470300-1", pageSize: 10 })).orders.map((order) => order.loadNumber)).toContain("470300-1");

    const moving = await getOrder(ctx, body.results[1].orderId);
    expect(attentionReasons(moving!, "2026-10-14")).toEqual(expect.arrayContaining(["Missing tracking", "Past due"]));
    expect((await listOrders(ctx, { tab: "attention", q: "470301-1", pageSize: 10 })).orders.map((order) => order.loadNumber)).toContain("470301-1");

    const recent = await getOrder(ctx, body.results[2].orderId);
    expect(attentionReasons(recent!, "2026-10-14")).not.toContain("Missing tracking");
    expect(attentionReasons(recent!, "2026-10-14")).not.toContain("Past due");
    expect((await listOrders(ctx, { tab: "attention", q: "470302-1", pageSize: 10 })).orders).toHaveLength(0);
    expect((await listOrders(ctx, { tab: "delivered", q: "470302-1", pageSize: 10 })).orders.map((order) => order.loadNumber)).toContain("470302-1");
  });

  it("links an exact delivery dock and does not create a location", async () => {
    await ctx.db
      .prepare(
        `INSERT INTO locations (
           id, kind, company, address1, address2, city, state, postal_code, country,
           contact, phone, notes, receiver_id, active, created_by, created_at, last_used_at, use_count
         ) VALUES ('loc-price', 'drop', 'Intermountain Electronics', '1676 East Declaration Drive', '', 'Price', 'UT', '84501', 'US', '', '', '', NULL, 1, 'EMIT', '2026-10-01T00:00:00.000Z', NULL, 3)`,
      )
      .run();
    await ctx.db
      .prepare(
        `INSERT INTO locations (
           id, kind, company, address1, address2, city, state, postal_code, country,
           contact, phone, notes, receiver_id, active, created_by, created_at, last_used_at, use_count
         ) VALUES ('loc-kodiak', 'drop', 'Basin Welding Shop', '4410 Quarry Ridge Road', '', 'Gillette', 'WY', '82718', 'US', '', '', '', NULL, 1, 'EMIT', '2026-10-01T00:00:00.000Z', NULL, 2)`,
      )
      .run();
    const dropsBefore = Number((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM locations WHERE kind = 'drop'`).get())?.n ?? 0);
    const pickupsBefore = Number((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM locations WHERE kind = 'pickup_once'`).get())?.n ?? 0);

    const response = await POST(
      post(
        {
          dryRun: false,
          loads: [
            sample({
              selectLoadNumber: "470400-1",
              salesOrderNumber: "SO-LOC-EXACT",
              stops: [
                { ...pickup, address1: "900 Brand New Dock", city: "Sheridan", state: "WY", postalCode: "82801" },
                {
                  type: "Delivery",
                  locationName: "Intermountain Electronics Price",
                  address1: "1676 E Declaration Dr",
                  city: "Price",
                  state: "UT",
                  postalCode: "84501",
                  date: "2026-03-04",
                },
              ],
            }),
            sample({
              selectLoadNumber: "470401-1",
              salesOrderNumber: "SO-LOC-LIKELY",
              stops: [
                pickup,
                {
                  type: "Delivery",
                  company: "Basin Welding",
                  address1: "4410 Quarry Ridge Rd",
                  city: "Gillette",
                  state: "WY",
                  postalCode: "82716",
                  date: "2026-03-04",
                },
              ],
            }),
          ],
        },
        { ip: "203.0.113.70" },
      ),
    );
    const body = await response.json();
    expect(body.results[0].locationMatches).toEqual([{ sequence: 2, locationId: "loc-price", strength: "exact", linked: true }]);
    expect(body.results[1].locationMatches).toEqual([
      expect.objectContaining({ sequence: 2, locationId: "loc-kodiak", strength: "likely", linked: false }),
    ]);
    const exact = await ctx.db.prepare(`SELECT stops_json FROM loads WHERE load_number = ?`).get("470400-1");
    const exactStops = JSON.parse(String(exact?.stops_json)) as Array<{ kind: string; locationId?: string | null }>;
    expect(exactStops[0].locationId ?? null).toBeNull();
    expect(exactStops[1].locationId).toBe("loc-price");
    const likely = JSON.parse(String((await ctx.db.prepare(`SELECT stops_json FROM loads WHERE load_number = ?`).get("470401-1"))?.stops_json)) as Array<{
      locationId?: string | null;
    }>;
    expect(likely[1].locationId ?? null).toBeNull();
    expect(Number((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM locations WHERE kind = 'drop'`).get())?.n ?? 0)).toBe(dropsBefore);
    expect(Number((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM locations WHERE kind = 'pickup_once'`).get())?.n ?? 0)).toBe(pickupsBefore);
    expect((await ctx.db.prepare(`SELECT use_count FROM locations WHERE id = ?`).get("loc-price"))?.use_count).toBe(3);
  });

  it("shares the bot upload rate limit", async () => {
    const ip = "203.0.113.80";
    for (let index = 0; index < BOT_UPLOAD_LIMIT; index += 1) {
      const response = await POST(post({ dryRun: true, loads: [{}] }, { ip }));
      expect(response.status).toBe(200);
    }
    const blocked = await POST(post({ dryRun: true, loads: [sample()] }, { ip }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    const tracking = await postTracking(
      new Request("http://portal.test/api/integrations/tracking-link", {
        method: "POST",
        headers: {
          authorization: `Bearer ${KEY}`,
          "content-type": "application/json",
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ loadNumber: "470100-1", trackingLink: "https://customer.goselect.com/tracking/limited" }),
      }),
    );
    expect(tracking.status).toBe(429);
  });
});
