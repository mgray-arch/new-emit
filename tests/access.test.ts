import { beforeAll, describe, expect, it } from "vitest";
import { identityFromGoogle, identityFromMicrosoft } from "@/lib/auth-policy";
import { answerQuestion } from "@/lib/assistant";
import type { PortalContext } from "@/lib/db";
import { listCustomerDocuments } from "@/lib/documents";
import { getOrder, listAllOrders, listOrders } from "@/lib/orders";
import { GET as downloadDoc } from "@/app/api/documents/[id]/route";
import { POST as ask } from "@/app/api/ask/route";
import { GET as listOrdersRoute, POST as createOrderRoute } from "@/app/api/orders/route";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { GET as googleStart } from "@/app/api/auth/google/route";
import { expectNoSecrets, seededPortal, sessionCookie } from "./helpers";
import type { Session } from "@/lib/types";

let ctx: PortalContext;

beforeAll(async () => {
  ctx = await seededPortal();
});

function receiverSession(): Session {
  return { userId: "receiver-1", email: "ops@enchantedrock.example", name: "Enchanted Rock", role: "receiver" };
}

describe("sign-in providers", () => {
  it("sends EMIT and receivers to Microsoft and Select admins to Google", () => {
    expect(identityFromMicrosoft("m.gray@emit.com", null)).toEqual({ ok: true, role: "customer", email: "m.gray@emit.com" });
    expect(identityFromMicrosoft("mgray@goselect.com", null)).toMatchObject({ ok: false });
    expect(identityFromMicrosoft("someone@goselect.com", "Enchanted Rock LLC")).toMatchObject({ ok: false });
    expect(identityFromMicrosoft("ops@enchantedrock.example", "Enchanted Rock LLC")).toEqual({
      ok: true,
      role: "receiver",
      email: "ops@enchantedrock.example",
    });
    expect(identityFromMicrosoft("stranger@example.com", null)).toMatchObject({ ok: false });

    expect(
      identityFromGoogle({ email: "mgray@goselect.com", emailVerified: true, hostedDomain: "goselect.com" }),
    ).toEqual({ ok: true, role: "admin", email: "mgray@goselect.com" });
    expect(
      identityFromGoogle({ email: "dmartin@goselect.com", emailVerified: true, hostedDomain: "goselect.com" }),
    ).toEqual({ ok: true, role: "admin", email: "dmartin@goselect.com" });
    expect(identityFromGoogle({ email: "other@goselect.com", emailVerified: true, hostedDomain: "goselect.com" })).toMatchObject({
      ok: false,
    });
    expect(identityFromGoogle({ email: "m.gray@emit.com", emailVerified: true, hostedDomain: null })).toMatchObject({ ok: false });
    expect(identityFromGoogle({ email: "mgray@goselect.com", emailVerified: false, hostedDomain: "goselect.com" })).toMatchObject({
      ok: false,
    });
    expect(identityFromGoogle({ email: "mgray@gmail.com", emailVerified: true, hostedDomain: null })).toMatchObject({ ok: false });
  });

  it("leaves Google sign-in unconfigured until the client id exists", async () => {
    const previousId = process.env.GOOGLE_CLIENT_ID;
    const previousSecret = process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const response = await googleStart(new Request("http://portal.test/api/auth/google"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("google=unconfigured");
    if (previousId) process.env.GOOGLE_CLIENT_ID = previousId;
    if (previousSecret) process.env.GOOGLE_CLIENT_SECRET = previousSecret;
  });
});

describe("receivers see only their loads", () => {
  it("filters the list, the assistant, and documents to the destination company", async () => {
    const cookie = await sessionCookie(receiverSession());
    const response = await listOrdersRoute(new Request("http://portal.test/api/orders?pageSize=50", { headers: { cookie } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.orders.length).toBeGreaterThan(0);
    expect(body.total).toBeGreaterThanOrEqual(body.orders.length);
    expect(body.total).toBeLessThan(24);
    expect(body.orders.every((order: { destination: { company: string }; customerCost: number | null }) => {
      return order.destination.company === "Enchanted Rock LLC" && order.customerCost === null;
    })).toBe(true);
    expect(body.orders.some((order: { salesOrderNumber: string }) => order.salesOrderNumber === "SO2196")).toBe(false);
    expectNoSecrets(body);
    expect(body.stats.total).toBe(body.total);

    const kodiak = listAllOrders(ctx).find((order) => order.salesOrderNumber === "SO2196")!;
    const hidden = await getOrderRoute(new Request(`http://portal.test/api/orders/${kodiak.id}`, { headers: { cookie } }), {
      params: Promise.resolve({ id: kodiak.id }),
    });
    expect(hidden.status).toBe(404);

    const own = listOrders(ctx, { receiverCompany: "Enchanted Rock LLC" }).orders[0];
    const visible = await getOrderRoute(new Request(`http://portal.test/api/orders/${own.id}`, { headers: { cookie } }), {
      params: Promise.resolve({ id: own.id }),
    });
    expect(visible.status).toBe(200);
    const visibleBody = await visible.json();
    expect(visibleBody.order.customerCost).toBeNull();
    expect(visibleBody.order.destination.company).toBe("Enchanted Rock LLC");

    const created = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({
          salesOrderNumber: "SO-RCV",
          origin: { company: "EMIT Technologies", address1: "2437 Allen Avenue", city: "Sheridan", state: "WY", postalCode: "82801" },
          destination: { company: "Enchanted Rock LLC", address1: "1", city: "Cypress", state: "TX", postalCode: "77429" },
        }),
      }),
    );
    expect(created.status).toBe(403);

    const question = await ask(
      new Request("http://portal.test/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({ question: "where is SO2196?" }),
      }),
    );
    const answer = await question.json();
    expect(answer.text).not.toContain("900196-1");
    expect(answer.text).not.toContain("SO2196");
    expectNoSecrets(answer);

    const week = await answerQuestion(ctx, "what delivers this week?", { receiverCompany: "Enchanted Rock LLC" });
    expect(week.text).not.toContain("SO2196");
    expect(week.references.some((ref) => ref.salesOrderNumber === "SO2196")).toBe(false);
    expect(week.references.every((ref) => ref.destinationCity === "Cypress")).toBe(true);

    const bol = listCustomerDocuments(ctx, kodiak.id)[0];
    expect(bol).toBeTruthy();
    const download = await downloadDoc(new Request(`http://portal.test/api/documents/${bol.id}`, { headers: { cookie } }), {
      params: Promise.resolve({ id: bol.id }),
    });
    expect(download.status).toBe(404);
    expect(getOrder(ctx, kodiak.id, "Enchanted Rock LLC")).toBeNull();
  });
});
