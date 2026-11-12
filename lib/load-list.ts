import type { CustomerOrder, TrackingStage } from "@/lib/types";

/** Working queues. On the Select side a load sits in exactly one of these. */
export const LOAD_TABS = ["attention", "active", "delivered", "history"] as const;
export type LoadTab = (typeof LOAD_TABS)[number];

/** EMIT and view-as have no Needs Attention list. Those loads stay on Active or Delivered. */
export function visibleLoadTabs(selectStaff: boolean): LoadTab[] {
  return selectStaff ? [...LOAD_TABS] : LOAD_TABS.filter((tab) => tab !== "attention");
}

/** Attention is omitted for EMIT and view-as. Select always receives it. */
export type LoadTabCounts = {
  active: number;
  delivered: number;
  history: number;
  attention?: number;
};

export const LOAD_TAB_LABEL: Record<LoadTab, string> = {
  attention: "Needs Attention",
  active: "Active",
  delivered: "Delivered",
  history: "History",
};

export type PickupGroup = "earlier" | "today" | "tomorrow" | "week" | "later" | "unscheduled";

export const PICKUP_GROUP_LABEL: Record<PickupGroup, string> = {
  earlier: "Earlier",
  today: "Today",
  tomorrow: "Tomorrow",
  week: "This Week",
  later: "Later",
  unscheduled: "No pickup date",
};

/** Today, tomorrow, the rest of this week, then anything after. Past dates stay in Earlier. */
export function pickupGroup(
  shipDate: string | null | undefined,
  today: string,
  tomorrow: string,
  weekEnd: string,
): PickupGroup {
  if (!shipDate) return "unscheduled";
  if (shipDate < today) return "earlier";
  if (shipDate === today) return "today";
  if (shipDate === tomorrow) return "tomorrow";
  if (shipDate <= weekEnd) return "week";
  return "later";
}

export function attentionReasons(
  order: Pick<CustomerOrder, "loadNumber" | "pendingReviewCount" | "trackingLink" | "trackingStage" | "mustDeliverDate" | "portalStatus">,
  today: string,
): string[] {
  if (order.portalStatus === "cancelled") return [];
  const reasons: string[] = [];
  if (!order.loadNumber) reasons.push("Pending Select load number");
  if ((order.pendingReviewCount ?? 0) > 0) reasons.push("Files in review");
  if ((order.trackingStage === "at_pickup" || order.trackingStage === "in_transit") && !order.trackingLink) {
    reasons.push("Missing tracking");
  }
  if (order.trackingStage !== "delivered" && order.mustDeliverDate && order.mustDeliverDate < today) {
    reasons.push("Past due");
  }
  return reasons;
}

export const DISPLAY_STATUSES = ["pending", "booked", "in_transit", "delivered", "attention", "cancelled"] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

export const DISPLAY_STATUS_LABEL: Record<DisplayStatus, string> = {
  pending: "Confirmed",
  booked: "Booked",
  in_transit: "In Transit",
  delivered: "Delivered",
  attention: "Needs Attention",
  cancelled: "Cancelled",
};

/** The colored pill on a card. For Select, Needs Attention wins over the travel stage. */
export function displayStatus(
  order: Pick<CustomerOrder, "loadNumber" | "pendingReviewCount" | "trackingLink" | "trackingStage" | "mustDeliverDate" | "portalStatus">,
  today: string,
  options?: { needsAttention?: boolean },
): DisplayStatus {
  const needsAttention = options?.needsAttention !== false;
  if (order.portalStatus === "cancelled") return "cancelled";
  if (needsAttention && attentionReasons(order, today).length) return "attention";
  if (order.trackingStage === "delivered") return "delivered";
  if (order.trackingStage === "in_transit" || order.trackingStage === "at_pickup" || order.portalStatus === "shipped") {
    return "in_transit";
  }
  if (order.trackingStage === "booked") return "booked";
  return "pending";
}

