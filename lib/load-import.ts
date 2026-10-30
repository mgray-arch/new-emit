import { randomBytes, randomUUID } from "node:crypto";
import type { PortalContext } from "@/lib/db";
import { withTransaction } from "@/lib/db";
import { findDuplicate } from "@/lib/locations";
import { matchStrength } from "@/lib/location-match";
import { timelineThrough } from "@/lib/orders";
import { parseSelectLoadNumber } from "@/lib/select-load";
import { appointmentWindow, calendarDate, clockTime, keptInstant, sanitizeSchedule } from "@/lib/stop-schedule";
import { resolvedRoute, type StopInput } from "@/lib/stops";
import { parseTrackingLink } from "@/lib/tracking-link";
import type { Place, PortalStatus, StopSchedule, TrackingStage } from "@/lib/types";
import { mapTransitToPortal, mapTransitToTracking } from "@/lib/sam";

/**
 * Historical EMIT loads, posted by the Select bot. There is no SAM client here.
 * The body is an allowlist: carrier pay, carrier name, MC, and rate confirmations
 * are not read and not stored. Documents are not imported.
 *
 * A row this endpoint creates has source `sam-import`. A load EMIT entered in the
 * portal has a null source and is never overwritten. When the sales order matches,
 * the Select load number is written if it is still blank, and a tracking link is
 * filled only when the portal load does not have one.
 */

export const SAM_IMPORT_SOURCE = "sam-import";
export const SAM_IMPORT_ENTERED_BY = "Imported from SAM";
export const IMPORT_BATCH_LIMIT = 200;
export const SALES_ORDER_MAX = 500;

const STATUS_ALIAS: Record<string, string> = {
  open: "Open",
  pending: "Open",
  submitted: "Open",
  "being prepared": "Open",
  covered: "Covered",
  booked: "Covered",
  "ready to ship": "Covered",
  dispatched: "Dispatched",
  "at shipper": "At Shipper",
  "at pickup": "At Shipper",
  loaded: "Loaded",
  "in transit": "In Transit",
  active: "In Transit",
  "at receiver": "At Receiver",
  "out for delivery": "Out for Delivery",
  delivered: "Delivered",
  completed: "Completed",
  complete: "Completed",
  cancelled: "Cancelled",
  canceled: "Cancelled",
  void: "Cancelled",
  voided: "Cancelled",
};

/**
 * SAM equipment names seen on EMIT loads, folded onto the portal list.
 * Anything else is kept as trimmed text, including Straight Box Truck and Power Only,
 * because those names do not name a length this portal already has.
 */
const EQUIPMENT_ALIAS: Record<string, string> = {
  flatbed: "Flatbed",
  f: "Flatbed",
  "48' flatbed": "48' Flatbed",
  "48 ft flatbed": "48' Flatbed",
  "48ft flatbed": "48' Flatbed",
  "flatbed 48": "48' Flatbed",
  "53' flatbed": "53' Flatbed",
  "53 ft flatbed": "53' Flatbed",
  "53ft flatbed": "53' Flatbed",
  "flatbed 53": "53' Flatbed",
  f53: "53' Flatbed",
  conestoga: "Conestoga",
  cn: "Conestoga",
  "hot shot": "Hot Shot",
  hotshot: "Hot Shot",
  "flatbed hotshot": "Hot Shot",
  sprinter: "Sprinter Van",
  "sprinter van": "Sprinter Van",
  sp: "Sprinter Van",
  "20' box truck": "20' Box Truck",
  "20 ft box truck": "20' Box Truck",
  "20ft box truck": "20' Box Truck",
  "24' box truck": "24' Box Truck",
  "24 ft box truck": "24' Box Truck",
  "24ft box truck": "24' Box Truck",
  "multi stop box truck": "Multi Stop Box Truck",
  ltl: "LTL",
  "straight box truck": "Straight Box Truck",
  "box truck": "Straight Box Truck",
  box: "Straight Box Truck",
  "power only": "Power Only",
  po: "Power Only",
  "step deck": "Step Deck",
  stepdeck: "Step Deck",
  sd: "Step Deck",
  "flatbed or stepdeck": "Flatbed or Stepdeck",
  "flatbed or step deck": "Flatbed or Stepdeck",
  fsd: "Flatbed or Stepdeck",
  "straight van": "Straight Van",
  sv: "Straight Van",
  "53' van": "53' Van",
  "53 ft van": "53' Van",
  "53ft van": "53' Van",
  v53: "53' Van",
  van: "Van",
  "dry van": "Van",
  reefer: "Reefer",
  rgn: "RGN",
};

