import { beforeAll, describe, expect, it } from "vitest";
import { GET as downloadDoc } from "@/app/api/documents/[id]/route";
import { PATCH as patchReceiver } from "@/app/api/admin/receivers/[id]/route";
import { POST as regenerateLink } from "@/app/api/admin/receivers/[id]/regenerate/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { GET as receiverPhoto } from "@/app/api/r/[token]/photos/[photoId]/route";
import { GET as receiverPortalRoute } from "@/app/api/r/[token]/route";
import ReceiverLinkPage from "@/app/r/[token]/page";
import type { PortalContext } from "@/lib/db";
import { ingestDocument, listCustomerDocuments, reviewDocument } from "@/lib/documents";
import { ingestCarrierPhoto, solidPng } from "@/lib/photos";
import { createReceiver, receiverPortal, updateReceiver } from "@/lib/receivers";
import { sensitiveReason } from "@/lib/sensitive";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;

beforeAll(async () => {
  ctx = await seededPortal();
});

const pickup = (company: string, city: string, state: string) => ({
  kind: "pickup" as const,
  place: { company, address1: "1 Main", city, state, postalCode: "00000", country: "US" },
});
const drop = (company: string, city: string, state: string) => ({
  kind: "drop" as const,
  place: { company, address1: "2 Main", city, state, postalCode: "00000", country: "US" },
});

async function openReceiver(token: string) {
  return receiverPortalRoute(new Request(`http://portal.test/api/r/${token}`), {
    params: Promise.resolve({ token }),
  });
}

