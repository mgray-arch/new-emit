import { beforeAll, describe, expect, it } from "vitest";
import { PATCH as setCarrier } from "@/app/api/admin/orders/[id]/carrier/route";
import { POST as printBol } from "@/app/api/orders/[id]/bol/print/route";
import { POST as uploadDocument } from "@/app/api/orders/[id]/documents/route";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { GET as receiverPortalRoute } from "@/app/api/r/[token]/route";
import { GET as track } from "@/app/api/track/[token]/route";
import { recordBolPrint } from "@/lib/bol-prints";
import { useTestPortal, type PortalContext } from "@/lib/db";
import { createReceiver } from "@/lib/receivers";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;

beforeAll(async () => {
  ctx = await seededPortal();
});

const headers = (cookie: string, json = false): HeadersInit => ({
  cookie,
  host: "portal.test",
  origin: "http://portal.test",
  ...(json ? { "content-type": "application/json" } : {}),
});

async function makeLoad(so: string) {
  const cookie = await sessionCookie(customerSession());
  const response = await createOrderRoute(
    new Request("http://portal.test/api/orders", {
      method: "POST",
      headers: headers(cookie, true),
      body: JSON.stringify({
        salesOrderNumber: so,
        stops: [
          { kind: "pickup", place: { company: "EMIT", address1: "1 Main", city: "Sheridan", state: "WY", postalCode: "82801", country: "US" } },
          { kind: "drop", place: { company: "Acme Dock", address1: "2 Main", city: "Boise", state: "ID", postalCode: "83702", country: "US" } },
        ],
      }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()).order as { id: string; trackingUrl: string };
}

async function uploadBol(orderId: string, name: string) {
  const cookie = await sessionCookie(adminSession());
  const form = new FormData();
  form.set("file", new File([new TextEncoder().encode(`Freight list ${name}\nPieces: 4\n`)], name, { type: "text/plain" }));
  form.set("slot", "bol");
  const response = await uploadDocument(new Request(`http://portal.test/api/orders/${orderId}/documents`, { method: "POST", headers: headers(cookie), body: form }), {
    params: Promise.resolve({ id: orderId }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  const bols = body.order.documents.filter((doc: { kind: string }) => doc.kind === "bol");
  const bol = bols[bols.length - 1];
  expect(bol?.id).toBeTruthy();
  return bol.id as string;
}

describe("BOL print history", () => {
  it("records version 1 with no banner, then a carrier change, then a new BOL", async () => {
    const order = await makeLoad("SO-BOL-PRINT");
    const documentId = await uploadBol(order.id, "bol-v1.txt");
    const admin = await sessionCookie(adminSession());
    const printed = await printBol(
      new Request(`http://portal.test/api/orders/${order.id}/bol/print`, {
        method: "POST",
        headers: headers(admin, true),
        body: JSON.stringify({ documentId }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(printed.status).toBe(200);
    const first = await printed.json();
    expect(first.version).toBe(1);
    expect(first.reprint).toBe(false);
    expect(first.reasons).toEqual([]);

    const detail = await getOrderRoute(new Request(`http://portal.test/api/orders/${order.id}`, { headers: headers(admin) }), {
      params: Promise.resolve({ id: order.id }),
    });
    const shown = (await detail.json()).order;
    expect(shown.bolPrint).toMatchObject({ version: 1, reprint: false, printedByName: "Mike Gray" });

    const carrier = await setCarrier(
      new Request(`http://portal.test/api/admin/orders/${order.id}/carrier`, {
        method: "PATCH",
        headers: headers(admin, true),
        body: JSON.stringify({ carrierName: "ACME Trucking", carrierMc: "MC 123456", driverName: "J. Smith" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(carrier.status).toBe(200);
    const changed = (await carrier.json()).order;
    expect(changed.carrierMc).toBe("123456");
    expect(changed.bolPrint.reprint).toBe(true);
    expect(changed.bolPrint.reasons).toContain("carrier_changed");

    const again = await printBol(
      new Request(`http://portal.test/api/orders/${order.id}/bol/print`, {
        method: "POST",
        headers: headers(admin, true),
        body: JSON.stringify({ documentId }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect((await again.json()).version).toBe(2);
    const cleared = await getOrderRoute(new Request(`http://portal.test/api/orders/${order.id}`, { headers: headers(admin) }), {
      params: Promise.resolve({ id: order.id }),
    });
    expect((await cleared.json()).order.bolPrint.reprint).toBe(false);

    const nextBol = await uploadBol(order.id, "bol-v2.txt");
    const updated = await getOrderRoute(new Request(`http://portal.test/api/orders/${order.id}`, { headers: headers(admin) }), {
      params: Promise.resolve({ id: order.id }),
    });
    const afterUpload = (await updated.json()).order;
    expect(afterUpload.bolPrint.reprint).toBe(true);
    expect(afterUpload.bolPrint.reasons).toContain("bol_updated");
    expect(nextBol).not.toBe(documentId);

    const viewAs = `${await sessionCookie(adminSession())}; portal_view_as=${encodeURIComponent("regular:add")}`;
    const blocked = await printBol(
      new Request(`http://portal.test/api/orders/${order.id}/bol/print`, {
        method: "POST",
        headers: headers(viewAs, true),
        body: JSON.stringify({ documentId: nextBol }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(blocked.status).toBe(403);
  });

  it("gives concurrent prints distinct versions", async () => {
    const order = await makeLoad("SO-BOL-RACE");
    const documentId = await uploadBol(order.id, "bol-race.txt");
    const [first, second] = await Promise.all([
      recordBolPrint(ctx, {
        loadId: order.id,
        documentId,
        printedById: "admin-1",
        printedByName: "Mike Gray",
        carrier: { carrierName: null, carrierMc: null, driverName: null },
      }),
      recordBolPrint(ctx, {
        loadId: order.id,
        documentId,
        printedById: "admin-1",
        printedByName: "Mike Gray",
        carrier: { carrierName: null, carrierMc: null, driverName: null },
      }),
    ]);
    expect([first.version, second.version].sort()).toEqual([1, 2]);
  });

  it("keeps print history and carrier identity off receiver links and public tracking", async () => {
    const order = await makeLoad("SO-BOL-HIDDEN");
    const documentId = await uploadBol(order.id, "bol-hidden.txt");
    await recordBolPrint(ctx, {
      loadId: order.id,
      documentId,
      printedById: "admin-1",
      printedByName: "Mike Gray",
      carrier: { carrierName: "HIDDEN CARRIER", carrierMc: "555", driverName: "Hidden Driver" },
    });
    await ctx.db.prepare(`UPDATE loads SET carrier_name = ?, carrier_mc = ?, driver_name = ? WHERE id = ?`).run("HIDDEN CARRIER", "555", "Hidden Driver", order.id);
    const token = String((await ctx.db.prepare(`SELECT tracking_token FROM loads WHERE id = ?`).get(order.id))?.tracking_token);
    const tracked = await track(new Request(`http://portal.test/api/track/${token}`), { params: Promise.resolve({ token }) });
    const trackedBody = await tracked.json();
    expect(JSON.stringify(trackedBody)).not.toMatch(/bolPrint|carrierName|carrierMc|driverName|HIDDEN CARRIER|documents/);
    expectNoSecrets(trackedBody);

    const receiver = await createReceiver(ctx, { company: "Acme Dock", contactEmails: [] });
    const portal = await receiverPortalRoute(new Request(`http://portal.test/api/r/${receiver.token}`), {
      params: Promise.resolve({ token: receiver.token }),
    });
    const text = JSON.stringify(await portal.json());
    expect(text).not.toMatch(/bolPrint|carrierName|HIDDEN CARRIER|Hidden Driver|ACME Trucking|123456|documents/);
    expect(text).toContain("SO-BOL-HIDDEN");
  });
});

describe("startup keeps carrier identity columns", () => {
  it("does not drop carrier name, MC, or driver when the database opens twice", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { openDatabase } = await import("@/lib/db");
    const file = path.join(mkdtempSync(path.join(tmpdir(), "emit-carrier-")), "portal.db");
    const first = await openDatabase(file);
    await first.prepare(`UPDATE loads SET carrier_name = 'KEEP' WHERE 0`).run();
    const columns = (await first.prepare(`PRAGMA table_info(loads)`).all()).map((column) => String(column.name));
    expect(columns).toEqual(expect.arrayContaining(["carrier_name", "carrier_mc", "driver_name"]));
    expect(columns).not.toContain("carrier_pay_cents");
    expect(columns).not.toContain("staff_notes");
    first.close?.();
    const second = await openDatabase(file);
    const again = (await second.prepare(`PRAGMA table_info(loads)`).all()).map((column) => String(column.name));
    expect(again).toContain("carrier_name");
    expect(again).not.toContain("carrier_pay_cents");
    second.close?.();
    useTestPortal(ctx);
  });
});
