import { beforeAll, describe, expect, it } from "vitest";
import { GET as copyDraftRoute } from "@/app/api/orders/[id]/copy-draft/route";
import { GET as nextSoRoute } from "@/app/api/orders/next-so/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { openDatabase, useTestPortal, type PortalContext } from "@/lib/db";
import { findUserById, sessionFromUser } from "@/lib/passwords";
import { createReceiver, receiverPortal } from "@/lib/receivers";
import { salesOrderLineErrors } from "@/lib/sales-orders";
import { nextSuffix, splitSuffix } from "@/lib/so-suffix";
import { createEmitUser } from "@/lib/users";
import { customerSession, sessionCookie } from "./helpers";

let ctx: PortalContext;

beforeAll(async () => {
  ctx = await useMemory();
});

async function useMemory(): Promise<PortalContext> {
  const portal: PortalContext = { db: await openDatabase(":memory:"), now: () => new Date("2026-10-30T18:00:00Z") };
  useTestPortal(portal);
  return portal;
}

const place = (company: string, city: string, state: string) => ({
  company,
  address1: "1 Main",
  city,
  state,
  postalCode: "82801",
  country: "US",
});

const stops = [
  { id: "p", kind: "pickup" as const, place: place("EMIT", "Sheridan", "WY") },
  { id: "d1", kind: "drop" as const, place: place("Yard A", "Casper", "WY") },
  { id: "d2", kind: "drop" as const, place: place("Yard B", "Billings", "MT") },
];

