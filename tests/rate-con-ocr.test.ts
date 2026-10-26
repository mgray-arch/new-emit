import { PDFDocument, StandardFonts } from "pdf-lib";
import { renderPageAsImage } from "unpdf";
import { beforeAll, describe, expect, it } from "vitest";
import { GET as listPhotos } from "@/app/api/orders/[id]/photos/route";
import { GET as receiverPhoto } from "@/app/api/r/[token]/photos/[photoId]/route";
import { GET as receiverPortalRoute } from "@/app/api/r/[token]/route";
import type { PortalContext } from "@/lib/db";
import { ingestDocument, listCustomerDocuments, listReviewQueue, reviewDocument } from "@/lib/documents";
import { ingestCarrierPhoto, solidPng } from "@/lib/photos";
import { createReceiver } from "@/lib/receivers";
import { customerSession, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;

beforeAll(async () => {
  ctx = await seededPortal();
});

async function photographedRateCon(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const lines = [
    "RATE CONFIRMATION",
    "Carrier pay $8,765.43",
    "Line haul $8,200.00",
    "Total carrier pay $8,765.43",
    "Agreed rate for this load",
    "Load confirmation",
    "Broker-carrier agreement",
  ];
  let y = 720;
  for (const line of lines) {
    page.drawText(line, { x: 48, y, size: 20, font });
    y -= 40;
  }
  const rendered = await renderPageAsImage(await doc.save(), 1, {
    scale: 2,
    canvasImport: () => import("@napi-rs/canvas"),
  });
  return new Uint8Array(rendered);
}

async function scannedPdf(png: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(png);
  const page = doc.addPage([612, 792]);
  const width = 500;
  const height = (image.height / image.width) * width;
  page.drawImage(image, { x: 48, y: 740 - height, width, height });
  return doc.save();
}

describe("rate confirmations hidden in images", () => {
  it("quarantines a photographed rate con and a scan with no text layer, and still shows a dock photo to EMIT", async () => {
    const png = await photographedRateCon();
    expect(Buffer.from(png.subarray(0, 8)).toString("hex")).toBe("89504e470d0a1a0a");

    const receiver = await createReceiver(ctx, { company: "OCR Dock LLC", contactEmails: [] });
    const cookie = await sessionCookie(customerSession());
    const created = await (
      await import("@/app/api/orders/route")
    ).POST(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({
          salesOrderNumber: "SO-OCR-1",
          stops: [
            {
              kind: "pickup",
              place: { company: "EMIT NORTH", address1: "1 Main", city: "Sheridan", state: "WY", postalCode: "82801", country: "US" },
            },
            {
              kind: "drop",
              place: { company: "OCR Dock LLC", address1: "2 Main", city: "Cypress", state: "TX", postalCode: "77429", country: "US" },
            },
          ],
        }),
      }),
    );
    expect(created.status).toBe(201);
    const order = (await created.json()).order as { id: string };
    await ctx.db.prepare(`UPDATE loads SET load_number = ? WHERE id = ?`).run("910010-1", order.id);

    const photo = await ingestCarrierPhoto(ctx, {
      loadNumber: "910010-1",
      filename: "arrival-dock.png",
      bytes: png,
      source: "gmail",
      receivedAt: "2026-10-14T19:00:00Z",
      subject: "Driver at the dock",
    });
    expect(photo.visibleToCustomer).toBe(false);
    expect(photo.heldReason).toMatch(/rate confirmation/i);

    const scan = await ingestDocument(ctx, {
      loadId: order.id,
      filename: "scan-packet.pdf",
      bytes: await scannedPdf(png),
      slot: "bol",
    });
    expect(scan.releasedIds).toEqual([]);
    expect(scan.heldIds).toHaveLength(1);
    expect(await listCustomerDocuments(ctx, order.id)).toEqual([]);

    const queue = await listReviewQueue(ctx);
    const photoItem = queue.find((item) => item.id === photo.id);
    const scanItem = queue.find((item) => item.id === scan.heldIds[0]);
    expect(photoItem).toMatchObject({ source: "photo", screenResult: "block", filename: "arrival-dock.png" });
    expect(scanItem).toMatchObject({ source: "document", screenResult: "block", filename: "scan-packet.pdf" });
    expect(scanItem?.textExcerpt?.toLowerCase()).toContain("rate confirmation");
    expect(photoItem?.textExcerpt?.toLowerCase()).toMatch(/rate confirmation|carrier pay/);

    await expect(reviewDocument(ctx, photo.id, "approve", "mgray@goselect.com")).rejects.toThrow(/cannot be released/);
    await expect(reviewDocument(ctx, scan.heldIds[0], "approve", "mgray@goselect.com")).rejects.toThrow(/cannot be released/);
    expect((await listCustomerDocuments(ctx, order.id)).some((doc) => doc.filename === "scan-packet.pdf")).toBe(false);

    const emitList = await listPhotos(
      new Request(`http://portal.test/api/orders/${order.id}/photos`, { headers: { cookie } }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect((await emitList.json()).photos.map((item: { filename: string }) => item.filename)).not.toContain("arrival-dock.png");

    const receiverPage = await receiverPortalRoute(new Request(`http://portal.test/api/r/${receiver.token}`), {
      params: Promise.resolve({ token: receiver.token }),
    });
    const receiverBody = await receiverPage.json();
    expect(JSON.stringify(receiverBody)).not.toMatch(/arrival-dock|scan-packet|rate confirmation|8,765|photos|documents/i);
    const hidden = await receiverPhoto(new Request(`http://portal.test/api/r/${receiver.token}/photos/${photo.id}`), {
      params: Promise.resolve({ token: receiver.token, photoId: photo.id }),
    });
    expect(hidden.status).toBe(404);

    const dock = await ingestCarrierPhoto(ctx, {
      loadNumber: "910010-1",
      filename: "plain-dock.png",
      bytes: solidPng(80, 90, 100),
      source: "gmail",
      receivedAt: "2026-10-14T19:05:00Z",
      subject: "Trailer at the door",
    });
    expect(dock.visibleToCustomer).toBe(true);
    const afterDock = await listPhotos(
      new Request(`http://portal.test/api/orders/${order.id}/photos`, { headers: { cookie } }),
      { params: Promise.resolve({ id: order.id }) },
    );
    const names = (await afterDock.json()).photos.map((item: { filename: string }) => item.filename);
    expect(names).toContain("plain-dock.png");
    expect(names).not.toContain("arrival-dock.png");

    await reviewDocument(ctx, photo.id, "delete", "mgray@goselect.com");
    await reviewDocument(ctx, scan.heldIds[0], "delete", "mgray@goselect.com");
    const remaining = await listReviewQueue(ctx);
    expect(remaining.some((item) => item.id === photo.id || item.id === scan.heldIds[0])).toBe(false);
    expect(await ctx.db.prepare(`SELECT id FROM carrier_photos WHERE id = ?`).get(photo.id)).toBeUndefined();
    expect(await ctx.db.prepare(`SELECT id FROM internal_documents WHERE id = ?`).get(scan.heldIds[0])).toBeUndefined();
  });

  it("quarantines a photo when OCR itself fails, and still lets Select approve that unclear file", async () => {
    const broken = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const held = await ingestCarrierPhoto(ctx, {
      loadNumber: "900196-1",
      filename: "blurry.png",
      bytes: broken,
      source: "gmail",
      receivedAt: "2026-10-14T19:10:00Z",
      subject: "Unreadable picture",
    });
    expect(held.visibleToCustomer).toBe(false);
    const item = (await listReviewQueue(ctx)).find((row) => row.id === held.id);
    expect(item?.screenResult).toBe("uncertain");
    expect(item?.screenReason.toLowerCase()).not.toMatch(/rate confirmation|carrier pay/);
    const approved = await reviewDocument(ctx, held.id, "approve", "mgray@goselect.com");
    expect(approved.reviewStatus).toBe("approved");
    const row = (await ctx.db.prepare(`SELECT held FROM carrier_photos WHERE id = ?`).get(held.id)) as { held: number };
    expect(row.held).toBe(0);
  });
});
