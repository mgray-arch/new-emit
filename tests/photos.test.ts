import { beforeAll, describe, expect, it } from "vitest";
import { GET as photoBytes } from "@/app/api/carrier-photos/[id]/route";
import { POST as ingestRoute } from "@/app/api/ingest/carrier-photos/route";
import { GET as listPhotos } from "@/app/api/orders/[id]/photos/route";
import { GET as receiverPhoto } from "@/app/api/r/[token]/photos/[photoId]/route";
import { GET as receiverPortal } from "@/app/api/r/[token]/route";
import { GET as track } from "@/app/api/track/[token]/route";
import type { PortalContext } from "@/lib/db";
import { ingestCarrierPhoto, photoHoldReason, sniffImage, solidPng } from "@/lib/photos";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "@/tests/helpers";
import type { Session } from "@/lib/types";

const TOKEN = "test-ingest-token-value";

let ctx: PortalContext;

beforeAll(async () => {
  process.env.CARRIER_PHOTO_INGEST_TOKEN = TOKEN;
  ctx = await seededPortal();
});

function enchantedToken(): string {
  const row = ctx.db.prepare(`SELECT access_token FROM receivers WHERE company = ?`).get("Enchanted Rock LLC") as {
    access_token: string;
  };
  return row.access_token;
}

function loadId(salesOrder: string): string {
  const row = ctx.db.prepare(`SELECT id FROM loads WHERE sales_order_number = ?`).get(salesOrder) as { id: string };
  return row.id;
}

async function asSession(session: Session, url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", await sessionCookie(session));
  return new Request(url, { ...init, headers });
}

