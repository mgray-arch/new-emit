/**
 * A public SAM / MacroPoint share link. Only http(s) URLs are stored.
 * `syncTrackingLinkFromSam` in lib/select-load.ts is what a future SAM sync calls.
 */

export const TRACKING_LINK_MAX = 2000;

export function parseTrackingLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > TRACKING_LINK_MAX) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return trimmed;
}
