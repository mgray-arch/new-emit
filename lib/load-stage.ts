import type { PortalStatus } from "@/lib/types";

/** Stages a person can set from the load list. Cancelled stays on Edit load. */
export const LIST_PORTAL_STATUSES = ["being_prepared", "ready_to_ship", "shipped"] as const;
export type ListPortalStatus = (typeof LIST_PORTAL_STATUSES)[number];

export function isListPortalStatus(value: string): value is ListPortalStatus {
  return (LIST_PORTAL_STATUSES as readonly string[]).includes(value);
}

/** A save that would newly set Ready to Ship. Saving an order that is already there does not ask again. */
export function stageBecomesReadyToShip(current: PortalStatus | null | undefined, next: PortalStatus): boolean {
  return next === "ready_to_ship" && current !== "ready_to_ship";
}

/**
 * What the list card should do with a picked stage.
 * Ready to Ship confirms first. The current stage, and anything outside the three list stages, does nothing.
 */
export function listStageChoice(current: PortalStatus, next: string): "noop" | "confirm" | "apply" {
  if (!isListPortalStatus(next) || next === current) return "noop";
  if (stageBecomesReadyToShip(current, next)) return "confirm";
  return "apply";
}
