import type { Place, StopKind } from "@/lib/types";

/**
 * Drop-order optimizer for multi-stop loads. Pickups stay first, in the order entered;
 * the drops are reordered to make the shortest open route (no return trip).
 * Miles are straight-line distance times ROAD_FACTOR, an estimate, not routed road miles.
 */
export interface LatLng {
  lat: number;
  lng: number;
}

export interface RoutePoint {
  id: string;
  kind: StopKind;
  point: LatLng;
}

export interface RoutePlan {
  currentOrder: string[];
  optimizedOrder: string[];
  currentMiles: number;
  optimizedMiles: number;
  /** True when the optimized order is the same as the current one. */
  unchanged: boolean;
}

/** Typical ratio of road miles to straight-line miles for US truck lanes. */
export const ROAD_FACTOR = 1.2;
/** Up to this many drops every order is tried; above it, nearest neighbor plus 2-opt. */
export const EXACT_DROP_LIMIT = 8;
export const MAX_ROUTE_STOPS = 25;

export function haversineMiles(a: LatLng, b: LatLng): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function legMiles(a: LatLng, b: LatLng): number {
  return haversineMiles(a, b) * ROAD_FACTOR;
}

export function routeMiles(points: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += legMiles(points[i - 1], points[i]);
  return total;
}

function pathMiles(start: LatLng | null, path: RoutePoint[]): number {
  return routeMiles([...(start ? [start] : []), ...path.map((stop) => stop.point)]);
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) out.push([item, ...tail]);
  });
  return out;
}

function nearestNeighbor(start: LatLng | null, drops: RoutePoint[]): RoutePoint[] {
  const left = [...drops];
  const out: RoutePoint[] = [];
  let at = start ?? left[0]?.point;
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i += 1) {
      if (legMiles(at!, left[i].point) < legMiles(at!, left[best].point)) best = i;
    }
    const [next] = left.splice(best, 1);
    out.push(next);
    at = next.point;
  }
  return out;
}

function twoOpt(start: LatLng | null, path: RoutePoint[]): RoutePoint[] {
  let best = path;
  let bestMiles = pathMiles(start, best);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i += 1) {
      for (let k = i + 1; k < best.length; k += 1) {
        const candidate = [...best.slice(0, i), ...best.slice(i, k + 1).reverse(), ...best.slice(k + 1)];
        const miles = pathMiles(start, candidate);
        if (miles + 1e-9 < bestMiles) {
          best = candidate;
          bestMiles = miles;
          improved = true;
        }
      }
    }
  }
  return best;
}

/** Best drop order after the given start point. Ties keep the entered order. */
export function bestDropOrder(start: LatLng | null, drops: RoutePoint[]): RoutePoint[] {
  if (drops.length <= 1) return drops;
  if (drops.length <= EXACT_DROP_LIMIT) {
    let best = drops;
    let bestMiles = pathMiles(start, drops);
    for (const candidate of permutations(drops)) {
      const miles = pathMiles(start, candidate);
      if (miles + 1e-9 < bestMiles) {
        best = candidate;
        bestMiles = miles;
      }
    }
    return best;
  }
  const greedy = twoOpt(start, nearestNeighbor(start, drops));
  return pathMiles(start, greedy) + 1e-9 < pathMiles(start, drops) ? greedy : drops;
}

export function planRoute(stops: RoutePoint[]): RoutePlan {
  const pickups = stops.filter((stop) => stop.kind === "pickup");
  const drops = stops.filter((stop) => stop.kind === "drop");
  const start = pickups.length ? pickups[pickups.length - 1].point : null;
  const optimized = [...pickups, ...bestDropOrder(start, drops)];
  const currentOrder = stops.map((stop) => stop.id);
  const optimizedOrder = optimized.map((stop) => stop.id);
  const round = (miles: number) => Math.round(miles);
  return {
    currentOrder,
    optimizedOrder,
    currentMiles: round(routeMiles(stops.map((stop) => stop.point))),
    optimizedMiles: round(routeMiles(optimized.map((stop) => stop.point))),
    unchanged: currentOrder.join("|") === optimizedOrder.join("|"),
  };
}

/** Reorders stops to match ids. SO lines point at stop ids, so they follow their drops. */
export function applyStopOrder<T extends { id: string }>(stops: T[], order: string[]): T[] {
  const byId = new Map(stops.map((stop) => [stop.id, stop]));
  if (order.length !== stops.length || order.some((id) => !byId.has(id))) {
    throw new Error("The route changed since it was optimized. Optimize again.");
  }
  return order.map((id) => byId.get(id)!);
}

export function placeQuery(place: Place): string {
  return [place.address1, place.city, `${place.state} ${place.postalCode ?? ""}`.trim()].filter((part) => part && part.trim()).join(", ");
}

export type Geocoder = (place: Place) => Promise<LatLng | null>;

const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

/** US Census Bureau geocoder. Free and keyless; US street addresses only. */
export function censusGeocoder(fetchImpl: typeof fetch = fetch, timeoutMs = 8000): Geocoder {
  const cache = new Map<string, LatLng | null>();
  return async (place) => {
    const query = placeQuery(place);
    if (!query) return null;
    if (cache.has(query)) return cache.get(query)!;
    const url = `${CENSUS_URL}?${new URLSearchParams({ address: query, benchmark: "Public_AR_Current", format: "json" })}`;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      const body = (await response.json()) as { result?: { addressMatches?: Array<{ coordinates?: { x?: number; y?: number } }> } };
      const match = body.result?.addressMatches?.[0]?.coordinates;
      const point = match && typeof match.x === "number" && typeof match.y === "number" ? { lat: match.y, lng: match.x } : null;
      cache.set(query, point);
      return point;
    } catch {
      return null;
    }
  };
}

export async function optimizeStops(
  stops: Array<{ id: string; kind: StopKind; place: Place }>,
  geocode: Geocoder,
): Promise<{ plan: RoutePlan } | { error: string; missing: string[] }> {
  const points = await Promise.all(stops.map((stop) => geocode(stop.place)));
  const missing = stops.filter((_, index) => !points[index]).map((stop) => stop.id);
  if (missing.length) {
    return { error: "We couldn't find some of these addresses on the map. Check the street, city, state, and ZIP.", missing };
  }
  return { plan: planRoute(stops.map((stop, index) => ({ id: stop.id, kind: stop.kind, point: points[index]! }))) };
}
