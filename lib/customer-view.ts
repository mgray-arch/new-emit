import type {
  CustomerDocument,
  CustomerOrder,
  Place,
  PortalStatus,
  PublicTracking,
  RateReason,
  Stop,
  TimelineEvent,
  TrackingStage,
  TransitOption,
} from "@/lib/types";
import {
  PORTAL_STATUSES,
  RATE_REASONS,
  STAGE_LABEL,
  TRACKING_STAGES,
  TRANSIT_OPTIONS,
  TRUCK_TYPES,
} from "@/lib/types";
import { portalPublicUrl } from "@/lib/public-url";
import { redactSensitiveText } from "@/lib/sensitive";
import { samLoadUrl } from "@/lib/sam-link";
import { sanitizeSchedule } from "@/lib/stop-schedule";
import { canSeePricing, resolveAccess, type Viewer } from "@/lib/types";
import { parseTrackingLink } from "@/lib/tracking-link";

/**
 * The only shipment shape that may leave the server toward EMIT or the assistant.
 * Built by copying an allowlist. Extra fields on the input are dropped.
 */

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function strOrNull(value: unknown): string | null {
  if (value == null || value === "") return null;
  return typeof value === "string" ? value : String(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export function serializePlace(value: unknown): Place {
  const place = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    company: str(place.company),
    address1: str(place.address1),
    address2: str(place.address2),
    city: str(place.city),
    state: str(place.state),
    postalCode: str(place.postalCode),
    country: str(place.country) || "US",
  };
}

function serializeTimeline(value: unknown): TimelineEvent[] {
  if (!Array.isArray(value)) return [];
  const events: TimelineEvent[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const stage = oneOf(row.stage, TRACKING_STAGES);
    if (!stage) continue;
    events.push({
      stage,
      at: str(row.at),
      label: STAGE_LABEL[stage],
    });
  }
  return events;
}

function serializeDocument(value: unknown): CustomerDocument | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const kind = row.kind === "bol" ? "bol" : row.kind === "attachment" ? "attachment" : null;
  if (!kind || typeof row.id !== "string") return null;
  return {
    id: row.id,
    kind,
    filename: str(row.filename) || "document",
    mediaType: str(row.mediaType) || "application/octet-stream",
    createdAt: str(row.createdAt),
  };
}

function serializeStops(value: unknown, origin: Place, destination: Place): Stop[] {
  const parsed: Stop[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const kind = row.kind === "pickup" || row.kind === "drop" ? row.kind : null;
      if (!kind) continue;
      const schedule = sanitizeSchedule(row.schedule);
      parsed.push({
        id: str(row.id) || `stop-${parsed.length + 1}`,
        kind,
        place: serializePlace(row.place),
        locationId: typeof row.locationId === "string" && row.locationId ? row.locationId : null,
        ...(schedule ? { schedule } : {}),
      });
    }
  }
  if (!parsed.some((stop) => stop.kind === "pickup") || !parsed.some((stop) => stop.kind === "drop")) {
    return [
      { id: "stop-1", kind: "pickup", place: origin },
      { id: "stop-2", kind: "drop", place: destination },
    ];
  }
  return parsed;
}

