import type { PortalStatus } from "@/lib/types";

/**
 * Stages a person can set from the load list. In Transit is the old Shipped action.
 * Delivered is a separate button for Select and EMIT admins. Cancelled stays on Edit load.
 */
export const LIST_PORTAL_STATUSES = ["being_prepared", "ready_to_ship", "in_transit"] as const;
export type ListPortalStatus = (typeof LIST_PORTAL_STATUSES)[number];

export function isListPortalStatus(value: string): value is ListPortalStatus {
  return (LIST_PORTAL_STATUSES as readonly string[]).includes(value);
}

/** The list menu. The old name `shipped` is the In Transit choice. */
export function asListPortalStatus(value: string): ListPortalStatus | null {
  if (value === "shipped") return "in_transit";
  return isListPortalStatus(value) ? value : null;
}

/** A save that would newly set Ready to Ship. Saving an order that is already there does not ask again. */
export function stageBecomesReadyToShip(current: PortalStatus | null | undefined, next: PortalStatus): boolean {
  return next === "ready_to_ship" && current !== "ready_to_ship";
}

/**
 * What the list card should do with a picked stage.
 * Ready to Ship confirms first. The current stage, and anything outside the list stages, does nothing.
 */
export function listStageChoice(current: PortalStatus, next: string): "noop" | "confirm" | "apply" {
  const picked = asListPortalStatus(next);
  if (!picked || picked === current) return "noop";
  if (stageBecomesReadyToShip(current, picked)) return "confirm";
  return "apply";
}

/** Stage choices on Edit load. Delivered is included for people who can mark it, and when the load is already there. */
export function formStageOptions(current: PortalStatus, allowDelivered: boolean): PortalStatus[] {
  const options: PortalStatus[] = ["being_prepared", "ready_to_ship", "in_transit"];
  if (allowDelivered || current === "delivered") options.push("delivered");
  options.push("cancelled");
  if (!options.includes(current)) options.push(current);
  return options;
}
