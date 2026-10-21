import type { CustomerOrder } from "@/lib/types";

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
