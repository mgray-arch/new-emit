import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DELETE as deleteOrderRoute } from "@/app/api/admin/orders/[id]/route";
import { PATCH as setLoadNumber } from "@/app/api/admin/orders/[id]/load-number/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { deleteConfirmText } from "@/lib/delete-confirm";
import type { PortalContext } from "@/lib/db";
import { readStoredBytes, writeStoredBytes } from "@/lib/storage";
import type { Session } from "@/lib/types";
import { adminSession, customerSession, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;

beforeAll(async () => {
  ctx = await seededPortal();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function headers(cookie: string): HeadersInit {
  return { cookie, host: "portal.test", origin: "http://portal.test" };
}

function emitAdminSession(): Session {
  return { userId: "emit-admin-1", email: "lead@emit.example", name: "Emit Lead", role: "emit_admin" };
}

const route = {
  origin: { company: "EMIT Technologies", address1: "2437 Allen Avenue", city: "Sheridan", state: "WY", postalCode: "82801" },
  destination: { company: "Kodiak Gas Services", address1: "6801 Brooklyn Court", city: "Oklahoma City", state: "OK", postalCode: "73132" },
};

async function createOrder(salesOrderNumber: string, cookie: string) {
  const response = await createOrderRoute(
    new Request("http://portal.test/api/orders", {
      method: "POST",
      headers: { ...headers(cookie), "content-type": "application/json" },
      body: JSON.stringify({ salesOrderNumber, ...route }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()).order as { id: string; loadNumber: string | null };
}

async function attachDependents(loadId: string) {
  const now = "2026-10-28T12:00:00.000Z";
  const customerKey = await writeStoredBytes(
    `customer-documents/${loadId}-bol`,
    new TextEncoder().encode("bol-bytes"),
    "application/pdf",
  );
  const internalKey = await writeStoredBytes(
    `internal-documents/${loadId}-rate`,
    new TextEncoder().encode("rate-bytes"),
    "application/pdf",
  );
  const photoKey = await writeStoredBytes(`carrier-photos/${loadId}-pic`, new TextEncoder().encode("photo-bytes"), "image/png");
  await ctx.db
    .prepare(
      `INSERT INTO customer_documents (id, load_id, kind, filename, media_type, storage_key, created_at, uploaded_by)
       VALUES (?, ?, 'bol', 'bol.pdf', 'application/pdf', ?, ?, ?)`,
    )
    .run(`${loadId}-doc`, loadId, customerKey, now, "admin-1");
  await ctx.db
    .prepare(
      `INSERT INTO internal_documents (
         id, load_id, kind, screen_result, screen_reason, review_status, filename, media_type,
         page_index, page_count, text_excerpt, storage_key, created_at, uploaded_by
       ) VALUES (?, ?, 'uncertain', 'uncertain', 'unread', 'pending', 'page.pdf', 'application/pdf', 1, 1, NULL, ?, ?, ?)`,
    )
    .run(`${loadId}-internal`, loadId, internalKey, now, "admin-1");
  await ctx.db
    .prepare(
      `INSERT INTO document_uploads (
         id, load_id, sha256, filename, doc_type, uploaded_by, released_count, held_count, created_at
       ) VALUES (?, ?, ?, 'bol.pdf', 'bol', 'admin-1', 1, 1, ?)`,
    )
    .run(`${loadId}-upload`, loadId, `${loadId}-sha`, now);
  await ctx.db
    .prepare(
      `INSERT INTO carrier_photos (
         id, load_id, sha256, filename, media_type, source, subject, received_at, created_at, held, hold_reason, storage_key
       ) VALUES (?, ?, ?, 'yard.png', 'image/png', 'gmail', NULL, ?, ?, 0, NULL, ?)`,
    )
    .run(`${loadId}-photo`, loadId, `${loadId}-photo-sha`, now, now, photoKey);
  return { customerKey, internalKey, photoKey };
}

async function countFor(table: string, loadId: string) {
  const row = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE load_id = ?`).get(loadId);
  return Number(row?.n ?? 0);
}

function deleteRequest(id: string, cookie: string) {
  return deleteOrderRoute(
    new Request(`http://portal.test/api/admin/orders/${id}`, { method: "DELETE", headers: headers(cookie) }),
    { params: Promise.resolve({ id }) },
  );
}

describe("delete confirm copy", () => {
  it("warns that SAM is unchanged, and names a separate void when a SAM load number is stored", () => {
    expect(deleteConfirmText(null)).toBe("Delete this order? This cannot be undone. It does not change SAM.");
    expect(deleteConfirmText("")).toBe("Delete this order? This cannot be undone. It does not change SAM.");
    expect(deleteConfirmText("458990-1")).toBe(
      "Delete this order? This cannot be undone. It does not change SAM. The SAM load must be voided separately in SAM.",
    );
  });
});

describe("DELETE /api/admin/orders/[id]", () => {
  it("lets a Select admin delete an order, its stops, documents, photos, and blobs, without calling SAM", async () => {
    const customer = await sessionCookie(customerSession());
    const admin = await sessionCookie(adminSession());
    const target = await createOrder("SO-DELETE-1", customer);
    const keeper = await createOrder("SO-DELETE-KEEP", customer);
    const numbered = await setLoadNumber(
      new Request(`http://portal.test/api/admin/orders/${target.id}/load-number`, {
        method: "PATCH",
        headers: { ...headers(admin), "content-type": "application/json" },
        body: JSON.stringify({ loadNumber: "458990-1" }),
      }),
      { params: Promise.resolve({ id: target.id }) },
    );
    expect(numbered.status).toBe(200);

    const targetFiles = await attachDependents(target.id);
    const keeperFiles = await attachDependents(keeper.id);
    const stops = await ctx.db.prepare(`SELECT stops_json FROM loads WHERE id = ?`).get(target.id);
    expect(String(stops?.stops_json)).toContain("pickup");
    expect(await readStoredBytes(targetFiles.customerKey)).toEqual(new TextEncoder().encode("bol-bytes"));

    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new Error("delete must not call SAM or Load Builder");
    });

    const removed = await deleteRequest(target.id, admin);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect(calls).toEqual([]);

    expect(await ctx.db.prepare(`SELECT id FROM loads WHERE id = ?`).get(target.id)).toBeUndefined();
    for (const table of ["customer_documents", "internal_documents", "document_uploads", "carrier_photos"]) {
      expect(await countFor(table, target.id)).toBe(0);
      expect(await countFor(table, keeper.id)).toBe(1);
    }
    await expect(readStoredBytes(targetFiles.customerKey)).rejects.toThrow(/missing/i);
    await expect(readStoredBytes(targetFiles.internalKey)).rejects.toThrow(/missing/i);
    await expect(readStoredBytes(targetFiles.photoKey)).rejects.toThrow(/missing/i);
    expect(await readStoredBytes(keeperFiles.customerKey)).toEqual(new TextEncoder().encode("bol-bytes"));
    expect(await ctx.db.prepare(`SELECT id, stops_json FROM loads WHERE id = ?`).get(keeper.id)).toBeTruthy();

    const pending = await deleteRequest(keeper.id, admin);
    expect(pending.status).toBe(200);
    expect(await ctx.db.prepare(`SELECT id FROM loads WHERE id = ?`).get(keeper.id)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("rejects an EMIT user and an EMIT admin", async () => {
    const customer = await sessionCookie(customerSession());
    const emitAdmin = await sessionCookie(emitAdminSession());
    const admin = await sessionCookie(adminSession());
    const order = await createOrder("SO-DELETE-FORBIDDEN", customer);

    const asCustomer = await deleteRequest(order.id, customer);
    expect(asCustomer.status).toBe(403);
    const asEmitAdmin = await deleteRequest(order.id, emitAdmin);
    expect(asEmitAdmin.status).toBe(403);
    expect(await ctx.db.prepare(`SELECT id FROM loads WHERE id = ?`).get(order.id)).toBeTruthy();

    const removed = await deleteRequest(order.id, admin);
    expect(removed.status).toBe(200);
  });

  it("returns 404 for an unknown id", async () => {
    const admin = await sessionCookie(adminSession());
    const missing = await deleteRequest("00000000-0000-4000-8000-000000000000", admin);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "Order not found" });
  });

  it("uses the Select admin check and does not import SAM or Load Builder", () => {
    const routeSource = readFileSync("app/api/admin/orders/[id]/route.ts", "utf8");
    expect(routeSource).toContain("requireAdmin");
    expect(routeSource).not.toMatch(/load-builder|@\/lib\/sam|requestLoadBuild|LOAD_BUILDER/);
    const ui = readFileSync("components/dashboard.tsx", "utf8");
    expect(ui).toMatch(/selectView && confirmDeleteId !== order\.id \? \([\s\S]*?btn danger[\s\S]*?Delete/);
    expect(ui).toMatch(/selectView && confirmDeleteId === order\.id \? \([\s\S]*?deleteConfirmText\(order\.loadNumber\)[\s\S]*?btn danger/);
    expect(ui).toContain('fetch(`/api/admin/orders/${id}`, { method: "DELETE" })');
  });
});
