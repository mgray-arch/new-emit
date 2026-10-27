import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PATCH as setOwnerRoute } from "@/app/api/admin/orders/[id]/owner/route";
import { GET as listOrdersRoute } from "@/app/api/orders/route";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { presentCustomerOrder } from "@/lib/customer-view";
import { formatEnteredBy } from "@/lib/entered-by";
import { assignLoadOwner } from "@/lib/load-owner";
import { loadBuilderPayload } from "@/lib/load-builder";
import { newLoadSlackText, slackUserIdForOwner } from "@/lib/slack-new-load";
import type { PortalContext } from "@/lib/db";
import type { CustomerOrder, Session } from "@/lib/types";
import { adminSession, customerSession, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  ctx = await seededPortal();
  for (const key of ["SLACK_NEW_LOADS_WEBHOOK_URL", "SLACK_USER_ID_DREW", "SLACK_USER_ID_AINSLEY"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SLACK_NEW_LOADS_WEBHOOK_URL;
  delete process.env.SLACK_USER_ID_DREW;
  delete process.env.SLACK_USER_ID_AINSLEY;
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function headers(cookie: string): HeadersInit {
  return { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" };
}

const emit = {
  company: "EMIT ALLEN",
  address1: "2437 Allen Avenue",
  city: "Sheridan",
  state: "WY",
  postalCode: "82801",
};

function destination(state: string) {
  return { company: "Receiver", address1: "100 Market", city: "Houston", state, postalCode: "77002" };
}

describe("load owner", () => {
  it("gives Drew flatbed and hot shot into Texas, and Ainsley everything else", () => {
    expect(assignLoadOwner({ destinationState: "TX", equipment: "53' Flatbed" })).toEqual({ owner: "Drew", needsCheck: false });
    expect(assignLoadOwner({ destinationState: "Texas", equipment: "Flatbed" })).toEqual({ owner: "Drew", needsCheck: false });
    expect(assignLoadOwner({ destinationState: "tx", equipment: "Hot Shot" })).toEqual({ owner: "Drew", needsCheck: false });
    expect(assignLoadOwner({ destinationState: "TX", equipment: "hot-shot" })).toEqual({ owner: "Drew", needsCheck: false });
    expect(assignLoadOwner({ destinationState: "CO", equipment: "48' Flatbed" })).toEqual({ owner: "Ainsley", needsCheck: false });
    expect(assignLoadOwner({ destinationState: "OK", equipment: "Hot Shot" })).toEqual({ owner: "Ainsley", needsCheck: false });
    expect(assignLoadOwner({ destinationState: "TX", equipment: "24' Box Truck" })).toEqual({ owner: "Ainsley", needsCheck: false });
    expect(assignLoadOwner({ destinationState: "TX", equipment: "Multi Stop Box Truck" })).toEqual({ owner: "Ainsley", needsCheck: false });
    expect(assignLoadOwner({ destinationState: "TX", equipment: "Sprinter Van" })).toEqual({ owner: "Ainsley", needsCheck: false });
    expect(assignLoadOwner({ destinationState: "TX", equipment: "Conestoga" })).toEqual({ owner: "Ainsley", needsCheck: false });
    expect(assignLoadOwner({ destinationState: "TX", equipment: "LTL" })).toEqual({ owner: "Ainsley", needsCheck: false });
    expect(assignLoadOwner({ destinationState: null, equipment: "Multi Stop Box Truck" })).toEqual({ owner: "Ainsley", needsCheck: true });
    expect(assignLoadOwner({ destinationState: "OK", equipment: null })).toEqual({ owner: "Ainsley", needsCheck: true });
    expect(assignLoadOwner({ destinationState: "TX", equipment: null })).toEqual({ owner: "Ainsley", needsCheck: true });
    expect(assignLoadOwner({ destinationState: "TX", equipment: "   " })).toEqual({ owner: "Ainsley", needsCheck: true });
    expect(assignLoadOwner({ destinationState: null, equipment: "53' Flatbed" })).toEqual({ owner: "Ainsley", needsCheck: true });
    expect(assignLoadOwner({ destinationState: null, equipment: null })).toEqual({ owner: "Ainsley", needsCheck: true });
  });
});

describe("new load slack text", () => {
  const notice = {
    salesOrderNumber: "SO-1",
    originCity: "Sheridan",
    originState: "WY",
    destinationCity: "Houston",
    destinationState: "TX",
    equipment: "53' Flatbed",
    owner: "Drew" as const,
    enteredByName: "Jane Doe",
    enteredByEmail: "jane@emit.example",
  };

  it("names the owner and who entered the load, and never includes a price", () => {
    const text = newLoadSlackText(notice, {});
    expect(text).toContain("Owner: Drew");
    expect(text).not.toContain("Needs a human check");
    expect(text).toContain("Entered by: Jane Doe (jane@emit.example)");
    expect(text).not.toMatch(/carrier|8765|customerCost|\$/i);
    const unclear = newLoadSlackText({ ...notice, owner: "Ainsley", equipment: null, needsCheck: true }, {});
    expect(unclear).toContain("Owner: Ainsley");
    expect(unclear).toContain("Needs a human check. Equipment or destination was missing.");
    expect(unclear).toContain("Equipment: not set");
    expect(unclear).not.toContain("<@");
  });

  it("mentions a Slack user id and falls back to the plain name", () => {
    expect(slackUserIdForOwner("Drew", {})).toBeNull();
    expect(slackUserIdForOwner("Drew", { SLACK_USER_ID_DREW: "not an id" })).toBeNull();
    expect(newLoadSlackText(notice, { SLACK_USER_ID_DREW: "UDREW123" })).toContain("Owner: <@UDREW123>");
    expect(newLoadSlackText({ ...notice, owner: "Ainsley" }, { SLACK_USER_ID_AINSLEY: "WAINSLEY1" })).toContain(
      "Owner: <@WAINSLEY1>",
    );
    expect(formatEnteredBy(null, null)).toBe("Unknown");
    expect(formatEnteredBy("M. Gray", null)).toBe("M. Gray");
    expect(formatEnteredBy(null, "jane@emit.example")).toBe("jane@emit.example");
    expect(formatEnteredBy("  ", "jane@emit.example")).toBe("jane@emit.example");
  });
});

describe("entered by on a new load", () => {
  it("stores the signed-in person and shows that name and email to EMIT and Select", async () => {
    const cookie = await sessionCookie(customerSession());
    const admin = await sessionCookie(adminSession());
    let posts: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      posts.push(`${url}\n${String(init?.body)}`);
      return new Response("ok", { status: 200 });
    });

    const quiet = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(cookie),
        body: JSON.stringify({
          salesOrderNumber: "SO-QUIET",
          origin: emit,
          destination: destination("TX"),
          truckType: "53' Flatbed",
          customerCost: 1750,
          comments: "carrier pay 8765.43 must stay out of slack",
        }),
      }),
    );
    expect(quiet.status).toBe(201);
    expect(posts).toHaveLength(0);
    const created = (await quiet.json()).order as CustomerOrder;
    expect(created.enteredByName).toBe("M. Gray");
    expect(created.enteredByEmail).toBe("m.gray@emit.example");
    expect(created).not.toHaveProperty("owner");
    expect(created).not.toHaveProperty("ownerNeedsCheck");
    const quietRow = (await ctx.db.prepare(`SELECT owner, owner_needs_check FROM loads WHERE sales_order_number = ?`).get("SO-QUIET")) as {
      owner: string;
      owner_needs_check: number;
    };
    expect(quietRow).toEqual({ owner: "Drew", owner_needs_check: 0 });
    expect(formatEnteredBy(created.enteredByName, created.enteredByEmail)).toBe("M. Gray (m.gray@emit.example)");
    expect(created.customerCost).toBeUndefined();
    expect(created.pendingReviewCount).toBeUndefined();
    expect(JSON.stringify(created)).not.toMatch(/carrierPay|carrier_pay|pendingReviewCount|samBuild/);

    process.env.SLACK_NEW_LOADS_WEBHOOK_URL = "https://hooks.slack.test/new-loads";
    process.env.SLACK_USER_ID_DREW = "UDREW123";
    const sent = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(cookie),
        body: JSON.stringify({
          salesOrderNumber: "SO-SLACK",
          origin: emit,
          destination: destination("TX"),
          truckType: "Hot Shot",
          customerCost: 1800,
        }),
      }),
    );
    expect(sent.status).toBe(201);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("https://hooks.slack.test/new-loads");
    expect(posts[0]).toContain("Owner: <@UDREW123>");
    expect(posts[0]).toContain("Entered by: M. Gray (m.gray@emit.example)");
    expect(posts[0]).not.toMatch(/1800|1750|carrier|8765/);

    const id = ((await sent.json()).order as CustomerOrder).id;
    const selectView = await getOrderRoute(new Request("http://portal.test/api/orders/" + id, { headers: headers(admin) }), {
      params: Promise.resolve({ id }),
    });
    const selectOrder = (await selectView.json()).order as CustomerOrder;
    expect(selectOrder.enteredByName).toBe("M. Gray");
    expect(selectOrder.enteredByEmail).toBe("m.gray@emit.example");
    expect(selectOrder.owner).toBe("Drew");
    expect(selectOrder.ownerNeedsCheck).toBe(false);
    expect(formatEnteredBy(selectOrder.enteredByName, selectOrder.enteredByEmail)).toBe("M. Gray (m.gray@emit.example)");

    const emitView = await getOrderRoute(new Request("http://portal.test/api/orders/" + id, { headers: headers(cookie) }), {
      params: Promise.resolve({ id }),
    });
    const emitOrder = (await emitView.json()).order as CustomerOrder;
    expect(emitOrder.enteredByName).toBe("M. Gray");
    expect(emitOrder.enteredByEmail).toBe("m.gray@emit.example");
    expect(emitOrder).not.toHaveProperty("owner");
    expect(emitOrder).not.toHaveProperty("ownerNeedsCheck");
    expect(emitOrder.customerCost).toBeUndefined();
    expect(emitOrder.pendingReviewCount).toBeUndefined();
    expect(JSON.stringify(emitOrder)).not.toMatch(/carrierPay|carrier_pay|8765|pendingReviewCount|samBuild/);

    const viewer = await sessionCookie({
      userId: "emit-viewer-1",
      email: "viewer@emit.example",
      name: "View Only",
      role: "emit_viewer",
    });
    const viewerDetail = await getOrderRoute(new Request("http://portal.test/api/orders/" + id, { headers: headers(viewer) }), {
      params: Promise.resolve({ id }),
    });
    const viewerOrder = (await viewerDetail.json()).order as CustomerOrder;
    expect(formatEnteredBy(viewerOrder.enteredByName, viewerOrder.enteredByEmail)).toBe("M. Gray (m.gray@emit.example)");
    expect(viewerOrder.customerCost).toBeUndefined();

    const lead = await sessionCookie({
      userId: "emit-admin-1",
      email: "lead@emit.example",
      name: "EMIT Lead",
      role: "emit_admin",
    });
    const leadDetail = await getOrderRoute(new Request("http://portal.test/api/orders/" + id, { headers: headers(lead) }), {
      params: Promise.resolve({ id }),
    });
    const leadOrder = (await leadDetail.json()).order as CustomerOrder;
    expect(leadOrder.enteredByEmail).toBe("m.gray@emit.example");
    expect(leadOrder.customerCost).toBeNull();
    expect(leadOrder.pendingReviewCount).toBeUndefined();

    const preview = presentCustomerOrder(selectOrder, { role: "admin", viewAs: { access: "regular", permission: "add" } });
    expect(preview.enteredByName).toBe("M. Gray");
    expect(preview.enteredByEmail).toBe("m.gray@emit.example");
    expect(preview).not.toHaveProperty("owner");
    expect(preview).not.toHaveProperty("ownerNeedsCheck");
    expect(preview.customerCost).toBeUndefined();
    expect(preview.pendingReviewCount).toBeUndefined();
    expect(JSON.stringify(preview)).not.toMatch(/carrierPay|carrier_pay|8765|pendingReviewCount|samBuild/);

    const viewAs = await getOrderRoute(
      new Request("http://portal.test/api/orders/" + id, { headers: headers(`${admin}; portal_view_as=regular:view`) }),
      { params: Promise.resolve({ id }) },
    );
    const viewAsOrder = (await viewAs.json()).order as CustomerOrder;
    expect(viewAsOrder.enteredByEmail).toBe("m.gray@emit.example");
    expect(viewAsOrder).not.toHaveProperty("owner");
    expect(viewAsOrder.customerCost).toBeUndefined();
    expect(viewAsOrder.pendingReviewCount).toBeUndefined();
    expect(JSON.stringify(viewAsOrder)).not.toMatch(/carrierPay|carrier_pay|samBuild/);

    const payload = loadBuilderPayload({
      ...selectOrder,
      carrierPay: 8765.43,
    } as CustomerOrder);
    expect(JSON.stringify(payload)).not.toMatch(/enteredBy|m\.gray@emit\.example|carrierPay|8765|ownerNeedsCheck/);
    expect(payload.createdBy).toBe("M. Gray");
    expect(payload.owner).toEqual({ name: selectOrder.owner, slackUserId: expect.any(String) });

    const older = await ctx.db.prepare(`SELECT id FROM loads WHERE entered_by_email IS NULL LIMIT 1`).get();
    const oldId = String(older?.id);
    const oldSelect = await getOrderRoute(new Request("http://portal.test/api/orders/" + oldId, { headers: headers(admin) }), {
      params: Promise.resolve({ id: oldId }),
    });
    const oldOrder = (await oldSelect.json()).order as CustomerOrder;
    expect(oldOrder.enteredByName).toBeNull();
    expect(oldOrder.enteredByEmail).toBeNull();
    expect(formatEnteredBy(oldOrder.enteredByName, oldOrder.enteredByEmail)).toBe("Unknown");
  });

  it("stores Ainsley when the equipment is missing, mentions her, and does not ping again on reassignment", async () => {
    process.env.SLACK_NEW_LOADS_WEBHOOK_URL = "https://hooks.slack.test/new-loads";
    process.env.SLACK_USER_ID_AINSLEY = "UAINSLEY1";
    const posts: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      posts.push(`${url}\n${String(init?.body)}`);
      return new Response("ok", { status: 200 });
    });
    const cookie = await sessionCookie(customerSession());
    const admin = await sessionCookie(adminSession());
    const created = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(cookie),
        body: JSON.stringify({
          salesOrderNumber: "SO-CHECK",
          origin: emit,
          destination: destination("TX"),
          customerCost: 2200,
        }),
      }),
    );
    expect(created.status).toBe(201);
    const emitOrder = (await created.json()).order as CustomerOrder;
    expect(emitOrder).not.toHaveProperty("owner");
    expect(JSON.stringify(emitOrder)).not.toMatch(/"owner"|Ainsley|2200/);
    const id = emitOrder.id;
    const row = (await ctx.db.prepare(`SELECT owner, owner_needs_check FROM loads WHERE id = ?`).get(id)) as {
      owner: string;
      owner_needs_check: number;
    };
    expect(row).toEqual({ owner: "Ainsley", owner_needs_check: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("Owner: <@UAINSLEY1>");
    expect(posts[0]).toContain("Needs a human check. Equipment or destination was missing.");
    expect(posts[0]).not.toMatch(/2200|carrier|8765/);

    const listed = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO-CHECK", { headers: headers(cookie) }));
    expect(JSON.stringify(await listed.json())).not.toMatch(/"owner"|ownerNeedsCheck|Ainsley/);
    const selectList = await listOrdersRoute(new Request("http://portal.test/api/orders?q=SO-CHECK", { headers: headers(admin) }));
    const selectRow = (await selectList.json()).orders.find((order: CustomerOrder) => order.id === id);
    expect(selectRow.owner).toBe("Ainsley");
    expect(selectRow.ownerNeedsCheck).toBe(true);

    const moved = await setOwnerRoute(
      new Request(`http://portal.test/api/admin/orders/${id}/owner`, {
        method: "PATCH",
        headers: headers(admin),
        body: JSON.stringify({ owner: "Drew" }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(moved.status).toBe(200);
    expect((await moved.json()).order).toMatchObject({ owner: "Drew", ownerNeedsCheck: false });
    expect(posts).toHaveLength(1);

    const denied = await setOwnerRoute(
      new Request(`http://portal.test/api/admin/orders/${id}/owner`, {
        method: "PATCH",
        headers: headers(cookie),
        body: JSON.stringify({ owner: "Ainsley" }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(denied.status).toBe(403);
    const after = (await ctx.db.prepare(`SELECT owner FROM loads WHERE id = ?`).get(id)) as { owner: string };
    expect(after.owner).toBe("Drew");
    expect(posts).toHaveLength(1);

    const preview = await getOrderRoute(
      new Request("http://portal.test/api/orders/" + id, { headers: headers(`${admin}; portal_view_as=regular:add`) }),
      { params: Promise.resolve({ id }) },
    );
    expect((await preview.json()).order).not.toHaveProperty("owner");
  });

  it("still saves the load when Slack does not answer", async () => {
    process.env.SLACK_NEW_LOADS_WEBHOOK_URL = "https://hooks.slack.test/down";
    vi.stubGlobal("fetch", async () => {
      throw new Error("slack down");
    });
    const response = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(await sessionCookie({ ...customerSession(), name: "Jane Doe", email: "jane@emit.example" } satisfies Session)),
        body: JSON.stringify({
          salesOrderNumber: "SO-SLACK-DOWN",
          origin: emit,
          destination: destination("CO"),
          truckType: "20' Box Truck",
        }),
      }),
    );
    expect(response.status).toBe(201);
  });
});
