import { beforeAll, describe, expect, it } from "vitest";
import { identityFromGoogle, identityFromMicrosoft } from "@/lib/auth-policy";
import { answerQuestion } from "@/lib/assistant";
import type { PortalContext } from "@/lib/db";
import { listCustomerDocuments } from "@/lib/documents";
import { getOrder, listAllOrders } from "@/lib/orders";
import { DELETE as deleteReceiver, PATCH as patchReceiver } from "@/app/api/admin/receivers/[id]/route";
import { POST as regenerateLink } from "@/app/api/admin/receivers/[id]/regenerate/route";
import { GET as listReceiversRoute, POST as createReceiverRoute } from "@/app/api/admin/receivers/route";
import { GET as downloadDoc } from "@/app/api/documents/[id]/route";
import { GET as receiverPortal } from "@/app/api/r/[token]/route";
import { GET as googleStart } from "@/app/api/auth/google/route";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;

beforeAll(async () => {
  ctx = await seededPortal();
});

async function enchantedToken(): Promise<string> {
  const row = (await ctx.db.prepare(`SELECT access_token FROM receivers WHERE company = ?`).get("Enchanted Rock LLC")) as {
    access_token: string;
  };
  return row.access_token;
}

describe("sign-in providers", () => {
  it("sends EMIT staff to Microsoft and Select admins to Google", () => {
    expect(identityFromMicrosoft("m.gray@emit.com")).toEqual({ ok: true, role: "customer", email: "m.gray@emit.com" });
    expect(identityFromMicrosoft("mgray@goselect.com")).toMatchObject({ ok: false });
    expect(identityFromMicrosoft("someone@goselect.com")).toMatchObject({ ok: false });
    expect(identityFromMicrosoft("ops@enchantedrock.example")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/private link/i),
    });
    expect(identityFromMicrosoft("stranger@example.com")).toMatchObject({ ok: false });

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

describe("receiver private links", () => {
  it("shows only that company's loads, status, lane, and tracking link", async () => {
    const token = await enchantedToken();
    const response = await receiverPortal(new Request(`http://portal.test/api/r/${token}`), {
      params: Promise.resolve({ token }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.company).toBe("Enchanted Rock LLC");
    expect(body.loads.length).toBeGreaterThan(0);
    expect(body.loads.length).toBeLessThan(24);
    expect(
      body.loads.every((load: { stops: Array<{ kind: string; city: string; state: string }> }) =>
        load.stops.some((stop) => stop.kind === "drop" && stop.city && stop.state),
      ),
    ).toBe(true);
    expect(body.loads.some((load: { loadNumber: string | null }) => load.loadNumber === "900196-1")).toBe(false);
    expect(body.loads[0].customerCost).toBeUndefined();
    expect(body.loads[0].documents).toBeUndefined();
    expect(body.loads[0].photos).toBeUndefined();
    expect(body.loads[0].salesOrderNumber).toBeUndefined();
    expect(body.loads[0].trackingUrl).toBeUndefined();
    expect(body.loads[0].stops[0].company).toBeUndefined();
    expect(body.loads[0].stops[0].city).toEqual(expect.any(String));
    expect(body.loads[0].comments).toBeUndefined();
    expectNoSecrets(body);

    const missing = await receiverPortal(new Request("http://portal.test/api/r/not-a-real-receiver-token-value"), {
      params: Promise.resolve({ token: "not-a-real-receiver-token-value" }),
    });
    expect(missing.status).toBe(404);

    const kodiak = (await listAllOrders(ctx)).find((order) => order.salesOrderNumber === "SO2196")!;
    expect(kodiak.customerCost).not.toBeNull();
    expect(await getOrder(ctx, kodiak.id, "Enchanted Rock LLC")).toBeNull();
    const bol = (await listCustomerDocuments(ctx, kodiak.id))[0];
    const download = await downloadDoc(new Request(`http://portal.test/api/documents/${bol.id}`), {
      params: Promise.resolve({ id: bol.id }),
    });
    expect(download.status).toBe(401);

    const week = await answerQuestion(ctx, "what delivers this week?");
    expect(week.references.some((ref) => ref.salesOrderNumber === "SO2196")).toBe(true);
  });

  it("lets an admin add, edit, disable, regenerate, and remove a receiver", async () => {
    const cookie = await sessionCookie(adminSession());
    const headers = { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" };
    const created = await createReceiverRoute(
      new Request("http://portal.test/api/admin/receivers", {
        method: "POST",
        headers,
        body: JSON.stringify({ company: "Kodiak Gas Services", contactEmails: ["dock@kodiak.example"] }),
      }),
    );
    expect(created.status).toBe(201);
    const receiver = (await created.json()).receiver;
    expect(receiver.token.length).toBeGreaterThan(20);
    expect(receiver.contactEmails).toEqual(["dock@kodiak.example"]);
    const firstUrl = await receiverPortal(new Request(`http://portal.test/api/r/${receiver.token}`), {
      params: Promise.resolve({ token: receiver.token }),
    });
    const firstBody = await firstUrl.json();
    expect(firstBody.loads.some((load: { loadNumber: string }) => load.loadNumber === "900196-1")).toBe(true);
    expect(firstBody.loads[0].photos).toBeUndefined();
    expectNoSecrets(firstBody);

    const edited = await patchReceiver(
      new Request(`http://portal.test/api/admin/receivers/${receiver.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ contactEmails: ["dock@kodiak.example", "ops@kodiak.example"] }),
      }),
      { params: Promise.resolve({ id: receiver.id }) },
    );
    expect((await edited.json()).receiver.contactEmails).toEqual(["dock@kodiak.example", "ops@kodiak.example"]);

    const disabled = await patchReceiver(
      new Request(`http://portal.test/api/admin/receivers/${receiver.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ enabled: false }),
      }),
      { params: Promise.resolve({ id: receiver.id }) },
    );
    expect((await disabled.json()).receiver.enabled).toBe(false);
    const blocked = await receiverPortal(new Request(`http://portal.test/api/r/${receiver.token}`), {
      params: Promise.resolve({ token: receiver.token }),
    });
    expect(blocked.status).toBe(404);

    await patchReceiver(
      new Request(`http://portal.test/api/admin/receivers/${receiver.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ enabled: true }),
      }),
      { params: Promise.resolve({ id: receiver.id }) },
    );
    const restored = await receiverPortal(new Request(`http://portal.test/api/r/${receiver.token}`), {
      params: Promise.resolve({ token: receiver.token }),
    });
    expect(restored.status).toBe(200);

    const regenerated = await regenerateLink(
      new Request(`http://portal.test/api/admin/receivers/${receiver.id}/regenerate`, { method: "POST", headers }),
      { params: Promise.resolve({ id: receiver.id }) },
    );
    const next = (await regenerated.json()).receiver;
    expect(next.token).not.toBe(receiver.token);
    const oldLink = await receiverPortal(new Request(`http://portal.test/api/r/${receiver.token}`), {
      params: Promise.resolve({ token: receiver.token }),
    });
    expect(oldLink.status).toBe(404);
    const newLink = await receiverPortal(new Request(`http://portal.test/api/r/${next.token}`), {
      params: Promise.resolve({ token: next.token }),
    });
    expect(newLink.status).toBe(200);

    const removed = await deleteReceiver(
      new Request(`http://portal.test/api/admin/receivers/${receiver.id}`, { method: "DELETE", headers }),
      { params: Promise.resolve({ id: receiver.id }) },
    );
    expect(removed.status).toBe(200);
    const gone = await receiverPortal(new Request(`http://portal.test/api/r/${next.token}`), {
      params: Promise.resolve({ token: next.token }),
    });
    expect(gone.status).toBe(404);

    const customer = await sessionCookie(customerSession());
    const forbidden = await listReceiversRoute(
      new Request("http://portal.test/api/admin/receivers", { headers: { cookie: customer } }),
    );
    expect(forbidden.status).toBe(403);
  });
});
