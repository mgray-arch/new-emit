import { randomUUID } from "node:crypto";
import type { PortalContext } from "@/lib/db";
import { ConflictError, PortalError } from "@/lib/http";
import { addressKey, matchStrength, normalizeCompany, type AddressLike } from "@/lib/location-match";
import { redactSensitiveText } from "@/lib/sensitive";
import { resolvedRoute } from "@/lib/stops";
import type { Place, Stop } from "@/lib/types";

/**
 * Saved delivery locations, plus a hidden history of one-off pickups.
 * EMIT pickup sites stay in the sites table and are the only pickup chips.
 * A future row is never a carrier, a rate, or a carrier name.
 */

export type LocationKind = "drop" | "pickup_once";

export interface SavedLocation {
  id: string;
  kind: LocationKind;
  company: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  contact: string;
  phone: string;
  notes: string;
  receiverId: string | null;
  receiverCompany: string | null;
  active: boolean;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  useCount: number;
}

export interface LocationDraft {
  company: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  postalCode?: string;
  country?: string;
  contact?: string;
  phone?: string;
  notes?: string;
  receiverId?: string | null;
  active?: boolean;
}

interface LocationRow {
  id: string;
  kind: string;
  company: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  contact: string;
  phone: string;
  notes: string;
  receiver_id: string | null;
  active: number;
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
}

const SELECT_LOCATION = `
  id, kind, company, address1, address2, city, state, postal_code, country,
  contact, phone, notes, receiver_id, active, created_by, created_at, last_used_at, use_count
`;

