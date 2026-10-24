import { extractText } from "unpdf";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type PortalContext } from "@/lib/db";
import {
  extractPdfLiteralText,
  listCustomerDocuments,
  listReviewQueue,
  readCustomerDocument,
  readInternalDocumentFile,
  screenPageText,
} from "@/lib/documents";
import { attentionReasons } from "@/lib/load-list";
import { listOrders } from "@/lib/orders";
import { backfillDemoSamples } from "@/lib/portal";
import { sensitiveReason } from "@/lib/sensitive";
import {
  DEMO_REVIEW_SAMPLE,
  DEMO_SAMPLE_DOCS,
  DEMO_SAMPLE_TRACKING,
  DEMO_WATERMARK,
  ensureDemoSamples,
  seedDemo,
} from "@/lib/seed";
import { seededPortal } from "./helpers";

let ctx: PortalContext;
const saved = {
  DEMO_SEED: process.env.DEMO_SEED,
  VERCEL_ENV: process.env.VERCEL_ENV,
};

beforeAll(async () => {
  ctx = await seededPortal();
});

afterEach(() => {
  restore("DEMO_SEED", saved.DEMO_SEED);
  restore("VERCEL_ENV", saved.VERCEL_ENV);
});

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const literal = extractPdfLiteralText(bytes);
  try {
    const result = await extractText(bytes, { mergePages: true });
    const raw: unknown = result.text;
    const fromPdf = Array.isArray(raw) ? raw.join("\n") : typeof raw === "string" ? raw : "";
    return [fromPdf, literal].filter(Boolean).join("\n");
  } catch {
    return literal;
  }
}

