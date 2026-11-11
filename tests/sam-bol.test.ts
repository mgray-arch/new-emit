import { readFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractText } from "unpdf";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { POST as uploadBot } from "@/app/api/integrations/documents/route";
import { GET as downloadDoc } from "@/app/api/documents/[id]/route";
import { GET as printDocumentPage } from "@/app/api/documents/[id]/print/route";
import { GET as printBolPage, POST as printBol } from "@/app/api/orders/[id]/bol/print/route";
import { POST as uploadDocument } from "@/app/api/orders/[id]/documents/route";
import { GET as getOrderRoute, PATCH as patchOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { PATCH as setCarrier } from "@/app/api/admin/orders/[id]/carrier/route";
import { coverLoadFromReleasedBol } from "@/lib/bol-coverage";
import { carrierIdentityLabel } from "@/lib/carrier";
import { ingestDocument } from "@/lib/documents";
import type { PortalContext } from "@/lib/db";
import { tripCaption } from "@/lib/load-list";
import { reprintMessage } from "@/lib/reprint";
import { parseSamBol, sameBolCarrier } from "@/lib/sam-bol";
import { sensitiveReason } from "@/lib/sensitive";
import { writeStoredBytes } from "@/lib/storage";
import type { CustomerOrder } from "@/lib/types";
import nextConfig from "../next.config";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

const TETON = [
  "BOL #: 467623-1                                BILL OF LADING",
  "Date: 11/09/2026",
  "Shipper Pickup: 11/24/2026",
  "EMIT TECHNOLOGIES",
  "2437 Allen Avenue",
  "Sheridan, WY 82801 US",
  "Pickup #: SO123456",
  "Consignee",
  "KODIAK GAS SERVICES",
  "Carrier",
  "TETON TRUCKS INC",
  "MC #: 1600217 DOT #: 4163340",
  "Truck #: Trailer #:",
  "Driver: Sam Driver (208) 555-0100",
  "3rd Party Freight Charges",
  "Bill To:",
  "Select Transport Partners, LLC.",
  "Email:docs@goselect.com",
  "Declared value $1,850.00",
  "Carrier Signature / Pick Up Date",
  "Carrier acknowledges receipt of packages and required placards.",
].join("\n");

let ctx: PortalContext;

beforeAll(async () => {
  process.env.BOT_UPLOAD_KEY = "bot-upload-test-key-0123456789";
  delete process.env.EMAIL_FROM;
  delete process.env.EMAIL_API_KEY;
  delete process.env.EMAIL_API_URL;
  delete process.env.SLACK_NEW_LOADS_WEBHOOK_URL;
  ctx = await seededPortal();
});

function headers(cookie: string, json = false): HeadersInit {
  return {
    cookie,
    host: "portal.test",
    origin: "http://portal.test",
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function makeLoad(salesOrderNumber: string): Promise<CustomerOrder> {
  const cookie = await sessionCookie(customerSession());
  const response = await createOrderRoute(
    new Request("http://portal.test/api/orders", {
      method: "POST",
      headers: headers(cookie, true),
      body: JSON.stringify({
        salesOrderNumber,
        origin: { company: "EMIT", address1: "2437 Allen Avenue", city: "Sheridan", state: "WY", postalCode: "82801" },
        destination: { company: "Kodiak", address1: "1 Dock", city: "Houston", state: "TX", postalCode: "77002" },
        shipDate: "2026-11-24",
      }),
    }),
  );
  expect(response.status).toBe(201);
  const order = (await response.json()).order as CustomerOrder;
  const ready = await patchOrderRoute(
    new Request(`http://portal.test/api/orders/${order.id}`, {
      method: "PATCH",
      headers: headers(cookie, true),
      body: JSON.stringify({ portalStatus: "ready_to_ship" }),
    }),
    { params: Promise.resolve({ id: order.id }) },
  );
  expect(ready.status).toBe(200);
  return (await ready.json()).order as CustomerOrder;
}

async function uploadText(orderId: string, filename: string, text: string, slot: "bol" | "attachment") {
  const cookie = await sessionCookie(adminSession());
  const form = new FormData();
  form.set("file", new File([new TextEncoder().encode(text)], filename, { type: "text/plain" }));
  form.set("slot", slot);
  return uploadDocument(
    new Request(`http://portal.test/api/orders/${orderId}/documents`, { method: "POST", headers: headers(cookie), body: form }),
    { params: Promise.resolve({ id: orderId }) },
  );
}

async function orderFrom(id: string): Promise<CustomerOrder> {
  const cookie = await sessionCookie(adminSession());
  const response = await getOrderRoute(new Request(`http://portal.test/api/orders/${id}`, { headers: headers(cookie) }), {
    params: Promise.resolve({ id }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).order as CustomerOrder;
}

function expectCarrierHidden(order: CustomerOrder) {
  const text = JSON.stringify(order);
  expect(text).not.toMatch(/docs@goselect\.com|555-0100|4163340|1,850|1850|Freight Charges|Sam Driver|Dayshin/i);
  expect(text).not.toMatch(/carrierPay|carrier_pay|rate confirmation/i);
  expectNoSecrets(order);
}

describe("SAM bill of lading text", () => {
  it("reads the carrier company, MC, and BOL number, and nothing about pay", async () => {
    const parsed = parseSamBol(TETON);
    expect(parsed).toEqual({ loadNumber: "467623-1", carrierName: "TETON TRUCKS INC", carrierMc: "1600217" });
    expect(Object.keys(parsed).sort()).toEqual(["carrierMc", "carrierName", "loadNumber"]);
    expect(JSON.stringify(parsed)).not.toMatch(/1850|docs@|4163340|555-0100|Sam Driver|Freight/i);
    expect(sensitiveReason(TETON)).toBeNull();

    const inline = parseSamBol(
      "bill   of   lading\nbol# : 461169 - 1\nCarrier CUSMIR EXPRESS LLC\nMC #: 1046091\nPickup #: $0-002002\nDeclared value $1,850.00",
    );
    expect(inline).toEqual({ loadNumber: "461169-1", carrierName: "CUSMIR EXPRESS LLC", carrierMc: "1046091" });
    expect(sameBolCarrier(parsed, { carrierName: "teton trucks inc", carrierMc: "MC 1600217" })).toBe(true);
    expect(sameBolCarrier(parsed, { carrierName: "RED MESA LLC", carrierMc: "1600217" })).toBe(false);
    expect(sameBolCarrier(parsed, { carrierName: "TETON TRUCKS INC", carrierMc: "999" })).toBe(false);
    expect(sameBolCarrier({ carrierName: null, carrierMc: null }, parsed)).toBe(false);

    const samples = [
      { file: "bol_461169-1.pdf", loadNumber: "461169-1", carrierName: "CUSMIR EXPRESS LLC", carrierMc: "1046091" },
      { file: "bol_461940-1.pdf", loadNumber: "461940-1", carrierName: "ASSURE TRANSPORT", carrierMc: "1659149" },
    ];
    for (const sample of samples) {
      const bytes = new Uint8Array(readFileSync(path.join(process.cwd(), "tests/fixtures", sample.file)));
      const result = await extractText(bytes.slice(), { mergePages: true });
      const raw: unknown = result.text;
      const text = Array.isArray(raw) ? raw.join("\n") : String(raw ?? "");
      expect(parseSamBol(text)).toEqual({
        loadNumber: sample.loadNumber,
        carrierName: sample.carrierName,
        carrierMc: sample.carrierMc,
      });
    }
  });
});

describe("released BOL covers the load", () => {
  it("books the carrier from a released BOL and stores a missing SAM load number", async () => {
    const order = await makeLoad("SO123456");
    expect(order.loadNumber).toBeNull();
    expect(order.trackingStage).toBe("submitted");
    expect(carrierIdentityLabel(order)).toBe("Carrier not assigned");

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const uploaded = await uploadText(order.id, "bol_467623-1.txt", TETON, "bol");
    expect(uploaded.status).toBe(200);
    const body = await uploaded.json();
    expect(body.released).toBe(1);
    expect(body.heldForReview).toBe(0);
    const shown = body.order as CustomerOrder;
    expect(shown.portalStatus).toBe("ready_to_ship");
    expect(shown.trackingStage).toBe("booked");
    expect(shown.loadNumber).toBe("467623-1");
    expect(shown.carrierName).toBe("TETON TRUCKS INC");
    expect(shown.carrierMc).toBe("1600217");
    expect(shown.driverName ?? null).toBeNull();
    expect(shown.customerCost ?? null).toBeNull();
    expect(carrierIdentityLabel(shown)).toContain("TETON TRUCKS INC");
    expect(carrierIdentityLabel(shown)).toContain("1600217");
    expect(tripCaption(shown.trackingStage, false)).toBe("Booked. A truck is booked and has not arrived at the dock yet.");
    expect(shown.haulCallout?.company).toBe("TETON TRUCKS INC");
    expect(shown.haulCallout?.mc).toBe("1600217");
    expect(shown.notices?.some((notice) => notice.text.includes("TETON TRUCKS INC") && notice.text.includes("1600217"))).toBe(true);
    expectCarrierHidden(shown);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    const row = await ctx.db
      .prepare(`SELECT carrier_name, carrier_mc, driver_name, load_number, tracking_stage, customer_cost_cents, carrier_notice_log FROM loads WHERE id = ?`)
      .get(order.id);
    expect(row).toMatchObject({
      carrier_name: "TETON TRUCKS INC",
      carrier_mc: "1600217",
      driver_name: null,
      load_number: "467623-1",
      tracking_stage: "booked",
      customer_cost_cents: null,
    });
    expect(String(row?.carrier_notice_log)).not.toMatch(/1850|docs@|4163340|555-0100/);
  });

  it("does not book a held rate confirmation, an attachment, or a load number that is already taken", async () => {
    const heldOrder = await makeLoad("SO-RATE-HELD");
    const rate = await uploadText(
      heldOrder.id,
      "rate-con.txt",
      "RATE CONFIRMATION\nCarrier TETON TRUCKS INC\nMC #: 1600217\nCarrier pay $1,850.00\nBOL #: 467623-1",
      "bol",
    );
    expect(rate.status).toBe(200);
    expect(await rate.json()).toMatchObject({ released: 0, heldForReview: 1 });
    const held = await orderFrom(heldOrder.id);
    expect(held.trackingStage).toBe("submitted");
    expect(held.carrierName ?? null).toBeNull();
    expect(held.loadNumber).toBeNull();
    expect(carrierIdentityLabel(held)).toBe("Carrier not assigned");

    await coverLoadFromReleasedBol(ctx, heldOrder.id, "RATE CONFIRMATION\nCarrier Pay $1,850.00\nCarrier TETON TRUCKS INC\nMC #: 1600217");
    expect((await orderFrom(heldOrder.id)).carrierName ?? null).toBeNull();

    const attachment = await makeLoad("SO-ATTACH-ONLY");
    const file = await uploadText(
      attachment.id,
      "notes.txt",
      "Dock notes. Four crates are staged at the Sheridan dock for pickup tomorrow.",
      "attachment",
    );
    expect(file.status).toBe(200);
    const attached = await orderFrom(attachment.id);
    expect(attached.trackingStage).toBe("submitted");
    expect(attached.carrierName ?? null).toBeNull();
    expect(attached.loadNumber).toBeNull();
    expect(attached.documents.some((doc) => doc.filename === "notes.txt" && doc.kind === "attachment")).toBe(true);

    const kept = await makeLoad("SO-KEEP-NUMBER");
    await ctx.db.prepare(`UPDATE loads SET load_number = ? WHERE id = ?`).run("900001-1", kept.id);
    const same = await uploadText(kept.id, "bol-keep.txt", TETON, "bol");
    expect(same.status).toBe(200);
    const numbered = await orderFrom(kept.id);
    expect(numbered.loadNumber).toBe("900001-1");
    expect(numbered.carrierName).toBe("TETON TRUCKS INC");
    expect(numbered.trackingStage).toBe("booked");

    const owner = await makeLoad("SO-OWNS-NUMBER");
    await ctx.db.prepare(`UPDATE loads SET load_number = ? WHERE id = ?`).run("467700-1", owner.id);
    const other = await makeLoad("SO-OTHER-NUMBER");
    const text = TETON.replace("467623-1", "467700-1");
    const blocked = await uploadText(other.id, "bol-taken.txt", text, "bol");
    expect(blocked.status).toBe(200);
    const left = await orderFrom(other.id);
    expect(left.loadNumber).toBeNull();
    expect(left.carrierName).toBe("TETON TRUCKS INC");
    expect((await orderFrom(owner.id)).loadNumber).toBe("467700-1");
  });

  it("books from a bot PDF upload of a real SAM bill of lading", async () => {
    const order = await makeLoad("SO-SAM-PDF");
    const bytes = readFileSync(path.join(process.cwd(), "tests/fixtures", "bol_461169-1.pdf"));
    const body = new FormData();
    body.set("file", new File([bytes], "bol_461169-1.pdf", { type: "application/pdf" }));
    body.set("salesOrderNumber", "SO-SAM-PDF");
    body.set("doc_type", "bol");
    const response = await uploadBot(
      new Request("http://portal.test/api/integrations/documents", {
        method: "POST",
        headers: { authorization: "Bearer bot-upload-test-key-0123456789", "x-forwarded-for": "203.0.113.77" },
        body,
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ released: 1, heldForReview: 0, docType: "bol" });
    const shown = await orderFrom(order.id);
    expect(shown.loadNumber).toBe("461169-1");
    expect(shown.carrierName).toBe("CUSMIR EXPRESS LLC");
    expect(shown.carrierMc).toBe("1046091");
    expect(shown.trackingStage).toBe("booked");
    expect(shown.driverName ?? null).toBeNull();
    expectCarrierHidden(shown);
  });
});

describe("reprint warning", () => {
  it("does not warn when an empty print is filled with the carrier already on that BOL", async () => {
    const order = await makeLoad("SO-REPRINT-BOL");
    const ingested = await ingestDocument(ctx, {
      loadId: order.id,
      filename: "bol_467623-1.txt",
      bytes: new TextEncoder().encode(TETON),
      slot: "bol",
    });
    expect(ingested.releasedIds).toHaveLength(1);
    const admin = await sessionCookie(adminSession());
    const printed = await printBol(
      new Request(`http://portal.test/api/orders/${order.id}/bol/print`, {
        method: "POST",
        headers: headers(admin, true),
        body: JSON.stringify({ documentId: ingested.releasedIds[0] }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(printed.status).toBe(200);
    expect((await orderFrom(order.id)).bolPrint).toMatchObject({ reprint: false, carrierName: null });

    await coverLoadFromReleasedBol(ctx, order.id, ingested.releasedTexts.join("\n"));
    const covered = await orderFrom(order.id);
    expect(covered.carrierName).toBe("TETON TRUCKS INC");
    expect(covered.carrierMc).toBe("1600217");
    expect(covered.trackingStage).toBe("booked");
    expect(covered.bolPrint?.reprint).toBe(false);
    expect(covered.bolPrint?.reasons).toEqual([]);

    const changed = await setCarrier(
      new Request(`http://portal.test/api/admin/orders/${order.id}/carrier`, {
        method: "PATCH",
        headers: headers(admin, true),
        body: JSON.stringify({ carrierName: "RED MESA LLC", carrierMc: "778899" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(changed.status).toBe(200);
    const next = (await changed.json()).order as CustomerOrder;
    expect(next.bolPrint?.reprint).toBe(true);
    expect(next.bolPrint?.reasons).toContain("carrier_changed");
    expect(
      reprintMessage({
        version: next.bolPrint!.version,
        reasons: next.bolPrint!.reasons,
        bolRemoved: next.bolPrint!.bolRemoved,
        printedCarrierName: next.bolPrint!.carrierName,
        printedCarrierMc: next.bolPrint!.carrierMc,
        currentCarrierName: next.carrierName ?? null,
        currentCarrierMc: next.carrierMc ?? null,
      }),
    ).toMatch(/RED MESA LLC/);

    const replaced = await uploadText(
      order.id,
      "bol-v2.txt",
      TETON.replace("TETON TRUCKS INC", "NORTHLINE FREIGHT").replace("1600217", "445566"),
      "bol",
    );
    expect(replaced.status).toBe(200);
    const afterFile = await orderFrom(order.id);
    expect(afterFile.carrierName).toBe("NORTHLINE FREIGHT");
    expect(afterFile.bolPrint?.reprint).toBe(true);
    expect(afterFile.bolPrint?.reasons).toContain("bol_updated");
    expect(afterFile.bolPrint?.reasons).toContain("carrier_changed");
  });

  it("still warns when a new BOL file replaces the printed one and the carrier is unchanged", async () => {
    const order = await makeLoad("SO-REPRINT-FILE");
    const first = await uploadText(order.id, "bol-a.txt", TETON, "bol");
    expect(first.status).toBe(200);
    const admin = await sessionCookie(adminSession());
    const documentId = ((await first.json()).order as CustomerOrder).documents.find((doc) => doc.kind === "bol")?.id;
    expect(documentId).toBeTruthy();
    const printed = await printBol(
      new Request(`http://portal.test/api/orders/${order.id}/bol/print`, {
        method: "POST",
        headers: headers(admin, true),
        body: JSON.stringify({ documentId }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(printed.status).toBe(200);
    expect((await orderFrom(order.id)).bolPrint?.reprint).toBe(false);

    const second = await uploadText(order.id, "bol-b.txt", `${TETON}\nPage note: second copy of the same carrier.`, "bol");
    expect(second.status).toBe(200);
    const shown = await orderFrom(order.id);
    expect(shown.carrierName).toBe("TETON TRUCKS INC");
    expect(shown.bolPrint?.reprint).toBe(true);
    expect(shown.bolPrint?.reasons).toEqual(["bol_updated"]);
  });
});

describe("print opens the uploaded file", () => {
  it("allows same-origin framing and sends a one-page PDF to the browser viewer", async () => {
    expect(nextConfig.headers).toBeTypeOf("function");
    const rules = await nextConfig.headers!();
    expect(rules.map((rule) => rule.source)).toEqual(["/:path*"]);
    const frame = rules[0]?.headers.find((header) => header.key === "X-Frame-Options");
    expect(frame?.value).toBe("SAMEORIGIN");

    const order = await makeLoad("SO-PRINT-PDF");
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("BOL #: 467623-1 BILL OF LADING", { x: 48, y: 740, size: 12, font });
    const bytes = await doc.save();
    const docId = "bol-print-redirect";
    const storageKey = await writeStoredBytes(`customer-documents/${docId}`, bytes, "application/pdf");
    await ctx.db
      .prepare(
        `INSERT INTO customer_documents (id, load_id, kind, filename, media_type, storage_key, created_at, uploaded_by)
         VALUES (?, ?, 'bol', 'bol_467623-1.pdf', 'application/pdf', ?, ?, 'Select bot')`,
      )
      .run(docId, order.id, storageKey, ctx.now().toISOString());

    const cookie = await sessionCookie(adminSession());
    const printed = await printBolPage(new Request(`http://portal.test/api/orders/${order.id}/bol/print`, { headers: headers(cookie) }), {
      params: Promise.resolve({ id: order.id }),
    });
    expect(printed.status).toBe(302);
    expect(printed.headers.get("location")).toBe(`/api/documents/${docId}`);
    expect(printed.headers.get("content-type")).not.toBe("text/html");

    const file = await downloadDoc(new Request(`http://portal.test/api/documents/${docId}`, { headers: headers(cookie) }), {
      params: Promise.resolve({ id: docId }),
    });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(file.headers.get("content-disposition")).toBe('inline; filename="bol_467623-1.pdf"');
    expect(Buffer.from(await file.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");
    expect((await orderFrom(order.id)).bolPrintCount).toBe(1);

    const listed = await printDocumentPage(new Request(`http://portal.test/api/documents/${docId}/print`, { headers: headers(cookie) }), {
      params: Promise.resolve({ id: docId }),
    });
    expect(listed.status).toBe(302);
    expect(listed.headers.get("location")).toBe(`/api/documents/${docId}`);
    expect((await orderFrom(order.id)).bolPrintCount).toBe(1);
  });
});