export type ImportAction =
  | "created"
  | "updated"
  | "linked"
  | "would create"
  | "would update"
  | "would link"
  | "error";

export interface ImportLocationMatch {
  sequence: number;
  locationId: string;
  strength: "exact" | "likely";
  linked: boolean;
}

export interface ImportLoadResult {
  selectLoadNumber: string | null;
  action: ImportAction;
  salesOrderNumber?: string;
  orderId?: string | null;
  portalStatus?: PortalStatus;
  trackingStage?: TrackingStage;
  truckType?: string | null;
  locationMatches?: ImportLocationMatch[];
  unchanged?: boolean;
  warnings?: string[];
  error?: string;
}

export interface ImportBatchResult {
  dryRun: boolean;
  summary: Record<string, number>;
  results: ImportLoadResult[];
}

interface ParsedLoad {
  selectLoadNumber: string;
  salesOrderNumber: string;
  portalStatus: PortalStatus;
  trackingStage: TrackingStage;
  truckType: string | null;
  truckProvided: boolean;
  customerCostCents: number | null;
  rateProvided: boolean;
  trackingLink: string | null;
  createdAt: string | null;
  stops: StopInput[];
  warnings: string[];
}

interface MemRow {
  id: string;
  salesOrderNumber: string;
  loadNumber: string | null;
  source: string | null;
  trackingLink: string | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The raw sales order, trimmed. A missing value stays blank. This does not invent a number. */
export function storedSalesOrder(value: unknown): { raw: string; error?: string } {
  if (value == null || value === "") return { raw: "" };
  if (typeof value !== "string") return { raw: "", error: "salesOrderNumber must be text." };
  const raw = value.trim().replace(/\s+/g, " ");
  if (!raw) return { raw: "" };
  if (raw.length > SALES_ORDER_MAX) return { raw: "", error: "salesOrderNumber is too long." };
  return { raw };
}

/**
 * Keys used only to find a portal load. Case and spaces fold together.
 * SO-68458, SO68458, and 68458 share the digit key. A compound value such as
 * so-1276_1277_2496_2497 stays one key and does not match 1276.
 */
export function salesOrderMatchKeys(raw: string): string[] {
  const compact = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (!compact) return [];
  const keys = new Set<string>([compact]);
  const simple = /^SO[-#:]?(\d+)$/.exec(compact);
  if (simple) keys.add(simple[1]);
  return [...keys];
}

export function salesOrdersMatch(left: string, right: string): boolean {
  const keys = new Set(salesOrderMatchKeys(left));
  if (keys.size === 0) return false;
  return salesOrderMatchKeys(right).some((key) => keys.has(key));
}

export function mapImportStatus(status: unknown, voided = false): { portalStatus: PortalStatus; trackingStage: TrackingStage } | { error: string } {
  const raw = text(status);
  if (!raw) return { error: "Status is required." };
  const key = raw.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  const canonical = STATUS_ALIAS[key];
  if (!canonical) return { error: `Status "${raw.slice(0, 40)}" is not a SAM transit status.` };
  const portalStatus = mapTransitToPortal(canonical, voided || canonical === "Cancelled");
  const trackingStage = mapTransitToTracking(canonical);
  return { portalStatus, trackingStage };
}

function equipmentKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\b(?:feet|foot)\b/g, "ft")
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Portal truck type when the name is one we know. Otherwise the trimmed equipment text. */
export function mapImportEquipment(value: unknown): string | null {
  const display = text(value).replace(/\s+/g, " ");
  if (!display) return null;
  const mapped = EQUIPMENT_ALIAS[equipmentKey(display)];
  if (mapped) return mapped;
  return display.slice(0, 80);
}

function countryCode(value: unknown): string | { error: string } {
  const raw = text(value).toUpperCase();
  if (!raw || raw === "USA" || raw === "UNITED STATES") return "US";
  if (raw === "CAN" || raw === "CANADA") return "CA";
  if (/^[A-Z]{2}$/.test(raw)) return raw;
  return { error: "Country must be a 2-letter code." };
}

function postalCode(raw: Record<string, unknown>): string {
  const direct = text(raw.postalCode ?? raw.postal_code ?? raw.zip ?? raw.zipCode);
  if (direct) return direct.slice(0, 12);
  const combined = text(raw.address);
  const matches = [...combined.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)];
  return matches.length ? matches[matches.length - 1][1] : "";
}