function likeContains(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function mapLocation(row: LocationRow, receiverCompany: string | null): SavedLocation {
  return {
    id: row.id,
    kind: row.kind === "pickup_once" ? "pickup_once" : "drop",
    company: row.company,
    address1: row.address1,
    address2: row.address2 ?? "",
    city: row.city,
    state: row.state,
    postalCode: row.postal_code ?? "",
    country: row.country || "US",
    contact: row.contact ?? "",
    phone: row.phone ?? "",
    notes: redactSensitiveText(row.notes ?? ""),
    receiverId: row.receiver_id,
    receiverCompany,
    active: Number(row.active) === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    useCount: Number(row.use_count ?? 0),
  };
}

function placeOf(location: SavedLocation): Place {
  return {
    company: location.receiverCompany || location.company,
    address1: location.address1,
    address2: location.address2,
    city: location.city,
    state: location.state,
    postalCode: location.postalCode,
    country: location.country || "US",
  };
}

async function receiverNames(ctx: PortalContext): Promise<Map<string, string>> {
  const rows = await ctx.db.prepare(`SELECT id, company FROM receivers`).all();
  return new Map(rows.map((row) => [String(row.id), String(row.company)]));
}

async function readLocation(ctx: PortalContext, id: string): Promise<SavedLocation | null> {
  const row = (await ctx.db.prepare(`SELECT ${SELECT_LOCATION} FROM locations WHERE id = ?`).get(id)) as LocationRow | undefined;
  if (!row) return null;
  const names = await receiverNames(ctx);
  return mapLocation(row, row.receiver_id ? names.get(row.receiver_id) ?? null : null);
}

async function listKind(ctx: PortalContext, kind: LocationKind, activeOnly: boolean): Promise<SavedLocation[]> {
  const sql = activeOnly
    ? `SELECT ${SELECT_LOCATION} FROM locations WHERE kind = ? AND active = 1 ORDER BY use_count DESC, last_used_at DESC, company`
    : `SELECT ${SELECT_LOCATION} FROM locations WHERE kind = ? ORDER BY active DESC, use_count DESC, company`;
  const rows = (await ctx.db.prepare(sql).all(kind)) as unknown as LocationRow[];
  const names = await receiverNames(ctx);
  return rows.map((row) => mapLocation(row, row.receiver_id ? names.get(row.receiver_id) ?? null : null));
}

export async function receiverForCompany(
  ctx: PortalContext,
  company: string,
): Promise<{ id: string; company: string } | null> {
  const target = normalizeCompany(company);
  if (!target) return null;
  const rows = await ctx.db.prepare(`SELECT id, company FROM receivers WHERE enabled = 1`).all();
  const match = rows.find((row) => normalizeCompany(String(row.company)) === target);
  return match ? { id: String(match.id), company: String(match.company) } : null;
}

export async function searchLocations(
  ctx: PortalContext,
  input: { q?: string; kind?: LocationKind; limit?: number },
): Promise<SavedLocation[]> {
  const kind = input.kind === "pickup_once" ? "pickup_once" : "drop";
  const limit = Math.min(20, Math.max(1, input.limit ?? 8));
  const q = input.q?.trim() ?? "";
  if (kind === "pickup_once" && q.length < 2) return [];
  const names = await receiverNames(ctx);
  if (!q) {
    const rows = (await ctx.db
      .prepare(
        `SELECT ${SELECT_LOCATION} FROM locations WHERE kind = ? AND active = 1 ORDER BY use_count DESC, last_used_at DESC, company LIMIT ?`,
      )
      .all(kind, limit)) as unknown as LocationRow[];
    return rows.map((row) => mapLocation(row, row.receiver_id ? names.get(row.receiver_id) ?? null : null));
  }
  const like = likeContains(q);
  const rows = (await ctx.db
    .prepare(
      `SELECT ${SELECT_LOCATION} FROM locations
       WHERE kind = ? AND active = 1
         AND (company LIKE ? ESCAPE '\\' OR city LIKE ? ESCAPE '\\' OR address1 LIKE ? ESCAPE '\\' OR address2 LIKE ? ESCAPE '\\' OR postal_code LIKE ? ESCAPE '\\')
       ORDER BY use_count DESC, last_used_at DESC, company
       LIMIT ?`,
    )
    .all(kind, like, like, like, like, like, limit)) as unknown as LocationRow[];
  return rows.map((row) => mapLocation(row, row.receiver_id ? names.get(row.receiver_id) ?? null : null));
}

export async function listManagedLocations(ctx: PortalContext, q?: string): Promise<SavedLocation[]> {
  const all = await listKind(ctx, "drop", false);
  const query = q?.trim().toLowerCase();
  if (!query) return all;
  return all.filter((location) =>
    [location.company, location.city, location.address1, location.address2, location.postalCode, location.receiverCompany ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(query),
  );
}

export async function findDuplicate(
  ctx: PortalContext,
  place: AddressLike,
  kind: LocationKind,
  ignoreId?: string | null,
): Promise<SavedLocation | null> {
  const rows = await listKind(ctx, kind, true);
  let best: { location: SavedLocation; strength: "exact" | "likely" } | null = null;
  for (const location of rows) {
    if (ignoreId && location.id === ignoreId) continue;
    const strength = matchStrength(place, location);
    if (!strength) continue;
    if (!best || strength === "exact" || (best.strength !== "exact" && location.useCount > best.location.useCount)) {
      best = { location, strength };
    }
  }
  if (kind === "pickup_once") {
    const sites = await ctx.db
      .prepare(`SELECT id, company, address1, city, state, postal_code, country FROM sites WHERE active = 1`)
      .all();
    for (const site of sites) {
      const asLocation: SavedLocation = {
        id: `site:${String(site.id)}`,
        kind: "pickup_once",
        company: String(site.company),
        address1: String(site.address1),
        address2: "",
        city: String(site.city),
        state: String(site.state),
        postalCode: String(site.postal_code ?? ""),
        country: String(site.country ?? "US"),
        contact: "",
        phone: "",
        notes: "",
        receiverId: null,
        receiverCompany: null,
        active: true,
        createdBy: "",
        createdAt: "",
        lastUsedAt: null,
        useCount: 0,
      };
      const strength = matchStrength(place, asLocation);
      if (!strength) continue;
      if (!best || strength === "exact" || best.strength !== "exact") best = { location: asLocation, strength };
    }
  }
  return best?.location ?? null;
}

async function touchLocation(ctx: PortalContext, id: string, increment: boolean): Promise<void> {
  const now = ctx.now().toISOString();
  if (increment) {
    await ctx.db
      .prepare(`UPDATE locations SET use_count = use_count + 1, last_used_at = ? WHERE id = ? AND kind != 'site'`)
      .run(now, id);
  } else {
    await ctx.db.prepare(`UPDATE locations SET last_used_at = ? WHERE id = ?`).run(now, id);
  }
}

async function insertLocation(
  ctx: PortalContext,
  kind: LocationKind,
  place: Place,
  actorName: string,
  receiverId: string | null,
  extra?: { contact?: string; phone?: string; notes?: string },
): Promise<SavedLocation> {
  const id = randomUUID();
  const now = ctx.now().toISOString();
  await ctx.db
    .prepare(
      `INSERT INTO locations (
         id, kind, company, address1, address2, city, state, postal_code, country,
         contact, phone, notes, receiver_id, active, created_by, created_at, last_used_at, use_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)`,
    )
    .run(
      id,
      kind,
      place.company.trim(),
      place.address1.trim(),
      (place.address2 ?? "").trim(),
      place.city.trim(),
      place.state.trim().toUpperCase(),
      (place.postalCode ?? "").trim(),
      place.country || "US",
      (extra?.contact ?? "").trim(),
      (extra?.phone ?? "").trim(),
      redactSensitiveText((extra?.notes ?? "").trim()),
      receiverId,
      actorName || "EMIT",
      now,
      now,
    );
  const saved = await readLocation(ctx, id);
  if (!saved) throw new PortalError("The location could not be saved", 500);
  return saved;
}

export interface StopChoice {
  id?: string;
  locationId?: string | null;
  saveAsNew?: boolean;
  contact?: string;
  phone?: string;
  notes?: string;
}

function referencedAlready(previous: Stop[], kind: Stop["kind"], locationId: string, place: Place): boolean {
  const key = addressKey(place);
  return previous.some((item) => {
    if (item.kind !== kind) return false;
    if (item.locationId && item.locationId === locationId) return true;
    return Boolean(key.split("|")[0]) && addressKey(item.place) === key;
  });
}

/**
 * Attach each stop to a saved location.
 * An exact address reuses the saved drop. A likely duplicate is refused unless this stop says saveAsNew.
 * One-off pickups are stored in the hidden history and never become pickup chips.
 */
export async function syncStopLocations(
  ctx: PortalContext,
  stops: Stop[],
  actorName: string,
  choices: StopChoice[],
  previous: Stop[] = [],
): Promise<Stop[]> {
  const duplicates: Array<{ stopId: string; location: SavedLocation }> = [];
  const next: Stop[] = [];
  for (const stop of stops) {
    const choice = choices.find((item) => item.id && item.id === stop.id);
    const saveAsNew = Boolean(choice?.saveAsNew);
    const requestedId = choice?.locationId ?? stop.locationId ?? null;
    const extra = { contact: choice?.contact, phone: choice?.phone, notes: choice?.notes };
    if (stop.kind === "pickup") {
      next.push(await syncPickup(ctx, stop, actorName, saveAsNew, previous, duplicates, extra));
      continue;
    }
    next.push(await syncDrop(ctx, stop, actorName, requestedId, saveAsNew, previous, duplicates, extra));
  }
  if (duplicates.length) {
    const name = duplicates[0].location.company;
    throw new ConflictError(`This looks like a duplicate of ${name}.`, duplicates);
  }
  return next;
}

async function syncDrop(
  ctx: PortalContext,
  stop: Stop,
  actorName: string,
  requestedId: string | null,
  saveAsNew: boolean,
  previous: Stop[],
  duplicates: Array<{ stopId: string; location: SavedLocation }>,
  extra: { contact?: string; phone?: string; notes?: string },
): Promise<Stop> {
  const receiver = await receiverForCompany(ctx, stop.place.company);
  const place: Place = receiver ? { ...stop.place, company: receiver.company } : stop.place;
  if (requestedId && !requestedId.startsWith("site:")) {
    const existing = await readLocation(ctx, requestedId);
    if (existing && existing.kind === "drop" && existing.active && matchStrength(place, existing)) {
      await touchLocation(ctx, existing.id, !referencedAlready(previous, "drop", existing.id, place));
      return { ...stop, locationId: existing.id, place: { ...place, company: existing.receiverCompany || place.company } };
    }
  }
  const match = await findDuplicate(ctx, place, "drop");
  if (match && !saveAsNew) {
    if (matchStrength(place, match) === "exact") {
      await touchLocation(ctx, match.id, !referencedAlready(previous, "drop", match.id, place));
      return {
        ...stop,
        locationId: match.id,
        place: { ...place, company: match.receiverCompany || place.company },
      };
    }
    duplicates.push({ stopId: stop.id, location: match });
    return { ...stop, place };
  }
  const saved = await insertLocation(ctx, "drop", place, actorName, receiver?.id ?? null, extra);
  return { ...stop, locationId: saved.id, place };
}

async function syncPickup(
  ctx: PortalContext,
  stop: Stop,
  actorName: string,
  saveAsNew: boolean,
  previous: Stop[],
  duplicates: Array<{ stopId: string; location: SavedLocation }>,
  extra: { contact?: string; phone?: string; notes?: string },
): Promise<Stop> {
  const match = await findDuplicate(ctx, stop.place, "pickup_once");
  if (match?.id.startsWith("site:")) {
    if (matchStrength(stop.place, match) === "exact") return { ...stop, locationId: null };
    if (!saveAsNew) {
      duplicates.push({ stopId: stop.id, location: match });
      return { ...stop, locationId: null };
    }
    await insertLocation(ctx, "pickup_once", stop.place, actorName, null, extra);
    return { ...stop, locationId: null };
  }
  if (match && matchStrength(stop.place, match) === "exact") {
    await touchLocation(ctx, match.id, !referencedAlready(previous, "pickup", match.id, stop.place));
    return { ...stop, locationId: null };
  }
  if (match && !saveAsNew) {
    duplicates.push({ stopId: stop.id, location: match });
    return stop;
  }
  await insertLocation(ctx, "pickup_once", stop.place, actorName, null, extra);
  return { ...stop, locationId: null };
}

export async function updateLocation(ctx: PortalContext, id: string, patch: LocationDraft): Promise<SavedLocation> {
  const existing = await readLocation(ctx, id);
  if (!existing || existing.kind !== "drop") throw new PortalError("Location not found", 404);
  const company = patch.company.trim();
  const address1 = patch.address1.trim();
  const city = patch.city.trim();
  const state = patch.state.trim().toUpperCase();
  if (!company || !address1 || !city || state.length !== 2) throw new PortalError("Enter a company, street, city, and state.");
  const linked = patch.receiverId === undefined ? await receiverForCompany(ctx, company) : null;
  const receiverId = patch.receiverId === undefined ? linked?.id ?? null : patch.receiverId || null;
  await ctx.db
    .prepare(
      `UPDATE locations SET
         company = ?, address1 = ?, address2 = ?, city = ?, state = ?, postal_code = ?, country = ?,
         contact = ?, phone = ?, notes = ?, receiver_id = ?, active = ?
       WHERE id = ?`,
    )
    .run(
      company,
      address1,
      (patch.address2 ?? "").trim(),
      city,
      state,
      (patch.postalCode ?? "").trim(),
      (patch.country || "US").trim() || "US",
      (patch.contact ?? "").trim(),
      (patch.phone ?? "").trim(),
      redactSensitiveText((patch.notes ?? "").trim()),
      receiverId,
      patch.active === false ? 0 : 1,
      id,
    );
  const saved = await readLocation(ctx, id);
  if (!saved) throw new PortalError("Location not found", 404);
  return saved;
}

export async function mergeLocations(ctx: PortalContext, sourceId: string, intoId: string): Promise<SavedLocation> {
  if (sourceId === intoId) throw new PortalError("Choose a different location to merge into.");
  const source = await readLocation(ctx, sourceId);
  const target = await readLocation(ctx, intoId);
  if (!source || !target || source.kind !== "drop" || target.kind !== "drop") throw new PortalError("Location not found", 404);
  const loads = await ctx.db.prepare(`SELECT id, stops_json FROM loads`).all();
  let moved = 0;
  for (const load of loads) {
    let stops: Stop[] = [];
    try {
      stops = JSON.parse(String(load.stops_json || "[]")) as Stop[];
    } catch {
      continue;
    }
    let changed = false;
    const rewritten = stops.map((stop) => {
      if (stop.kind !== "drop") return stop;
      const sameId = stop.locationId === source.id;
      const sameAddress = addressKey(stop.place) === addressKey(source) && addressKey(source).split("|")[0] !== "";
      if (!sameId && !sameAddress) return stop;
      changed = true;
      return { ...stop, locationId: target.id, place: placeOf(target) };
    });
    if (!changed) continue;
    moved += 1;
    const route = resolvedRoute({ stops: rewritten });
    await ctx.db
      .prepare(`UPDATE loads SET stops_json = ?, origin_json = ?, destination_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(route.stops), JSON.stringify(route.origin), JSON.stringify(route.destination), ctx.now().toISOString(), String(load.id));
  }
  await ctx.db
    .prepare(`UPDATE locations SET use_count = use_count + ?, last_used_at = ?, receiver_id = COALESCE(receiver_id, ?) WHERE id = ?`)
    .run(source.useCount + moved, ctx.now().toISOString(), source.receiverId, target.id);
  await ctx.db.prepare(`UPDATE locations SET active = 0, use_count = 0 WHERE id = ?`).run(source.id);
  const saved = await readLocation(ctx, target.id);
  if (!saved) throw new PortalError("Location not found", 404);
  return saved;
}

/** Fill the drop list from loads already on file. Skipped once any location exists. */
export async function backfillDropLocations(ctx: PortalContext): Promise<void> {
  const count = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM locations`).get();
  if (Number(count?.n ?? 0) > 0) return;
  const loads = await ctx.db.prepare(`SELECT stops_json, created_by, updated_at FROM loads`).all();
  const grouped = new Map<string, { place: Place; count: number; lastUsed: string; createdBy: string }>();
  for (const load of loads) {
    let stops: Stop[] = [];
    try {
      stops = JSON.parse(String(load.stops_json || "[]")) as Stop[];
    } catch {
      continue;
    }
    for (const stop of stops) {
      if (stop.kind !== "drop") continue;
      const key = addressKey(stop.place);
      if (!key.split("|")[0]) continue;
      const current = grouped.get(key);
      const used = String(load.updated_at || "");
      if (!current) {
        grouped.set(key, { place: stop.place, count: 1, lastUsed: used, createdBy: String(load.created_by || "EMIT") });
      } else {
        current.count += 1;
        if (used > current.lastUsed) current.lastUsed = used;
      }
    }
  }
  for (const group of grouped.values()) {
    const receiver = await receiverForCompany(ctx, group.place.company);
    const id = randomUUID();
    await ctx.db
      .prepare(
        `INSERT INTO locations (
           id, kind, company, address1, address2, city, state, postal_code, country,
           contact, phone, notes, receiver_id, active, created_by, created_at, last_used_at, use_count
         ) VALUES (?, 'drop', ?, ?, ?, ?, ?, ?, ?, '', '', '', ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        receiver?.company || group.place.company,
        group.place.address1,
        group.place.address2 ?? "",
        group.place.city,
        group.place.state,
        group.place.postalCode ?? "",
        group.place.country || "US",
        receiver?.id ?? null,
        group.createdBy,
        group.lastUsed || ctx.now().toISOString(),
        group.lastUsed || ctx.now().toISOString(),
        group.count,
      );
  }
}
