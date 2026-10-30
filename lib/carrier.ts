import { PortalError } from "@/lib/http";

/** Blank clears the field. Extra spaces collapse. Pay is never accepted here. */
export function normalizeCarrierName(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!value) return null;
  if (value.length > 120) throw new PortalError("Carrier name must be 120 characters or fewer.");
  return value;
}

export function normalizeDriverName(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!value) return null;
  if (value.length > 80) throw new PortalError("Driver name must be 80 characters or fewer.");
  return value;
}

/**
 * Digits only, 1 to 8. An optional "MC" prefix is stripped. Blank clears the field.
 * This is the carrier's MC number, not a rate and not pay.
 */
export function normalizeCarrierMc(raw: string | null | undefined): string | null {
  const stripped = (raw ?? "").trim().replace(/^MC[\s#-]*/i, "").replace(/\s+/g, "");
  if (!stripped) return null;
  if (!/^\d{1,8}$/.test(stripped)) throw new PortalError("MC number must be 1 to 8 digits.");
  return stripped;
}

export function carrierIdentityLabel(input: {
  driverName?: string | null;
  carrierName?: string | null;
  carrierMc?: string | null;
}): string {
  if (!input.driverName && !input.carrierName && !input.carrierMc) return "Carrier not assigned";
  const driver = input.driverName?.trim() || "—";
  const carrier = input.carrierName?.trim() || "—";
  const mc = input.carrierMc?.trim() || "—";
  return `Driver: ${driver} · Carrier: ${carrier} · MC ${mc}`;
}
