import { beforeAll, describe, expect, it } from "vitest";
import { GET as getOrderRoute, PATCH as patchOrder } from "@/app/api/orders/[id]/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { emptyDraft, payloadFromDraft, draftSalesOrderErrors, draftFromOrder } from "@/components/load-form";
import { loadBuilderPayload } from "@/lib/load-builder";
import { listOrders } from "@/lib/orders";
import { toSamCreatePayload } from "@/lib/sam";
import {
  parseLegacySalesOrders,
  salesOrderError,
  salesOrderLineErrors,
  storedSalesOrders,
} from "@/lib/sales-orders";
import { orderInputSchema, orderPatchSchema } from "@/lib/validate";
import type { PortalContext } from "@/lib/db";
import { customerSession, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;
beforeAll(async () => {
  ctx = await seededPortal();
});

const place = (company: string, city: string, state: string) => ({
  company,
  address1: "1 Main",
  city,
  state,
  postalCode: "00000",
  country: "US",
});
const twoDrops = [
  { id: "p", kind: "pickup" as const, place: place("EMIT", "Sheridan", "WY") },
  { id: "d1", kind: "drop" as const, place: place("Yard", "Casper", "WY") },
  { id: "d2", kind: "drop" as const, place: place("Kodiak", "Oklahoma City", "OK") },
];
const oneDrop = twoDrops.slice(0, 2);

async function post(body: unknown) {
  const cookie = await sessionCookie(customerSession());
  return createOrderRoute(
    new Request("http://portal.test/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" },
      body: JSON.stringify(body),
    }),
  );
}

describe("one SO per field", () => {
  it("rejects commas, spaces, and semicolons and accepts one SO", () => {
    expect(salesOrderError("SO123")).toBeNull();
    expect(salesOrderError("so-1276_1277")).toBeNull();
    expect(salesOrderError("SO1, SO2")).toMatch(/one sales order/i);
    expect(salesOrderError("SO1 SO2")).toMatch(/one sales order/i);
    expect(salesOrderError("SO1;SO2")).toMatch(/one sales order/i);
    expect(salesOrderError("")).toMatch(/enter/i);
  });

  it("requires a drop for each SO only when there is more than one drop", () => {
    expect(salesOrderLineErrors([{ number: "SO1", stopId: null }], oneDrop, { required: true })).toEqual([]);
    expect(salesOrderLineErrors([{ number: "SO1", stopId: null }], twoDrops, { required: true })[0]).toMatch(/choose which drop/);
    expect(salesOrderLineErrors([{ number: "SO1", stopId: "d2" }], twoDrops, { required: true })).toEqual([]);
    expect(salesOrderLineErrors([{ number: "SO1", stopId: "d1" }, { number: "so1", stopId: "d2" }], twoDrops)[0]).toMatch(/twice/);
    expect(salesOrderLineErrors([], twoDrops, { required: true })[0]).toMatch(/required/);
  });

  it("validates the API body the same way", () => {
    expect(orderInputSchema.safeParse({ salesOrders: [{ number: "SO1, SO2", stopId: "d1" }], stops: twoDrops }).success).toBe(false);
    expect(orderInputSchema.safeParse({ salesOrders: [{ number: "SO1", stopId: null }], stops: twoDrops }).success).toBe(false);
    const ok = orderInputSchema.parse({ salesOrders: [{ number: "so1", stopId: "d1" }, { number: "so2", stopId: "d2" }], stops: twoDrops });
    expect(ok.salesOrders?.map((line) => line.number)).toEqual(["SO1", "SO2"]);
    expect(orderInputSchema.safeParse({ stops: twoDrops }).success).toBe(false);
    expect(orderPatchSchema.safeParse({ comments: "x" }).success).toBe(true);
  });
});

describe("older single-string SOs", () => {
  it("splits comma or space separated values and upper-cases them", () => {
    expect(parseLegacySalesOrders("so1, SO2 so3;SO1")).toEqual(["SO1", "SO2", "SO3"]);
    expect(parseLegacySalesOrders("")).toEqual([]);
  });

  it("reads stored JSON first and falls back to the old column", () => {
    expect(storedSalesOrders(null, "SO1, SO2", oneDrop)).toEqual([
      { number: "SO1", stopId: "d1" },
      { number: "SO2", stopId: "d1" },
    ]);
    expect(storedSalesOrders(null, "SO1, SO2", twoDrops)).toEqual([
      { number: "SO1", stopId: null },
      { number: "SO2", stopId: null },
    ]);
    expect(storedSalesOrders(JSON.stringify([{ number: "SO9", stopId: "d2" }]), "ignored", twoDrops)).toEqual([{ number: "SO9", stopId: "d2" }]);
    expect(storedSalesOrders(JSON.stringify([{ number: "SO9", stopId: "gone" }]), "", twoDrops)).toEqual([{ number: "SO9", stopId: null }]);
    expect(storedSalesOrders("not json", "SO7", oneDrop)).toEqual([{ number: "SO7", stopId: "d1" }]);
  });

  it("still accepts the older salesOrderNumber field from API callers", async () => {
    const response = await post({ salesOrderNumber: "so-legacy-a, so-legacy-b", stops: oneDrop.map((s) => ({ ...s, id: `legacy-${s.id}` })) });
    expect(response.status).toBe(201);
    const { order } = await response.json();
    expect(order.salesOrderNumber).toBe("SO-LEGACY-A, SO-LEGACY-B");
    expect(order.salesOrders).toEqual([
      { number: "SO-LEGACY-A", stopId: "legacy-d1" },
      { number: "SO-LEGACY-B", stopId: "legacy-d1" },
    ]);
  });
});

