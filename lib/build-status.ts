import type { OrderNotice } from "@/lib/types";

/** Read-only label for the list and the load page. */
export function buildStatusLabel(
  loadNumber: string | null | undefined,
  slackNotifiedAt: string | null | undefined,
): string | null {
  const number = loadNumber?.trim() ?? "";
  if (number) return `Built in SAM: ${number}`;
  if (slackNotifiedAt?.trim()) return "Sent to Slack";
  return null;
}

const LEGACY_CARRIER = /Carrier:\s*(.+?)\.\s*MC\s*([^.]+)\./i;

/** Older history lines named the company only inside the sentence. */
function legacyCarrier(text: string): { company: string; mc: string } | null {
  const match = text.match(LEGACY_CARRIER);
  if (!match) return null;
  const company = match[1].trim();
  const raw = match[2].trim();
  const mc = /^not provided$/i.test(raw) ? "" : raw.replace(/^mc[\s#-]+/i, "");
  if (!company && !mc) return null;
  return { company, mc };
}

export function parseOrderNotices(raw: string | null | undefined): OrderNotice[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const notices: OrderNotice[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const kind = row.kind === "assigned" || row.kind === "changed" ? row.kind : null;
      const text = typeof row.text === "string" ? row.text.trim() : "";
      const at = typeof row.at === "string" ? row.at : "";
      if (!kind || !text) continue;
      const fromLog = {
        company: typeof row.company === "string" ? row.company.trim() : "",
        mc: typeof row.mc === "string" ? row.mc.trim() : "",
      };
      const named = fromLog.company || fromLog.mc ? fromLog : legacyCarrier(text);
      notices.push({
        at,
        kind,
        text,
        ...(named?.company ? { company: named.company } : {}),
        ...(named ? { mc: named.mc } : {}),
      });
    }
    return notices;
  } catch {
    return [];
  }
}