describe("carrier photos", () => {
  it("accepts images, rejects documents, and dedupes by hash", async () => {
    const png = solidPng(10, 20, 30);
    expect(sniffImage(png)).toBe("png");
    expect(sniffImage(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe("pdf");

    const first = await ingestRoute(
      new Request("http://portal.test/api/ingest/carrier-photos", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          loadNumber: "900196-1",
          source: "gmail:msg-dock",
          receivedAt: "2026-10-14T17:00:00Z",
          filename: "yard.png",
          contentType: "image/png",
          subject: "Yard check",
          dataBase64: Buffer.from(png).toString("base64"),
        }),
      }),
    );
    expect(first.status).toBe(201);
    const created = await first.json();
    expect(created.duplicate).toBe(false);
    expect(created.visibleToCustomer).toBe(true);
    expect(created.loadNumber).toBe("900196-1");

    const again = await ingestRoute(
      new Request("http://portal.test/api/ingest/carrier-photos", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          loadNumber: "900196-1",
          source: "gmail:msg-dock-retry",
          receivedAt: "2026-10-14T17:05:00Z",
          filename: "yard-again.png",
          contentType: "image/png",
          dataBase64: Buffer.from(png).toString("base64"),
        }),
      }),
    );
    expect(again.status).toBe(200);
    const duplicate = await again.json();
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.id).toBe(created.id);

    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF");
    const rejected = await ingestRoute(
      new Request("http://portal.test/api/ingest/carrier-photos", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          loadNumber: "900196-1",
          source: "gmail",
          receivedAt: "2026-10-14T17:06:00Z",
          filename: "photo.jpg",
          contentType: "image/jpeg",
          dataBase64: Buffer.from(pdf).toString("base64"),
        }),
      }),
    );
    expect(rejected.status).toBe(415);
    expect(await rejected.json()).toMatchObject({ error: expect.stringMatching(/PDF/i) });

    const heic = Buffer.alloc(24);
    heic.writeUInt32BE(24, 0);
    heic.write("ftyp", 4, 4, "ascii");
    heic.write("heic", 8, 4, "ascii");
    const webp = Buffer.alloc(16);
    webp.write("RIFF", 0);
    webp.write("WEBP", 8);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    for (const [filename, contentType, bytes] of [
      ["pic.heic", "image/heic", heic],
      ["pic.webp", "image/webp", webp],
      ["pic.jpg", "image/jpeg", jpeg],
    ] as const) {
      const response = await ingestRoute(
        new Request("http://portal.test/api/ingest/carrier-photos", {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({
            loadNumber: "900203-1",
            source: "gmail",
            receivedAt: "2026-10-14T17:07:00Z",
            filename,
            contentType,
            dataBase64: Buffer.from(bytes).toString("base64"),
          }),
        }),
      );
      expect(response.status, filename).toBe(201);
    }
  });

  it("hides rate-confirmation images from EMIT and receivers, and keeps them for admins", async () => {
    const heldBytes = solidPng(1, 1, 1, "RATE CONFIRMATION carrier pay $8,765.43");
    expect(photoHoldReason({ filename: "note.png", source: "gmail", subject: "hello", bytes: heldBytes })).toMatch(/rate confirmation/i);

    const response = await ingestRoute(
      new Request("http://portal.test/api/ingest/carrier-photos", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          loadNumber: "900196-1",
          source: "gmail:msg-rate",
          receivedAt: "2026-10-14T17:08:00Z",
          filename: "ratecon.png",
          contentType: "image/png",
          subject: "Rate confirmation attached",
          dataBase64: Buffer.from(heldBytes).toString("base64"),
        }),
      }),
    );
    expect(response.status).toBe(201);
    const held = await response.json();
    expect(held.visibleToCustomer).toBe(false);
    expect(held.heldReason).toMatch(/rate confirmation/i);
    expectNoSecrets(held);

    const so2196 = loadId("SO2196");
    const customerList = await listPhotos(await asSession(customerSession(), `http://portal.test/api/orders/${so2196}/photos`), {
      params: Promise.resolve({ id: so2196 }),
    });
    expect(customerList.status).toBe(200);
    const customerBody = await customerList.json();
    expectNoSecrets(customerBody);
    const names = customerBody.photos.map((photo: { filename: string }) => photo.filename);
    expect(names).toContain("dock.png");
    expect(names).not.toContain("rate-confirmation.png");
    expect(names).not.toContain("ratecon.png");
    expect(JSON.stringify(customerBody)).not.toMatch(/rate confirmation/i);

    const hidden = await photoBytes(await asSession(customerSession(), `http://portal.test/api/carrier-photos/${held.id}`), {
      params: Promise.resolve({ id: held.id }),
    });
    expect(hidden.status).toBe(404);

    const adminList = await listPhotos(await asSession(adminSession(), `http://portal.test/api/orders/${so2196}/photos`), {
      params: Promise.resolve({ id: so2196 }),
    });
    const adminBody = await adminList.json();
    const heldRow = adminBody.photos.find((photo: { id: string }) => photo.id === held.id);
    expect(heldRow.held).toBe(true);
    expect(heldRow.holdReason).toMatch(/rate confirmation/i);
    const adminBytes = await photoBytes(await asSession(adminSession(), `http://portal.test/api/carrier-photos/${held.id}`), {
      params: Promise.resolve({ id: held.id }),
    });
    expect(adminBytes.status).toBe(200);
    expect(adminBytes.headers.get("content-type")).toBe("image/png");

    const docs = ctx.db.prepare(`SELECT COUNT(*) AS n FROM customer_documents`).get() as { n: number };
    const before = docs.n;
    ingestCarrierPhoto(ctx, {
      loadNumber: "900196-1",
      filename: "extra.png",
      bytes: solidPng(4, 5, 6),
      source: "gmail",
      receivedAt: "2026-10-14T17:09:00Z",
    });
    const after = ctx.db.prepare(`SELECT COUNT(*) AS n FROM customer_documents`).get() as { n: number };
    expect(after.n).toBe(before);
  });

  it("shows a receiver link only photos on their own loads, and requires the ingest token or an admin", async () => {
    const so2196 = loadId("SO2196");
    const token = enchantedToken();
    const portal = await receiverPortal(new Request(`http://portal.test/api/r/${token}`), {
      params: Promise.resolve({ token }),
    });
    const receiverBody = await portal.json();
    const own = receiverBody.loads.find((load: { salesOrderNumber: string }) => load.salesOrderNumber === "SO4555");
    expect(own.photos.map((photo: { filename: string }) => photo.filename)).toContain("cypress-arrival.png");
    expect(receiverBody.loads.some((load: { salesOrderNumber: string }) => load.salesOrderNumber === "SO2196")).toBe(false);
    expect(receiverBody.loads[0].customerCost).toBeUndefined();
    expectNoSecrets(receiverBody);

    const locked = await listPhotos(new Request(`http://portal.test/api/orders/${so2196}/photos`), {
      params: Promise.resolve({ id: so2196 }),
    });
    expect(locked.status).toBe(401);

    const dock = ctx.db.prepare(`SELECT id FROM carrier_photos WHERE filename = ?`).get("dock.png") as { id: string };
    const stolen = await receiverPhoto(new Request(`http://portal.test/api/r/${token}/photos/${dock.id}`), {
      params: Promise.resolve({ token, photoId: dock.id }),
    });
    expect(stolen.status).toBe(404);

    const held = ctx.db.prepare(`SELECT id FROM carrier_photos WHERE filename = ?`).get("rate-confirmation.png") as { id: string };
    const hidden = await receiverPhoto(new Request(`http://portal.test/api/r/${token}/photos/${held.id}`), {
      params: Promise.resolve({ token, photoId: held.id }),
    });
    expect(hidden.status).toBe(404);

    const cypress = ctx.db.prepare(`SELECT id FROM carrier_photos WHERE filename = ?`).get("cypress-arrival.png") as { id: string };
    const allowed = await receiverPhoto(new Request(`http://portal.test/api/r/${token}/photos/${cypress.id}`), {
      params: Promise.resolve({ token, photoId: cypress.id }),
    });
    expect(allowed.status).toBe(200);

    const missing = await ingestRoute(
      new Request("http://portal.test/api/ingest/carrier-photos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          loadNumber: "900196-1",
          source: "gmail",
          receivedAt: "2026-10-14T17:10:00Z",
          filename: "x.png",
          dataBase64: Buffer.from(solidPng(1, 2, 3)).toString("base64"),
        }),
      }),
    );
    expect(missing.status).toBe(401);

    const wrong = await ingestRoute(
      new Request("http://portal.test/api/ingest/carrier-photos", {
        method: "POST",
        headers: { authorization: "Bearer not-the-token", "content-type": "application/json" },
        body: JSON.stringify({
          loadNumber: "900196-1",
          source: "gmail",
          receivedAt: "2026-10-14T17:10:00Z",
          filename: "x.png",
          dataBase64: Buffer.from(solidPng(1, 2, 3)).toString("base64"),
        }),
      }),
    );
    expect(wrong.status).toBe(401);

    const customerPost = await ingestRoute(
      await asSession(customerSession(), "http://portal.test/api/ingest/carrier-photos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          loadNumber: "900196-1",
          source: "gmail",
          receivedAt: "2026-10-14T17:10:00Z",
          filename: "x.png",
          dataBase64: Buffer.from(solidPng(9, 9, 9)).toString("base64"),
        }),
      }),
    );
    expect(customerPost.status).toBe(403);

    const trackingRow = ctx.db.prepare(`SELECT tracking_token FROM loads WHERE id = ?`).get(so2196) as {
      tracking_token: string;
    };
    const tracking = await track(new Request(`http://portal.test/api/track/${trackingRow.tracking_token}`), {
      params: Promise.resolve({ token: trackingRow.tracking_token }),
    });
    const tracked = await tracking.json();
    expect(JSON.stringify(tracked)).not.toMatch(/dock\.png|rate-confirmation|carrier-photos|8765/);
  });
});