describe("multiple SOs on a multi-drop load", () => {
  it("saves each SO with its drop, searches by one SO, and keeps them on edit", async () => {
    const stops = twoDrops.map((s) => ({ ...s, id: `m-${s.id}` }));
    const response = await post({
      salesOrders: [
        { number: "so-multi-a", stopId: "m-d1" },
        { number: "SO-MULTI-B", stopId: "m-d2" },
        { number: "SO-MULTI-C", stopId: "m-d2" },
      ],
      stops,
    });
    expect(response.status).toBe(201);
    const { order } = await response.json();
    expect(order.salesOrders).toEqual([
      { number: "SO-MULTI-A", stopId: "m-d1" },
      { number: "SO-MULTI-B", stopId: "m-d2" },
      { number: "SO-MULTI-C", stopId: "m-d2" },
    ]);
    expect(order.salesOrderNumber).toBe("SO-MULTI-A, SO-MULTI-B, SO-MULTI-C");
    expect((await listOrders(ctx, { q: "SO-MULTI-B" })).total).toBe(1);

    const builder = loadBuilderPayload(order);
    expect(builder.salesOrders).toEqual([
      { number: "SO-MULTI-A", stopSequence: 2 },
      { number: "SO-MULTI-B", stopSequence: 3 },
      { number: "SO-MULTI-C", stopSequence: 3 },
    ]);
    expect((builder.stops as Array<{ salesOrders: string[] }>).map((stop) => stop.salesOrders)).toEqual([
      [],
      ["SO-MULTI-A"],
      ["SO-MULTI-B", "SO-MULTI-C"],
    ]);
    expect(JSON.stringify(builder)).not.toMatch(/carrier/i);

    // Reordering the drops keeps each SO with its drop.
    const cookie = await sessionCookie(customerSession());
    const patched = await patchOrder(
      new Request(`http://portal.test/api/orders/${order.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({ stops: [stops[0], stops[2], stops[1]] }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(patched.status).toBe(200);
    const after = (await patched.json()).order;
    expect(after.stops.map((s: { id: string }) => s.id)).toEqual(["m-p", "m-d2", "m-d1"]);
    expect(after.salesOrders).toEqual(order.salesOrders);

    // A patch whose SO points at no drop is rejected.
    const bad = await patchOrder(
      new Request(`http://portal.test/api/orders/${order.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({ salesOrders: [{ number: "SO-X", stopId: "nope" }] }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(bad.status).toBe(400);
    const reread = await getOrderRoute(
      new Request(`http://portal.test/api/orders/${order.id}`, { headers: { cookie, host: "portal.test" } }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect((await reread.json()).order.salesOrders.length).toBe(3);
  });

  it("sends every SO to SAM in ALL CAPS, at load level and on its drop", () => {
    const input = orderInputSchema.parse({
      salesOrders: [
        { number: "so-a", stopId: "d1" },
        { number: "so-b", stopId: "d2" },
      ],
      stops: twoDrops,
    });
    const payload = toSamCreatePayload(input, customerSession());
    expect(payload.customerReference).toBe("SO-A, SO-B");
    expect(payload.referenceNumbers).toEqual([
      { key: "SO", value: "SO-A" },
      { key: "SO", value: "SO-B" },
    ]);
    const stops = payload.stops as Array<{ referenceNumbers: unknown[] }>;
    expect(stops.map((stop) => stop.referenceNumbers)).toEqual([[], [{ key: "SO", value: "SO-A" }], [{ key: "SO", value: "SO-B" }]]);
  });
});

describe("form draft", () => {
  it("starts with one empty SO row and auto-assigns the only drop", () => {
    const draft = emptyDraft();
    expect(draft.salesOrders).toEqual([{ number: "", stopId: null }]);
    expect(draftSalesOrderErrors(draft)[0]).toMatch(/required/);
    const filled = { ...draft, salesOrders: [{ number: "so5", stopId: null }, { number: "", stopId: null }] };
    expect(draftSalesOrderErrors(filled)).toEqual([]);
    const drop = draft.stops.find((stop) => stop.kind === "drop")!;
    expect(payloadFromDraft(filled).salesOrders).toEqual([{ number: "SO5", stopId: drop.id }]);
  });

  it("turns an older order into rows", () => {
    const order = { salesOrderNumber: "SO1, SO2", salesOrders: [], stops: [] } as unknown as Parameters<typeof draftFromOrder>[0];
    expect(draftFromOrder({ ...order, origin: place("A", "B", "WY"), destination: place("C", "D", "TX") }).salesOrders).toEqual([
      { number: "SO1", stopId: null },
      { number: "SO2", stopId: null },
    ]);
  });
});
