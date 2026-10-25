/** Who should own a new load. Change this function when the rule changes. */
export type LoadOwner = "Drew" | "Ainsley" | "Unassigned";

export interface LoadOwnerInput {
  /** Customer name. Blank means the customer is unknown. */
  customer?: string | null;
  /** Delivery state, such as TX. Blank means the destination is unknown. */
  destinationState?: string | null;
  /** Equipment label, such as 53' Flatbed. Blank means the equipment is unknown. */
  equipment?: string | null;
}

type EquipmentKind = "flatbed" | "hotshot" | "box" | "other" | "unknown";

function equipmentKind(equipment: string | null | undefined): EquipmentKind {
  const value = (equipment ?? "").trim().toLowerCase().replace(/['’]/g, "");
  if (!value) return "unknown";
  if (/box\s*truck/.test(value)) return "box";
  if (/hot\s*-?\s*shot/.test(value)) return "hotshot";
  if (value.includes("flatbed")) return "flatbed";
  return "other";
}

/** True, false, or null when the state was not provided. */
function deliversToTexas(state: string | null | undefined): boolean | null {
  const value = (state ?? "").trim().toLowerCase();
  if (!value) return null;
  return value === "tx" || value === "texas";
}

/** True for EMIT, false for a named other customer, null when the customer is blank. */
function isEmitCustomer(customer: string | null | undefined): boolean | null {
  const value = (customer ?? "").trim();
  if (!value) return null;
  return /^emit\b/i.test(value);
}

/**
 * Drew owns EMIT freight that delivers to Texas on a flatbed (any name containing
 * "flatbed") or a hot shot. Ainsley owns EMIT box trucks, EMIT freight that delivers
 * outside Texas, and every other customer. Missing equipment or destination stays
 * Unassigned when the rule would have to guess. A box truck does not need a
 * destination. Another customer does not need equipment or a destination.
 */
export function assignLoadOwner(input: LoadOwnerInput): LoadOwner {
  const emit = isEmitCustomer(input.customer);
  if (emit === false) return "Ainsley";
  if (emit === null) return "Unassigned";

  const equipment = equipmentKind(input.equipment);
  if (equipment === "box") return "Ainsley";

  const texas = deliversToTexas(input.destinationState);
  if (texas === null) return "Unassigned";
  if (!texas) return "Ainsley";
  if (equipment === "flatbed" || equipment === "hotshot") return "Drew";
  return "Unassigned";
}
