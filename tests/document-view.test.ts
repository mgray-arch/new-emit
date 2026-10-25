import { beforeAll, describe, expect, it } from "vitest";
import { GET as downloadDoc } from "@/app/api/documents/[id]/route";
import { documentContentDisposition, documentOpensInline, wantsDocumentDownload } from "@/lib/document-view";
import { ingestDocument, listReviewQueue, reviewDocument } from "@/lib/documents";
import type { PortalContext } from "@/lib/db";
import { adminSession, customerSession, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;

beforeAll(async () => {
  ctx = await seededPortal();
});

function headers(cookie?: string): HeadersInit {
  return cookie ? { cookie, host: "portal.test" } : { host: "portal.test" };
}

function openDoc(id: string, cookie?: string, search = "") {
  return downloadDoc(new Request(`http://portal.test/api/documents/${id}${search}`, { headers: headers(cookie) }), {
    params: Promise.resolve({ id }),
  });
}

function expectSafeHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("document viewing", () => {
  it("opens a pdf or image inline and downloads anything else", () => {
    expect(documentOpensInline("application/pdf")).toBe(true);
    expect(documentOpensInline("image/png")).toBe(true);
    expect(documentOpensInline("image/jpeg")).toBe(true);
    expect(documentOpensInline("text/plain")).toBe(false);
    expect(documentOpensInline("application/octet-stream")).toBe(false);
    expect(wantsDocumentDownload("1")).toBe(true);
    expect(wantsDocumentDownload("0")).toBe(false);
    expect(wantsDocumentDownload(null)).toBe(false);
    expect(documentContentDisposition("application/pdf", "bol.pdf", false)).toBe('inline; filename="bol.pdf"');
    expect(documentContentDisposition("image/png", "scan.png", false)).toBe('inline; filename="scan.png"');
    expect(documentContentDisposition("application/pdf", "bol.pdf", true)).toBe('attachment; filename="bol.pdf"');
    expect(documentContentDisposition("text/plain", "notes.txt", false)).toBe('attachment; filename="notes.txt"');
    expect(documentContentDisposition("application/pdf", 'bad"name.pdf', false)).toBe('inline; filename="bad_name.pdf"');
  });

  it("serves a released PDF inline, and as a download when asked, for EMIT and Select", async () => {
    const row = (await ctx.db
      .prepare(`SELECT id FROM customer_documents WHERE filename = ?`)
      .get("SO2196-bol.pdf")) as { id: string };
    const customer = await sessionCookie(customerSession());
    const emitAdmin = await sessionCookie({
      userId: "emit-admin-1",
      email: "lead@emit.example",
      name: "EMIT Lead",
      role: "emit_admin",
    });
    const admin = await sessionCookie(adminSession());
    const preview = `${admin}; portal_view_as=regular:view`;

    for (const cookie of [customer, emitAdmin, admin, preview]) {
      const inline = await openDoc(row.id, cookie);
      expect(inline.status).toBe(200);
      expectSafeHeaders(inline);
      expect(inline.headers.get("content-type")).toBe("application/pdf");
      expect(inline.headers.get("content-disposition")).toBe('inline; filename="SO2196-bol.pdf"');
      expect(Buffer.from(await inline.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");

      const saved = await openDoc(row.id, cookie, "?download=1");
      expect(saved.status).toBe(200);
      expectSafeHeaders(saved);
      expect(saved.headers.get("content-type")).toBe("application/pdf");
      expect(saved.headers.get("content-disposition")).toBe('attachment; filename="SO2196-bol.pdf"');
    }

    const anon = await openDoc(row.id);
    expect(anon.status).toBe(401);
    const anonDownload = await openDoc(row.id, undefined, "?download=1");
    expect(anonDownload.status).toBe(401);
  });

  it("keeps a text file as a download, and an approved image inline", async () => {
    const load = (await ctx.db.prepare(`SELECT id FROM loads WHERE sales_order_number = ?`).get("SO2196")) as { id: string };
    const notes = new TextEncoder().encode(
      "Dock notes for SO2196. Commodity is a pump skid. Call the yard before arrival. No payment figures are on this page.",
    );
    const text = await ingestDocument(ctx, { loadId: load.id, filename: "notes.txt", bytes: notes, slot: "attachment" });
    expect(text.releasedIds).toHaveLength(1);
    const customer = await sessionCookie(customerSession());
    const plain = await openDoc(text.releasedIds[0], customer);
    expect(plain.status).toBe(200);
    expectSafeHeaders(plain);
    expect(plain.headers.get("content-type")).toBe("text/plain");
    expect(plain.headers.get("content-disposition")).toBe('attachment; filename="notes.txt"');
    const plainDownload = await openDoc(text.releasedIds[0], customer, "?download=1");
    expect(plainDownload.headers.get("content-disposition")).toBe('attachment; filename="notes.txt"');

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const image = await ingestDocument(ctx, { loadId: load.id, filename: "yard.png", bytes: new Uint8Array(png), slot: "attachment" });
    expect(image.heldIds).toHaveLength(1);
    const held = await openDoc(image.heldIds[0], customer, "?download=1");
    expect(held.status).toBe(404);
    await reviewDocument(ctx, image.heldIds[0], "approve", "mgray@goselect.com");
    const released = (await ctx.db.prepare(`SELECT id FROM customer_documents WHERE filename = ?`).get("yard.png")) as { id: string };
    const viewed = await openDoc(released.id, customer);
    expect(viewed.status).toBe(200);
    expectSafeHeaders(viewed);
    expect(viewed.headers.get("content-type")).toBe("image/png");
    expect(viewed.headers.get("content-disposition")).toBe('inline; filename="yard.png"');
    const downloaded = await openDoc(released.id, customer, "?download=1");
    expect(downloaded.headers.get("content-disposition")).toBe('attachment; filename="yard.png"');
    expect(Buffer.from(await downloaded.arrayBuffer()).subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  it("still hides a quarantined page from EMIT and from Select on this route", async () => {
    const held = (await listReviewQueue(ctx))[0];
    const customer = await sessionCookie(customerSession());
    const admin = await sessionCookie(adminSession());
    for (const cookie of [customer, admin]) {
      const inline = await openDoc(held.id, cookie);
      const saved = await openDoc(held.id, cookie, "?download=1");
      expect(inline.status).toBe(404);
      expect(saved.status).toBe(404);
    }
  });
});
