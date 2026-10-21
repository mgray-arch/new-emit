/**
 * Select (SAM) load numbers look like 458934-1: the SAM order id, a dash,
 * and the load sequence. The portal never invents one.
 *
 * A Select admin types the number after building the load in SAM (source "manual").
 * A future SAM API sync should call assignSelectLoadNumber / syncSelectLoadNumberFromSam
 * with source "sam" and the number SAM returned. Until that sync exists, an empty
 * number means the load is pending.
 */

export const SELECT_LOAD_NUMBER = /^\d{3,12}-\d{1,4}$/;

export const PENDING_LOAD_LABEL = "Pending";

export type LoadNumberSource = "manual" | "sam";

export function formatLoadNumber(value: string | null | undefined): string {
  const text = value?.trim();
  return text ? text : PENDING_LOAD_LABEL;
}

/**
 * Empty input clears the number (pending). A non-empty value must match
 * the SAM shape. Spaces around the dash are ignored.
 */
export function normalizeSelectLoadNumber(value: unknown): { loadNumber: string | null; error?: string } {
  if (value == null) return { loadNumber: null };
  const compact = String(value).trim().replace(/\s+/g, "");
  if (!compact) return { loadNumber: null };
  if (!SELECT_LOAD_NUMBER.test(compact)) {
    return { loadNumber: null, error: "Enter a Select load number like 458934-1." };
  }
  return { loadNumber: compact };
}

/** Number SAM returned, or null when the payload has none or it is not a load number. */
export function parseSelectLoadNumber(value: unknown): string | null {
  const normalized = normalizeSelectLoadNumber(value);
  if (normalized.error) return null;
  return normalized.loadNumber;
}
