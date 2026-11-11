import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as inboundLog } from "@/app/api/admin/inbound-email/route";
import { POST as reviewDecision } from "@/app/api/admin/review/[id]/route";
import { POST as inboundEmail } from "@/app/api/integrations/inbound-email/route";
import { GET as readDocument } from "@/app/api/documents/[id]/route";
import { GET as receiverRoute } from "@/app/api/r/[token]/route";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { listCustomerDocuments, listReviewQueue } from "@/lib/documents";
import {
  loadNumbersIn,
  logSubject,
  matchInboundOrder,
  receiveInboundEmail,
  recognizableBolText,
  salesOrderTokens,
  senderAllowed,
  verifyInboundWebhook,
} from "@/lib/inbound-email";
import type { PortalContext } from "@/lib/db";
import type { CustomerOrder } from "@/lib/types";
import { adminSession, customerSession, seededPortal, sessionCookie } from "./helpers";

const SECRET_RAW = Buffer.from("inbound-email-test-secret-key!!");
const SECRET = `whsec_${SECRET_RAW.toString("base64")}`;
const SENTINEL = "PAY-SENTINEL-424242";

let ctx: PortalContext;
let customerCookie = "";
let adminCookie = "";

beforeAll(async () => {
  process.env.INBOUND_EMAIL_WEBHOOK_SECRET = SECRET;
  process.env.INBOUND_EMAIL_ALLOWED_SENDERS = "goselect.com,notifications@sam.example";
  process.env.RESEND_API_KEY = "re_test_inbound_key_0123456789";
  ctx = await seededPortal();
  customerCookie = await sessionCookie(customerSession());
  adminCookie = await sessionCookie(adminSession());
});

afterAll(() => {
  delete process.env.INBOUND_EMAIL_WEBHOOK_SECRET;
  delete process.env.INBOUND_EMAIL_ALLOWED_SENDERS;
  delete process.env.RESEND_API_KEY;
  vi.restoreAllMocks();
});

function headers(cookie = "", json = false): HeadersInit {
  return {
    cookie,
    host: "portal.test",
    origin: "http://portal.test",
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function sign(payload: string, timestamp = String(Math.floor(Date.now() / 1000)), id = "msg_test_inbound"): string {
  const mac = createHmac("sha256", SECRET_RAW).update(`${id}.${timestamp}.${payload}`).digest("base64");
  return `v1,${mac}`;
}

async function pdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 48, y: 700, size: 12, font, maxWidth: 520 });
  return doc.save();
}

