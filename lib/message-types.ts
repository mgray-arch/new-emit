/** Customer-safe message shapes. No prices, carrier fields, or load comments. */

export interface MessageLoadRef {
  id: string | null;
  loadNumber: string | null;
  salesOrderNumber: string | null;
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
}

export interface MessageMention {
  token: string;
  orderId: string;
}

export interface MessageView {
  id: string;
  seq: number;
  body: string;
  createdAt: string;
  authorName: string;
  authorEmail: string;
  side: "emit" | "select";
  mine: boolean;
  load: MessageLoadRef | null;
  mentions: MessageMention[];
}

export interface LoadOption {
  id: string;
  loadNumber: string | null;
  salesOrderNumber: string;
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
}

export interface MessageTextPart {
  text: string;
  orderId: string | null;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,80}$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split plain text into linkable load tokens. Tokens come from the server.
 * Anything that is not a load number or sales order the server recognized stays text.
 */
export function splitMessageMentions(body: string, mentions: MessageMention[]): MessageTextPart[] {
  const unique = new Map<string, string>();
  for (const mention of mentions) {
    if (!TOKEN.test(mention.token) || !mention.orderId) continue;
    unique.set(mention.token.toLowerCase(), mention.orderId);
  }
  const tokens = [...unique.keys()].sort((left, right) => right.length - left.length);
  if (!tokens.length) return body ? [{ text: body, orderId: null }] : [];
  const re = new RegExp(`(^|[^A-Za-z0-9])(${tokens.map(escapeRegExp).join("|")})(?=$|[^A-Za-z0-9])`, "gi");
  const parts: MessageTextPart[] = [];
  let cursor = 0;
  for (const match of body.matchAll(re)) {
    const prefix = match[1] ?? "";
    const token = match[2] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    if (start > cursor) parts.push({ text: body.slice(cursor, start), orderId: null });
    parts.push({ text: body.slice(start, start + token.length), orderId: unique.get(token.toLowerCase()) ?? null });
    cursor = start + token.length;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor), orderId: null });
  return parts.filter((part) => part.text.length > 0);
}
