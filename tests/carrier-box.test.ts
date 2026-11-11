import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { PATCH as setCarrier } from "@/app/api/admin/orders/[id]/carrier/route";
import { POST as printBol } from "@/app/api/orders/[id]/bol/print/route";
import { POST as uploadDocument } from "@/app/api/orders/[id]/documents/route";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { GET as listOrdersRoute, POST as createOrderRoute } from "@/app/api/orders/route";
import CarrierBox from "@/components/carrier-box";
import { carrierBoxState, previousCarrierLine, type CarrierBoxOrder } from "@/lib/carrier-box";
import type { PortalContext } from "@/lib/db";
import type { BolPrintSummary, CustomerOrder, OrderNotice } from "@/lib/types";
import { adminSession, customerSession, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;

beforeAll(async () => {
  ctx = await seededPortal();
});

function notice(kind: "assigned" | "changed", company: string, mc: string, text: string): OrderNotice {
  return { at: "2026-11-01T12:00:00.000Z", kind, text, company, mc };
}

function print(over: Partial<BolPrintSummary> = {}): BolPrintSummary {
  return {
    version: 1,
    printedAt: "2026-11-01T12:00:00.000Z",
    printedByName: "Mike Gray",
    carrierName: "EPG TRUCKING INC",
    carrierMc: "1077278",
    driverName: null,
    documentId: "doc-1",
    reprint: false,
    reasons: [],
    bolRemoved: false,
    ...over,
  };
}

function assigned(over: Partial<CarrierBoxOrder> = {}): CarrierBoxOrder {
  return {
    carrierName: "EPG TRUCKING INC",
    carrierMc: "1077278",
    notices: [notice("assigned", "EPG TRUCKING INC", "1077278", "Carrier assigned: EPG TRUCKING INC. MC 1077278.")],
    ...over,
  };
}

function markup(order: CarrierBoxOrder & { driverName?: string | null; customerCost?: number }): string {
  return renderToStaticMarkup(createElement(CarrierBox, { order }));
}

describe("carrier box state", () => {
  it("is neutral when no carrier is assigned", () => {
    expect(carrierBoxState({})).toMatchObject({ tone: "none", name: "", previousName: null });
    expect(carrierBoxState({ carrierName: "   ", carrierMc: "" })).toMatchObject({ tone: "none" });
    const cleared = carrierBoxState({
      carrierName: null,
      carrierMc: null,
      notices: [
        notice("assigned", "EPG TRUCKING INC", "1077278", "Carrier assigned: EPG TRUCKING INC. MC 1077278."),
        notice("changed", "RED MESA LLC", "778899", "Carrier changed from EPG TRUCKING INC (MC 1077278) to RED MESA LLC. MC 778899."),
      ],
    });
    expect(cleared.tone).toBe("none");
    expect(previousCarrierLine(cleared)).toBeNull();
  });

  it("is green when a carrier is assigned and nothing has replaced them", () => {
    const state = carrierBoxState(assigned());
    expect(state).toMatchObject({ tone: "assigned", name: "EPG TRUCKING INC", mc: "1077278", previousName: null });
    expect(carrierBoxState({ carrierName: "EPG TRUCKING INC", carrierMc: "1077278" }).tone).toBe("assigned");
    const fileOnly = carrierBoxState(
      assigned({
        bolPrint: print({ reprint: true, reasons: ["bol_updated"] }),
      }),
    );
    expect(fileOnly.tone).toBe("assigned");
    const acknowledged = carrierBoxState(
      assigned({
        notices: [
          notice("assigned", "NORTHLINE FREIGHT", "445566", "Carrier assigned: NORTHLINE FREIGHT. MC 445566."),
          notice("changed", "EPG TRUCKING INC", "1077278", "Carrier changed from NORTHLINE FREIGHT (MC 445566) to EPG TRUCKING INC. MC 1077278."),
        ],
        bolPrint: print({ reasons: ["bol_updated"], reprint: true }),
      }),
    );
    expect(acknowledged.tone).toBe("assigned");
    expect(acknowledged.previousName).toBeNull();
  });

  it("stays green when only the driver on the last print differs", () => {
    const state = carrierBoxState(
      assigned({
        bolPrint: print({
          driverName: "Pat",
          reprint: true,
          reasons: ["carrier_changed"],
        }),
      }),
    );
    expect(state.tone).toBe("assigned");
  });

  it("is red after a history change until a BOL with the new carrier is printed", () => {
    const state = carrierBoxState(
      assigned({
        carrierName: "RED MESA LLC",
        carrierMc: "778899",
        notices: [
          notice("assigned", "EPG TRUCKING INC", "1077278", "Carrier assigned: EPG TRUCKING INC. MC 1077278."),
          notice(
            "changed",
            "RED MESA LLC",
            "778899",
            "Carrier changed from EPG TRUCKING INC (MC 1077278) to RED MESA LLC. MC 778899.",
          ),
        ],
      }),
    );
    expect(state).toMatchObject({
      tone: "changed",
      name: "RED MESA LLC",
      mc: "778899",
      previousName: "EPG TRUCKING INC",
      previousMc: "1077278",
    });
    expect(previousCarrierLine(state)).toBe("Was EPG TRUCKING INC · MC 1077278");
  });

  it("is red when the last printed carrier differs, and names that carrier", () => {
    const state = carrierBoxState(
      assigned({
        carrierName: "RED MESA LLC",
        carrierMc: "778899",
        bolPrint: print({
          carrierName: "EPG TRUCKING INC",
          carrierMc: "1077278",
          reprint: true,
          reasons: ["carrier_changed"],
        }),
        notices: [
          notice("assigned", "EPG TRUCKING INC", "1077278", "Carrier assigned: EPG TRUCKING INC. MC 1077278."),
          notice("changed", "RED MESA LLC", "778899", "Carrier changed from EPG TRUCKING INC (MC 1077278) to RED MESA LLC. MC 778899."),
        ],
      }),
    );
    expect(state.tone).toBe("changed");
    expect(previousCarrierLine(state)).toBe("Was EPG TRUCKING INC · MC 1077278");
  });

  it("is red when a print with no carrier is flagged as a carrier change", () => {
    const state = carrierBoxState(
      assigned({
        bolPrint: print({
          carrierName: null,
          carrierMc: null,
          reprint: true,
          reasons: ["carrier_changed"],
        }),
        notices: [notice("assigned", "EPG TRUCKING INC", "1077278", "Carrier assigned: EPG TRUCKING INC. MC 1077278.")],
      }),
    );
    expect(state.tone).toBe("changed");
    expect(state.previousName).toBeNull();
  });

  it("reads a previous name from the history sentence when the prior line has no company", () => {
    const state = carrierBoxState({
      carrierName: "RED MESA LLC",
      carrierMc: "778899",
      notices: [
        {
          at: "2026-11-02T12:00:00.000Z",
          kind: "changed",
          text: "Carrier changed from NORTHLINE FREIGHT (MC 445566) to RED MESA LLC. MC 778899.",
        },
      ],
    });
    expect(state.tone).toBe("changed");
    expect(previousCarrierLine(state)).toBe("Was NORTHLINE FREIGHT · MC 445566");
  });

  it("treats letter case and an MC prefix as the same carrier", () => {
    const state = carrierBoxState(
      assigned({
        carrierName: "epg trucking inc",
        carrierMc: "MC 1077278",
        bolPrint: print({ carrierName: "EPG TRUCKING INC", carrierMc: "1077278" }),
      }),
    );
    expect(state.tone).toBe("assigned");
  });

  it("treats an MC-only change as a carrier change", () => {
    const state = carrierBoxState(
      assigned({
        carrierMc: "999",
        notices: [
          notice("assigned", "EPG TRUCKING INC", "1077278", "Carrier assigned: EPG TRUCKING INC. MC 1077278."),
          notice("changed", "EPG TRUCKING INC", "999", "Carrier changed from EPG TRUCKING INC (MC 1077278) to EPG TRUCKING INC. MC 999."),
        ],
      }),
    );
    expect(state.tone).toBe("changed");
    expect(previousCarrierLine(state)).toBe("Was EPG TRUCKING INC · MC 1077278");
  });
});

describe("carrier box markup", () => {
  it("renders the green, red, and no-carrier states without pay", () => {
    const green = markup({ ...assigned(), driverName: "Pat Driver" });
    expect(green).toContain('data-tone="assigned"');
    expect(green).toContain("EPG TRUCKING INC");
    expect(green).toContain("MC 1077278");
    expect(green).toContain("Driver: Pat Driver");
    expect(green).not.toContain("Carrier changed");
    expect(green).not.toContain("No carrier yet");

    const red = markup(
      assigned({
        carrierName: "RED MESA LLC",
        carrierMc: "778899",
        notices: [
          notice("assigned", "EPG TRUCKING INC", "1077278", "Carrier assigned: EPG TRUCKING INC. MC 1077278."),
          notice("changed", "RED MESA LLC", "778899", "Carrier changed from EPG TRUCKING INC (MC 1077278) to RED MESA LLC. MC 778899."),
        ],
      }),
    );
    expect(red).toContain('data-tone="changed"');
    expect(red).toContain("Carrier changed");
    expect(red).toContain("RED MESA LLC");
    expect(red).toContain("MC 778899");
    expect(red).toContain("Was EPG TRUCKING INC · MC 1077278");

    const empty = markup({ carrierName: null, carrierMc: null, customerCost: 2400 });
    expect(empty).toContain('data-tone="none"');
    expect(empty).toContain("No carrier yet");
    expect(empty).toContain("Driver: —");
    expect(empty).not.toContain("2400");

    const box = (html: string) => html.slice(html.indexOf('class="carrier-box"'), html.indexOf("</div>"));
    expect(box(green)).not.toContain("Driver:");
    expect(box(red)).not.toContain("Driver:");
    expect(green + red + empty).not.toMatch(/pay|rate|\$|\bSAM\b/i);
  });

  it("stays on the signed-in load list and load page, and off receiver and public tracking pages", () => {
    expect(readFileSync("components/dashboard.tsx", "utf8")).toContain("<CarrierBox");
    expect(readFileSync("app/orders/[id]/page.tsx", "utf8")).toContain("<CarrierCallout");
    expect(readFileSync("app/r/[token]/page.tsx", "utf8")).not.toContain("CarrierBox");
    expect(readFileSync("app/r/[token]/page.tsx", "utf8")).not.toContain("carrier-box");
    expect(readFileSync("app/track/[token]/page.tsx", "utf8")).not.toContain("CarrierBox");
    expect(readFileSync("app/track/[token]/page.tsx", "utf8")).not.toContain("carrier-box");
  });
});

const headers = (cookie: string, json = false): HeadersInit => ({
  cookie,
  host: "portal.test",
  origin: "http://portal.test",
  ...(json ? { "content-type": "application/json" } : {}),
});

describe("carrier box follows a real assignment and print", () => {
  it("goes green, red, then green again once the new carrier is printed", async () => {
    expect(ctx.db).toBeTruthy();
    const customer = await sessionCookie(customerSession());
    const admin = await sessionCookie(adminSession());
    const created = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(customer, true),
        body: JSON.stringify({
          salesOrderNumber: "SO-CARRIER-BOX",
          stops: [
            { kind: "pickup", place: { company: "EMIT", address1: "1 Main", city: "Sheridan", state: "WY", postalCode: "82801", country: "US" } },
            { kind: "drop", place: { company: "Acme Dock", address1: "2 Main", city: "Cypress", state: "TX", postalCode: "77429", country: "US" } },
          ],
        }),
      }),
    );
    expect(created.status).toBe(201);
    const order = (await created.json()).order as CustomerOrder;
    expect(carrierBoxState(order).tone).toBe("none");

    const first = await setCarrier(
      new Request(`http://portal.test/api/admin/orders/${order.id}/carrier`, {
        method: "PATCH",
        headers: headers(admin, true),
        body: JSON.stringify({ carrierName: "EPG TRUCKING INC", carrierMc: "1077278", driverName: "" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(first.status).toBe(200);
    const assignedOrder = (await first.json()).order as CustomerOrder;
    expect(carrierBoxState(assignedOrder).tone).toBe("assigned");

    const second = await setCarrier(
      new Request(`http://portal.test/api/admin/orders/${order.id}/carrier`, {
        method: "PATCH",
        headers: headers(admin, true),
        body: JSON.stringify({ carrierName: "RED MESA LLC", carrierMc: "778899" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(second.status).toBe(200);
    const changedOrder = (await second.json()).order as CustomerOrder;
    expect(carrierBoxState(changedOrder)).toMatchObject({
      tone: "changed",
      name: "RED MESA LLC",
      previousName: "EPG TRUCKING INC",
      previousMc: "1077278",
    });
    expect(JSON.stringify(changedOrder)).not.toMatch(/carrierPay|carrier_pay|\$/);

    const listed = await listOrdersRoute(
      new Request("http://portal.test/api/orders?q=SO-CARRIER-BOX", { headers: headers(customer) }),
    );
    expect(listed.status).toBe(200);
    const row = ((await listed.json()).orders as CustomerOrder[]).find((item) => item.id === order.id);
    expect(row).toBeTruthy();
    expect(carrierBoxState(row!)).toMatchObject({ tone: "changed", previousName: "EPG TRUCKING INC" });

    const form = new FormData();
    form.set("file", new File([new TextEncoder().encode("Freight list\nPieces: 4\n")], "bol.txt", { type: "text/plain" }));
    form.set("slot", "bol");
    const uploaded = await uploadDocument(
      new Request(`http://portal.test/api/orders/${order.id}/documents`, { method: "POST", headers: headers(admin), body: form }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(uploaded.status).toBe(200);
    const documentId = (await uploaded.json()).order.documents.find((doc: { kind: string }) => doc.kind === "bol").id as string;
    const printed = await printBol(
      new Request(`http://portal.test/api/orders/${order.id}/bol/print`, {
        method: "POST",
        headers: headers(admin, true),
        body: JSON.stringify({ documentId }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(printed.status).toBe(200);

    const detail = await getOrderRoute(new Request(`http://portal.test/api/orders/${order.id}`, { headers: headers(admin) }), {
      params: Promise.resolve({ id: order.id }),
    });
    const afterPrint = (await detail.json()).order as CustomerOrder;
    expect(afterPrint.bolPrint?.reasons ?? []).not.toContain("carrier_changed");
    expect(carrierBoxState(afterPrint).tone).toBe("assigned");

    const form2 = new FormData();
    form2.set("file", new File([new TextEncoder().encode("Freight list revised\nPieces: 5\n")], "bol-2.txt", { type: "text/plain" }));
    form2.set("slot", "bol");
    const uploadedAgain = await uploadDocument(
      new Request(`http://portal.test/api/orders/${order.id}/documents`, { method: "POST", headers: headers(admin), body: form2 }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(uploadedAgain.status).toBe(200);
    const afterFile = await getOrderRoute(new Request(`http://portal.test/api/orders/${order.id}`, { headers: headers(customer) }), {
      params: Promise.resolve({ id: order.id }),
    });
    const fileChanged = (await afterFile.json()).order as CustomerOrder;
    expect(fileChanged.bolPrint?.reasons).toContain("bol_updated");
    expect(fileChanged.bolPrint?.reasons).not.toContain("carrier_changed");
    expect(carrierBoxState(fileChanged).tone).toBe("assigned");

    const cleared = await setCarrier(
      new Request(`http://portal.test/api/admin/orders/${order.id}/carrier`, {
        method: "PATCH",
        headers: headers(admin, true),
        body: JSON.stringify({ carrierName: "", carrierMc: "", driverName: "" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(cleared.status).toBe(200);
    expect(carrierBoxState((await cleared.json()).order).tone).toBe("none");
  });
});
