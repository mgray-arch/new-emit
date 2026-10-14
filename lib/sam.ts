import { serializeCustomerOrder, trackingUrlFor } from "@/lib/customer-view";
import type { CustomerOrder, PortalStatus, TrackingStage } from "@/lib/types";
import { STAGE_LABEL, TRACKING_STAGES } from "@/lib/types";
import type { OrderInput } from "@/lib/validate";
import type { Session } from "@/lib/types";

/**
 * Placeholder HTTP contract for Select's SAM TMS. The paths are not confirmed —
 * credentials are not available yet. The mapping below is the security boundary:
 * carrier cost, carrier pay items, carrier name, and MC number are never copied
 * onto the customer order, and there is no fallback from carrier cost to the
 * customer rate.
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
  const stops = Array.isArray(load.stops) ? load.stops.map((stop) => asRecord(stop)) : [];
  const pickup = stops.find((stop) => String(stop.type).toLowerCase() === "pickup") ?? stops[0] ?? {};
  const delivery = [...stops].reverse().find((stop) => String(stop.type).toLowerCase() === "delivery") ?? stops[stops.length - 1] ?? {};
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
    loadNumber: String(load.loadNumber ?? ""),
    portalStatus: mapTransitToPortal(transit, order.voided === true),
    trackingStage,
    timeline,
    origin: placeFromStop(pickup),
    destination: placeFromStop(delivery),
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

export function toSamCreatePayload(input: OrderInput, actor: Session): Record<string, unknown> {
  return {
    customerReference: input.salesOrderNumber,
    referenceNumbers: [{ key: "SO", value: input.salesOrderNumber }],
    equipment: input.truckType ?? null,
    teamRequired: input.transit === "Team",
    customerRate: input.customerCost ?? 0,
    comments: input.comments ?? "",
    submittedBy: actor.email,
    stops: [
      {
        type: "Pickup",
        locationName: input.origin.company,
        address1: input.origin.address1,
        city: input.origin.city,
        state: input.origin.state,
        zip: input.origin.postalCode,
        country: input.origin.country || "US",
        date: input.shipDate ?? null,
        time: input.shipTime ?? null,
      },
      {
        type: "Delivery",
        locationName: input.destination.company,
        address1: input.destination.address1,
        city: input.destination.city,
        state: input.destination.state,
        zip: input.destination.postalCode,
        country: input.destination.country || "US",
        date: input.mustDeliverDate ?? null,
      },
    ],
  };
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
}