function streetLine(raw: Record<string, unknown>, city: string): string {
  const explicit = text(raw.address1 ?? raw.address_1 ?? raw.street);
  if (explicit) return explicit;
  const combined = text(raw.address);
  if (!combined) return "";
  if (city) {
    const at = combined.toLowerCase().indexOf(city.toLowerCase());
    if (at > 0) return combined.slice(0, at).replace(/[,\s]+$/, "");
  }
  return combined.replace(/,?\s*[A-Za-z]{2}\s*,?\s*\d{5}(?:-\d{4})?\s*$/i, "").replace(/,\s*$/, "");
}

function stopKind(value: unknown): "pickup" | "drop" | null {
  const kind = text(value).toLowerCase();
  if (kind === "pickup" || kind === "pick" || kind === "shipper" || kind === "origin") return "pickup";
  if (kind === "drop" || kind === "delivery" || kind === "deliver" || kind === "receiver" || kind === "destination" || kind === "consignee") {
    return "drop";
  }
  return null;
}

function scheduleFrom(raw: Record<string, unknown>, warnings: string[]): StopSchedule | null {
  const appointment = asRecord(raw.appointment);
  const fromObject = appointment
    ? {
        start: clockTime(appointment.earliest ?? appointment.start) || clockTime(appointment.time),
        end: clockTime(appointment.latest ?? appointment.end),
      }
    : { start: null, end: null };
  const fromText = appointmentWindow(raw.time ?? raw.appointmentTime ?? raw.appointment_time);
  const start = clockTime(raw.appointmentStart ?? raw.appointment_start) || fromObject.start || fromText.start;
  const end = clockTime(raw.appointmentEnd ?? raw.appointment_end) || fromObject.end || fromText.end;
  const text = start ? null : fromText.text;
  const arrived = keptInstant(raw.arrivalTime ?? raw.arrivedAt ?? raw.arrival);
  const departed = keptInstant(raw.departureTime ?? raw.departedAt ?? raw.departure);
  const date = calendarDate(raw.date);
  if ((raw.arrivalTime || raw.arrivedAt || raw.arrival) && !arrived) warnings.push("An arrival time was not a timestamp and was left off.");
  if ((raw.departureTime || raw.departedAt || raw.departure) && !departed) warnings.push("A departure time was not a timestamp and was left off.");
  if (raw.date != null && raw.date !== "" && !date) warnings.push("A stop date was not a calendar date and was left off.");
  return sanitizeSchedule({
    date,
    appointmentStart: start,
    appointmentEnd: end,
    appointmentText: text,
    arrivedAt: arrived,
    departedAt: departed,
  });
}

