import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DELETE as deleteOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as restoreOrderRoute } from "@/app/api/admin/orders/[id]/restore/route";
import { PATCH as setLoadNumber } from "@/app/api/admin/orders/[id]/load-number/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { findBotLoad } from "@/lib/bot-documents";
import { deleteConfirmText } from "@/lib/delete-confirm";
import type { PortalContext } from "@/lib/db";
import { applyLoadStatus } from "@/lib/load-builder";
import { getOrder, getOrderByToken, listOrders } from "@/lib/orders";
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

function deleteRequest(id: string, cookie?: string) {
  return deleteOrderRoute(
    new Request(`http://portal.test/api/orders/${id}`, {
      method: "DELETE",
      headers: cookie ? headers(cookie) : { host: "portal.test", origin: "http://portal.test" },
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("delete confirm copy", () => {
  it("names the sales order and the load number and does not mention an outside system", () => {
    expect(deleteConfirmText({ salesOrderNumber: "SO123", loadNumber: null })).toBe(
      "Delete SO123 (Select load no load number yet)? This removes the load from the portal. Confirm to delete it.",
    );
    expect(deleteConfirmText({ salesOrderNumber: "SO123 and SO456", loadNumber: "458990-1" })).toBe(
      "Delete SO123 and SO456 (Select load 458990-1)? This removes the load from the portal. Confirm to delete it.",
    );
    expect(deleteConfirmText({ salesOrderNumber: "SO123", loadNumber: "458990-1" })).not.toMatch(/SAM/);
  });
});

describe("DELETE /api/orders/[id]", () => {
  it("soft-deletes a load for Select, keeps the files, and drops it from lists and intake", async () => {
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

    const stored = (await ctx.db.prepare(`SELECT id, deleted_at, deleted_by, audit_log, stops_json FROM loads WHERE id = ?`).get(target.id)) as {
      deleted_at: string;
      deleted_by: string;
      audit_log: string;
      stops_json: string;
    };
    expect(stored.deleted_at).toBeTruthy();
    expect(stored.deleted_by).toContain("Mike Gray");
    expect(stored.audit_log).toContain("Deleted by Mike Gray");
    expect(stored.stops_json).toContain("pickup");
    for (const table of ["customer_documents", "internal_documents", "document_uploads", "carrier_photos"]) {
      expect(await countFor(table, target.id)).toBe(1);
      expect(await countFor(table, keeper.id)).toBe(1);
    }
    expect(await readStoredBytes(targetFiles.customerKey)).toEqual(new TextEncoder().encode("bol-bytes"));
    expect(await readStoredBytes(keeperFiles.customerKey)).toEqual(new TextEncoder().encode("bol-bytes"));
    expect(await getOrder(ctx, target.id)).toBeNull();
    const token = (await ctx.db.prepare(`SELECT tracking_token FROM loads WHERE id = ?`).get(target.id)) as { tracking_token: string };
    expect(await getOrderByToken(ctx, token.tracking_token)).toBeNull();
    expect((await listOrders(ctx, { q: "SO-DELETE-1", pageSize: 10 })).total).toBe(0);
    expect((await listOrders(ctx, { q: "458990-1", pageSize: 10 })).orders.some((order) => order.id === target.id)).toBe(false);
    await expect(findBotLoad(ctx, { loadNumber: "458990-1" })).rejects.toThrow(/No load matches/);
    await expect(findBotLoad(ctx, { salesOrderNumber: "SO-DELETE-1" })).rejects.toThrow(/No load matches/);
    await expect(applyLoadStatus(ctx, { orderId: target.id, carrier: null })).rejects.toThrow(/No portal load/);
    expect(calls).toEqual([]);

    const restored = await restoreOrderRoute(
      new Request(`http://portal.test/api/admin/orders/${target.id}/restore`, { method: "POST", headers: headers(admin) }),
      { params: Promise.resolve({ id: target.id }) },
    );
    expect(restored.status).toBe(200);
    expect((await listOrders(ctx, { q: "SO-DELETE-1", pageSize: 10 })).orders.some((order) => order.id === target.id)).toBe(true);
    const broughtBack = await getOrder(ctx, target.id);
    expect(broughtBack?.auditEvents?.some((event) => event.kind === "deleted" && event.text.includes("Mike Gray"))).toBe(true);
    expect(broughtBack?.auditEvents?.some((event) => event.kind === "restored")).toBe(true);
  });

  it("lets an EMIT admin delete, and refuses a regular EMIT user, view-as, and a signed-out request", async () => {
    const customer = await sessionCookie(customerSession());
    const emitAdmin = await sessionCookie(emitAdminSession());
    const admin = await sessionCookie(adminSession());
    const order = await createOrder("SO-DELETE-FORBIDDEN", customer);

    const signedOut = await deleteRequest(order.id);
    expect(signedOut.status).toBe(401);
    const asCustomer = await deleteRequest(order.id, customer);
    expect(asCustomer.status).toBe(403);
    const preview = await deleteRequest(order.id, `${admin}; portal_view_as=admin:full`);
    expect(preview.status).toBe(403);
    expect(await ctx.db.prepare(`SELECT deleted_at FROM loads WHERE id = ?`).get(order.id)).toMatchObject({ deleted_at: null });

    const asEmitAdmin = await deleteRequest(order.id, emitAdmin);
    expect(asEmitAdmin.status).toBe(200);
    const hidden = (await ctx.db.prepare(`SELECT deleted_by FROM loads WHERE id = ?`).get(order.id)) as { deleted_by: string };
    expect(hidden.deleted_by).toContain("Emit Lead");
    expect((await listOrders(ctx, { q: "SO-DELETE-FORBIDDEN", pageSize: 10 })).total).toBe(0);
  });

  it("returns 404 for an unknown id", async () => {
    const admin = await sessionCookie(adminSession());
    const missing = await deleteRequest("00000000-0000-4000-8000-000000000000", admin);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "Order not found" });
  });

  it("checks delete permission on the order route and does not call an outside system", () => {
    const routeSource = readFileSync("app/api/orders/[id]/route.ts", "utf8");
    expect(routeSource).toContain("canDeleteLoad");
    expect(routeSource).toContain("rejectIfViewingAs");
    expect(routeSource).not.toMatch(/load-builder|@\/lib\/sam|requestLoadBuild|LOAD_BUILDER/);
    const page = readFileSync("app/orders/[id]/page.tsx", "utf8");
    expect(page).toContain("canDeleteLoad");
    expect(page).toContain("<DeleteLoadButton");
    const ui = readFileSync("components/dashboard.tsx", "utf8");
    expect(ui).toContain("canDeleteLoad");
    expect(ui).toContain("<DeleteLoadButton");
    expect(ui).not.toContain("api/admin/orders");
    const deleter = readFileSync("lib/orders.ts", "utf8");
    const body = deleter.slice(deleter.indexOf("export async function deleteOrder"));
    expect(body.slice(0, 900)).not.toMatch(/fetch\(|load-builder|from \"@\/lib\/sam\"/);
  });
});