function headers(cookie: string): HeadersInit {
  return { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" };
}

async function post(body: unknown, session = customerSession()) {
  const cookie = await sessionCookie(session);
  return createOrderRoute(
    new Request("http://portal.test/api/orders", {
      method: "POST",
      headers: headers(cookie),
      body: JSON.stringify(body),
    }),
  );
}

describe("T-suffix suggestions", () => {
  it("parses only a trailing _T suffix and treats a bare SO as T1", () => {
    expect(splitSuffix("so-002003")).toEqual({ base: "SO-002003", n: null });
    expect(splitSuffix("SO-002003_T2")).toEqual({ base: "SO-002003", n: 2 });
    expect(splitSuffix("so-002003_t02")).toEqual({ base: "SO-002003", n: 2 });
    expect(splitSuffix("SO_TX_5")).toEqual({ base: "SO_TX_5", n: null });
    expect(splitSuffix("SO_T")).toEqual({ base: "SO_T", n: null });
    expect(nextSuffix("SO-002003", []).suggestion).toBe("SO-002003_T2");
    expect(nextSuffix("SO-002003", ["SO-002003"]).suggestion).toBe("SO-002003_T2");
    expect(nextSuffix("so-002003_t2", ["SO-002003_T2"]).suggestion).toBe("SO-002003_T3");
    expect(nextSuffix("SO-002003", ["SO-002003_T2", "so-002003_t5"]).suggestion).toBe("SO-002003_T6");
    expect(nextSuffix("SO-002003", ["SO-002003_T2", "SO-002003_T5"]).highestInUse).toBe("_T5");
    const longBase = "A".repeat(38);
    expect(nextSuffix(longBase, []).tooLong).toBe(true);
    expect(nextSuffix(longBase, []).suggestion).toBeNull();
  });

  it("suggests the next suffix from stored loads, including cancelled ones, and hides it from view-only", async () => {
    const created = await post({ salesOrderNumber: "SO-002003", stops: stops.slice(0, 2), portalStatus: "cancelled" });
    expect(created.status).toBe(201);
    const cookie = await sessionCookie(customerSession());
    const suggested = await nextSoRoute(new Request("http://portal.test/api/orders/next-so?so=so-002003", { headers: { cookie } }));
    expect(suggested.status).toBe(200);
    expect(await suggested.json()).toMatchObject({ base: "SO-002003", suggestion: "SO-002003_T2" });
    const viewer = await createEmitUser(ctx, {
      name: "View Only",
      email: "view.only.so@emit.example",
      password: "temporary-pass",
      permission: "view",
    });
    const viewerRow = await findUserById(ctx, viewer.user.id);
    if (!viewerRow) throw new Error("view user missing");
    const viewOnly = await nextSoRoute(
      new Request("http://portal.test/api/orders/next-so?so=SO-002003", {
        headers: { cookie: await sessionCookie(sessionFromUser(viewerRow)) },
      }),
    );
    expect(viewOnly.status).toBe(403);
  });

  it("copies a load with new stop ids, mapped SOs, and no documents, cost, or tracking link", async () => {
    const created = await post({
      salesOrders: [
        { number: "SO-COPY-A", stopId: "d1" },
        { number: "SO-COPY-B_T2", stopId: "d2" },
      ],
      stops,
      comments: "Leave the gate open",
      shipDate: "2026-11-02",
      customerCost: 1800,
      truckType: "Flatbed",
    });
    expect(created.status).toBe(201);
    const source = (await created.json()).order;
    const cookie = await sessionCookie(customerSession());
    const draftResponse = await copyDraftRoute(new Request(`http://portal.test/api/orders/${source.id}/copy-draft`, { headers: { cookie } }), {
      params: Promise.resolve({ id: source.id }),
    });
    expect(draftResponse.status).toBe(200);
    const { draft } = await draftResponse.json();
    expect(draft.copiedFromId).toBe(source.id);
    expect(draft.stops.map((stop: { id: string }) => stop.id)).not.toEqual(source.stops.map((stop: { id: string }) => stop.id));
    expect(draft.salesOrders.map((line: { number: string }) => line.number)).toEqual(["SO-COPY-A_T2", "SO-COPY-B_T3"]);
    expect(draft.salesOrders[0].stopId).toBe(draft.stops[1].id);
    expect(draft.salesOrders[1].stopId).toBe(draft.stops[2].id);
    expect(draft.comments).toBe("Leave the gate open");
    expect(draft.shipDate).toBe("2026-11-02");
    expect(draft.customerCost).toBeUndefined();
    expect(draft.loadNumber).toBeUndefined();
    expect(draft.trackingLink).toBeUndefined();
    expect(JSON.stringify(draft)).not.toMatch(/documents|bolPrint|carrierPay/);

    const saved = await post({
      salesOrders: draft.salesOrders.map((line: { number: string; stopId: string }) => ({ number: line.number, stopId: line.stopId })),
      stops: draft.stops,
      comments: draft.comments,
      shipDate: draft.shipDate,
      truckType: "Flatbed",
      copiedFromId: draft.copiedFromId,
      customerCost: 1800,
    });
    expect(saved.status).toBe(201);
    const copy = (await saved.json()).order;
    expect(copy.loadNumber).toBeNull();
    expect(copy.trackingLink).toBeNull();
    expect(copy.documents).toEqual([]);
    expect(copy.customerCost).toBeUndefined();
    const stored = await ctx.db.prepare(`SELECT copied_from_id, customer_cost_cents, tracking_link FROM loads WHERE id = ?`).get(copy.id);
    expect(stored).toMatchObject({ copied_from_id: source.id, customer_cost_cents: null, tracking_link: null });
  });

  it("saves a duplicate sales order, including one on a cancelled load, and warns without blocking", async () => {
    const first = await post({ salesOrderNumber: "SO-RACE-1", stops: stops.slice(0, 2) });
    expect(first.status).toBe(201);
    expect((await first.json()).warnings).toEqual([]);
    const second = await post({ salesOrderNumber: "SO-RACE-1", stops: stops.slice(0, 2) });
    expect(second.status).toBe(201);
    const saved = await second.json();
    expect(saved.order.salesOrderNumber).toBe("SO-RACE-1");
    expect(saved.warnings).toEqual([{ number: "SO-RACE-1", message: "SO-RACE-1 is already on another load." }]);
    const count = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM loads WHERE UPPER(sales_order_number) = 'SO-RACE-1'`).get();
    expect(Number(count?.n)).toBe(2);

    const again = await post({ salesOrderNumber: "SO-002003", stops: stops.slice(0, 2) });
    expect(again.status).toBe(201);
    const earlier = await again.json();
    expect(earlier.order.salesOrderNumber).toBe("SO-002003");
    expect(earlier.warnings[0]).toMatchObject({ number: "SO-002003" });
    expect(earlier.warnings[0].message).toMatch(/already on another load/);
  });

  it("shows a receiver only the sales orders for that receiver's drops", async () => {
    const created = await post({
      salesOrders: [
        { number: "SO-DROP-A", stopId: "d1" },
        { number: "SO-DROP-B", stopId: "d2" },
      ],
      stops,
    });
    expect(created.status).toBe(201);
    const receiver = await createReceiver(ctx, { company: "Yard A", contactEmails: ["a@yard.example"] });
    const body = await receiverPortal(ctx, receiver.token);
    const text = JSON.stringify(body);
    expect(text).toContain("SO-DROP-A");
    expect(text).not.toContain("SO-DROP-B");
    expect(text).not.toMatch(/bolPrint|carrierName|driverName|documents/);
  });

  it("leaves a deleted drop's SOs unassigned and blocks the save", () => {
    const three = [
      ...stops,
      { id: "d3", kind: "drop" as const, place: place("Yard C", "Idaho Falls", "ID") },
    ];
    const removed = three.filter((stop) => stop.id !== "d2");
    const errors = salesOrderLineErrors(
      [
        { number: "SO1", stopId: "d1" },
        { number: "SO2", stopId: "d2" },
      ],
      removed,
      { required: true },
    );
    expect(errors.join(" ")).toMatch(/choose which drop SO2/);
  });
});
