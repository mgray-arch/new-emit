import { beforeAll, describe, expect, it } from "vitest";
import * as trackingRoute from "@/app/api/integrations/tracking-link/route";
import { POST } from "@/app/api/integrations/tracking-link/route";
import { POST as createOrder } from "@/app/api/orders/route";
import type { PortalContext } from "@/lib/db";
import { customerSession, seededPortal, sessionCookie } from "@/tests/helpers";

const KEY = "bot-upload-test-key-0123456789";
const LINK = "https://macropoint.example/share/bot-email";

let ctx: PortalContext;

beforeAll(async () => {
  process.env.BOT_UPLOAD_KEY = KEY;
  ctx = await seededPortal();
});

function post(body: unknown, init?: { key?: string | null; ip?: string; contentType?: string | null }) {
  const headers = new Headers();
  if (init?.key !== null) headers.set("authorization", `Bearer ${init?.key ?? KEY}`);
  headers.set("x-forwarded-for", init?.ip ?? "198.51.100.10");
  if (init?.contentType !== null) headers.set("content-type", init?.contentType ?? "application/json");
  return new Request("http://portal.test/api/integrations/tracking-link", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("bot tracking link", () => {
  it("accepts only the same long bearer key and only POST", async () => {
    const handlers = trackingRoute as Record<string, unknown>;
    expect(handlers.POST).toEqual(expect.any(Function));
    expect(handlers.GET).toBeUndefined();
    expect(handlers.DELETE).toBeUndefined();

    const missing = await POST(post({ loadNumber: "900196-1", trackingLink: LINK }, { key: null, ip: "198.51.100.21" }));
    expect(missing.status).toBe(401);
    const wrong = await POST(
      post({ loadNumber: "900196-1", trackingLink: LINK }, { key: "bot-upload-test-key-0123456780", ip: "198.51.100.22" }),
    );
    expect(wrong.status).toBe(401);
    const cookie = await sessionCookie(customerSession());
    const sessionOnly = await POST(
      new Request("http://portal.test/api/integrations/tracking-link", {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "x-forwarded-for": "198.51.100.23" },
        body: JSON.stringify({ loadNumber: "900196-1", trackingLink: LINK }),
      }),
    );
    expect(sessionOnly.status).toBe(401);
  });

  it("sets a link by load number or sales order, and does not clear or duplicate it", async () => {
    const created = await POST(post({ load_number: "900196-1", tracking_link: LINK }, { ip: "198.51.100.30" }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      salesOrderNumber: "SO2196",
      loadNumber: "900196-1",
      trackingLink: LINK,
      duplicate: false,
    });
    const source = await ctx.db.prepare(`SELECT tracking_link, tracking_link_source FROM loads WHERE load_number = ?`).get("900196-1");
    expect(source).toMatchObject({ tracking_link: LINK, tracking_link_source: "bot-email" });

    const again = await POST(post({ salesOrderNumber: "SO2196", trackingLink: LINK }, { ip: "198.51.100.31" }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ trackingLink: LINK, duplicate: true, loadNumber: "900196-1" });

    const blank = await POST(post({ loadNumber: "900196-1", trackingLink: "" }, { ip: "198.51.100.32" }));
    expect(blank.status).toBe(400);
    const javascript = await POST(post({ loadNumber: "900196-1", trackingLink: "javascript:alert(1)" }, { ip: "198.51.100.33" }));
    expect(javascript.status).toBe(400);
    const still = await ctx.db.prepare(`SELECT tracking_link FROM loads WHERE load_number = ?`).get("900196-1");
    expect(still?.tracking_link).toBe(LINK);

    const replaced = await POST(
      post({ loadNumber: "900196-1", salesOrderNumber: "SO2196", trackingLink: "https://macropoint.example/share/next" }, { ip: "198.51.100.34" }),
    );
    expect(replaced.status).toBe(201);
    expect((await replaced.json()).duplicate).toBe(false);

    const missing = await POST(post({ salesOrderNumber: "SO-DOES-NOT-EXIST", trackingLink: LINK }, { ip: "198.51.100.35" }));
    expect(missing.status).toBe(404);
    const mismatch = await POST(
      post({ loadNumber: "900196-1", salesOrderNumber: "SO2981", trackingLink: LINK }, { ip: "198.51.100.36" }),
    );
    expect(mismatch.status).toBe(409);
    const neither = await POST(post({ trackingLink: LINK }, { ip: "198.51.100.37" }));
    expect(neither.status).toBe(400);
    const notJson = await POST(post("loadNumber=900196-1", { ip: "198.51.100.38", contentType: "text/plain" }));
    expect(notJson.status).toBe(415);

    const cookie = await sessionCookie(customerSession());
    const pending = await createOrder(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({
          salesOrderNumber: "SO-BOT-TRACK",
          stops: [
            { kind: "pickup", place: { company: "EMIT", address1: "1 Main", city: "Sheridan", state: "WY", postalCode: "82801", country: "US" } },
            { kind: "drop", place: { company: "Kodiak", address1: "2 Main", city: "Oklahoma City", state: "OK", postalCode: "73102", country: "US" } },
          ],
        }),
      }),
    );
    expect(pending.status).toBe(201);
    const withoutNumber = await POST(
      post({ salesOrderNumber: "SO-BOT-TRACK", trackingLink: "https://track.example/pending" }, { ip: "198.51.100.39" }),
    );
    expect(withoutNumber.status).toBe(201);
    expect(await withoutNumber.json()).toMatchObject({
      salesOrderNumber: "SO-BOT-TRACK",
      loadNumber: null,
      trackingLink: "https://track.example/pending",
      duplicate: false,
    });
  });
});
