/** Who owns a portal load. This portal is EMIT only. */
export type LoadOwner = "Drew" | "Ainsley";

export interface LoadOwnerInput {
  /** Delivery state, such as TX. Blank means the destination is unknown. */
  destinationState?: string | null;
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

/**
 * Drew owns flatbed (any name containing "flatbed") or hot shot freight that delivers
 * to Texas. Ainsley owns every other load: box trucks, anything that delivers outside
 * Texas, and other equipment. Missing equipment or destination still goes to Ainsley,
 * with needsCheck so the Slack note asks a person to confirm.
 */
export function assignLoadOwner(input: LoadOwnerInput): LoadAssignment {
  const equipment = equipmentKind(input.equipment);
  const texas = deliversToTexas(input.destinationState);
  const needsCheck = equipment === "unknown" || texas === null;
  if (!needsCheck && texas && (equipment === "flatbed" || equipment === "hotshot")) {
    return { owner: "Drew", needsCheck: false };
  }
  return { owner: "Ainsley", needsCheck };
}
