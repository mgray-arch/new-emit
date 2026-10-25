import { randomUUID } from "node:crypto";
import type { Place, Stop, StopKind, StopSchedule } from "@/lib/types";

export interface StopInput {
  id?: string;
  kind: StopKind;
  place: Place;
  locationId?: string | null;
  schedule?: StopSchedule | null;
}

/**
 * A drop before every pickup is allowed, but the form should say so.
 * Returns null when the sequence has a pickup first, or when a pickup or drop is missing
 * (those are hard errors, not warnings).
 */
export function stopSequenceWarning(stops: Array<{ kind: StopKind }>): string | null {
  const firstPickup = stops.findIndex((stop) => stop.kind === "pickup");
  const firstDrop = stops.findIndex((stop) => stop.kind === "drop");
  if (firstPickup < 0 || firstDrop < 0) return null;
  if (firstDrop < firstPickup) {
    return "A drop is listed before every pickup. Save only if that sequence is intentional.";
  }
  return null;
}

export function resolvedRoute(input: { stops?: StopInput[] | null }): { stops: Stop[]; origin: Place; destination: Place } {
  const stops = (input.stops ?? []).map((stop) => ({
    id: stop.id && stop.id.trim() ? stop.id.trim() : randomUUID(),
    kind: stop.kind,
    place: { ...stop.place, country: stop.place.country || "US", address2: stop.place.address2 ?? "" },
    locationId: stop.locationId ?? null,
    ...(stop.schedule ? { schedule: stop.schedule } : {}),
  }));
  const pickup = stops.find((stop) => stop.kind === "pickup");
  const drop = [...stops].reverse().find((stop) => stop.kind === "drop");
  if (!pickup || !drop) {
    throw new Error("Add at least one pickup and one drop.");
  }
  return { stops, origin: pickup.place, destination: drop.place };
}

export function legacyStops(origin: Place, destination: Place): StopInput[] {
  return [
    { id: "stop-1", kind: "pickup", place: origin },
    { id: "stop-2", kind: "drop", place: destination },
  ];
}
