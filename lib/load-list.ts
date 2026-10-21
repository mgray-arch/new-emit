import type { CustomerOrder, TrackingStage } from "@/lib/types";

/** Working queues. A load sits in exactly one of these. */
export const LOAD_TABS = ["attention", "active", "delivered", "history"] as const;
export type LoadTab = (typeof LOAD_TABS)[number];

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
  if (order.pendingReviewCount > 0) reasons.push("Files in review");
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
  pending: "Pending",
  booked: "Booked",
  in_transit: "In Transit",
  delivered: "Delivered",
  attention: "Needs Attention",
  cancelled: "Cancelled",
};

/** The colored pill on a card. Needs Attention wins over the travel stage. */
export function displayStatus(
  order: Pick<CustomerOrder, "loadNumber" | "pendingReviewCount" | "trackingLink" | "trackingStage" | "mustDeliverDate" | "portalStatus">,
  today: string,
): DisplayStatus {
  if (order.portalStatus === "cancelled") return "cancelled";
  if (attentionReasons(order, today).length) return "attention";
  if (order.trackingStage === "delivered") return "delivered";
  if (order.trackingStage === "in_transit" || order.trackingStage === "at_pickup" || order.portalStatus === "shipped") {
    return "in_transit";
  }
  if (order.trackingStage === "booked" || order.portalStatus === "ready_to_ship") return "booked";
  return "pending";
}

export function fileSummary(order: Pick<CustomerOrder, "attachmentCount" | "bolCount" | "pendingReviewCount">): string {
  const files = order.attachmentCount + order.bolCount;
  const filePart = files === 0 ? "" : files === 1 ? "1 file" : `${files} files`;
  if (order.pendingReviewCount <= 0) return filePart || "No files yet";
  const review = order.pendingReviewCount === 1 ? "1 awaiting review" : `${order.pendingReviewCount} awaiting review`;
  return filePart ? `${filePart}, ${review}` : review.charAt(0).toUpperCase() + review.slice(1);
}

export const SIMPLE_STEPS = ["Ordered", "Booked", "Picked up", "Delivered"] as const;

export function simpleStepIndex(stage: TrackingStage): number {
  if (stage === "submitted") return 0;
  if (stage === "booked") return 1;
  if (stage === "at_pickup" || stage === "in_transit") return 2;
  return 3;
}

export function tripCaption(stage: TrackingStage, cancelled: boolean): string {
  if (cancelled) return "This load was cancelled.";
  if (stage === "submitted") return "Ordered. Select has not booked a truck yet.";
  if (stage === "booked") return "Booked. The truck has not arrived at the dock.";
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
 * Carrier pay is not a column.
 */
export function loadsToCsv(orders: CustomerOrder[], includePricing: boolean): string {
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
    if (includePricing) {
      row.push(order.customerCost == null ? "" : order.customerCost.toFixed(2), order.rateReason ?? "");
    }
    lines.push(row.map(cell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
