/** Who owns a portal load. This portal is EMIT only. */
export type LoadOwner = "Drew" | "Ainsley";

export interface LoadOwnerInput {
  /** Delivery state, such as TX. Blank means the destination is unknown. */
  destinationState?: string | null;
  /** Delivery city, such as Price. Used with the state for Price, UT. */
  destinationCity?: string | null;
  /** Equipment label, such as 53' Flatbed. Blank means the equipment is unknown. */
  equipment?: string | null;
}

export interface LoadAssignment {
  owner: LoadOwner;
  /** True when equipment or destination was missing, so a person should confirm the owner. */
  needsCheck: boolean;
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

/** Price, UT. City and state are both required. Equipment does not matter. */
function deliversToPriceUtah(city: string | null | undefined, state: string | null | undefined): boolean {
  const place = (city ?? "").trim().toLowerCase();
  const region = (state ?? "").trim().toLowerCase();
  return place === "price" && (region === "ut" || region === "utah");
}

/**
 * Drew owns every load into Price, UT, and flatbed or hot shot freight into Texas.
 * Ainsley owns every other load. Missing equipment or destination still goes to
 * Ainsley, with needsCheck, unless the delivery is already Price, UT.
 */
export function assignLoadOwner(input: LoadOwnerInput): LoadAssignment {
  if (deliversToPriceUtah(input.destinationCity, input.destinationState)) {
    return { owner: "Drew", needsCheck: false };
  }
  const equipment = equipmentKind(input.equipment);
  const texas = deliversToTexas(input.destinationState);
  const needsCheck = equipment === "unknown" || texas === null;
  if (!needsCheck && texas && (equipment === "flatbed" || equipment === "hotshot")) {
    return { owner: "Drew", needsCheck: false };
  }
  return { owner: "Ainsley", needsCheck };
}