describe("receiver links", () => {
  it("treats hyphenated rate-confirmation and carrier-pay names as sensitive", () => {
    expect(sensitiveReason("rate-confirmation.png")).toMatch(/rate confirmation/i);
    expect(sensitiveReason("carrier-pay.jpg")).toMatch(/carrier pay/i);
    expect(sensitiveReason("carrier_rate.pdf")).toMatch(/carrier rate/i);
    expect(sensitiveReason("rate_con.pdf")).toMatch(/rate con/i);
    expect(sensitiveReason("cypress-arrival.png")).toBeNull();
  });

  it("shows only loads that deliver to that company, and never pay or a rate confirmation", async () => {
    const cypress = await createReceiver(ctx, { company: "Cypress Dock LLC", contactEmails: ["dock@cypress.example"] });
    expect(cypress.enabled).toBe(true);
    expect(cypress.token.length).toBeGreaterThan(20);

    const cookie = await sessionCookie(customerSession());
    const headers = { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" };
    const created = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers,
        body: JSON.stringify({
          salesOrderNumber: "SO-RCV-CYPRESS",
          customerCost: 4242.42,
          comments: "Carrier pay is $8,765.43. See the rate confirmation. PAY-SENTINEL-424242",
          stops: [pickup("EMIT NORTH", "Sheridan", "WY"), drop("Cypress Dock LLC", "Cypress", "TX")],
        }),
      }),
    );
    expect(created.status).toBe(201);
    const order = (await created.json()).order as { id: string };
    await ctx.db
      .prepare(`UPDATE loads SET load_number = ?, customer_cost_cents = ?, comments = ? WHERE id = ?`)
      .run("910001-1", 424242, "Carrier pay is $8,765.43. See the rate confirmation. PAY-SENTINEL-424242", order.id);

    const pickupOnly = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers,
        body: JSON.stringify({
          salesOrderNumber: "SO-RCV-PICKUP-ONLY",
          stops: [pickup("Cypress Dock LLC", "Cypress", "TX"), drop("Enchanted Rock LLC", "Houston", "TX")],
        }),
      }),
    );
    expect(pickupOnly.status).toBe(201);

    const text = new TextEncoder().encode(
      "RATE CONFIRMATION\nCarrier: BLACKHAWK HAULING LLC\nMC 998877\nCarrier Pay: $8,765.43\nLine haul agreed rate",
    );
    const held = await ingestDocument(ctx, {
      loadId: order.id,
      filename: "rate-confirmation-SENTINEL.txt",
      bytes: text,
      slot: "attachment",
    });
    expect(held.releasedIds).toEqual([]);
    expect(held.heldIds.length).toBeGreaterThan(0);
    await expect(reviewDocument(ctx, held.heldIds[0], "approve", "mgray@goselect.com")).rejects.toThrow(/cannot be released/);
    const released = await listCustomerDocuments(ctx, order.id);
    expect(released.some((doc) => doc.filename.includes("SENTINEL"))).toBe(false);
    const anonymous = await downloadDoc(new Request(`http://portal.test/api/documents/${held.heldIds[0]}`), {
      params: Promise.resolve({ id: held.heldIds[0] }),
    });
    expect(anonymous.status).toBe(401);

    const named = await ingestCarrierPhoto(ctx, {
      loadNumber: "910001-1",
      filename: "rate-confirmation.png",
      bytes: solidPng(9, 9, 9),
      source: "gmail",
      receivedAt: "2026-10-14T18:00:00Z",
    });
    expect(named.visibleToCustomer).toBe(false);
    const embedded = await ingestCarrierPhoto(ctx, {
      loadNumber: "910001-1",
      filename: "note.png",
      bytes: solidPng(2, 2, 2, "RATE CONFIRMATION carrier pay $8,765.43 BLACKHAWK"),
      source: "gmail",
      receivedAt: "2026-10-14T18:01:00Z",
      subject: "clean subject",
    });
    expect(embedded.visibleToCustomer).toBe(false);
    const visible = await ingestCarrierPhoto(ctx, {
      loadNumber: "910001-1",
      filename: "dock-ok.png",
      bytes: solidPng(4, 5, 6),
      source: "gmail",
      receivedAt: "2026-10-14T18:02:00Z",
    });
    expect(visible.visibleToCustomer).toBe(true);

    const response = await openReceiver(cypress.token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.company).toBe("Cypress Dock LLC");
    const numbers = body.loads.map((load: { loadNumber: string | null }) => load.loadNumber);
    expect(numbers).toContain("910001-1");
    expect(numbers).not.toContain("900196-1");
    expect(
      body.loads.every((load: { stops: Array<{ kind: string; city: string }> }) =>
        load.stops.some((stop) => stop.kind === "drop" && stop.city === "Cypress"),
      ),
    ).toBe(true);
    const own = body.loads.find((load: { loadNumber: string }) => load.loadNumber === "910001-1");
    expect(Object.keys(own).sort()).toEqual(
      ["latestEta", "loadNumber", "mustDeliverDate", "portalStatus", "shipDate", "stops", "timeline", "trackingLink", "trackingStage"].sort(),
    );
    expect(own.photos).toBeUndefined();
    expect(own.customerCost).toBeUndefined();
    expect(own.documents).toBeUndefined();
    expect(own.comments).toBeUndefined();
    expect(own.salesOrderNumber).toBeUndefined();
    expect(own.stops[0]).toEqual({ kind: "pickup", city: "Sheridan", state: "WY" });
    expect(own.stops.at(-1)).toEqual({ kind: "drop", city: "Cypress", state: "TX", salesOrders: ["SO-RCV-CYPRESS"] });
    const textBody = JSON.stringify(body);
    expect(textBody).not.toMatch(/customerCost|rateReason|carrierPay|carrierName|carrierMc|driverName|bolPrint|documents|comments|photos/i);
    expect(textBody).not.toContain("SO-RCV-PICKUP-ONLY");
    expect(textBody).not.toMatch(/PAY-SENTINEL|4242\.42|424242|BLACKHAWK|8,765\.43|8765\.43|rate confirmation|rate-confirmation|dock-ok/i);
    expectNoSecrets(body);

    const hiddenName = await receiverPhoto(new Request(`http://portal.test/api/r/${cypress.token}/photos/${named.id}`), {
      params: Promise.resolve({ token: cypress.token, photoId: named.id }),
    });
    expect(hiddenName.status).toBe(404);
    const hiddenBytes = await receiverPhoto(new Request(`http://portal.test/api/r/${cypress.token}/photos/${embedded.id}`), {
      params: Promise.resolve({ token: cypress.token, photoId: embedded.id }),
    });
    expect(hiddenBytes.status).toBe(404);
    const allowed = await receiverPhoto(new Request(`http://portal.test/api/r/${cypress.token}/photos/${visible.id}`), {
      params: Promise.resolve({ token: cypress.token, photoId: visible.id }),
    });
    expect(allowed.status).toBe(404);

    const enchanted = (await ctx.db.prepare(`SELECT access_token FROM receivers WHERE company = ?`).get("Enchanted Rock LLC")) as {
      access_token: string;
    };
    await ctx.db.prepare(`UPDATE loads SET load_number = ? WHERE sales_order_number = ?`).run("910002-1", "SO-RCV-PICKUP-ONLY");
    const rockAgain = await openReceiver(enchanted.access_token);
    const rockBody = await rockAgain.json();
    const rockNumbers = rockBody.loads.map((load: { loadNumber: string | null }) => load.loadNumber);
    expect(rockNumbers).toContain("910002-1");
    expect(rockNumbers).not.toContain("910001-1");
    expect(JSON.stringify(rockBody)).not.toMatch(/PAY-SENTINEL|rate-confirmation-SENTINEL|dock-ok\.png/);
    expectNoSecrets(rockBody);

    const direct = await receiverPortal(ctx, cypress.token);
    expect(direct?.loads.some((load) => load.loadNumber === "910001-1")).toBe(true);
  });

  it("returns 404 for a disabled link and for the token a reset replaces", async () => {
    const receiver = await createReceiver(ctx, { company: "Reset Dock LLC", contactEmails: [] });
    const first = await openReceiver(receiver.token);
    expect(first.status).toBe(200);

    const cookie = await sessionCookie(adminSession());
    const headers = { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" };
    const disabled = await patchReceiver(
      new Request(`http://portal.test/api/admin/receivers/${receiver.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ enabled: false }),
      }),
      { params: Promise.resolve({ id: receiver.id }) },
    );
    expect((await disabled.json()).receiver.enabled).toBe(false);
    expect((await openReceiver(receiver.token)).status).toBe(404);
    await expect(ReceiverLinkPage({ params: Promise.resolve({ token: receiver.token }) })).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
    expect(await receiverPortal(ctx, receiver.token)).toBeNull();

    await updateReceiver(ctx, receiver.id, { enabled: true });
    const regenerated = await regenerateLink(
      new Request(`http://portal.test/api/admin/receivers/${receiver.id}/regenerate`, { method: "POST", headers }),
      { params: Promise.resolve({ id: receiver.id }) },
    );
    const next = (await regenerated.json()).receiver as { token: string };
    expect(next.token).not.toBe(receiver.token);
    expect((await openReceiver(receiver.token)).status).toBe(404);
    await expect(ReceiverLinkPage({ params: Promise.resolve({ token: receiver.token }) })).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
    expect((await openReceiver(next.token)).status).toBe(200);

    const missing = await openReceiver("not-a-real-receiver-token-value");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "This link is not valid." });
    await expect(ReceiverLinkPage({ params: Promise.resolve({ token: "not-a-real-receiver-token-value" }) })).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
  });
});
