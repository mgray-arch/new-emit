/** EMIT's own cost: what EMIT pays Select. This is never carrier pay. */

export const COST_ERROR = "Enter a dollar amount from 0 to 1000000, with at most two decimal places.";

const MAX_CENTS = 1_000_000 * 100;
const DOLLAR_TEXT = /^\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/;

export function formatCostCents(cents: number | null): string {
  if (cents == null) return "not set";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** History line for the load page. The clock is stored separately on the event. */
export function costHistoryText(fromCents: number | null, toCents: number | null, who: string): string {
  return `Cost changed from ${formatCostCents(fromCents)} to ${formatCostCents(toCents)} by ${who}.`;
}

function centsFromNumber(amount: number): { cents: number } | { error: string } {
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return { error: COST_ERROR };
  const scaled = amount * 100;
  const cents = Math.round(scaled);
  if (!Number.isSafeInteger(cents) || Math.abs(scaled - cents) > 1e-6 || cents > MAX_CENTS) return { error: COST_ERROR };
  return { cents };
}

/**
 * A dollar amount, or blank for "not set".
 * Accepts 1500, 1500.50, $1,500.00. Rejects negatives, extra decimals, and text.
 */
export function parseCustomerCost(value: unknown): { cents: number | null } | { error: string } {
  if (value == null) return { cents: null };
  if (typeof value === "number") return centsFromNumber(value);
  if (typeof value !== "string") return { error: COST_ERROR };
  const trimmed = value.trim();
  if (!trimmed) return { cents: null };
  const match = trimmed.match(DOLLAR_TEXT);
  if (!match) return { error: COST_ERROR };
  const whole = match[1].replace(/,/g, "");
  const fraction = (match[2] ?? "").padEnd(2, "0");
  if (whole.length > 7) return { error: COST_ERROR };
  const dollars = Number(whole);
  const extra = Number(fraction);
  if (!Number.isSafeInteger(dollars) || !Number.isSafeInteger(extra)) return { error: COST_ERROR };
  if (dollars > 1_000_000 || (dollars === 1_000_000 && extra > 0)) return { error: COST_ERROR };
  return { cents: dollars * 100 + extra };
}
