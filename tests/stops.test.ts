import { beforeAll, describe, expect, it } from "vitest";
import { GET as getOrderRoute, PATCH as patchOrder } from "@/app/api/orders/[id]/route";
import { GET as listOrdersRoute, POST as createOrderRoute } from "@/app/api/orders/route";
import { orderInputSchema } from "@/lib/validate";
import { listOrders } from "@/lib/orders";
import { mapSamDetailToCustomer, toSamCreatePayload, toSamStopReplacement } from "@/lib/sam";
import { stopSequenceWarning } from "@/lib/stops";
import type { PortalContext } from "@/lib/db";
import { customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;

beforeAll(async () => {
  ctx = await seededPortal();
});

const pickup = (company: string, city: string, state: string) => ({
  kind: "pickup" as const,
  place: { company, address1: "1 Main", city, state, postalCode: "00000", country: "US" },
});
const drop = (company: string, city: string, state: string) => ({
  kind: "drop" as const,
  place: { company, address1: "2 Main", city, state, postalCode: "00000", country: "US" },
});

describe("stop sequence", () => {
  it("warns when a drop precedes every pickup and rejects a route with no drop", () => {
    expect(stopSequenceWarning([{ kind: "drop" }, { kind: "pickup" }])).toMatch(/before every pickup/);
    expect(stopSequenceWarning([{ kind: "pickup" }, { kind: "drop" }, { kind: "pickup" }])).toBeNull();
    expect(stopSequenceWarning([{ kind: "pickup" }])).toBeNull();

    const missingDrop = orderInputSchema.safeParse({
      salesOrderNumber: "SO-STOPS",
      stops: [pickup("EMIT", "Sheridan", "WY"), pickup("EMIT", "Casper", "WY")],
    });
    expect(missingDrop.success).toBe(false);

    const legacy = orderInputSchema.safeParse({
      salesOrderNumber: "SO-LEGACY",
      origin: pickup("EMIT", "Sheridan", "WY").place,
      destination: drop("Kodiak", "Oklahoma City", "OK").place,
    });
    expect(legacy.success).toBe(true);
  });

  it("saves extra stops, then reorder and removal on the same load", async () => {
    const cookie = await sessionCookie(customerSession());
    const created = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({
          salesOrderNumber: "SO-MULTI-1",
          stops: [
            { id: "a", ...pickup("EMIT Technologies", "Sheridan", "WY") },
            { id: "b", ...drop("Enchanted Rock LLC", "Cypress", "TX") },
            { id: "c", ...drop("Kodiak Gas Services", "Oklahoma City", "OK") },
          ],
        }),
      }),
    );
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.order.stops.map((stop: { id: string }) => stop.id)).toEqual(["a", "b", "c"]);
    expect(body.order.origin.city).toBe("Sheridan");
    expect(body.order.destination.company).toBe("Kodiak Gas Services");
    expect(body.order.loadNumber).toBeNull();
    expect(body.confirmation).toBeUndefined();
    expect(body.order.stops.map((stop: { kind: string }) => stop.kind)).toEqual(["pickup", "drop", "drop"]);
    expectNoSecrets(body);

    const reordered = await patchOrder(
      new Request(`http://portal.test/api/orders/${body.order.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({
          stops: [
            { id: "b", ...drop("Enchanted Rock LLC", "Cypress", "TX") },
            { id: "a", ...pickup("EMIT Technologies", "Sheridan", "WY") },
            { id: "c", ...drop("Kodiak Gas Services", "Oklahoma City", "OK") },
          ],
        }),
      }),
      { params: Promise.resolve({ id: body.order.id }) },
    );
    expect(reordered.status).toBe(200);
    const reorderedBody = await reordered.json();
    expect(reorderedBody.order.stops.map((stop: { id: string }) => stop.id)).toEqual(["b", "a", "c"]);

    const removed = await patchOrder(
      new Request(`http://portal.test/api/orders/${body.order.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({
          stops: [
            { id: "a", ...pickup("EMIT Technologies", "Sheridan", "WY") },
            { id: "b", ...drop("Enchanted Rock LLC", "Cypress", "TX") },
          ],
        }),
      }),
      { params: Promise.resolve({ id: body.order.id }) },
    );
    expect(removed.status).toBe(200);
    const removedBody = await removed.json();
    expect(removedBody.order.stops).toHaveLength(2);
    expect(removedBody.order.destination.company).toBe("Enchanted Rock LLC");

    const detail = await getOrderRoute(new Request(`http://portal.test/api/orders/${body.order.id}`, { headers: { cookie } }), {
      params: Promise.resolve({ id: body.order.id }),
    });
    expect((await detail.json()).order.stops).toHaveLength(2);
  });

  it("shows a load to a receiver when only an intermediate drop is theirs", async () => {
    const cookie = await sessionCookie(customerSession());
    const created = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({
          salesOrderNumber: "SO-MID-DROP",
          stops: [
            { id: "p", ...pickup("EMIT Technologies", "Sheridan", "WY") },
            { id: "e", ...drop("Enchanted Rock LLC", "Cypress", "TX") },
            { id: "k", ...drop("Kodiak Gas Services", "Oklahoma City", "OK") },
          ],
        }),
      }),
    );
    const order = (await created.json()).order;
    expect(order.destination.company).toBe("Kodiak Gas Services");

    const token = (
      (await ctx.db.prepare(`SELECT access_token FROM receivers WHERE company = ?`).get("Enchanted Rock LLC")) as {
        access_token: string;
      }
    ).access_token;
    const { GET: receiverPortal } = await import("@/app/api/r/[token]/route");
    const list = await receiverPortal(new Request(`http://portal.test/api/r/${token}`), {
      params: Promise.resolve({ token }),
    });
    const listed = await list.json();
    const match = listed.loads.find((load: { salesOrderNumber: string }) => load.salesOrderNumber === "SO-MID-DROP");
    expect(match).toBeTruthy();
    expect(match.customerCost).toBeUndefined();
    expect(match.stops.map((stop: { kind: string }) => stop.kind)).toEqual(["pickup", "drop", "drop"]);
    expect((await listOrders(ctx, { q: "Casper", receiverCompany: "Enchanted Rock LLC" })).total).toBe(0);
  });

  it("sends the full stop sequence to SAM and drops carrier fields on the way back", () => {
    const input = orderInputSchema.parse({
      salesOrderNumber: "SO-SAM-STOPS",
      shipDate: "2026-10-20",
      shipTime: "14:30",
      mustDeliverDate: "2026-10-22",
      stops: [
        { id: "1", ...pickup("EMIT", "Sheridan", "WY") },
        { id: "2", ...drop("Yard", "Casper", "WY") },
        { id: "3", ...drop("Kodiak", "Oklahoma City", "OK") },
      ],
    });
    const payload = toSamCreatePayload(input, customerSession());
    const stops = payload.stops as Array<{ sequence: number; type: string; city: string }>;
    expect(stops.map((stop) => stop.type)).toEqual(["Pickup", "Delivery", "Delivery"]);
    expect(stops.map((stop) => stop.sequence)).toEqual([1, 2, 3]);
    expect(stops[0]).toMatchObject({ date: "2026-10-20", time: "14:30" });
    expect(stops[1]).toMatchObject({ time: null });
    expect(stops[2]).toMatchObject({ date: "2026-10-22", time: null });
    expect(JSON.stringify(payload)).not.toMatch(/carrier/i);
    const replacement = toSamStopReplacement("900999-1", input);
    expect(replacement.loadNumber).toBe("900999-1");
    expect((replacement.stops as unknown[]).length).toBe(3);

    const mapped = mapSamDetailToCustomer({
      orderId: 1,
      customerRate: 1500,
      referenceNumbers: [{ key: "SO", value: "SO-SAM-STOPS" }],
      loads: [
        {
          loadNumber: "900999-1",
          transitStatus: "Open",
          stops: [
            { type: "Pickup", locationName: "EMIT", city: "Sheridan", state: "WY", carrierRate: 400 },
            { type: "Delivery", locationName: "Yard", city: "Casper", state: "WY" },
            { type: "Delivery", locationName: "Kodiak", city: "Oklahoma City", state: "OK", carrierPay: 900 },
          ],
        },
      ],
    });
    expect(mapped.stops.map((stop) => stop.place.city)).toEqual(["Sheridan", "Casper", "Oklahoma City"]);
    expect(mapped.destination.city).toBe("Oklahoma City");
    expectNoSecrets(mapped);
    expect(JSON.stringify(mapped)).not.toMatch(/carrierRate|carrierPay/);
  });
});