async function makeLoad(salesOrderNumber: string, company = "Kodiak"): Promise<CustomerOrder> {
  const response = await createOrderRoute(
    new Request("http://portal.test/api/orders", {
      method: "POST",
      headers: headers(customerCookie, true),
      body: JSON.stringify({
        salesOrderNumber,
        origin: { company: "EMIT", address1: "2437 Allen Avenue", city: "Sheridan", state: "WY", postalCode: "82801" },
        destination: { company, address1: "1 Dock", city: "Houston", state: "TX", postalCode: "77002" },
        shipDate: "2026-11-24",
      }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()).order as CustomerOrder;
}

describe("inbound mail matching and allowlist", () => {
  it("reads load numbers and sales orders, and ignores dates and the S0 typo", async () => {
    expect(loadNumbersIn("Ship date 2026-11-09. Select Transport Bill of Lading - Load #467862-1")).toEqual(["467862-1"]);
    expect(loadNumbersIn("2026-11-09")).toEqual([]);
    expect(loadNumbersIn("BOL #: 900196 - 1", "labeled")).toEqual(["900196-1"]);
    expect(salesOrderTokens("Pickup #: SO-2582, S0-2583 and so2584")).toEqual(["SO-2582", "SO-2583", "SO-2584"]);
    expect(recognizableBolText("BILL OF LADING\nBOL #: 461169-1\nShipper EMIT Technologies, Sheridan WY 82801")).toBe(true);
    expect(recognizableBolText(`RATE CONFIRMATION\nCarrier pay $8,765.43\n${SENTINEL}\nBOL #: 461169-1\nBILL OF LADING`)).toBe(false);
    expect(logSubject(`Rate confirmation carrier pay $8,765.43 ${SENTINEL}`)).toBe("Bill of lading email");
    expect(logSubject("Select Transport Bill of Lading - Load #467862-1")).toContain("467862-1");

    expect(senderAllowed("SAM <docs@goselect.com>")).toBe(true);
    expect(senderAllowed("notifications@sam.example")).toBe(true);
    expect(senderAllowed("bot@mail.goselect.com")).toBe(true);
    expect(senderAllowed("stranger@example.com")).toBe(false);
    expect(senderAllowed("not-an-email")).toBe(false);

    const byNumber = await matchInboundOrder(ctx, {
      subject: "Load #900196-1",
      filename: "notes.pdf",
      text: "Pickup #: SO-2582",
    });
    expect(byNumber).toMatchObject({ status: "matched", load: { loadNumber: "900196-1" } });

    await ctx.db
      .prepare(`UPDATE loads SET sales_order_number = ?, sales_orders_json = ? WHERE load_number = ?`)
      .run("SO-2582, SO-2583", JSON.stringify([{ number: "SO-2582" }, { number: "SO-2583" }]), "900181-1");
    const bySo = await matchInboundOrder(ctx, {
      subject: "Select Transport Bill of Lading",
      filename: "bill.pdf",
      text: "Pickup #: SO-2582, S0-2583",
    });
    expect(bySo).toMatchObject({ status: "matched", load: { loadNumber: "900181-1" } });

    await ctx.db.prepare(`UPDATE loads SET sales_order_number = ? WHERE load_number = ?`).run("SO-7771", "900182-1");
    await ctx.db.prepare(`UPDATE loads SET sales_order_number = ? WHERE load_number = ?`).run("SO-7772", "900183-1");
    const ambiguous = await matchInboundOrder(ctx, {
      subject: "Bill of lading",
      filename: "bill.pdf",
      text: "SO-7771, S0-7772",
    });
    expect(ambiguous.status).toBe("ambiguous");

    const missing = await matchInboundOrder(ctx, {
      subject: "Load #467862-1",
      filename: "bill.pdf",
      text: "No sales order on this page at all.",
    });
    expect(missing.status).toBe("unmatched");
  });
});

describe("inbound mail filing", () => {
  it("files a recognizable BOL, holds a rate con and an unclear image, and dedupes by hash", async () => {
    const order = await makeLoad("SO-INBOUND-BOL", "Enchanted Rock LLC");
    await ctx.db.prepare(`UPDATE loads SET load_number = ? WHERE id = ?`).run("461169-1", order.id);
    const bol = new Uint8Array(readFileSync(path.join(process.cwd(), "tests/fixtures", "bol_461169-1.pdf")));
    const filed = await receiveInboundEmail(ctx, {
      providerId: "email-bol-461169",
      from: "SAM <docs@goselect.com>",
      subject: "Select Transport Bill of Lading - Load #461169-1",
      attachments: [{ filename: "Bill of Lading for Load #461169-1.pdf", contentType: "application/pdf", bytes: bol }],
    });
    expect(filed).toMatchObject({ outcome: "released", duplicate: false, loadNumber: "461169-1", released: 1, heldForReview: 0 });
    const visible = await listCustomerDocuments(ctx, order.id);
    expect(visible.some((doc) => doc.kind === "bol" && doc.filename.includes("461169-1"))).toBe(true);
    const upload = await ctx.db.prepare(`SELECT doc_type FROM document_uploads WHERE load_id = ?`).get(order.id);
    expect(upload).toMatchObject({ doc_type: "bol" });

    const again = await receiveInboundEmail(ctx, {
      providerId: "email-bol-461169-retry",
      from: "docs@goselect.com",
      subject: "Select Transport Bill of Lading - Load #461169-1",
      attachments: [{ filename: "Bill of Lading for Load #461169-1.pdf", contentType: "application/pdf", bytes: bol }],
    });
    expect(again.outcome).toBe("duplicate");
    expect(await listCustomerDocuments(ctx, order.id)).toHaveLength(visible.length);

    const sameMessage = await receiveInboundEmail(ctx, {
      providerId: "email-bol-461169",
      from: "docs@goselect.com",
      subject: "Select Transport Bill of Lading - Load #461169-1",
      attachments: [{ filename: "Bill of Lading for Load #461169-1.pdf", contentType: "application/pdf", bytes: bol }],
    });
    expect(sameMessage.duplicate).toBe(true);

    const rateBytes = await pdf(
      `RATE CONFIRMATION\nCarrier pay $8,765.43\n${SENTINEL}\nCarrier BLACKHAWK HAULING LLC\nThis page is a carrier rate confirmation and must not be released to EMIT.`,
    );
    const held = await receiveInboundEmail(ctx, {
      providerId: "email-rate-900196",
      from: "docs@goselect.com",
      subject: "Select Transport Bill of Lading - Load #900196-1",
      attachments: [{ filename: "rate-confirmation.pdf", contentType: "application/pdf", bytes: rateBytes }],
    });
    expect(held.released).toBe(0);
    expect(held.heldForReview).toBeGreaterThan(0);
    expect(held.outcome).toBe("held");
    const rateLoad = (await ctx.db.prepare(`SELECT id FROM loads WHERE load_number = ?`).get("900196-1")) as { id: string };
    const rateDocs = await listCustomerDocuments(ctx, rateLoad.id);
    expect(rateDocs.some((doc) => doc.filename.includes("rate"))).toBe(false);
    const rateUpload = await ctx.db
      .prepare(`SELECT doc_type FROM document_uploads WHERE load_id = ? AND filename LIKE '%rate%'`)
      .get(rateLoad.id);
    expect(rateUpload).toMatchObject({ doc_type: "review" });
    const queue = await listReviewQueue(ctx);
    const rateItem = queue.find((item) => item.filename.includes("rate"));
    expect(rateItem?.screenResult).toBe("block");
    expect(await readDocument(new Request("http://portal.test/api/documents/" + rateItem!.id, { headers: headers(customerCookie) }), {
      params: Promise.resolve({ id: rateItem!.id }),
    })).toMatchObject({ status: 404 });

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const image = await receiveInboundEmail(ctx, {
      providerId: "email-png-900181",
      from: "docs@goselect.com",
      subject: "Load #900181-1 photo",
      attachments: [{ filename: "dock.png", contentType: "image/png", bytes: new Uint8Array(png) }],
    });
    expect(image.released).toBe(0);
    expect(image.outcome).toBe("held");
    const imageLoad = (await ctx.db.prepare(`SELECT id FROM loads WHERE load_number = ?`).get("900181-1")) as { id: string };
    expect((await listCustomerDocuments(ctx, imageLoad.id)).some((doc) => doc.filename.includes("dock"))).toBe(false);

    const unmatched = await receiveInboundEmail(ctx, {
      providerId: "email-unmatched-1",
      from: "notifications@sam.example",
      subject: "Select Transport Bill of Lading",
      attachments: [
        {
          filename: "unknown-bol.pdf",
          contentType: "application/pdf",
          bytes: await pdf(`RATE CONFIRMATION\nCarrier pay $8,765.43\n${SENTINEL}\nNo load number and no sales order on this page.`),
        },
      ],
    });
    expect(unmatched.outcome).toBe("unmatched");
    expect(unmatched.released).toBe(0);
    const inboundItem = (await listReviewQueue(ctx)).find((item) => item.filename.includes("unknown-bol"));
    expect(inboundItem?.source).toBe("inbound");
    expect(inboundItem?.textExcerpt).toBeNull();
    const approved = await reviewDecision(
      new Request(`http://portal.test/api/admin/review/${inboundItem!.id}`, {
        method: "POST",
        headers: headers(adminCookie, true),
        body: JSON.stringify({ action: "approve" }),
      }),
      { params: Promise.resolve({ id: inboundItem!.id }) },
    );
    expect(approved.status).toBe(409);

    const rejected = await receiveInboundEmail(ctx, {
      providerId: "email-stranger-1",
      from: "Stranger <stranger@example.com>",
      subject: `Load #461169-1 ${SENTINEL} carrier pay $8,765.43`,
      attachments: [{ filename: "Bill of Lading.pdf", contentType: "application/pdf", bytes: bol }],
    });
    expect(rejected.outcome).toBe("rejected_sender");
    expect(await listCustomerDocuments(ctx, order.id)).toHaveLength(visible.length);

    const log = await ctx.db.prepare(`SELECT sender, subject, outcome, detail FROM inbound_emails`).all();
    const logText = JSON.stringify(log);
    expect(logText).not.toContain(SENTINEL);
    expect(logText).not.toContain("8,765.43");
    expect(logText).not.toContain("8765.43");
    expect(log.some((row) => row.outcome === "rejected_sender" && row.sender === "stranger@example.com")).toBe(true);

    const customerView = await getOrderRoute(new Request(`http://portal.test/api/orders/${order.id}`, { headers: headers(customerCookie) }), {
      params: Promise.resolve({ id: order.id }),
    });
    expect(JSON.stringify(await customerView.json())).not.toContain(SENTINEL);
    const rateView = await getOrderRoute(new Request(`http://portal.test/api/orders/${rateLoad.id}`, { headers: headers(customerCookie) }), {
      params: Promise.resolve({ id: rateLoad.id }),
    });
    expect(JSON.stringify(await rateView.json())).not.toContain(SENTINEL);

    const token = (await ctx.db.prepare(`SELECT access_token FROM receivers LIMIT 1`).get()) as { access_token: string };
    const receiver = await receiverRoute(new Request("http://portal.test/api/r/" + token.access_token), {
      params: Promise.resolve({ token: token.access_token }),
    });
    const receiverText = JSON.stringify(await receiver.json());
    expect(receiverText).not.toContain(SENTINEL);
    expect(receiverText).not.toContain("461169-1.pdf");
    expect(receiverText).not.toContain("unknown-bol");
    expect(receiverText).not.toContain("rate-confirmation");

    const denied = await inboundLog(new Request("http://portal.test/api/admin/inbound-email", { headers: headers(customerCookie) }));
    expect(denied.status).toBe(403);
    const allowed = await inboundLog(new Request("http://portal.test/api/admin/inbound-email", { headers: headers(adminCookie) }));
    expect(allowed.status).toBe(200);
    const emails = (await allowed.json()).emails as Array<{ subject: string; detail: string; outcome: string }>;
    expect(JSON.stringify(emails)).not.toContain(SENTINEL);
    expect(emails.some((email) => email.outcome === "released")).toBe(true);
  }, 180000);
});

describe("inbound webhook signature", () => {
  it("rejects unsigned, stale, and tampered requests and accepts a signed message", async () => {
    const unsigned = await inboundEmail(
      new Request("http://portal.test/api/integrations/inbound-email", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.50" },
        body: JSON.stringify({ type: "email.received" }),
      }),
    );
    expect(unsigned.status).toBe(401);

    const payload = JSON.stringify({ type: "email.received", data: { email_id: "email-signed-1", from: "docs@goselect.com", subject: "Hi" } });
    const stale = await inboundEmail(
      new Request("http://portal.test/api/integrations/inbound-email", {
        method: "POST",
        headers: {
          "x-forwarded-for": "203.0.113.51",
          "svix-id": "msg_stale",
          "svix-timestamp": "1000",
          "svix-signature": sign(payload, "1000", "msg_stale"),
        },
        body: payload,
      }),
    );
    expect(stale.status).toBe(401);

    const tampered = await inboundEmail(
      new Request("http://portal.test/api/integrations/inbound-email", {
        method: "POST",
        headers: {
          "x-forwarded-for": "203.0.113.52",
          "svix-id": "msg_tamper",
          "svix-timestamp": String(Math.floor(Date.now() / 1000)),
          "svix-signature": sign(payload, String(Math.floor(Date.now() / 1000)), "msg_tamper"),
        },
        body: payload + " ",
      }),
    );
    expect(tampered.status).toBe(401);

    const previous = process.env.INBOUND_EMAIL_WEBHOOK_SECRET;
    process.env.INBOUND_EMAIL_WEBHOOK_SECRET = "";
    try {
      const missing = await inboundEmail(
        new Request("http://portal.test/api/integrations/inbound-email", {
          method: "POST",
          headers: { "x-forwarded-for": "203.0.113.53", "svix-id": "msg_x", "svix-timestamp": "1", "svix-signature": "v1,aa" },
          body: payload,
        }),
      );
      expect(missing.status).toBe(401);
    } finally {
      process.env.INBOUND_EMAIL_WEBHOOK_SECRET = previous;
    }

    expect(verifyInboundWebhook({ payload, headers: { id: null, timestamp: null, signature: null }, secret: SECRET })).toBe(false);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/attachments")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "att-bol-461169",
                filename: "Bill of Lading for Load #461169-1.pdf",
                content_type: "application/pdf",
                content_disposition: "attachment",
                download_url: "https://inbound-cdn.resend.com/bol.pdf",
                size: 1200,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.startsWith("https://inbound-cdn.resend.com/")) {
        const bytes = readFileSync(path.join(process.cwd(), "tests/fixtures", "bol_461169-1.pdf"));
        return new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } });
      }
      return new Response("no", { status: 404 });
    });
    const id = "msg_signed_ok";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signedBody = JSON.stringify({
      type: "email.received",
      data: {
        email_id: `email-${randomUUID().slice(0, 8)}`,
        from: "docs@goselect.com",
        subject: "Select Transport Bill of Lading - Load #461169-1",
        attachments: [{ id: "att-bol-461169", filename: "Bill of Lading for Load #461169-1.pdf" }],
      },
    });
    const accepted = await inboundEmail(
      new Request("http://portal.test/api/integrations/inbound-email", {
        method: "POST",
        headers: {
          "x-forwarded-for": "203.0.113.54",
          "svix-id": id,
          "svix-timestamp": timestamp,
          "svix-signature": `v1,not-the-signature ${sign(signedBody, timestamp, id)}`,
        },
        body: signedBody,
      }),
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, duplicate: true, outcome: "duplicate" });
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();

    const ignoredFetch = vi.spyOn(globalThis, "fetch");
    const badId = "msg_bad_sig";
    const badTime = String(Math.floor(Date.now() / 1000));
    const rejectedCall = await inboundEmail(
      new Request("http://portal.test/api/integrations/inbound-email", {
        method: "POST",
        headers: {
          "x-forwarded-for": "203.0.113.55",
          "svix-id": badId,
          "svix-timestamp": badTime,
          "svix-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
        body: signedBody,
      }),
    );
    expect(rejectedCall.status).toBe(401);
    expect(ignoredFetch).not.toHaveBeenCalled();
    ignoredFetch.mockRestore();
  }, 120000);
});
