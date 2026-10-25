import { randomUUID } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import * as integrationRoute from "@/app/api/integrations/documents/route";
import { POST } from "@/app/api/integrations/documents/route";
import {
  assertOneLoad,
  BOT_UPLOAD_LIMIT,
  BOT_UPLOADER,
  parseBotDocType,
} from "@/lib/bot-documents";
import { presentCustomerOrder } from "@/lib/customer-view";
import type { PortalContext } from "@/lib/db";
import { PortalError } from "@/lib/http";
import { getOrder } from "@/lib/orders";
import { solidPng } from "@/lib/photos";
import { adminSession, seededPortal, sessionCookie } from "@/tests/helpers";

const KEY = "bot-upload-test-key-0123456789";

let ctx: PortalContext;

beforeAll(async () => {
  process.env.BOT_UPLOAD_KEY = KEY;
  ctx = await seededPortal();
});

async function pdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 48, y: 720, size: 12, font, maxWidth: 500 });
  return doc.save();
}

function form(fields: { filename: string; bytes: Uint8Array; loadNumber?: string; salesOrderNumber?: string; docType?: string }) {
  const body = new FormData();
  body.set("file", new File([Buffer.from(fields.bytes)], fields.filename, { type: "text/plain" }));
  if (fields.loadNumber !== "") body.set("loadNumber", fields.loadNumber ?? "900196-1");
  if (fields.salesOrderNumber) body.set("salesOrderNumber", fields.salesOrderNumber);
  if (fields.docType !== undefined) body.set("doc_type", fields.docType);
  return body;
}

function post(body: BodyInit, init?: { key?: string | null; ip?: string; contentType?: string }) {
  const headers = new Headers();
  if (init?.key !== null) headers.set("authorization", `Bearer ${init?.key ?? KEY}`);
  headers.set("x-forwarded-for", init?.ip ?? "203.0.113.10");
  if (init?.contentType) headers.set("content-type", init.contentType);
  return new Request("http://portal.test/api/integrations/documents", { method: "POST", headers, body });
}

async function loadId(loadNumber: string): Promise<string> {
  const row = (await ctx.db.prepare(`SELECT id FROM loads WHERE load_number = ?`).get(loadNumber)) as { id: string };
  return row.id;
}

