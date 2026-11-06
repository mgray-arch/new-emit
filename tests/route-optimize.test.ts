import { describe, expect, it } from "vitest";
import { POST as optimizeRoute } from "@/app/api/route-optimize/route";
import {
  applyStopOrder,
  censusGeocoder,
  haversineMiles,
  optimizeStops,
  planRoute,
  placeQuery,
  type LatLng,
} from "@/lib/route-optimize";
import { resolveSalesOrders } from "@/lib/sales-orders";
import { customerSession, sessionCookie } from "./helpers";

const SHERIDAN = { lat: 44.797, lng: -106.956 };
const CASPER = { lat: 42.866, lng: -106.313 };
const DENVER = { lat: 39.739, lng: -104.99 };
const OKC = { lat: 35.468, lng: -97.516 };

describe("route optimizer", () => {
  it("measures straight-line miles", () => {
    expect(Math.round(haversineMiles(DENVER, OKC))).toBeGreaterThan(490);
    expect(Math.round(haversineMiles(DENVER, OKC))).toBeLessThan(510);
  });

  it("keeps pickups first and orders drops by distance", () => {
    const plan = planRoute([
      { id: "p", kind: "pickup", point: SHERIDAN },
      { id: "okc", kind: "drop", point: OKC },
      { id: "casper", kind: "drop", point: CASPER },
      { id: "denver", kind: "drop", point: DENVER },
    ]);
    expect(plan.optimizedOrder).toEqual(["p", "casper", "denver", "okc"]);
    expect(plan.optimizedMiles).toBeLessThan(plan.currentMiles);
    expect(plan.unchanged).toBe(false);
  });

  it("moves a drop entered before the pickup to after it", () => {
    const plan = planRoute([
      { id: "d", kind: "drop", point: DENVER },
      { id: "p", kind: "pickup", point: SHERIDAN },
      { id: "c", kind: "drop", point: CASPER },
    ]);
    expect(plan.optimizedOrder).toEqual(["p", "c", "d"]);
  });

  it("says unchanged when the route is already best", () => {
    const plan = planRoute([
      { id: "p", kind: "pickup", point: SHERIDAN },
      { id: "c", kind: "drop", point: CASPER },
      { id: "d", kind: "drop", point: DENVER },
    ]);
    expect(plan.unchanged).toBe(true);
    expect(plan.optimizedMiles).toBe(plan.currentMiles);
  });

  it("handles more drops than the exact limit", () => {
    const points: LatLng[] = Array.from({ length: 11 }, (_, i) => ({ lat: 35 + i, lng: -100 }));
    const shuffled = [5, 0, 9, 2, 7, 1, 10, 3, 8, 4, 6];
    const plan = planRoute([
      { id: "p", kind: "pickup", point: { lat: 34, lng: -100 } },
      ...shuffled.map((i) => ({ id: `d${i}`, kind: "drop" as const, point: points[i] })),
    ]);
    expect(plan.optimizedOrder).toEqual(["p", ...points.map((_, i) => `d${i}`)]);
  });

  it("applies the order and SO lines follow their drops", () => {
    const stops = [
      { id: "p", kind: "pickup" },
      { id: "a", kind: "drop" },
      { id: "b", kind: "drop" },
    ];
    const lines = [
      { number: "SO1", stopId: "a" },
      { number: "SO2", stopId: "b" },
    ];
    const moved = applyStopOrder(stops, ["p", "b", "a"]);
    expect(moved.map((s) => s.id)).toEqual(["p", "b", "a"]);
    expect(resolveSalesOrders(lines, moved)).toEqual(lines);
    expect(() => applyStopOrder(stops, ["p", "a"])).toThrow(/optimize again/i);
  });

  it("reports addresses it cannot find", async () => {
    const place = { company: "X", address1: "1 Main", city: "Nowhere", state: "ZZ", postalCode: "", country: "US" };
    const result = await optimizeStops(
      [
        { id: "p", kind: "pickup", place },
        { id: "d", kind: "drop", place: { ...place, city: "Somewhere" } },
      ],
      async (p) => (p.city === "Nowhere" ? SHERIDAN : null),
    );
    expect(result).toMatchObject({ missing: ["d"] });
  });

  it("parses the Census geocoder response and caches it", async () => {
    let calls = 0;
    const fakeFetch = (async (url: string) => {
      calls += 1;
      expect(url).toContain("geocoding.geo.census.gov");
      expect(url).toContain(encodeURIComponent("1 Main").replace(/%20/g, "+"));
      return new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { x: -106.9, y: 44.8 } }] } }));
    }) as unknown as typeof fetch;
    const geocode = censusGeocoder(fakeFetch);
    const place = { company: "X", address1: "1 Main", city: "Sheridan", state: "WY", postalCode: "82801", country: "US" };
    expect(placeQuery(place)).toBe("1 Main, Sheridan, WY 82801");
    expect(await geocode(place)).toEqual({ lat: 44.8, lng: -106.9 });
    expect(await geocode(place)).toEqual({ lat: 44.8, lng: -106.9 });
    expect(calls).toBe(1);
  });

  it("requires a signed-in user and two drops", async () => {
    const unauth = await optimizeRoute(
      new Request("http://portal.test/api/route-optimize", { method: "POST", body: "{}", headers: { host: "portal.test" } }),
    );
    expect(unauth.status).toBe(401);
    const cookie = await sessionCookie(customerSession());
    const place = { company: "X", address1: "1 Main", city: "Sheridan", state: "WY", postalCode: "82801", country: "US" };
    const oneDrop = await optimizeRoute(
      new Request("http://portal.test/api/route-optimize", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, host: "portal.test", origin: "http://portal.test" },
        body: JSON.stringify({
          stops: [
            { id: "p", kind: "pickup", place },
            { id: "d", kind: "drop", place },
          ],
        }),
      }),
    );
    expect(oneDrop.status).toBe(400);
  });
});
