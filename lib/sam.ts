import { serializeCustomerOrder, trackingUrlFor } from "@/lib/customer-view";
import { parseSelectLoadNumber } from "@/lib/select-load";
import { legacyStops, resolvedRoute } from "@/lib/stops";
import type { CustomerOrder, PortalStatus, TrackingStage } from "@/lib/types";
import { STAGE_LABEL, TRACKING_STAGES } from "@/lib/types";
import type { OrderInput } from "@/lib/validate";
import type { Session } from "@/lib/types";

/**
 * Placeholder HTTP contract for Select's SAM TMS. The paths are not confirmed —
 * credentials are not available yet. The mapping below is the security boundary:
 * carrier cost, carrier pay items, carrier name, and MC number are never copied
 * onto the customer order, and there is no fallback from carrier cost to the
 * customer rate. A SAM load number is copied only when it matches the Select
 * load-number shape. The running app does not call this client. When it does,
 * persist that number with syncSelectLoadNumberFromSam in lib/select-load.ts.
 */

export interface SamClientOptions {
  baseUrl: string;
  token: string;
  customerId: string;
  fetchImpl?: typeof fetch;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function firstLoad(order: Record<string, unknown>): Record<string, unknown> {
  const loads = order.loads;
  if (Array.isArray(loads) && loads[0] && typeof loads[0] === "object") return loads[0] as Record<string, unknown>;
  return asRecord(order.load ?? order);
}

export function mapTransitToTracking(transitStatus: string): TrackingStage {
  switch (transitStatus) {
    case "Covered":
    case "Dispatched":
      return "booked";
    case "At Shipper":
    case "Loaded":
      return "at_pickup";
    case "In Transit":
    case "At Receiver":
    case "Out for Delivery":
      return "in_transit";
    case "Delivered":
    case "Completed":
      return "delivered";
    default:
      return "submitted";
  }
}

export function mapTransitToPortal(transitStatus: string, voided = false): PortalStatus {
  if (voided || transitStatus === "Cancelled") return "cancelled";
  switch (transitStatus) {
    case "Open":
      return "being_prepared";
    case "Covered":
    case "Dispatched":
      return "ready_to_ship";
    default:
      return transitStatus ? "shipped" : "being_prepared";
  }
}

function pickSalesOrder(order: Record<string, unknown>): string {
  if (typeof order.salesOrderNumber === "string") return order.salesOrderNumber;
  const refs = Array.isArray(order.referenceNumbers) ? order.referenceNumbers : [];
  for (const ref of refs) {
    const row = asRecord(ref);
    const key = String(row.key ?? "");
    if (/so|sales|po|order/i.test(key) && typeof row.value === "string") return row.value;
  }
  return "";
}

/** Customer sell rate only. Never falls back to carrier cost. */
export function pickCustomerRate(order: Record<string, unknown>): number | null {
  if (typeof order.customerRate === "number") return order.customerRate;
  const charges = asRecord(order.customerCharges);
  if (typeof charges.lineHaul === "number") return charges.lineHaul;
  if (typeof charges.customerTotal === "number") return charges.customerTotal;
  return null;
}

function placeFromStop(stop: Record<string, unknown>) {
  return {
    company: String(stop.locationName ?? stop.company ?? ""),
    address1: String(stop.address1 ?? ""),
    city: String(stop.city ?? ""),
    state: String(stop.state ?? ""),
    postalCode: String(stop.zip ?? stop.postalCode ?? ""),
    country: String(stop.country ?? "US"),
  };
}

function commentsFrom(order: Record<string, unknown>): string {
  if (typeof order.comments === "string") return order.comments;
  const list = Array.isArray(order.commentList) ? order.commentList : Array.isArray(order.comments) ? order.comments : [];
  return list
    .map((item) => (typeof item === "string" ? item : String(asRecord(item).text ?? "")))
    .filter(Boolean)
    .join("\n");
}

export function mapSamDetailToCustomer(raw: unknown): CustomerOrder {
  const order = asRecord(raw);
  const load = firstLoad(order);
  const transit = String(load.transitStatus ?? order.transitStatus ?? "");
  const trackingStage = mapTransitToTracking(transit);
  const rawStops = Array.isArray(load.stops) ? load.stops.map((stop) => asRecord(stop)) : [];
  const customerStops = rawStops.map((stop, index) => ({
    id: String(stop.id ?? `stop-${index + 1}`),
    kind: String(stop.type).toLowerCase() === "pickup" ? "pickup" : "drop",
    place: placeFromStop(stop),
  }));
  const pickup = rawStops.find((stop) => String(stop.type).toLowerCase() === "pickup") ?? rawStops[0] ?? {};
  const delivery =
    [...rawStops].reverse().find((stop) => /deliver|drop/.test(String(stop.type).toLowerCase())) ??
    rawStops[rawStops.length - 1] ??
    {};
  const tracking = asRecord(load.tracking);
  const stageIndex = TRACKING_STAGES.indexOf(trackingStage);
  const timeline = TRACKING_STAGES.slice(0, stageIndex + 1).map((stage) => ({
    stage,
    at: String(load.updatedAt ?? order.updatedAt ?? ""),
    label: STAGE_LABEL[stage],
  }));
  const shareUrl = typeof tracking.shareUrl === "string" ? tracking.shareUrl : "";
  return serializeCustomerOrder({
    id: String(order.id ?? order.orderId ?? ""),
    salesOrderNumber: pickSalesOrder(order),
    loadNumber: parseSelectLoadNumber(load.loadNumber ?? order.loadNumber),
    portalStatus: mapTransitToPortal(transit, order.voided === true),
    trackingStage,
    timeline,
    origin: placeFromStop(pickup),
    destination: placeFromStop(delivery),
    stops: customerStops,
    truckType: load.equipment ?? order.equipment ?? null,
    transit: load.teamRequired === true || order.teamRequired === true ? "Team" : "Normal",
    shipDate: typeof pickup.date === "string" ? pickup.date : null,
    shipTime: typeof pickup.time === "string" ? pickup.time : null,
    mustDeliverDate: typeof delivery.date === "string" ? delivery.date : null,
    truckEta: null,
    latestEta: typeof tracking.eta === "string" ? tracking.eta : null,
    trackingUrl: shareUrl || trackingUrlFor(String(load.trackingToken ?? "")),
    customerCost: pickCustomerRate(order),
    rateReason: null,
    comments: commentsFrom(order),
    createdBy: String(asRecord(order.customer).name ?? order.createdBy ?? "SAM"),
    createdAt: String(order.createdAt ?? ""),
    updatedAt: String(order.updatedAt ?? ""),
    attachmentCount: 0,
    bolCount: 0,
    pendingReviewCount: 0,
    documents: [],
  });
}

/**
 * Full ordered stop list for SAM. Create and later edits both send this whole list
 * (sequence 1..n), and SAM replaces the load's stops. There is no partial diff.
 * Carrier pay is not a field on a stop.
 */
export function toSamStops(input: OrderInput): Array<Record<string, unknown>> {
  const route = resolvedRoute({
    stops:
      input.stops && input.stops.length > 0
        ? input.stops
        : input.origin && input.destination
          ? legacyStops(input.origin, input.destination)
          : [],
  });
  let seenPickup = false;
  let dropsRemaining = route.stops.filter((stop) => stop.kind === "drop").length;
  return route.stops.map((stop, index) => {
    const firstPickup = stop.kind === "pickup" && !seenPickup;
    if (stop.kind === "pickup") seenPickup = true;
    const lastDrop = stop.kind === "drop" && dropsRemaining === 1;
    if (stop.kind === "drop") dropsRemaining -= 1;
    return {
      sequence: index + 1,
      type: stop.kind === "pickup" ? "Pickup" : "Delivery",
      locationName: stop.place.company,
      address1: stop.place.address1,
      city: stop.place.city,
      state: stop.place.state,
      zip: stop.place.postalCode,
      country: stop.place.country || "US",
      date: firstPickup ? (input.shipDate ?? null) : lastDrop ? (input.mustDeliverDate ?? null) : null,
      time: firstPickup ? (input.shipTime ?? null) : null,
    };
  });
}

export function toSamCreatePayload(input: OrderInput, actor: Session): Record<string, unknown> {
  return {
    customerReference: input.salesOrderNumber,
    referenceNumbers: [{ key: "SO", value: input.salesOrderNumber }],
    equipment: input.truckType ?? null,
    teamRequired: input.transit === "Team",
    customerRate: input.customerCost ?? 0,
    comments: input.comments ?? "",
    submittedBy: actor.email,
    stops: toSamStops(input),
  };
}

/**
 * Not called until SAM credentials exist. Editing stops in the portal writes the
 * mock store today. The live call replaces every stop on the load with `toSamStops`.
 */
export function toSamStopReplacement(loadNumber: string, input: OrderInput): Record<string, unknown> {
  return { loadNumber, stops: toSamStops(input) };
}

export class SamTmsClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SamClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`SAM request failed (${response.status})`);
    }
    return response.json();
  }

  async submit(input: OrderInput, actor: Session): Promise<CustomerOrder> {
    const raw = await this.request(`/v1/customers/${encodeURIComponent(this.options.customerId)}/orders`, {
      method: "POST",
      body: JSON.stringify(toSamCreatePayload(input, actor)),
    });
    return mapSamDetailToCustomer(raw);
  }

  async list(): Promise<CustomerOrder[]> {
    const raw = await this.request(`/v1/customers/${encodeURIComponent(this.options.customerId)}/orders?limit=500`);
    const record = asRecord(raw);
    const rows = Array.isArray(raw) ? raw : Array.isArray(record.orders) ? record.orders : [];
    return rows.map((row) => mapSamDetailToCustomer(row));
  }

  async get(id: string): Promise<CustomerOrder> {
    const raw = await this.request(`/v1/orders/${encodeURIComponent(id)}`);
    return mapSamDetailToCustomer(raw);
  }

  /** Replace the load's stop sequence. SAM is expected to persist `stops` in order. */
  async replaceStops(loadNumber: string, input: OrderInput): Promise<CustomerOrder> {
    const raw = await this.request(`/v1/loads/${encodeURIComponent(loadNumber)}/stops`, {
      method: "PUT",
      body: JSON.stringify(toSamStopReplacement(loadNumber, input)),
    });
    return mapSamDetailToCustomer(raw);
  }
}