describe("demo sample documents and tracking links", () => {
  it("releases watermarked BOL and POD files on Active, Delivered, and History loads", async () => {
    expect(DEMO_SAMPLE_DOCS.length).toBeGreaterThanOrEqual(4);
    expect(DEMO_SAMPLE_DOCS.length).toBeLessThanOrEqual(6);
    const tabs = new Set(DEMO_SAMPLE_DOCS.map((doc) => doc.tab));
    expect(tabs).toEqual(new Set(["active", "delivered", "history"]));

    for (const doc of DEMO_SAMPLE_DOCS) {
      const page = await listOrders(ctx, { tab: doc.tab, q: doc.salesOrderNumber, pageSize: 10 });
      expect(page.orders.map((order) => order.salesOrderNumber)).toContain(doc.salesOrderNumber);
      const order = page.orders.find((item) => item.salesOrderNumber === doc.salesOrderNumber)!;
      const files = await listCustomerDocuments(ctx, order.id);
      expect(files.map((file) => file.filename)).toContain(doc.filename);
      const stored = files.find((file) => file.filename === doc.filename)!;
      expect(stored.kind).toBe(doc.slot);
      const bytes = await readCustomerDocument(ctx, stored.id);
      expect(bytes?.mediaType).toBe("application/pdf");
      const text = await pdfText(bytes!.bytes);
      expect(text).toContain(DEMO_WATERMARK);
      expect(text).toContain(doc.title);
      expect(text).not.toMatch(/rate confirmation|carrier pay|\$\s?\d/i);
      expect(sensitiveReason(text)).toBeNull();
      expect(screenPageText(text).decision).toBe("pass");
      expect(attentionReasons(order, "2026-10-14")).not.toContain("Files in review");
    }
  });

  it("holds one sample page for Select review and leaves it off the customer documents", async () => {
    const queue = await listReviewQueue(ctx);
    const held = queue.find((item) => item.filename === DEMO_REVIEW_SAMPLE.filename);
    expect(held?.salesOrderNumber).toBe("SO4526");
    expect(held?.screenResult).toBe("uncertain");
    expect(held?.kind).toBe("uncertain");
    expect(held?.screenReason.toLowerCase()).not.toMatch(/rate|carrier pay/);
    const internal = await readInternalDocumentFile(ctx, held!.id);
    expect(internal?.bytes.subarray(0, 4)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    expect(extractPdfLiteralText(internal!.bytes).trim()).toBe("");
    expect(screenPageText(extractPdfLiteralText(internal!.bytes)).decision).toBe("uncertain");

    const select = await listOrders(ctx, { tab: "attention", q: "SO4526", pageSize: 10 });
    expect(select.orders).toHaveLength(1);
    expect(attentionReasons(select.orders[0], "2026-10-14")).toContain("Files in review");
    expect((select.orders[0].pendingReviewCount ?? 0)).toBeGreaterThan(0);
    const active = await listOrders(ctx, { tab: "active", q: "SO4526", pageSize: 10 });
    expect(active.orders).toHaveLength(0);
    const emit = await listOrders(ctx, { tab: "active", q: "SO4526", includeAttention: false, pageSize: 10 });
    expect(emit.orders.map((order) => order.salesOrderNumber)).toContain("SO4526");

    const hidden = await listCustomerDocuments(ctx, select.orders[0].id);
    expect(hidden.map((file) => file.filename)).not.toContain(DEMO_REVIEW_SAMPLE.filename);
  });

  it("sets fake tracking links on several in-transit loads and leaves SO2196 blank", async () => {
    for (const sample of DEMO_SAMPLE_TRACKING) {
      const row = await ctx.db
        .prepare(`SELECT tracking_link, tracking_link_source, tracking_stage FROM loads WHERE sales_order_number = ?`)
        .get(sample.salesOrderNumber);
      expect(row).toMatchObject({ tracking_link: sample.url, tracking_link_source: "demo" });
      expect(["in_transit", "at_pickup"]).toContain(row?.tracking_stage);
    }
    const bare = await ctx.db
      .prepare(`SELECT tracking_link, tracking_stage FROM loads WHERE sales_order_number = ?`)
      .get("SO2196");
    expect(bare).toMatchObject({ tracking_link: null, tracking_stage: "in_transit" });
    const attention = await listOrders(ctx, { tab: "attention", q: "SO2196", pageSize: 10 });
    expect(attentionReasons(attention.orders[0], "2026-10-14")).toContain("Missing tracking");
    const stillBare = await ctx.db
      .prepare(`SELECT tracking_link FROM loads WHERE sales_order_number = ?`)
      .get("SO68582 and SO68583");
    expect(stillBare?.tracking_link ?? null).toBeNull();

    const linked = await listOrders(ctx, { tab: "active", q: "SO4422", pageSize: 10 });
    expect(linked.orders[0].trackingLink).toBe("https://example.com/track/TEST-2");
    expect(attentionReasons(linked.orders[0], "2026-10-14")).not.toContain("Missing tracking");
  });

  it("does not duplicate files or replace a tracking link that is already saved", async () => {
    const own: PortalContext = {
      db: await openDatabase(":memory:"),
      now: () => new Date("2026-10-14T18:00:00Z"),
    };
    await seedDemo(own);
    const before = await own.db.prepare(`SELECT COUNT(*) AS n FROM customer_documents`).get();
    const held = await own.db.prepare(`SELECT COUNT(*) AS n FROM internal_documents`).get();
    await own.db
      .prepare(`UPDATE loads SET tracking_link = ?, tracking_link_source = 'admin' WHERE sales_order_number = ?`)
      .run("https://example.com/track/KEEP", "SO4570");
    await ensureDemoSamples(own);
    const after = await own.db.prepare(`SELECT COUNT(*) AS n FROM customer_documents`).get();
    const heldAfter = await own.db.prepare(`SELECT COUNT(*) AS n FROM internal_documents`).get();
    expect(Number(after?.n)).toBe(Number(before?.n));
    expect(Number(heldAfter?.n)).toBe(Number(held?.n));
    const kept = await own.db.prepare(`SELECT tracking_link, tracking_link_source FROM loads WHERE sales_order_number = ?`).get("SO4570");
    expect(kept).toMatchObject({ tracking_link: "https://example.com/track/KEEP", tracking_link_source: "admin" });
    const untouched = await own.db.prepare(`SELECT tracking_link FROM loads WHERE sales_order_number = ?`).get("SO2196");
    expect(untouched?.tracking_link ?? null).toBeNull();
  });

  it("backfills an already-seeded database only outside production and only when the demo seed is on", async () => {
    const own: PortalContext = {
      db: await openDatabase(":memory:"),
      now: () => new Date("2026-10-14T18:00:00Z"),
    };
    await seedDemo(own);
    await own.db.prepare(`DELETE FROM customer_documents WHERE filename LIKE '%-sample.pdf'`).run();
    await own.db.prepare(`DELETE FROM internal_documents WHERE filename = ?`).run(DEMO_REVIEW_SAMPLE.filename);
    await own.db
      .prepare(`UPDATE loads SET tracking_link = NULL, tracking_link_source = NULL WHERE tracking_link LIKE 'https://example.com/track/TEST-%'`)
      .run();
    await own.db.prepare(`UPDATE loads SET pending_review_count = 0 WHERE sales_order_number = ?`).run("SO4526");

    process.env.VERCEL_ENV = "production";
    process.env.DEMO_SEED = "true";
    await backfillDemoSamples(own);
    expect(Number((await own.db.prepare(`SELECT COUNT(*) AS n FROM customer_documents WHERE filename LIKE '%-sample.pdf'`).get())?.n)).toBe(0);

    process.env.VERCEL_ENV = "preview";
    process.env.DEMO_SEED = "false";
    await backfillDemoSamples(own);
    expect(await own.db.prepare(`SELECT tracking_link FROM loads WHERE sales_order_number = ?`).get("SO4422")).toMatchObject({
      tracking_link: null,
    });

    process.env.DEMO_SEED = "true";
    await backfillDemoSamples(own);
    expect(Number((await own.db.prepare(`SELECT COUNT(*) AS n FROM customer_documents WHERE filename LIKE '%-sample.pdf'`).get())?.n)).toBe(
      DEMO_SAMPLE_DOCS.length,
    );
    const review = await own.db
      .prepare(`SELECT screen_result, kind FROM internal_documents WHERE filename = ?`)
      .get(DEMO_REVIEW_SAMPLE.filename);
    expect(review).toMatchObject({ screen_result: "uncertain", kind: "uncertain" });
    expect(await own.db.prepare(`SELECT tracking_link FROM loads WHERE sales_order_number = ?`).get("SO4422")).toMatchObject({
      tracking_link: "https://example.com/track/TEST-2",
    });
    expect(await own.db.prepare(`SELECT tracking_link FROM loads WHERE sales_order_number = ?`).get("SO2196")).toMatchObject({
      tracking_link: null,
    });
    const pending = await own.db.prepare(`SELECT pending_review_count FROM loads WHERE sales_order_number = ?`).get("SO2196");
    expect(Number(pending?.pending_review_count)).toBe(0);
  });
});
