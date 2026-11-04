import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as printBol } from "@/app/api/orders/[id]/bol/print/route";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import type { PortalContext } from "@/lib/db";
import { latestBolPages } from "@/lib/bol-print";
import { adminSession, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;

beforeAll(async () => {
  ctx = await seededPortal();
});

afterAll(() => {
  /* seeded portal is process-wide for this file */
});

function headers(cookie: string): HeadersInit {
  return { cookie, host: "portal.test" };
}

describe("BOL print", () => {
  it("prints only the newest uploaded BOL and records that print", async () => {
    expect(latestBolPages([])).toEqual([]);
    const load = await ctx.db.prepare(`SELECT id FROM loads LIMIT 1`).get();
    const loadId = String(load?.id);
    const cookie = await sessionCookie(adminSession());
    const missing = await printBol(new Request(`http://portal.test/api/orders/${loadId}/bol/print`, { headers: headers(cookie) }), {
      params: Promise.resolve({ id: loadId }),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("BOL not uploaded yet");
    expect(Number((await ctx.db.prepare(`SELECT COUNT(*) AS n FROM bol_prints WHERE load_id = ?`).get(loadId))?.n)).toBe(0);

    await ctx.db
      .prepare(
        `INSERT INTO customer_documents (id, load_id, kind, filename, media_type, storage_key, created_at, uploaded_by)
         VALUES ('att-1', ?, 'attachment', 'photo.jpg', 'image/jpeg', 'memory:att', '2026-10-01T00:00:00.000Z', 'Select bot')`,
      )
      .run(loadId);
    await ctx.db
      .prepare(
        `INSERT INTO internal_documents (
           id, load_id, kind, screen_result, screen_reason, review_status, filename, media_type,
           page_index, page_count, storage_key, created_at, uploaded_by
         ) VALUES ('rate-1', ?, 'rate_confirmation', 'block', 'rate confirmation', 'pending', 'rate.pdf', 'application/pdf', 1, 1, 'memory:rate', '2026-10-02T00:00:00.000Z', 'Select bot')`,
      )
      .run(loadId);
    await ctx.db
      .prepare(
        `INSERT INTO customer_documents (id, load_id, kind, filename, media_type, storage_key, created_at, uploaded_by)
         VALUES
           ('bol-old', ?, 'bol', 'old-bol.pdf', 'application/pdf', 'memory:old', '2026-10-02T00:00:00.000Z', 'M. Gray'),
           ('bol-p1', ?, 'bol', 'SO-bol.pdf', 'application/pdf', 'memory:p1', '2026-10-03T00:00:00.000Z', 'Select bot'),
           ('bol-p2', ?, 'bol', 'SO-bol.pdf', 'application/pdf', 'memory:p2', '2026-10-03T00:00:00.000Z', 'Select bot')`,
      )
      .run(loadId, loadId, loadId);

    const printed = await printBol(new Request(`http://portal.test/api/orders/${loadId}/bol/print`, { headers: headers(cookie) }), {
      params: Promise.resolve({ id: loadId }),
    });
    expect(printed.status).toBe(200);
    const html = await printed.text();
    expect(html).toContain("/api/documents/bol-p1");
    expect(html).toContain("/api/documents/bol-p2");
    expect(html).not.toContain("bol-old");
    expect(html).not.toContain("rate-1");
    expect(html).not.toContain("att-1");
    expect(html).toContain("min-height: 48px");
    expect(html).not.toMatch(/carrierPay|carrier pay|rate confirmation|\$/i);
    const rows = await ctx.db.prepare(`SELECT document_id, printed_by FROM bol_prints WHERE load_id = ?`).all(loadId);
    expect(rows).toEqual([{ document_id: "bol-p1", printed_by: "admin-1" }]);

    const detail = await getOrderRoute(new Request(`http://portal.test/api/orders/${loadId}`, { headers: headers(cookie) }), {
      params: Promise.resolve({ id: loadId }),
    });
    const body = await detail.json();
    expect(body.order.bolPrintCount).toBe(1);
    expect(JSON.stringify(body)).not.toMatch(/carrierPay|rate confirmation/i);
  });
});
