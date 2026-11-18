import { beforeAll, describe, expect, it } from "vitest";
import { GET as cronDeliver } from "@/app/api/cron/deliver-loads/route";
import { POST as postDelivery } from "@/app/api/integrations/delivery/route";
import { PATCH as patchOrder } from "@/app/api/orders/[id]/route";
import { GET as publicTrack } from "@/app/api/track/[token]/route";
import { migrateShippedToInTransit, openDatabase, type PortalContext } from "@/lib/db";
import { filenameLooksLikePod, promoteDeliveredLoads } from "@/lib/delivery";
import { toPublicTracking } from "@/lib/customer-view";
import { getOrder } from "@/lib/orders";
import type { CustomerOrder } from "@/lib/types";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

const SECRET = "delivery-test-secret-0123456789";
const CRON_SECRET = "cron-test-secret-0123456789";

let ctx: PortalContext;

beforeAll(async () => {
  process.env.LOAD_BUILDER_SECRET = SECRET;
  process.env.CRON_SECRET = CRON_SECRET;
  ctx = await seededPortal();
});

function headers(cookie?: string): HeadersInit {
  return {
    "content-type": "application/json",
    host: "portal.test",
    origin: "http://portal.test",
    ...(cookie ? { cookie } : {}),
  };
}

async function loadBySo(salesOrderNumber: string): Promise<CustomerOrder> {
  const row = await ctx.db.prepare(`SELECT id FROM loads WHERE sales_order_number = ?`).get(salesOrderNumber);
  const order = await getOrder(ctx, String(row?.id));
  if (!order) throw new Error(`missing ${salesOrderNumber}`);
  return order;
}

async function statusOf(id: string): Promise<{ portal: string; tracking: string; held: string | null; signal: string | null }> {
  const row = await ctx.db
    .prepare(`SELECT portal_status, tracking_stage, delivery_held_at, delivery_signal_at FROM loads WHERE id = ?`)
    .get(id);
  return {
    portal: String(row?.portal_status),
    tracking: String(row?.tracking_stage),
    held: row?.delivery_held_at == null ? null : String(row.delivery_held_at),
    signal: row?.delivery_signal_at == null ? null : String(row.delivery_signal_at),
  };
}

