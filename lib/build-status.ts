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
      notices.push({ at, kind, text });
    }
    return notices;
  } catch {
    return [];
  }
}
