import { beforeAll, describe, expect, it } from "vitest";
import { PUT as replaceSites } from "@/app/api/admin/sites/route";
import { POST as checkLocation } from "@/app/api/locations/check/route";
import { PATCH as patchLocation } from "@/app/api/locations/[id]/route";
import { POST as mergeLocation } from "@/app/api/locations/[id]/merge/route";
import { GET as listLocations } from "@/app/api/locations/route";
import { GET as listSitesRoute } from "@/app/api/sites/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { listOrders } from "@/lib/orders";
import { addressKey, companySimilar, isLikelyDuplicate, matchStrength } from "@/lib/location-match";
import type { PortalContext } from "@/lib/db";
import type { Session } from "@/lib/types";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;

beforeAll(async () => {
  ctx = await seededPortal();
});

function emitAdminSession(): Session {
  return { userId: "emit-admin-1", email: "lead@emit.example", name: "Emit Lead", role: "emit_admin" };
}

function headers(cookie: string): HeadersInit {
  return { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" };
}

const yard = {
  company: "EMIT ALLEN",
  address1: "2437 Allen Avenue",
  city: "Sheridan",
  state: "WY",
  postalCode: "82801",
  country: "US",
};

function orderBody(salesOrderNumber: string, destination: Record<string, string>, extra?: Record<string, unknown>) {
  return {
    salesOrderNumber,
    stops: [
      { id: "pickup-1", kind: "pickup", place: yard },
      { id: "drop-1", kind: "drop", place: destination, ...extra },
    ],
  };
}

describe("duplicate detection", () => {
  it("treats suffix, suite, case, and ZIP+4 as the same street", () => {
    const allen = { company: "EMIT ALLEN", address1: "2437 Allen Avenue", city: "Sheridan", state: "WY", postalCode: "82801" };
    expect(matchStrength(allen, { ...allen, address1: "2437 allen ave" })).toBe("exact");
    expect(
      matchStrength(
        { company: "Encore", address1: "3606 Encore Ave.", city: "Millsap", state: "TX", postalCode: "76066" },
        { company: "Encore", address1: "3606 Encore Avenue", city: "Millsap", state: "TX", postalCode: "76066" },
      ),
    ).toBe("exact");
    expect(
      matchStrength(
        { company: "Enchanted Rock", address1: "1850 Mound Road Suite 4", city: "Cypress", state: "TX", postalCode: "77433" },
        { company: "Enchanted Rock LLC", address1: "1850 Mound Rd Ste 4", city: "Cypress", state: "TX", postalCode: "77433-1000" },
      ),
    ).toBe("exact");
    expect(addressKey({ address1: "10443 Fisher Rd,", city: "Houston", state: "TX", postalCode: "77041" })).toBe(
      addressKey({ address1: "10443 Fisher Road", city: "Houston", state: "TX", postalCode: "77041" }),
    );
    expect(companySimilar("Kodiak Gas Services", "Kodiak Gas Services LLC")).toBe(true);
    expect(companySimilar("Kodiak Gas", "Kodiak Gas Services")).toBe(true);
    expect(
      isLikelyDuplicate(
        { company: "Kodiak Gas", address1: "6801 Brooklyn Ct", city: "Oklahoma City", state: "OK", postalCode: "" },
        { company: "Kodiak Gas Services", address1: "6801 Brooklyn Court", city: "Oklahoma City", state: "OK", postalCode: "73132" },
      ),
    ).toBe(true);
  });

  it("does not match a different street, city, or an unrelated company with a different ZIP", () => {
    expect(
      matchStrength(
        { company: "EMIT ALLEN", address1: "2437 Allen Avenue", city: "Sheridan", state: "WY", postalCode: "82801" },
        { company: "EMIT NORTH", address1: "2571 North Main Street", city: "Sheridan", state: "WY", postalCode: "82801" },
      ),
    ).toBeNull();
    expect(
      matchStrength(
        { company: "Kodiak", address1: "6801 Brooklyn Court", city: "Oklahoma City", state: "OK", postalCode: "73132" },
        { company: "Kodiak", address1: "6801 Brooklyn Court", city: "Tulsa", state: "OK", postalCode: "73132" },
      ),
    ).toBeNull();
    expect(
      matchStrength(
        { company: "Northwind", address1: "6801 Brooklyn Court", city: "Oklahoma City", state: "OK", postalCode: "73132" },
        { company: "Kodiak Gas Services", address1: "6801 Brooklyn Court", city: "Oklahoma City", state: "OK", postalCode: "99999" },
      ),
    ).toBeNull();
    expect(
      matchStrength(
        { company: "Kodiak Gas Services", address1: "6801 Brooklyn Court", city: "Oklahoma City", state: "OK", postalCode: "73132" },
        { company: "Kodiak Gas Services LLC", address1: "6801 Brooklyn Court", city: "Oklahoma City", state: "OK", postalCode: "" },
      ),
    ).toBe("likely");
  });

  it("reuses an exact drop and refuses a likely one until save-as-new", async () => {
    const cookie = await sessionCookie(customerSession());
    const place = {
      company: "Permian Widgets LLC",
      address1: "900 Unique Dock Road",
      city: "Midland",
      state: "TX",
      postalCode: "79701",
      country: "US",
    };
    const first = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(cookie),
        body: JSON.stringify(orderBody("SO-LOC-1", place)),
      }),
    );
    expect(first.status).toBe(201);
    const again = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(cookie),
        body: JSON.stringify(
          orderBody("SO-LOC-2", { ...place, address1: "900 unique dock rd.", company: "Permian Widgets" }),
        ),
      }),
    );
    expect(again.status).toBe(201);
    const rows = (await ctx.db
      .prepare(`SELECT id, use_count FROM locations WHERE kind = 'drop' AND city = 'Midland' AND address1 LIKE '900%'`)
      .all()) as Array<{ id: string; use_count: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].use_count).toBe(2);

    const fuzzy = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(cookie),
        body: JSON.stringify(orderBody("SO-LOC-FUZZY", { ...place, postalCode: "79702", company: "Permian Widgets" })),
      }),
    );
    expect(fuzzy.status).toBe(409);
    const conflict = await fuzzy.json();
    expect(conflict.error).toMatch(/duplicate of/i);
    expect(conflict.duplicates[0].location.company).toMatch(/Permian Widgets/);
    expect(conflict.duplicates[0].stopId).toBe("drop-1");

    const forced = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(cookie),
        body: JSON.stringify(
          orderBody("SO-LOC-NEW", { ...place, postalCode: "79702", company: "Permian Widgets" }, { saveAsNew: true }),
        ),
      }),
    );
    expect(forced.status).toBe(201);
    const after = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM locations WHERE kind = 'drop' AND city = 'Midland'`).get();
    expect(Number(after?.n)).toBe(2);
  });

  it("keeps a one-off pickup out of the yard list and stores it only as hidden history", async () => {
    const cookie = await sessionCookie(customerSession());
    const before = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM sites`).get();
    const created = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(cookie),
        body: JSON.stringify({
          salesOrderNumber: "SO-LOC-ONCE",
          stops: [
            {
              id: "pickup-1",
              kind: "pickup",
              place: {
                company: "Job trailer",
                address1: "77 Temporary Yard",
                city: "Gillette",
                state: "WY",
                postalCode: "82716",
                country: "US",
              },
            },
            {
              id: "drop-1",
              kind: "drop",
              place: {
                company: "Plain Drop Co",
                address1: "15 Side Street",
                city: "Gillette",
                state: "WY",
                postalCode: "82716",
                country: "US",
              },
            },
          ],
        }),
      }),
    );
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.order.stops[0].locationId).toBeNull();
    const after = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM sites`).get();
    expect(after?.n).toBe(before?.n);
    const sites = await listSitesRoute(new Request("http://portal.test/api/sites", { headers: { cookie } }));
    const siteBody = await sites.json();
    expect(siteBody.sites.some((site: { company: string }) => site.company === "Job trailer")).toBe(false);

    const hidden = await listLocations(
      new Request("http://portal.test/api/locations?kind=pickup_once&q=Temporary", { headers: { cookie } }),
    );
    const hiddenBody = await hidden.json();
    expect(hiddenBody.locations.some((row: { company: string }) => row.company === "Job trailer")).toBe(true);
    const tooShort = await listLocations(
      new Request("http://portal.test/api/locations?kind=pickup_once&q=t", { headers: { cookie } }),
    );
    expect((await tooShort.json()).locations).toEqual([]);

    const yardOrder = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(cookie),
        body: JSON.stringify({
          salesOrderNumber: "SO-LOC-YARD",
          origin: yard,
          destination: {
            company: "Plain Drop Co",
            address1: "15 Side Street",
            city: "Gillette",
            state: "WY",
            postalCode: "82716",
            country: "US",
          },
        }),
      }),
    );
    expect(yardOrder.status).toBe(201);
    const yardCount = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM sites`).get();
    expect(yardCount?.n).toBe(before?.n);
    const history = await ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM locations WHERE kind = 'pickup_once' AND company = 'EMIT ALLEN'`)
      .get();
    expect(Number(history?.n)).toBe(0);
  });

  it("links a drop to the receiver when the company matches, and merge re-points the load", async () => {
    const cookie = await sessionCookie(adminSession());
    const created = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(cookie),
        body: JSON.stringify(
          orderBody("SO-LOC-RCV", {
            company: "Enchanted Rock",
            address1: "42 Generator Way",
            city: "Cypress",
            state: "TX",
            postalCode: "77429",
            country: "US",
          }),
        ),
      }),
    );
    expect(created.status).toBe(201);
    const order = (await created.json()).order;
    expect(order.destination.company).toBe("Enchanted Rock LLC");
    const saved = (await ctx.db
      .prepare(`SELECT company, receiver_id FROM locations WHERE address1 = ?`)
      .get("42 Generator Way")) as { company: string; receiver_id: string | null };
    expect(saved.company).toBe("Enchanted Rock LLC");
    expect(saved.receiver_id).toBeTruthy();
    const found = await listOrders(ctx, { receiverCompany: "Enchanted Rock LLC", q: "SO-LOC-RCV" });
    expect(found.orders.some((row) => row.salesOrderNumber === "SO-LOC-RCV")).toBe(true);

    const target = await createOrderRoute(
      new Request("http://portal.test/api/orders", {
        method: "POST",
        headers: headers(cookie),
        body: JSON.stringify(
          orderBody("SO-LOC-KEEP", {
            company: "Kept Dock LLC",
            address1: "8 Kept Street",
            city: "Houston",
            state: "TX",
            postalCode: "77002",
            country: "US",
          }),
        ),
      }),
    );
    expect(target.status).toBe(201);
    const sourceId = (await ctx.db.prepare(`SELECT id FROM locations WHERE address1 = ?`).get("42 Generator Way")) as { id: string };
    const intoId = (await ctx.db.prepare(`SELECT id FROM locations WHERE address1 = ?`).get("8 Kept Street")) as { id: string };
    const merged = await mergeLocation(
      new Request("http://portal.test/api/locations/merge", {
        method: "POST",
        headers: headers(cookie),
        body: JSON.stringify({ intoId: intoId.id }),
      }),
      { params: Promise.resolve({ id: sourceId.id }) },
    );
    expect(merged.status).toBe(200);
    const moved = (await ctx.db.prepare(`SELECT destination_json FROM loads WHERE sales_order_number = ?`).get("SO-LOC-RCV")) as {
      destination_json: string;
    };
    expect(JSON.parse(moved.destination_json).company).toBe("Kept Dock LLC");
    expect(JSON.parse(moved.destination_json).address1).toBe("8 Kept Street");
    const inactive = (await ctx.db.prepare(`SELECT active FROM locations WHERE id = ?`).get(sourceId.id)) as { active: number };
    expect(inactive.active).toBe(0);
  });

  it("lets an EMIT admin manage drops but not pickup sites, and redacts carrier notes", async () => {
    const customer = await sessionCookie(customerSession());
    const emit = await sessionCookie(emitAdminSession());
    const admin = await sessionCookie(adminSession());

    const denied = await listLocations(new Request("http://portal.test/api/locations?manage=1", { headers: { cookie: customer } }));
    expect(denied.status).toBe(403);
    const search = await listLocations(new Request("http://portal.test/api/locations?q=Permian", { headers: { cookie: customer } }));
    expect(search.status).toBe(200);
    const searchBody = await search.json();
    expect(searchBody.locations.length).toBeGreaterThan(0);
    expectNoSecrets(searchBody);

    const managed = await listLocations(new Request("http://portal.test/api/locations?manage=1", { headers: { cookie: emit } }));
    expect(managed.status).toBe(200);
    const locationId = (await managed.json()).locations[0].id as string;
    const patched = await patchLocation(
      new Request(`http://portal.test/api/locations/${locationId}`, {
        method: "PATCH",
        headers: headers(emit),
        body: JSON.stringify({
          company: "Permian Widgets LLC",
          address1: "900 Unique Dock Road",
          city: "Midland",
          state: "TX",
          postalCode: "79701",
          notes: "Carrier pay is $8,765.43 for BLACKHAWK INTERNAL-ONLY-SENTINEL. Dock opens at 7.",
        }),
      }),
      { params: Promise.resolve({ id: locationId }) },
    );
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    expect(patchedBody.location.notes).toBe("Dock opens at 7.");
    expect(patchedBody.location.notes).not.toMatch(/INTERNAL-ONLY-SENTINEL|BLACKHAWK|8765/);
    expectNoSecrets(patchedBody);
    expect(patchedBody.location.carrierPay).toBeUndefined();

    const sitesDenied = await replaceSites(
      new Request("http://portal.test/api/admin/sites", {
        method: "PUT",
        headers: headers(emit),
        body: JSON.stringify({ sites: [] }),
      }),
    );
    expect(sitesDenied.status).toBe(403);

    const mergeDenied = await mergeLocation(
      new Request("http://portal.test/api/locations/x/merge", {
        method: "POST",
        headers: headers(customer),
        body: JSON.stringify({ intoId: locationId }),
      }),
      { params: Promise.resolve({ id: "not-a-location" }) },
    );
    expect(mergeDenied.status).toBe(403);

    const checked = await checkLocation(
      new Request("http://portal.test/api/locations/check", {
        method: "POST",
        headers: headers(admin),
        body: JSON.stringify({
          kind: "drop",
          place: {
            company: "Permian Widgets",
            address1: "900 Unique Dock Rd",
            city: "Midland",
            state: "TX",
            postalCode: "79701",
          },
        }),
      }),
    );
    expect(checked.status).toBe(200);
    expect((await checked.json()).match.company).toMatch(/Permian Widgets/);
  });
});