function parseStops(value: unknown, warnings: string[]): { stops: StopInput[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) return { error: "Each load needs at least one pickup and one drop." };
  if (value.length > 25) return { error: "A load can have at most 25 stops." };
  const indexed = value.map((item, index) => ({ item, index }));
  const hasSequence = indexed.some((entry) => {
    const row = asRecord(entry.item);
    return row != null && typeof row.sequence === "number" && Number.isFinite(row.sequence);
  });
  if (hasSequence) {
    indexed.sort((left, right) => {
      const leftRow = asRecord(left.item);
      const rightRow = asRecord(right.item);
      const leftSeq = leftRow && typeof leftRow.sequence === "number" ? leftRow.sequence : Number.MAX_SAFE_INTEGER;
      const rightSeq = rightRow && typeof rightRow.sequence === "number" ? rightRow.sequence : Number.MAX_SAFE_INTEGER;
      return leftSeq - rightSeq || left.index - right.index;
    });
  }
  const stops: StopInput[] = [];
  for (const entry of indexed) {
    const raw = asRecord(entry.item);
    if (!raw) return { error: "Each stop must be a JSON object." };
    const kind = stopKind(raw.kind ?? raw.type);
    if (!kind) return { error: "Each stop needs a type of Pickup or Delivery." };
    const city = text(raw.city);
    const state = text(raw.state).toUpperCase();
    const company = text(raw.company ?? raw.locationName ?? raw.location_name ?? raw.name);
    const address1 = streetLine(raw, city);
    if (!company) return { error: "Each stop needs a company name." };
    if (!address1) return { error: "Each stop needs a street address." };
    if (!city) return { error: "Each stop needs a city." };
    if (!/^[A-Z]{2}$/.test(state)) return { error: "Each stop needs a two-letter state." };
    if (company.length > 120 || address1.length > 200 || city.length > 80) return { error: "A stop address is too long." };
    const country = countryCode(raw.country);
    if (typeof country !== "string") return country;
    const address2 = text(raw.address2 ?? raw.address_2);
    if (address2.length > 120) return { error: "A stop address is too long." };
    const place: Place = {
      company,
      address1,
      address2,
      city,
      state,
      postalCode: postalCode(raw),
      country,
    };
    const schedule = scheduleFrom(raw, warnings);
    stops.push({
      id: `stop-${stops.length + 1}`,
      kind,
      place,
      locationId: null,
      ...(schedule ? { schedule } : {}),
    });
  }
  if (!stops.some((stop) => stop.kind === "pickup") || !stops.some((stop) => stop.kind === "drop")) {
    return { error: "Each load needs at least one pickup and one drop." };
  }
  return { stops };
}

function moneyCents(value: unknown): { cents: number | null; provided: boolean } | { error: string } {
  if (value == null || value === "") return { cents: null, provided: false };
  const amount = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) {
    return { error: "customerRate must be a dollar amount from 0 to 1000000." };
  }
  return { cents: Math.round(amount * 100), provided: true };
}

