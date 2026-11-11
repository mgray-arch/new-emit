import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as uploadBot } from "@/app/api/integrations/documents/route";
import { POST as uploadDocument } from "@/app/api/orders/[id]/documents/route";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { PATCH as patchOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as ingestPhoto } from "@/app/api/ingest/carrier-photos/route";
import { screenPageBytes } from "@/lib/documents";
import { ingestDocument } from "@/lib/documents";
import type { PortalContext } from "@/lib/db";
import { reviewDocument } from "@/lib/documents";
import { solidPng } from "@/lib/photos";
import { refileCustomerAttachment } from "@/lib/refile-attachment";
import { bolLoadNumberFromFilename, customerUploadSlot } from "@/lib/sam-bol";
import { writeStoredBytes } from "@/lib/storage";
import type { CustomerOrder } from "@/lib/types";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

function bolText(loadNumber: string): string {
  return [
    `BOL #: ${loadNumber}                                BILL OF LADING`,
    "Shipper EMIT TECHNOLOGIES",
    "Carrier",
    "TETON TRUCKS INC",
    `MC #: 1600217 DOT #: 4163340`,
    "Declared value $1,850.00",
  ].join("\n");
}

const RATE = "RATE CONFIRMATION\nCarrier pay $1,850.00\nBOL #: 470099-1\nBILL OF LADING\nThis page is a carrier rate confirmation.";

let ctx: PortalContext;

