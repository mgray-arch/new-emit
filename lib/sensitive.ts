/**
 * Language that means a page or note is about what Select pays a carrier.
 * Shared by the document screener, the customer-view redaction, and the assistant.
 * Dollar amounts by themselves are not enough — a BOL can name a declared value.
 * A SAM bill of lading names itself ("BILL OF LADING" and "BOL #:" plus the load
 * number). On that page only the dollar-amount-plus-carrier rule is skipped.
 * Every explicit rate-confirmation phrase above still holds the page.
 */

const STRONG: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rate\s*confirmations?/i, reason: "Page says rate confirmation." },
  { pattern: /\brate\s*cons?\b/i, reason: "Page says rate con." },
  { pattern: /carrier\s*pay/i, reason: "Page mentions carrier pay." },
  { pattern: /carrier\s*rates?/i, reason: "Page mentions a carrier rate." },
  { pattern: /carrier\s*costs?/i, reason: "Page mentions carrier cost." },
  { pattern: /load\s*confirmations?/i, reason: "Page says load confirmation." },
  { pattern: /line\s*-?\s*hauls?/i, reason: "Page mentions line haul." },
  { pattern: /agreed\s*rates?/i, reason: "Page mentions an agreed rate." },
  { pattern: /carrier\s*settlements?/i, reason: "Page mentions carrier settlement." },
  { pattern: /quick\s*pay/i, reason: "Page mentions quick pay." },
  { pattern: /amount\s+due\s+(to\s+)?(the\s+)?carrier/i, reason: "Page states an amount due to the carrier." },
  { pattern: /pay(?:able)?\s+to\s+(the\s+)?carrier/i, reason: "Page says pay to the carrier." },
  { pattern: /paid\s+to\s+(the\s+)?(motor\s+)?carrier/i, reason: "Page says paid to the carrier." },
  { pattern: /compensation\s+to\s+(the\s+)?(motor\s+)?carrier/i, reason: "Page states carrier compensation." },
  { pattern: /total\s+carrier\s+pay/i, reason: "Page mentions total carrier pay." },
  { pattern: /broker\s*carrier\s*agreements?/i, reason: "Page is a broker-carrier agreement." },
];

/**
 * A dollar amount. "$0-002002" and "$12-345" are misread reference numbers, not
 * money: the leading lookahead rejects the whole "$" + digits + "-" + digit
 * token so the engine cannot backtrack into a shorter hit such as "$0" or "$1".
 * Real amounts ($1,850.00, $2500) and ranges written "$1,200-$1,500" still match.
 */
const DOLLAR =
  /\$(?!\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?-\d)\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/;
const CARRIER_MONEY_CONTEXT =
  /\b(carriers?|motor\s+carrier|mc\s*#?\s*\d{3,}|line\s*-?\s*haul|rate\s+per\s+mile|all[-\s]?in\s+rate)\b/i;

/** SAM's bill of lading: "BILL OF LADING" and "BOL #:" followed by a load number like 461169-1. */
function isSamSelectBol(text: string): boolean {
  return /bill\s+of\s+lading/i.test(text) && /bol\s*#\s*:\s*\d{6}\s*-\s*\d{1,2}(?!\d)/i.test(text);
}

/** Hyphens and underscores count as spaces, so rate-confirmation and carrier-pay still match. */
function loosen(text: string): string {
  return text.replace(/[_-]+/g, " ");
}

export function sensitiveReason(text: string): string | null {
  const loose = loosen(text);
  for (const rule of STRONG) {
    if (rule.pattern.test(loose)) return rule.reason;
  }
  if (!isSamSelectBol(text) && DOLLAR.test(text) && CARRIER_MONEY_CONTEXT.test(loose)) {
    return "A dollar amount is tied to carrier or line-haul language.";
  }
  return null;
}

export function redactSensitiveText(text: string): string {
  if (!text) return "";
  const parts = text.split(/\n+|(?<=[.!?])\s+/);
  const kept = parts.map((part) => part.trim()).filter((part) => part && !sensitiveReason(part));
  return kept.join(" ").replace(/\s+/g, " ").trim();
}