function createdInstant(value: unknown): string | null {
  const raw = text(value);
  if (!raw || raw.length > 40) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function parseLoad(value: unknown): { load: ParsedLoad } | { selectLoadNumber: string | null; error: string } {
  const raw = asRecord(value);
  if (!raw) return { selectLoadNumber: null, error: "Each load must be a JSON object." };
  const numberText = text(raw.selectLoadNumber ?? raw.loadNumber ?? raw.load_number);
  const selectLoadNumber = numberText ? parseSelectLoadNumber(numberText) : null;
  if (!numberText) return { selectLoadNumber: null, error: "selectLoadNumber is required." };
  if (!selectLoadNumber) return { selectLoadNumber: null, error: "Enter a Select load number like 460117-1." };
  const salesOrder = storedSalesOrder(raw.salesOrderNumber ?? raw.sales_order_number);
  if (salesOrder.error) return { selectLoadNumber, error: salesOrder.error };
  const status = mapImportStatus(raw.status ?? raw.transitStatus ?? raw.transit_status, raw.voided === true);
  if ("error" in status) return { selectLoadNumber, error: status.error };
  const equipmentText = text(raw.equipment ?? raw.truckType ?? raw.truck_type ?? raw.equipmentName);
  const codeText = text(raw.equipmentCode ?? raw.equipment_code);
  const truckProvided = Boolean(equipmentText || codeText);
  if (equipmentText.length > 80) return { selectLoadNumber, error: "Equipment name is too long." };
  const truckType = mapImportEquipment(equipmentText || codeText);
  const rate = moneyCents(raw.customerRate ?? raw.customer_rate);
  if ("error" in rate) return { selectLoadNumber, error: rate.error };
  const warnings: string[] = [];
  const trackingRaw = raw.trackingShareUrl ?? raw.trackingLink ?? raw.tracking_link;
  let trackingLink: string | null = null;
  if (text(typeof trackingRaw === "string" ? trackingRaw : "")) {
    trackingLink = parseTrackingLink(trackingRaw);
    if (!trackingLink) warnings.push("Tracking link was not an http(s) URL and was left off.");
  }
  const createdRaw = raw.createdAt ?? raw.created_at;
  const createdAt = createdInstant(createdRaw);
  if (text(typeof createdRaw === "string" ? createdRaw : "") && !createdAt) {
    warnings.push("createdAt was not a timestamp and was not stored.");
  }
  const stops = parseStops(raw.stops, warnings);
  if ("error" in stops) return { selectLoadNumber, error: stops.error };
  return {
    load: {
      selectLoadNumber,
      salesOrderNumber: salesOrder.raw,
      portalStatus: status.portalStatus,
      trackingStage: status.trackingStage,
      truckType,
      truckProvided,
      customerCostCents: rate.cents,
      rateProvided: rate.provided,
      trackingLink,
      createdAt,
      stops: stops.stops,
      warnings,
    },
  };
}

function firstPickup(stops: StopInput[]): StopInput | undefined {
  return stops.find((stop) => stop.kind === "pickup");
}

function lastDrop(stops: StopInput[]): StopInput | undefined {
  return [...stops].reverse().find((stop) => stop.kind === "drop");
}

async function attachLocations(
  ctx: PortalContext,
  stops: StopInput[],
  warnings: string[],
): Promise<{ stops: StopInput[]; matches: ImportLocationMatch[] }> {
  const matches: ImportLocationMatch[] = [];
  const next: StopInput[] = [];
  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index];
    if (stop.kind !== "drop") {
      next.push({ ...stop, locationId: null });
      continue;
    }
    const found = await findDuplicate(ctx, stop.place, "drop");
    const strength = found && !found.id.startsWith("site:") ? matchStrength(stop.place, found) : null;
    if (found && strength === "exact") {
      matches.push({ sequence: index + 1, locationId: found.id, strength, linked: true });
      next.push({
        ...stop,
        locationId: found.id,
        place: { ...stop.place, company: found.receiverCompany || stop.place.company },
      });
      continue;
    }
    if (found && strength === "likely") {
      matches.push({ sequence: index + 1, locationId: found.id, strength, linked: false });
      warnings.push(`Stop ${index + 1} matched a saved location only loosely, so it was not linked.`);
    }
    next.push({ ...stop, locationId: null });
  }
  return { stops: next, matches };
}

function actionName(dryRun: boolean, verb: "create" | "update" | "link"): ImportAction {
  if (!dryRun) return verb === "create" ? "created" : verb === "update" ? "updated" : "linked";
  return verb === "create" ? "would create" : verb === "update" ? "would update" : "would link";
}

function resultOf(
  load: ParsedLoad,
  action: ImportAction,
  extra: {
    orderId?: string | null;
    salesOrderNumber?: string;
    matches?: ImportLocationMatch[];
    unchanged?: boolean;
    warnings?: string[];
    linked?: boolean;
  },
): ImportLoadResult {
  const warnings = extra.warnings && extra.warnings.length ? [...new Set(extra.warnings)] : undefined;
  const linked = extra.linked === true;
  return {
    selectLoadNumber: load.selectLoadNumber,
    action,
    salesOrderNumber: extra.salesOrderNumber ?? load.salesOrderNumber,
    orderId: extra.orderId || null,
    ...(linked
      ? {}
      : {
          portalStatus: load.portalStatus,
          trackingStage: load.trackingStage,
          truckType: load.truckType,
        }),
    ...(extra.matches && extra.matches.length ? { locationMatches: extra.matches } : {}),
    ...(typeof extra.unchanged === "boolean" ? { unchanged: extra.unchanged } : {}),
    ...(warnings ? { warnings } : {}),
  };
}