describe("bot document upload", () => {
  it("accepts only a long bearer key and does not read, list, or delete", async () => {
    const handlers = integrationRoute as Record<string, unknown>;
    expect(handlers.POST).toEqual(expect.any(Function));
    expect(handlers.GET).toBeUndefined();
    expect(handlers.PUT).toBeUndefined();
    expect(handlers.DELETE).toBeUndefined();

    const bytes = new TextEncoder().encode("Bill of lading for four crates from Sheridan to Oklahoma City.");
    const missing = await POST(post(form({ filename: "ignored.txt", bytes }), { key: null, ip: "203.0.113.21" }));
    expect(missing.status).toBe(401);

    const wrong = await POST(
      post(form({ filename: "ignored.txt", bytes }), { key: "bot-upload-test-key-0123456780", ip: "203.0.113.22" }),
    );
    expect(wrong.status).toBe(401);

    const cookie = await sessionCookie(adminSession());
    const sessionOnly = await POST(
      new Request("http://portal.test/api/integrations/documents", {
        method: "POST",
        headers: { cookie, "x-forwarded-for": "203.0.113.23" },
        body: form({ filename: "ignored.txt", bytes }),
      }),
    );
    expect(sessionOnly.status).toBe(401);

    const previous = process.env.BOT_UPLOAD_KEY;
    process.env.BOT_UPLOAD_KEY = "short-key";
    try {
      const short = await POST(post(form({ filename: "ignored.txt", bytes }), { key: "short-key", ip: "203.0.113.24" }));
      expect(short.status).toBe(401);
    } finally {
      process.env.BOT_UPLOAD_KEY = previous;
    }
  });

  it("finds the load by Select load number and rejects a bad number", async () => {
    expect(parseBotDocType("")).toBe("bol");
    expect(parseBotDocType("POD")).toBe("pod");
    expect(() => assertOneLoad([], "458934-1")).toThrow(PortalError);
    try {
      assertOneLoad([], "458934-1");
    } catch (error) {
      expect(error).toBeInstanceOf(PortalError);
      expect((error as PortalError).status).toBe(404);
    }
    try {
      assertOneLoad([{ id: "a" }, { id: "b" }], "458934-1");
    } catch (error) {
      expect((error as PortalError).status).toBe(409);
      expect((error as PortalError).message).toMatch(/more than one load/i);
    }

    const missing = await POST(
      post(form({ filename: "bol.txt", bytes: new TextEncoder().encode("Bill of lading for a missing Select load number."), loadNumber: "458934-1" }), {
        ip: "203.0.113.25",
      }),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: expect.stringMatching(/458934-1/) });

    const malformed = await POST(
      post(form({ filename: "bol.txt", bytes: new TextEncoder().encode("Bill of lading with a made up number."), loadNumber: "LOAD-1" }), {
        ip: "203.0.113.26",
      }),
    );
    expect(malformed.status).toBe(400);

    const badType = await POST(
      post(
        form({
          filename: "bol.txt",
          bytes: new TextEncoder().encode("Bill of lading with an unknown document type."),
          docType: "invoice",
        }),
        { ip: "203.0.113.27" },
      ),
    );
    expect(badType.status).toBe(400);

    const json = await POST(
      post(JSON.stringify({ loadNumber: "900196-1" }), {
        ip: "203.0.113.28",
        contentType: "application/json",
      }),
    );
    expect(json.status).toBe(415);
  });

  it("screens like a normal upload, records Select bot, and ignores a duplicate hash", async () => {
    const id = await loadId("900196-1");
    const before = Number(
      (await ctx.db.prepare(`SELECT COUNT(*) AS n FROM customer_documents WHERE load_id = ?`).get(id))?.n ?? 0,
    );
    const bol = await pdf("Bill of lading. Shipper EMIT Technologies, Sheridan WY. Receiver Enchanted Rock.");
    const created = await POST(post(form({ filename: "emailed-bol.txt", bytes: bol, docType: "bol" }), { ip: "203.0.113.30" }));
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(Object.keys(body).sort()).toEqual(
      ["docType", "duplicate", "heldForReview", "loadNumber", "released", "salesOrderNumber", "sha256", "uploadedBy"].sort(),
    );
    expect(body).toMatchObject({
      loadNumber: "900196-1",
      salesOrderNumber: "SO2196",
      docType: "bol",
      uploadedBy: BOT_UPLOADER,
      duplicate: false,
      released: 1,
      heldForReview: 0,
    });
    const stored = await ctx.db
      .prepare(`SELECT kind, uploaded_by FROM customer_documents WHERE load_id = ? AND filename = ?`)
      .get(id, "emailed-bol.txt");
    expect(stored).toMatchObject({ kind: "bol", uploaded_by: BOT_UPLOADER });

    const againBody = new FormData();
    againBody.set("file", new File([Buffer.from(bol)], "emailed-bol-retry.txt"));
    againBody.set("load_number", "900196-1");
    againBody.set("docType", "photo");
    const again = await POST(post(againBody, { ip: "203.0.113.30" }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true, docType: "bol", sha256: body.sha256, uploadedBy: BOT_UPLOADER });
    const after = Number(
      (await ctx.db.prepare(`SELECT COUNT(*) AS n FROM customer_documents WHERE load_id = ?`).get(id))?.n ?? 0,
    );
    expect(after).toBe(before + 1);

    const other = await POST(
      post(form({ filename: "same-bytes.txt", bytes: bol, loadNumber: "900181-1" }), { ip: "203.0.113.31" }),
    );
    expect(other.status).toBe(201);
    expect((await other.json()).duplicate).toBe(false);

    const rate = await pdf("This rate confirmation lists carrier pay for the Sheridan load today.");
    const held = await POST(post(form({ filename: "ratecon.txt", bytes: rate }), { ip: "203.0.113.32" }));
    expect(held.status).toBe(201);
    expect(await held.json()).toMatchObject({ released: 0, heldForReview: 1, uploadedBy: BOT_UPLOADER });
    const quarantined = await ctx.db
      .prepare(
        `SELECT screen_result, review_status, uploaded_by FROM internal_documents WHERE load_id = ? AND filename = ?`,
      )
      .get(id, "ratecon.txt");
    expect(quarantined).toMatchObject({ screen_result: "block", review_status: "pending", uploaded_by: BOT_UPLOADER });
    expect(
      await ctx.db.prepare(`SELECT id FROM customer_documents WHERE load_id = ? AND filename = ?`).get(id, "ratecon.txt"),
    ).toBeUndefined();

    const order = await getOrder(ctx, id);
    const emitView = presentCustomerOrder(order!, "customer");
    const emitAdminView = presentCustomerOrder(order!, "emit_admin");
    expect(JSON.stringify(emitView)).not.toMatch(/pendingReviewCount|rate confirmation|carrier pay/);
    expect(JSON.stringify(emitAdminView)).not.toMatch(/pendingReviewCount/);
    expect(emitView.documents.some((doc) => doc.filename === "ratecon.txt")).toBe(false);
    expect(presentCustomerOrder(order!, "admin").pendingReviewCount).toBeGreaterThan(0);

    const photo = await POST(
      post(form({ filename: "dock.png", bytes: solidPng(4, 8, 12), docType: "photo", loadNumber: "900181-1" }), {
        ip: "203.0.113.33",
      }),
    );
    expect(photo.status).toBe(201);
    expect(await photo.json()).toMatchObject({ docType: "photo", released: 0, heldForReview: 1 });
    const photoRow = await ctx.db
      .prepare(`SELECT screen_result, uploaded_by FROM internal_documents WHERE filename = ?`)
      .get("dock.png");
    expect(photoRow).toMatchObject({ screen_result: "uncertain", uploaded_by: BOT_UPLOADER });

    const pod = await pdf("Proof of delivery. Receiver signed for four crates in Oklahoma City today.");
    const podResponse = await POST(
      post(form({ filename: "pod.txt", bytes: pod, docType: "pod", loadNumber: "900182-1" }), { ip: "203.0.113.34" }),
    );
    expect(podResponse.status).toBe(201);
    expect(await podResponse.json()).toMatchObject({ docType: "pod", released: 1, heldForReview: 0 });
    const podLoad = await loadId("900182-1");
    const podRow = await ctx.db
      .prepare(`SELECT kind, uploaded_by FROM customer_documents WHERE load_id = ? AND filename = ?`)
      .get(podLoad, "pod.txt");
    expect(podRow).toMatchObject({ kind: "attachment", uploaded_by: BOT_UPLOADER });
  });

  it("accepts a sales order number, and rejects text and a mismatched pair", async () => {
    const byOrder = await pdf("Bill of lading filed from the sales order number alone, Sheridan to Oklahoma City.");
    const created = await POST(
      post(form({ filename: "by-so.pdf", bytes: byOrder, loadNumber: "", salesOrderNumber: "SO2196" }), { ip: "203.0.113.40" }),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      loadNumber: "900196-1",
      salesOrderNumber: "SO2196",
      docType: "bol",
      duplicate: false,
    });

    const text = await POST(
      post(
        form({
          filename: "notes.txt",
          bytes: new TextEncoder().encode("Bill of lading written as plain text instead of a PDF."),
          loadNumber: "900181-1",
        }),
        { ip: "203.0.113.41" },
      ),
    );
    expect(text.status).toBe(415);

    const mismatch = await POST(
      post(
        form({
          filename: "mismatch.pdf",
          bytes: await pdf("Bill of lading whose load number and sales order do not match."),
          loadNumber: "900196-1",
          salesOrderNumber: "SO2981",
        }),
        { ip: "203.0.113.42" },
      ),
    );
    expect(mismatch.status).toBe(409);
  });

  it("rate limits uploads per IP, including failed keys", async () => {
    const ip = "203.0.113.50";
    const now = ctx.now().toISOString();
    const insert = ctx.db.prepare(`INSERT INTO login_attempts (id, bucket, created_at) VALUES (?, ?, ?)`);
    for (let index = 0; index < BOT_UPLOAD_LIMIT - 1; index += 1) {
      await insert.run(randomUUID(), `bot-upload:${ip}`, now);
    }
    const bytes = new TextEncoder().encode("Bill of lading used only to probe the rate limit window.");
    const lastFailure = await POST(post(form({ filename: "limit.txt", bytes }), { key: "wrong-key-not-the-real-one", ip }));
    expect(lastFailure.status).toBe(401);
    const blocked = await POST(post(form({ filename: "limit.txt", bytes }), { ip }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(await blocked.json()).toMatchObject({ error: expect.stringMatching(/too many uploads/i) });
  });
});
