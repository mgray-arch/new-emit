/**
 * Language that means a page or note is about what Select pays a carrier.
 * Shared by the document screener, the customer-view redaction, and the assistant.
 * Dollar amounts by themselves are not enough — a BOL can name a declared value.
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
];

const DOLLAR = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/;
const CARRIER_MONEY_CONTEXT =
  /\b(carriers?|motor\s+carrier|mc\s*#?\s*\d{3,}|line\s*-?\s*haul|rate\s+per\s+mile|all[-\s]?in\s+rate)\b/i;

/** Hyphens and underscores count as spaces, so rate-confirmation and carrier-pay still match. */
function loosen(text: string): string {
  return text.replace(/[_-]+/g, " ");
}

export function sensitiveReason(text: string): string | null {
  const loose = loosen(text);
  for (const rule of STRONG) {
    if (rule.pattern.test(loose)) return rule.reason;
  }
  if (DOLLAR.test(text) && CARRIER_MONEY_CONTEXT.test(loose)) {
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