async function insertImport(ctx: PortalContext, load: ParsedLoad, stops: StopInput[], createdAt: string): Promise<string> {
  const id = randomUUID();
  const now = ctx.now().toISOString();
  const token = randomBytes(24).toString("base64url");
  const route = resolvedRoute({ stops });
  const pickup = firstPickup(route.stops);
  const drop = lastDrop(route.stops);
  await ctx.db
    .prepare(
      `INSERT INTO loads (
         id, sales_order_number, load_number, load_number_source, source,
         portal_status, tracking_stage, timeline_json,
         origin_json, destination_json, stops_json, truck_type, transit,
         ship_date, ship_time, must_deliver_date, truck_eta, latest_eta,
         tracking_token, tracking_link, tracking_link_source,
         customer_cost_cents, rate_reason, comments,
         created_by, entered_by_name, entered_by_email,
         created_at, updated_at, pending_review_count
       ) VALUES (
         ?, ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?, ?, NULL,
         ?, ?, ?, NULL, NULL,
         ?, ?, ?,
         ?, NULL, '',
         ?, ?, NULL,
         ?, ?, 0
       )`,
    )
    .run(
      id,
      load.salesOrderNumber,
      load.selectLoadNumber,
      SAM_IMPORT_SOURCE,
      SAM_IMPORT_SOURCE,
      load.portalStatus,
      load.trackingStage,
      JSON.stringify(timelineThrough(load.trackingStage, createdAt)),
      JSON.stringify(route.origin),
      JSON.stringify(route.destination),
      JSON.stringify(route.stops),
      load.truckType,
      pickup?.schedule?.date ?? null,
      pickup?.schedule?.appointmentStart ?? null,
      drop?.schedule?.date ?? null,
      token,
      load.trackingLink,
      load.trackingLink ? SAM_IMPORT_SOURCE : null,
      load.customerCostCents,
      SAM_IMPORT_ENTERED_BY,
      SAM_IMPORT_ENTERED_BY,
      createdAt,
      now,
    );
  return id;
}

interface ExistingImport {
  id: string;
  salesOrderNumber: string;
  customerCostCents: number | null;
  truckType: string | null;
  trackingLink: string | null;
  createdAt: string;
}

async function readImport(ctx: PortalContext, id: string): Promise<ExistingImport | null> {
  const row = await ctx.db
    .prepare(
      `SELECT id, sales_order_number, customer_cost_cents, truck_type, tracking_link, created_at, source
       FROM loads WHERE id = ?`,
    )
    .get(id);
  if (!row || row.source !== SAM_IMPORT_SOURCE) return null;
  return {
    id: String(row.id),
    salesOrderNumber: String(row.sales_order_number ?? ""),
    customerCostCents: row.customer_cost_cents == null ? null : Number(row.customer_cost_cents),
    truckType: row.truck_type == null ? null : String(row.truck_type),
    trackingLink: row.tracking_link == null || String(row.tracking_link).trim() === "" ? null : String(row.tracking_link),
    createdAt: String(row.created_at),
  };
}

async function updateImport(ctx: PortalContext, existing: ExistingImport, load: ParsedLoad, stops: StopInput[]): Promise<void> {
  const now = ctx.now().toISOString();
  const createdAt = load.createdAt ?? existing.createdAt;
  const route = resolvedRoute({ stops });
  const pickup = firstPickup(route.stops);
  const drop = lastDrop(route.stops);
  const trackingLink = load.trackingLink ?? existing.trackingLink;
  await ctx.db
    .prepare(
      `UPDATE loads SET
         sales_orders_json = CASE WHEN sales_order_number = ? THEN sales_orders_json ELSE NULL END,
         sales_order_number = ?, portal_status = ?, tracking_stage = ?, timeline_json = ?,
         origin_json = ?, destination_json = ?, stops_json = ?, truck_type = ?,
         ship_date = ?, ship_time = ?, must_deliver_date = ?,
         tracking_link = ?, tracking_link_source = CASE WHEN ? IS NULL THEN tracking_link_source ELSE ? END,
         customer_cost_cents = ?, created_at = ?, updated_at = ?
       WHERE id = ? AND source = ?`,
    )
    .run(
      load.salesOrderNumber || existing.salesOrderNumber,
      load.salesOrderNumber || existing.salesOrderNumber,
      load.portalStatus,
      load.trackingStage,
      JSON.stringify(timelineThrough(load.trackingStage, createdAt)),
      JSON.stringify(route.origin),
      JSON.stringify(route.destination),
      JSON.stringify(route.stops),
      load.truckProvided ? load.truckType : existing.truckType,
      pickup?.schedule?.date ?? null,
      pickup?.schedule?.appointmentStart ?? null,
      drop?.schedule?.date ?? null,
      trackingLink,
      load.trackingLink,
      load.trackingLink ? SAM_IMPORT_SOURCE : null,
      load.rateProvided ? load.customerCostCents : existing.customerCostCents,
      createdAt,
      now,
      existing.id,
      SAM_IMPORT_SOURCE,
    );
}