/**
 * Names shown on a loads-list card. First pickup and final delivery.
 * Extra stops are the ones between those two. Company text is not rewritten.
 */
export function listEndpointNames(order: {
  origin: { company?: string | null };
  destination: { company?: string | null };
  stops?: Array<{ kind: string; place?: { company?: string | null } | null }> | null;
}): { pickup: string; delivery: string; extraStops: number } {
  const stops = order.stops ?? [];
  const firstPickup = stops.find((stop) => stop.kind === "pickup");
  const finalDelivery = [...stops].reverse().find((stop) => stop.kind === "drop");
  const pickup = (firstPickup ? firstPickup.place?.company : order.origin.company) ?? "";
  const delivery = (finalDelivery ? finalDelivery.place?.company : order.destination.company) ?? "";
  return {
    pickup: pickup.trim(),
    delivery: delivery.trim(),
    extraStops: stops.length > 2 ? stops.length - 2 : 0,
  };
}

/** Shipped, Delivered, and Cancelled sit below loads that are still open. */
export function loadIsFinished(order: {
  portalStatus?: string | null;
  trackingStage?: string | null;
}): boolean {
  return order.portalStatus === "shipped" || order.portalStatus === "cancelled" || order.trackingStage === "delivered";
}

export interface LoadListSortKey {
  id?: string | null;
  salesOrderNumber?: string | null;
  portalStatus?: string | null;
  trackingStage?: string | null;
  shipDate?: string | null;
  shipTime?: string | null;
}

function shipDateKey(order: LoadListSortKey): string {
  return order.shipDate?.trim() ?? "";
}

function shipTimeKey(order: LoadListSortKey, missing: string): string {
  return order.shipTime?.trim() || missing;
}

/**
 * Open dated loads first (soonest ship date and time; a blank time is after timed loads that day).
 * Open loads with no ship date next, by sales order.
 * Shipped, Delivered, and Cancelled last, most recent ship date and time first.
 * A blank time on a finished load sorts as the start of that day. A blank date sorts last.
 */
export function compareLoadList(a: LoadListSortKey, b: LoadListSortKey): number {
  const rankA = loadIsFinished(a) ? 2 : shipDateKey(a) ? 0 : 1;
  const rankB = loadIsFinished(b) ? 2 : shipDateKey(b) ? 0 : 1;
  if (rankA !== rankB) return rankA - rankB;
  if (rankA === 2) {
    const dateA = shipDateKey(a);
    const dateB = shipDateKey(b);
    if (dateA !== dateB) {
      if (!dateA) return 1;
      if (!dateB) return -1;
      return dateB.localeCompare(dateA);
    }
    const time = shipTimeKey(b, "00:00").localeCompare(shipTimeKey(a, "00:00"));
    if (time) return time;
  } else if (rankA === 0) {
    const date = shipDateKey(a).localeCompare(shipDateKey(b));
    if (date) return date;
    const time = shipTimeKey(a, "24:00").localeCompare(shipTimeKey(b, "24:00"));
    if (time) return time;
  }
  const salesOrder = (a.salesOrderNumber ?? "").localeCompare(b.salesOrderNumber ?? "");
  if (salesOrder) return salesOrder;
  return (a.id ?? "").localeCompare(b.id ?? "");
}

export function sortLoadList<T extends LoadListSortKey>(orders: T[]): T[] {
  return [...orders].sort(compareLoadList);
}

/** Put an updated card back into the list order. A new Shipped status drops it into the finished group. */
export function replaceListedOrder<T extends LoadListSortKey>(rows: T[], next: T): T[] {
  return sortLoadList(rows.map((row) => (row.id === next.id ? next : row)));
}

/**
 * A focus refresh can still be in flight when a cost save returns. The older
 * response must not replace the order the save just wrote.
 * Server timestamps are ISO-8601, so string order matches time order.
 */
export function preferNewerOrder<T extends { updatedAt?: string | null }>(current: T | null | undefined, incoming: T): T {
  if (!current?.updatedAt || !incoming.updatedAt) return incoming;
  return incoming.updatedAt >= current.updatedAt ? incoming : current;
}