function money(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

export interface CustomerViewOptions {
  /** False omits customerCost and rateReason. Default true keeps stored orders intact for internal callers. */
  includePricing?: boolean;
  /** False omits pendingReviewCount. Default true keeps stored orders intact for internal callers. */
  includeReview?: boolean;
  /** False omits who submitted the load. Portal responses include it. The assistant leaves it off. */
  includeEnteredBy?: boolean;
}

export function serializeCustomerOrder(value: unknown, options?: CustomerViewOptions): CustomerOrder {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const includePricing = options?.includePricing !== false;
  const includeReview = options?.includeReview !== false;
  const includeEnteredBy = options?.includeEnteredBy === true;
  const portalStatus = oneOf(raw.portalStatus, PORTAL_STATUSES) ?? "being_prepared";
  const trackingStage = oneOf(raw.trackingStage, TRACKING_STAGES) ?? "submitted";
  const documents = Array.isArray(raw.documents)
    ? raw.documents.map(serializeDocument).filter((doc): doc is CustomerDocument => doc !== null)
    : [];
  const stops = serializeStops(raw.stops, serializePlace(raw.origin), serializePlace(raw.destination));
  const pickup = stops.find((stop) => stop.kind === "pickup") ?? stops[0];
  const drop = [...stops].reverse().find((stop) => stop.kind === "drop") ?? stops[stops.length - 1];
  const order: CustomerOrder = {
    id: str(raw.id),
    salesOrderNumber: str(raw.salesOrderNumber),
    loadNumber: strOrNull(raw.loadNumber),
    portalStatus,
    trackingStage,
    timeline: serializeTimeline(raw.timeline),
    origin: pickup.place,
    destination: drop.place,
    stops,
    truckType: truckLabel(raw.truckType),
    transit: oneOf(raw.transit, TRANSIT_OPTIONS),
    shipDate: strOrNull(raw.shipDate),
    shipTime: strOrNull(raw.shipTime),
    mustDeliverDate: strOrNull(raw.mustDeliverDate),
    truckEta: strOrNull(raw.truckEta),
    latestEta: strOrNull(raw.latestEta),
    trackingUrl: str(raw.trackingUrl),
    trackingLink: parseTrackingLink(raw.trackingLink),
    comments: redactSensitiveText(str(raw.comments)),
    createdBy: str(raw.createdBy),
    createdAt: str(raw.createdAt),
    updatedAt: str(raw.updatedAt),
    attachmentCount: numberOrZero(raw.attachmentCount),
    bolCount: numberOrZero(raw.bolCount),
    documents,
  };
  if (includeReview) order.pendingReviewCount = numberOrZero(raw.pendingReviewCount);
  if (includeEnteredBy) {
    order.enteredByName = strOrNull(raw.enteredByName);
    order.enteredByEmail = strOrNull(raw.enteredByEmail);
  }
  if (includePricing) {
    order.customerCost = money(raw.customerCost);
    order.rateReason = oneOf(raw.rateReason, RATE_REASONS);
  }
  return order;
}

/** The order shape that may be sent to this viewer. EMIT admins with see pricing or full access, and Select, get EMIT's cost. Regular EMIT users never do, and neither does a view-as regular preview. Every signed-in user gets who entered the load. Nobody at EMIT gets carrier pay, the review count, or the SAM build controls. */
export function presentCustomerOrder(order: CustomerOrder, viewer: Viewer): CustomerOrder {
  const access = resolveAccess(viewer);
  const view = serializeCustomerOrder(order, {
    includePricing: canSeePricing(access),
    includeReview: access.select,
    includeEnteredBy: true,
  });
  if (access.select) {
    view.owner = order.owner === "Drew" || order.owner === "Ainsley" ? order.owner : null;
    view.ownerNeedsCheck = order.ownerNeedsCheck === true;
    if (order.samBuildStatus === "building" || order.samBuildStatus === "failed") view.samBuildStatus = order.samBuildStatus;
    if (order.samBuildError) view.samBuildError = order.samBuildError;
    if (order.samBuildAt) view.samBuildAt = order.samBuildAt;
    const url = samLoadUrl(view.loadNumber);
    if (url) view.samUrl = url;
  }
  return view;
}

function truckLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > 80) return null;
  return oneOf(trimmed, TRUCK_TYPES) ?? trimmed;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function toPublicTracking(order: CustomerOrder): PublicTracking {
  return {
    loadNumber: order.loadNumber,
    salesOrderNumber: order.salesOrderNumber,
    portalStatus: order.portalStatus,
    trackingStage: order.trackingStage,
    timeline: order.timeline.map((event) => ({
      stage: event.stage,
      at: event.at,
      label: event.label,
    })),
    latestEta: order.latestEta,
    originCity: order.origin.city,
    originState: order.origin.state,
    destinationCity: order.destination.city,
    destinationState: order.destination.state,
    stops: order.stops.map((stop) => ({ kind: stop.kind, city: stop.place.city, state: stop.place.state })),
    shipDate: order.shipDate,
    mustDeliverDate: order.mustDeliverDate,
    truckType: order.truckType,
    trackingLink: order.trackingLink ?? null,
  };
}

export function trackingUrlFor(token: string): string {
  return `${portalPublicUrl()}/track/${token}`;
}

export function assertNoCarrierFields(value: unknown): void {
  const json = JSON.stringify(value);
  const forbidden = ["carrierPay", "carrierRate", "carrierCost", "carrier_pay", "carrier_name", "staffNotes", "staff_notes"];
  for (const key of forbidden) {
    if (json.includes(`"${key}"`)) {
      throw new Error(`Customer payload contained forbidden field ${key}`);
    }
  }
}