async function linkPortal(ctx: PortalContext, row: MemRow, load: ParsedLoad): Promise<boolean> {
  const numberMissing = !row.loadNumber;
  const linkMissing = !row.trackingLink && Boolean(load.trackingLink);
  if (!numberMissing && !linkMissing) return false;
  await ctx.db
    .prepare(
      `UPDATE loads SET
         load_number = COALESCE(load_number, ?),
         load_number_source = CASE WHEN load_number IS NULL THEN ? ELSE load_number_source END,
         tracking_link = CASE WHEN tracking_link IS NULL OR trim(tracking_link) = '' THEN ? ELSE tracking_link END,
         tracking_link_source = CASE
           WHEN (tracking_link IS NULL OR trim(tracking_link) = '') AND ? IS NOT NULL THEN ?
           ELSE tracking_link_source
         END,
         updated_at = ?
       WHERE id = ? AND (source IS NULL OR source != ?)`,
    )
    .run(
      load.selectLoadNumber,
      SAM_IMPORT_SOURCE,
      load.trackingLink,
      load.trackingLink,
      SAM_IMPORT_SOURCE,
      ctx.now().toISOString(),
      row.id,
      SAM_IMPORT_SOURCE,
    );
  return true;
}

function portalMatches(portal: MemRow[], salesOrderNumber: string): MemRow[] {
  if (!salesOrderNumber) return [];
  return portal.filter((row) => salesOrdersMatch(row.salesOrderNumber, salesOrderNumber));
}

export async function importSamLoads(
  ctx: PortalContext,
  input: { dryRun: boolean; loads: unknown[] },
): Promise<ImportBatchResult> {
  const rows = await ctx.db
    .prepare(`SELECT id, sales_order_number, load_number, source, tracking_link FROM loads`)
    .all();
  const byNumber = new Map<string, MemRow>();
  const portal: MemRow[] = [];
  for (const row of rows) {
    const mem: MemRow = {
      id: String(row.id),
      salesOrderNumber: String(row.sales_order_number ?? ""),
      loadNumber: row.load_number == null || String(row.load_number).trim() === "" ? null : String(row.load_number),
      source: row.source == null || String(row.source).trim() === "" ? null : String(row.source),
      trackingLink: row.tracking_link == null || String(row.tracking_link).trim() === "" ? null : String(row.tracking_link),
    };
    if (mem.loadNumber) byNumber.set(mem.loadNumber, mem);
    if (mem.source !== SAM_IMPORT_SOURCE) portal.push(mem);
  }

  const results: ImportLoadResult[] = [];
  for (const item of input.loads) {
    try {
      results.push(await importOne(ctx, item, input.dryRun, byNumber, portal));
    } catch (error) {
      console.error(error);
      const raw = asRecord(item);
      const numberText = raw ? text(raw.selectLoadNumber ?? raw.loadNumber ?? raw.load_number) : "";
      results.push({
        selectLoadNumber: parseSelectLoadNumber(numberText),
        action: "error",
        error: "That load could not be saved.",
      });
    }
  }
  const summary: Record<string, number> = {};
  for (const result of results) summary[result.action] = (summary[result.action] ?? 0) + 1;
  return { dryRun: input.dryRun, summary, results };
}