/** Page-1 list refresh. Keeps a card whose save is newer than this response. */
export function mergeListedOrders<T extends { id: string; updatedAt?: string | null }>(current: T[], incoming: T[]): T[] {
  const local = new Map(current.map((order) => [order.id, order]));
  return incoming.map((order) => preferNewerOrder(local.get(order.id), order));
}

export function fileSummary(order: Pick<CustomerOrder, "attachmentCount" | "bolCount" | "pendingReviewCount">): string {
  const files = order.attachmentCount + order.bolCount;
  const filePart = files === 0 ? "" : files === 1 ? "1 file" : `${files} files`;
  const pending = order.pendingReviewCount ?? 0;
  if (pending <= 0) return filePart || "No files yet";
  const review = pending === 1 ? "1 awaiting review" : `${pending} awaiting review`;
  return filePart ? `${filePart}, ${review}` : review.charAt(0).toUpperCase() + review.slice(1);
}

export const SIMPLE_STEPS = ["Confirmed", "Booked", "Picked up", "Delivered"] as const;

export function simpleStepIndex(stage: TrackingStage): number {
  if (stage === "submitted") return 0;
  if (stage === "booked") return 1;
  if (stage === "at_pickup" || stage === "in_transit") return 2;
  return 3;
}

export function tripCaption(stage: TrackingStage, cancelled: boolean): string {
  if (cancelled) return "This load was cancelled.";
  if (stage === "submitted") return "Confirmed. Select has this load. A truck is not booked yet.";
  if (stage === "booked") return "Booked. A truck is booked and has not arrived at the dock yet.";
  if (stage === "at_pickup") return "The driver is at the pickup.";
  if (stage === "in_transit") return "Picked up. The truck is on the road.";
  return "Delivered.";
}

export function emptyListMessage(tab: LoadTab, filtering: boolean): string {
  if (filtering) return "No loads match that search. Try a load number, a city, or a receiver.";
  if (tab === "attention") return "Nothing needs attention right now.";
  if (tab === "active") return "No loads are booked or on the road.";
  if (tab === "delivered") return "No deliveries in the last 7 days.";
  return "History is empty. Older deliveries and cancelled loads show up here.";
}

function cell(value: string | number | null | undefined): string {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * History export. Pricing columns are included only when this viewer may see EMIT's cost.
 * Carrier pay is not a column. Driver, carrier company, and MC are included only for
 * viewers who can see carrier identity.
 */
export function loadsToCsv(orders: CustomerOrder[], includePricing: boolean, includeCarrier = false): string {
  const headers = [
    "Sales order",
    "Select load",
    "Status",
    "Stage",
    "Pickup",
    "Pickup city",
    "Pickup state",
    "Pickup date",
    "Receiver",
    "Receiver city",
    "Receiver state",
    "Must deliver",
    "Truck",
    "Tracking link",
    "Comments",
  ];
  if (includeCarrier) headers.push("Driver", "Carrier company", "MC");
  if (includePricing) headers.push("Cost", "Rate reason");
  const lines = [headers.join(",")];
  for (const order of orders) {
    const row = [
      order.salesOrderNumber,
      order.loadNumber ?? "",
      order.portalStatus,
      order.trackingStage,
      order.origin.company,
      order.origin.city,
      order.origin.state,
      order.shipDate ?? "",
      order.destination.company,
      order.destination.city,
      order.destination.state,
      order.mustDeliverDate ?? "",
      order.truckType ?? "",
      order.trackingLink ?? "",
      order.comments ?? "",
    ];
    if (includeCarrier) {
      row.push(order.driverName ?? "", order.carrierName ?? "", order.carrierMc ?? "");
    }
    if (includePricing) {
      row.push(order.customerCost == null ? "" : order.customerCost.toFixed(2), order.rateReason ?? "");
    }
    lines.push(row.map(cell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