describe("delivery signals", () => {
  it("recognizes a proof of delivery by name and not a bill of lading", () => {
    expect(filenameLooksLikePod("SO4540-pod-sample.pdf")).toBe(true);
    expect(filenameLooksLikePod("POD.pdf")).toBe(true);
    expect(filenameLooksLikePod("proof of delivery.pdf")).toBe(true);
    expect(filenameLooksLikePod("SO4422-bol-sample.pdf")).toBe(false);
  });

  it("migrates stored Shipped rows to In Transit and can run again", async () => {
    const db = await openDatabase(":memory:");
    await db
      .prepare(
        `INSERT INTO loads (
           id, sales_order_number, portal_status, tracking_stage, timeline_json,
           origin_json, destination_json, tracking_token, comments, created_by, created_at, updated_at
         ) VALUES ('old', 'SO-OLD', 'shipped', 'in_transit', '[]', '{}', '{}', 'token-old-0123456789', '', 'Test', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
      )
      .run();
    expect((await migrateShippedToInTransit(db))).toBe(1);
    expect((await db.prepare(`SELECT portal_status FROM loads WHERE id = 'old'`).get())?.portal_status).toBe("in_transit");
    expect(await migrateShippedToInTransit(db)).toBe(0);
  });

  it("leaves an In Transit load alone until a delivery signal exists", async () => {
    const order = await loadBySo("SO2196");
    expect(order.portalStatus).toBe("in_transit");
    const first = await promoteDeliveredLoads(ctx);
    expect(first.loadIds).not.toContain(order.id);
    expect((await statusOf(order.id)).portal).toBe("in_transit");
  });

  it("moves an In Transit load to Delivered from a POD, and a manual undo sticks", async () => {
    const order = await loadBySo("SO2196");
    await ctx.db
      .prepare(
        `INSERT INTO document_uploads (id, load_id, sha256, filename, doc_type, uploaded_by, released_count, held_count, created_at)
         VALUES ('pod-2196', ?, 'abc', 'proof.pdf', 'pod', 'Select bot', 1, 0, '2026-10-14T18:00:00Z')`,
      )
      .run(order.id);
    const promoted = await promoteDeliveredLoads(ctx);
    expect(promoted.loadIds).toContain(order.id);
    expect(await statusOf(order.id)).toMatchObject({ portal: "delivered", tracking: "delivered", held: null });

    const select = await sessionCookie(adminSession());
    const undo = await patchOrder(
      new Request(`http://portal.test/api/orders/${order.id}`, {
        method: "PATCH",
        headers: headers(select),
        body: JSON.stringify({ portalStatus: "in_transit" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(undo.status).toBe(200);
    expect((await undo.json()).order.portalStatus).toBe("in_transit");
    expect((await statusOf(order.id)).held).toBeTruthy();

    const again = await promoteDeliveredLoads(ctx);
    expect(again.loadIds).not.toContain(order.id);
    expect((await statusOf(order.id)).portal).toBe("in_transit");

    await ctx.db.prepare(`UPDATE loads SET delivery_signal_at = ?, delivery_signal_kind = ? WHERE id = ?`).run("2026-10-15T12:00:00.000Z", "delivered", order.id);
    const afterEvent = await promoteDeliveredLoads(ctx);
    expect(afterEvent.loadIds).toContain(order.id);
    expect((await statusOf(order.id)).portal).toBe("delivered");
  });

  it("uses a recorded drop departure with no proof of delivery, and ignores a load that is not In Transit", async () => {
    const moving = await loadBySo("SO4422");
    await ctx.db.prepare(`UPDATE loads SET portal_status = 'in_transit', tracking_stage = 'in_transit', delivery_held_at = NULL, delivery_signal_at = NULL WHERE id = ?`).run(moving.id);
    const podUploads = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM document_uploads WHERE load_id = ? AND lower(doc_type) = 'pod'`).get(moving.id);
    const podFiles = await ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM customer_documents WHERE load_id = ? AND lower(filename) LIKE '%pod%'`)
      .get(moving.id);
    expect(Number(podUploads?.n)).toBe(0);
    expect(Number(podFiles?.n)).toBe(0);
    const stops = JSON.parse(String((await ctx.db.prepare(`SELECT stops_json FROM loads WHERE id = ?`).get(moving.id))?.stops_json)) as Array<Record<string, unknown>>;
    const drop = [...stops].reverse().find((stop) => stop.kind === "drop");
    if (!drop) throw new Error("no drop");
    drop.schedule = { date: "2026-10-16", appointmentStart: null, appointmentEnd: null, appointmentText: null, arrivedAt: null, departedAt: "2026-10-16T22:00:00.000Z" };
    await ctx.db.prepare(`UPDATE loads SET stops_json = ? WHERE id = ?`).run(JSON.stringify(stops), moving.id);
    const run = await promoteDeliveredLoads(ctx);
    expect(run.loadIds).toContain(moving.id);

    const preparing = await loadBySo("SO4501");
    expect(preparing.portalStatus).toBe("being_prepared");
    await ctx.db.prepare(`UPDATE loads SET tracking_stage = 'delivered' WHERE id = ?`).run(preparing.id);
    await ctx.db
      .prepare(
        `INSERT INTO customer_documents (id, load_id, kind, filename, media_type, storage_key, created_at)
         VALUES ('pod-prep', ?, 'attachment', 'SO4501-pod.pdf', 'application/pdf', 'skip', '2026-10-14T18:00:00Z')`,
      )
      .run(preparing.id);
    const skipped = await promoteDeliveredLoads(ctx);
    expect(skipped.loadIds).not.toContain(preparing.id);
    expect((await statusOf(preparing.id)).portal).toBe("being_prepared");
  });

  it("moves an In Transit load from tracking stage Delivered when no proof of delivery is on file", async () => {
    const order = await loadBySo("SO4570");
    await ctx.db.prepare(`DELETE FROM document_uploads WHERE load_id = ? AND lower(doc_type) = 'pod'`).run(order.id);
    await ctx.db.prepare(`DELETE FROM customer_documents WHERE load_id = ? AND lower(filename) LIKE '%pod%'`).run(order.id);
    await ctx.db
      .prepare(
        `UPDATE loads SET portal_status = 'in_transit', tracking_stage = 'delivered', delivery_held_at = NULL, delivery_signal_at = NULL, deleted_at = NULL WHERE id = ?`,
      )
      .run(order.id);
    const pods = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM document_uploads WHERE load_id = ? AND lower(doc_type) = 'pod'`).get(order.id);
    expect(Number(pods?.n)).toBe(0);
    const run = await promoteDeliveredLoads(ctx);
    expect(run.loadIds).toContain(order.id);
    expect((await statusOf(order.id)).portal).toBe("delivered");
  });

  it("does not promote a deleted load", async () => {
    const order = await loadBySo("SO4570");
    await ctx.db
      .prepare(`UPDATE loads SET portal_status = 'in_transit', tracking_stage = 'delivered', deleted_at = '2026-10-14T18:00:00Z', delivery_held_at = NULL WHERE id = ?`)
      .run(order.id);
    const run = await promoteDeliveredLoads(ctx);
    expect(run.loadIds).not.toContain(order.id);
    expect((await statusOf(order.id)).portal).toBe("in_transit");
  });

  it("records an integration delivery event without changing status, and rejects a bad key or a rate field", async () => {
    const order = await loadBySo("SO4418");
    await ctx.db.prepare(`UPDATE loads SET portal_status = 'in_transit', tracking_stage = 'in_transit' WHERE id = ?`).run(order.id);
    const before = await statusOf(order.id);

    const missing = await postDelivery(
      new Request("http://portal.test/api/integrations/delivery", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.70" },
        body: JSON.stringify({ loadNumber: order.loadNumber, event: "departure" }),
      }),
    );
    expect(missing.status).toBe(401);

    const rated = await postDelivery(
      new Request("http://portal.test/api/integrations/delivery", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.71" },
        body: JSON.stringify({ loadNumber: order.loadNumber, event: "delivered", carrierPay: 10 }),
      }),
    );
    expect(rated.status).toBe(400);

    const saved = await postDelivery(
      new Request("http://portal.test/api/integrations/delivery", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.72" },
        body: JSON.stringify({ orderId: order.id, event: "arrival_completed" }),
      }),
    );
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body).toMatchObject({ orderId: order.id, portalStatus: "in_transit", event: "arrival_completed", recorded: true });
    const after = await statusOf(order.id);
    expect(after.portal).toBe(before.portal);
    expect(after.tracking).toBe(before.tracking);
    expect(after.signal).toBeTruthy();
  });

  it("lets Select and an EMIT admin mark delivered, and refuses a regular EMIT user", async () => {
    const order = await loadBySo("SO68582 and SO68583");
    await ctx.db.prepare(`UPDATE loads SET portal_status = 'in_transit', tracking_stage = 'in_transit', delivery_held_at = NULL, delivery_signal_at = NULL WHERE id = ?`).run(order.id);
    const customer = await sessionCookie(customerSession());
    const refused = await patchOrder(
      new Request(`http://portal.test/api/orders/${order.id}`, {
        method: "PATCH",
        headers: headers(customer),
        body: JSON.stringify({ portalStatus: "delivered" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(refused.status).toBe(403);
    expect((await statusOf(order.id)).portal).toBe("in_transit");
    const podUploads = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM document_uploads WHERE load_id = ? AND lower(doc_type) = 'pod'`).get(order.id);
    const podFiles = await ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM customer_documents WHERE load_id = ? AND lower(filename) LIKE '%pod%'`)
      .get(order.id);
    expect(Number(podUploads?.n)).toBe(0);
    expect(Number(podFiles?.n)).toBe(0);

    const emitAdmin = await sessionCookie({
      userId: "emit-admin-1",
      email: "lead@emit.example",
      name: "EMIT Lead",
      role: "emit_admin",
    });
    const marked = await patchOrder(
      new Request(`http://portal.test/api/orders/${order.id}`, {
        method: "PATCH",
        headers: headers(emitAdmin),
        body: JSON.stringify({ portalStatus: "delivered" }),
      }),
      { params: Promise.resolve({ id: order.id }) },
    );
    expect(marked.status).toBe(200);
    const markedOrder = (await marked.json()).order as CustomerOrder;
    expect(markedOrder.portalStatus).toBe("delivered");
    expect(markedOrder.trackingStage).toBe("delivered");
    expect(markedOrder.stageEvents?.at(-1)?.text).toBe("Stage changed from In Transit to Delivered.");
  });

  it("shows In Transit and Delivered on the public tracking page without files or pay", async () => {
    const moving = await loadBySo("SO4422");
    const tokenRow = await ctx.db.prepare(`SELECT tracking_token FROM loads WHERE id = ?`).get(moving.id);
    const token = String(tokenRow?.tracking_token);
    const response = await publicTrack(new Request(`http://portal.test/api/track/${token}`), { params: Promise.resolve({ token }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.portalStatus === "in_transit" || body.portalStatus === "delivered").toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/document|pod|bol|photo|carrierPay|customerCost/i);
    expectNoSecrets(body);
    const page = toPublicTracking(await loadBySo("SO2196"));
    expect(page.portalStatus).toBe("delivered");
    expect(Object.keys(page).sort()).toEqual(
      ["destinationCity", "destinationState", "latestEta", "loadNumber", "mustDeliverDate", "originCity", "originState", "portalStatus", "salesOrderNumber", "shipDate", "stops", "timeline", "trackingLink", "trackingStage", "truckType"].sort(),
    );
  });

  it("requires the cron secret and then runs the same job", async () => {
    const open = await cronDeliver(new Request("http://portal.test/api/cron/deliver-loads"));
    expect(open.status).toBe(401);
    const wrong = await cronDeliver(
      new Request("http://portal.test/api/cron/deliver-loads", { headers: { authorization: "Bearer nope-not-the-secret" } }),
    );
    expect(wrong.status).toBe(401);
    const ok = await cronDeliver(
      new Request("http://portal.test/api/cron/deliver-loads", { headers: { authorization: `Bearer ${CRON_SECRET}` } }),
    );
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.ok).toBe(true);
    expect(typeof body.delivered).toBe("number");
  });
});
