import type { TrackingStage } from "@/lib/types";

/** Shown when a load has no public tracking link yet. */
export const NO_LIVE_TRACKING = "No live tracking link yet. Select adds one when the truck is on the way.";

/**
 * The tracking card on an EMIT order. It follows shipment progress.
 * It does not mention how Select builds the load.
 */
export function trackingCardCopy(input: {
  trackingStage: TrackingStage;
  carrierAssigned: boolean;
  cancelled?: boolean;
}): { kicker: string; title: string; phrase: string } {
  if (input.cancelled) {
    return { kicker: "Cancelled", title: "This load was cancelled", phrase: "Cancelled" };
  }
  if (input.trackingStage === "submitted") {
    return { kicker: "Confirmed", title: "Waiting for carrier", phrase: "Confirmed - waiting for carrier" };
  }
  if (input.trackingStage === "booked") {
    const title = input.carrierAssigned ? "Carrier assigned" : "Being scheduled";
    return { kicker: "Booked", title, phrase: `Booked - ${title.charAt(0).toLowerCase()}${title.slice(1)}` };
  }
  if (input.trackingStage === "at_pickup") {
    return { kicker: "Picked up", title: "At the pickup", phrase: "Picked up - at the pickup" };
  }
  if (input.trackingStage === "in_transit") {
    return { kicker: "Picked up", title: "On the road", phrase: "Picked up - on the road" };
  }
  return { kicker: "Delivered", title: "Delivered", phrase: "Delivered" };
}

/** Read-only status for EMIT. A stored number is a load number, not a build system. */
export function customerBuildStatus(
  loadNumber: string | null | undefined,
  slackNotifiedAt: string | null | undefined,
): string | null {
  const number = loadNumber?.trim() ?? "";
  if (number) return `Load # ${number}`;
  if (slackNotifiedAt?.trim()) return "Sent to Slack";
  return null;
}

/** Drop the word SAM from text an EMIT user, receiver, or public page can read. */
export function customerFacingText(value: string | null | undefined): string {
  if (!value) return "";
  const replaced = value
    .replace(/\bImported from SAM\b/gi, "Imported")
    .replace(/\bBuilt in SAM:\s*/gi, "Load # ");
  if (!/\bSAM\b/i.test(replaced)) return replaced.trim();
  return replaced
    .split(/\n+|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part && !/\bSAM\b/i.test(part))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