beforeAll(async () => {
  process.env.BOT_UPLOAD_KEY = "bot-upload-test-key-0123456789";
  process.env.CARRIER_PHOTO_INGEST_TOKEN = "test-ingest-token-value";
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

async function orderFrom(id: string, cookie?: string): Promise<CustomerOrder> {
  const response = await getOrderRoute(
    new Request(`http://portal.test/api/orders/${id}`, { headers: headers(cookie ?? (await sessionCookie(adminSession()))) }),
    { params: Promise.resolve({ id }) },
  );
  expect(response.status).toBe(200);
  return (await response.json()).order as CustomerOrder;
}

describe("which control filed the attachment", () => {
  it("names a Select BOL from the filename the other-file input would send", () => {
    expect(bolLoadNumberFromFilename("Select-BOL-468322-1_111126-1043.pdf")).toBe("468322-1");
    expect(bolLoadNumberFromFilename("BOL-468322-1.pdf")).toBe("468322-1");
    expect(bolLoadNumberFromFilename("bol_467623-1.txt")).toBe("467623-1");
    expect(bolLoadNumberFromFilename("notes.txt")).toBeNull();
    expect(bolLoadNumberFromFilename("mybol-1234-1.pdf")).toBeNull();
    expect(bolLoadNumberFromFilename("rate-confirmation.pdf")).toBeNull();
    expect(customerUploadSlot("attachment", "Select-BOL-468322-1_111126-1043.pdf", "")).toBe("bol");
    expect(customerUploadSlot("attachment", "notes.txt", bolText("470001-1"))).toBe("bol");
    expect(customerUploadSlot("attachment", "notes.txt", "Dock notes. Four crates are staged at the Sheridan dock.")).toBe("attachment");
    expect(customerUploadSlot("bol", "notes.txt", "Dock notes. Four crates are staged at the Sheridan dock.")).toBe("bol");

    const detail = readFileSync(path.join(process.cwd(), "app/orders/[id]/page.tsx"), "utf8");
    const board = readFileSync(path.join(process.cwd(), "components/dashboard.tsx"), "utf8");
    expect(detail).toContain('aria-label="Upload BOL"');
    expect(detail).toContain('aria-label="Upload other file"');
    expect(detail).not.toContain("Upload another file");
    expect(board).toContain('aria-label="Upload BOL"');
    expect(board).toContain('aria-label="Upload other file"');
    expect(board).not.toContain("Upload attachment");
    expect(`${detail}\n${board}`).not.toMatch(/\bSAM\b/);
    expect(`${detail}\n${board}`).not.toMatch(/rate confirmation|carrier pay/i);
  });
});

describe("a bill of lading dropped on the other-file control", () => {
  it("screens it, files it as a BOL, and fills the load number, carrier, and MC", async () => {
    const order = await makeLoad("SO-MISFILE-BOL");
    const uploaded = await uploadText(order.id, "Select-BOL-470001-1_111126-1043.txt", bolText("470001-1"), "attachment");
    expect(uploaded.status).toBe(200);
    const body = await uploaded.json();
    expect(body).toMatchObject({ released: 1, heldForReview: 0 });
    const shown = body.order as CustomerOrder;
    expect(shown.loadNumber).toBe("470001-1");
    expect(shown.carrierName).toBe("TETON TRUCKS INC");
    expect(shown.carrierMc).toBe("1600217");
    expect(shown.driverName ?? null).toBeNull();
    expect(shown.documents.some((doc) => doc.filename.startsWith("Select-BOL-470001-1") && doc.kind === "bol")).toBe(true);
    expect(shown.documents.some((doc) => doc.kind === "attachment")).toBe(false);
    expectNoSecrets(shown);

    const stored = await ctx.db
      .prepare(`SELECT kind, uploaded_by FROM customer_documents WHERE load_id = ? AND filename LIKE 'Select-BOL-470001-1%'`)
      .get(order.id);
    expect(stored).toMatchObject({ kind: "bol", uploaded_by: "Mike Gray" });
    expect(await ctx.db.prepare(`SELECT id FROM internal_documents WHERE load_id = ?`).get(order.id)).toBeUndefined();

    const byText = await makeLoad("SO-MISFILE-TEXT");
    const header = await uploadText(byText.id, "notes.txt", bolText("470002-1"), "attachment");
    expect(header.status).toBe(200);
    const filled = await orderFrom(byText.id);
    expect(filled.loadNumber).toBe("470002-1");
    expect(filled.carrierName).toBe("TETON TRUCKS INC");
    expect(filled.carrierMc).toBe("1600217");
    expect(filled.documents.find((doc) => doc.filename === "notes.txt")?.kind).toBe("bol");
  });

  it("holds a rate confirmation even when the filename looks like a BOL, and EMIT never sees it", async () => {
    const order = await makeLoad("SO-MISFILE-RATE");
    const uploaded = await uploadText(order.id, "Select-BOL-470099-1_rate.txt", RATE, "attachment");
    expect(uploaded.status).toBe(200);
    expect(await uploaded.json()).toMatchObject({ released: 0, heldForReview: 1 });
    const shown = await orderFrom(order.id);
    expect(shown.carrierName ?? null).toBeNull();
    expect(shown.loadNumber).toBeNull();
    expect(shown.documents.some((doc) => doc.filename.includes("rate"))).toBe(false);
    const held = await ctx.db
      .prepare(`SELECT screen_result, review_status FROM internal_documents WHERE load_id = ?`)
      .get(order.id);
    expect(held).toMatchObject({ screen_result: "block", review_status: "pending" });

    const emit = await orderFrom(order.id, await sessionCookie(customerSession()));
    expect(JSON.stringify(emit)).not.toMatch(/rate confirmation|carrier pay|1,850|Select-BOL-470099-1_rate/i);
    expectNoSecrets(emit);

    const screened = await screenPageBytes({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      text: RATE,
      mediaType: "application/pdf",
    });
    expect(screened.decision).toBe("block");
  });

  it("files a bot POD whose name is a Select BOL as a BOL", async () => {
    const order = await makeLoad("SO-MISFILE-BOT");
    const bytes = readFileSync(path.join(process.cwd(), "tests/fixtures", "bol_461169-1.pdf"));
    const body = new FormData();
    body.set("file", new File([bytes], "Select-BOL-461169-1_111126-1043.pdf", { type: "application/pdf" }));
    body.set("salesOrderNumber", "SO-MISFILE-BOT");
    body.set("doc_type", "pod");
    const response = await uploadBot(
      new Request("http://portal.test/api/integrations/documents", {
        method: "POST",
        headers: { authorization: "Bearer bot-upload-test-key-0123456789", "x-forwarded-for": "203.0.113.88" },
        body,
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ docType: "bol", released: 1, heldForReview: 0 });
    const shown = await orderFrom(order.id);
    expect(shown.loadNumber).toBe("461169-1");
    expect(shown.carrierName).toBe("CUSMIR EXPRESS LLC");
    expect(shown.carrierMc).toBe("1046091");
    expectNoSecrets(shown);
  });

  it("does not leave a Select BOL image in the photo gallery", async () => {
    const order = await makeLoad("SO-MISFILE-PHOTO");
    await ctx.db.prepare(`UPDATE loads SET load_number = ? WHERE id = ?`).run("468322-1", order.id);
    const response = await ingestPhoto(
      new Request("http://portal.test/api/ingest/carrier-photos", {
        method: "POST",
        headers: { authorization: "Bearer test-ingest-token-value", "content-type": "application/json" },
        body: JSON.stringify({
          loadNumber: "468322-1",
          source: "Select admin",
          receivedAt: "2026-11-11T17:43:00Z",
          filename: "Select-BOL-468322-1_111126-1043.png",
          contentType: "image/png",
          dataBase64: Buffer.from(solidPng(12, 24, 36)).toString("base64"),
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.filedAsBol).toBe(true);
    expect(body.visibleToCustomer).toBe(false);
    expect(await ctx.db.prepare(`SELECT id FROM carrier_photos WHERE load_id = ?`).get(order.id)).toBeUndefined();
    expect(await ctx.db.prepare(`SELECT id FROM customer_documents WHERE load_id = ?`).get(order.id)).toBeUndefined();
    const held = await ctx.db.prepare(`SELECT review_status FROM internal_documents WHERE load_id = ?`).get(order.id);
    expect(held).toMatchObject({ review_status: "pending" });
  });
});

describe("refile an attachment that skipped the BOL path", () => {
  it("dry-runs, then files the attachment as a BOL without leaving the old row", async () => {
    const order = await makeLoad("SO-REFILE");
    const ingested = await ingestDocument(ctx, {
      loadId: order.id,
      filename: "Select-BOL-470004-1_111126-1043.txt",
      bytes: new TextEncoder().encode(bolText("470004-1")),
      slot: "attachment",
    });
    expect(ingested.releasedIds).toHaveLength(1);
    expect((await orderFrom(order.id)).carrierName ?? null).toBeNull();

    const preview = await refileCustomerAttachment(ctx, ingested.releasedIds[0], false);
    expect(preview.applied).toBe(false);
    expect(preview.slot).toBe("bol");
    expect(preview.parsedLoadNumber).toBe("470004-1");
    expect(preview.parsedCarrierName).toBe("TETON TRUCKS INC");
    expect(preview.parsedCarrierMc).toBe("1600217");
    expect(preview.note).toMatch(/Nothing was written/);
    expect((await orderFrom(order.id)).loadNumber).toBeNull();

    const applied = await refileCustomerAttachment(ctx, ingested.releasedIds[0], true);
    expect(applied.applied).toBe(true);
    expect(applied.releasedCount).toBe(1);
    expect(await ctx.db.prepare(`SELECT id FROM customer_documents WHERE id = ?`).get(ingested.releasedIds[0])).toBeUndefined();
    const shown = await orderFrom(order.id);
    expect(shown.loadNumber).toBe("470004-1");
    expect(shown.carrierName).toBe("TETON TRUCKS INC");
    expect(shown.carrierMc).toBe("1600217");
    expect(shown.documents.some((doc) => doc.kind === "bol" && doc.filename.startsWith("Select-BOL-470004-1"))).toBe(true);
    expect(shown.documents.some((doc) => doc.kind === "attachment")).toBe(false);
    const actor = await ctx.db.prepare(`SELECT uploaded_by FROM customer_documents WHERE load_id = ?`).get(order.id);
    expect(actor).toMatchObject({ uploaded_by: "Select refile" });
    expectNoSecrets(shown);
  });

  it("pulls a rate confirmation out of EMIT when the old row skipped the screen", async () => {
    const order = await makeLoad("SO-REFILE-RATE");
    const id = randomUUID();
    const bytes = new TextEncoder().encode(RATE);
    const storageKey = await writeStoredBytes(`customer-documents/${id}`, bytes, "text/plain");
    await ctx.db
      .prepare(
        `INSERT INTO customer_documents (id, load_id, kind, filename, media_type, storage_key, created_at, uploaded_by)
         VALUES (?, ?, 'attachment', 'Select-BOL-470099-1_rate.txt', 'text/plain', ?, ?, NULL)`,
      )
      .run(id, order.id, storageKey, ctx.now().toISOString());

    const applied = await refileCustomerAttachment(ctx, id, true);
    expect(applied.applied).toBe(true);
    expect(applied.blocked).toBe(true);
    expect(applied.releasedCount).toBe(0);
    expect(await ctx.db.prepare(`SELECT id FROM customer_documents WHERE id = ?`).get(id)).toBeUndefined();
    const held = await ctx.db
      .prepare(`SELECT screen_result, review_status FROM internal_documents WHERE load_id = ? AND filename = ?`)
      .get(order.id, "Select-BOL-470099-1_rate.txt");
    expect(held).toMatchObject({ screen_result: "block", review_status: "pending" });
    const emit = await orderFrom(order.id, await sessionCookie(customerSession()));
    expect(JSON.stringify(emit)).not.toMatch(/rate confirmation|carrier pay|1,850|Select-BOL/i);
    expect(emit.carrierName ?? null).toBeNull();
    expectNoSecrets(emit);
  });

  it("refuses to approve an unclear page once the text reads as a rate confirmation, and fills a BOL Mike approves", async () => {
    const blocked = await makeLoad("SO-APPROVE-RATE");
    const rateId = randomUUID();
    const rateKey = await writeStoredBytes(`internal-documents/${rateId}`, new TextEncoder().encode(RATE), "text/plain");
    await ctx.db
      .prepare(
        `INSERT INTO internal_documents (
           id, load_id, kind, screen_result, screen_reason, review_status, filename, media_type,
           page_index, page_count, text_excerpt, storage_key, created_at, uploaded_by
         ) VALUES (?, ?, 'uncertain', 'uncertain', 'OCR could not read this file.', 'pending', ?, 'text/plain', 1, 1, NULL, ?, ?, NULL)`,
      )
      .run(rateId, blocked.id, "notes.txt", rateKey, ctx.now().toISOString());
    await expect(reviewDocument(ctx, rateId, "approve", "mgray@goselect.com")).rejects.toThrow(/cannot be released/);
    expect(await ctx.db.prepare(`SELECT id FROM customer_documents WHERE load_id = ?`).get(blocked.id)).toBeUndefined();
    const still = await ctx.db.prepare(`SELECT review_status FROM internal_documents WHERE id = ?`).get(rateId);
    expect(still).toMatchObject({ review_status: "pending" });

    const allowed = await makeLoad("SO-APPROVE-BOL");
    const bolId = randomUUID();
    const bolKey = await writeStoredBytes(`internal-documents/${bolId}`, new TextEncoder().encode(bolText("470005-1")), "text/plain");
    await ctx.db
      .prepare(
        `INSERT INTO internal_documents (
           id, load_id, kind, screen_result, screen_reason, review_status, filename, media_type,
           page_index, page_count, text_excerpt, storage_key, created_at, uploaded_by
         ) VALUES (?, ?, 'uncertain', 'uncertain', 'OCR could not read this file.', 'pending', ?, 'text/plain', 1, 1, NULL, ?, ?, NULL)`,
      )
      .run(bolId, allowed.id, "notes.txt", bolKey, ctx.now().toISOString());
    const approved = await reviewDocument(ctx, bolId, "approve", "mgray@goselect.com");
    expect(approved.reviewStatus).toBe("approved");
    const shown = await orderFrom(allowed.id);
    expect(shown.documents.find((doc) => doc.filename === "notes.txt")?.kind).toBe("bol");
    expect(shown.loadNumber).toBe("470005-1");
    expect(shown.carrierName).toBe("TETON TRUCKS INC");
    expect(shown.carrierMc).toBe("1600217");
    expectNoSecrets(shown);
  });
});
