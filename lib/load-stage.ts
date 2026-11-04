import type { PortalStatus } from "@/lib/types";

/** A save that would newly set Ready to Ship. Saving an order that is already there does not ask again. */
export function stageBecomesReadyToShip(current: PortalStatus | null | undefined, next: PortalStatus): boolean {
  return next === "ready_to_ship" && current !== "ready_to_ship";
}

export function readyToShipConfirmText(): string {
  return "Saving as Ready to Ship posts this order to Slack once. Load Builder uses that post. Being Prepared does not.";
}