async function importOne(
  ctx: PortalContext,
  item: unknown,
  dryRun: boolean,
  byNumber: Map<string, MemRow>,
  portal: MemRow[],
): Promise<ImportLoadResult> {
  const parsed = parseLoad(item);
  if ("error" in parsed) return { selectLoadNumber: parsed.selectLoadNumber, action: "error", error: parsed.error };
  const load = parsed.load;
  const existing = byNumber.get(load.selectLoadNumber);
  if (existing && existing.source === SAM_IMPORT_SOURCE) {
    const attached = await attachLocations(ctx, load.stops, load.warnings);
    if (!dryRun && existing.id) {
      await withTransaction(ctx.db, async () => {
        const row = await readImport(ctx, existing.id);
        if (!row) throw new Error("Imported load disappeared before update");
        await updateImport(ctx, row, load, attached.stops);
      });
    }
    existing.salesOrderNumber = load.salesOrderNumber || existing.salesOrderNumber;
    if (load.trackingLink) existing.trackingLink = load.trackingLink;
    return resultOf(load, actionName(dryRun, "update"), {
      orderId: existing.id || null,
      matches: attached.matches,
      warnings: load.warnings,
    });
  }
  if (existing && existing.source !== SAM_IMPORT_SOURCE) {
    if (load.salesOrderNumber && existing.salesOrderNumber && !salesOrdersMatch(existing.salesOrderNumber, load.salesOrderNumber)) {
      return {
        selectLoadNumber: load.selectLoadNumber,
        action: "error",
        error: "That Select load number is already on a portal load with a different sales order.",
      };
    }
    const wrote = dryRun ? !existing.loadNumber || (!existing.trackingLink && Boolean(load.trackingLink)) : await linkPortal(ctx, existing, load);
    if (wrote) {
      existing.loadNumber = existing.loadNumber ?? load.selectLoadNumber;
      if (!existing.trackingLink && load.trackingLink) existing.trackingLink = load.trackingLink;
    }
    return resultOf(load, actionName(dryRun, "link"), {
      orderId: existing.id,
      salesOrderNumber: existing.salesOrderNumber,
      unchanged: !wrote,
      warnings: load.warnings,
      linked: true,
    });
  }

  const matches = portalMatches(portal, load.salesOrderNumber);
  if (matches.length > 1) {
    return {
      selectLoadNumber: load.selectLoadNumber,
      action: "error",
      error: "That sales order matches more than one portal load.",
    };
  }
  if (matches.length === 1) {
    const portalRow = matches[0];
    if (portalRow.loadNumber && portalRow.loadNumber !== load.selectLoadNumber) {
      return {
        selectLoadNumber: load.selectLoadNumber,
        action: "error",
        error: "That sales order is already linked to a different Select load number.",
      };
    }
    const wrote = dryRun
      ? !portalRow.loadNumber || (!portalRow.trackingLink && Boolean(load.trackingLink))
      : await linkPortal(ctx, portalRow, load);
    portalRow.loadNumber = portalRow.loadNumber ?? load.selectLoadNumber;
    if (load.trackingLink && !portalRow.trackingLink) portalRow.trackingLink = load.trackingLink;
    byNumber.set(load.selectLoadNumber, portalRow);
    return resultOf(load, actionName(dryRun, "link"), {
      orderId: portalRow.id,
      salesOrderNumber: portalRow.salesOrderNumber,
      unchanged: !wrote,
      warnings: load.warnings,
      linked: true,
    });
  }

  const attached = await attachLocations(ctx, load.stops, load.warnings);
  const createdAt = load.createdAt ?? ctx.now().toISOString();
  let orderId: string | null = null;
  if (!dryRun) {
    orderId = await withTransaction(ctx.db, async () => insertImport(ctx, load, attached.stops, createdAt));
  }
  const mem: MemRow = {
    id: orderId ?? "",
    salesOrderNumber: load.salesOrderNumber,
    loadNumber: load.selectLoadNumber,
    source: SAM_IMPORT_SOURCE,
    trackingLink: load.trackingLink,
  };
  byNumber.set(load.selectLoadNumber, mem);
  return resultOf(load, actionName(dryRun, "create"), {
    orderId,
    matches: attached.matches,
    warnings: load.warnings,
  });
}
