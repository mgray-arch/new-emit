import { portalPublicUrl } from "@/lib/public-url";
import { redactSensitiveText } from "@/lib/sensitive";

/** Slack incoming webhook for a portal message. Separate from the new-load webhook. */
export const MESSAGE_PREVIEW_LIMIT = 80;

/**
 * Who a message note may @mention. Keys match loads.owner.
 * Drew Martin (dmartin@goselect.com) and Ainsley Hamilton (ahamilton@goselect.com).
 * SLACK_USER_ID_DREW and SLACK_USER_ID_AINSLEY replace those ids when set to a member id.
 * A blank or invalid override keeps the built-in id. Any other name is plain text.
 */
export const MESSAGE_OWNER_SLACK: Readonly<Record<string, { slackId: string; envKey: string }>> = {
  Drew: { slackId: "U0AGS6MDBL1", envKey: "SLACK_USER_ID_DREW" },
  Ainsley: { slackId: "U0CE02REJCB", envKey: "SLACK_USER_ID_AINSLEY" },
};

/** Same shape the new-load note accepts: a Slack member id, not a display name. */
const SLACK_USER_ID = /^[UW][A-Z0-9]+$/i;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let emailSkipWarned = false;

export interface MessageNotice {
  authorName: string;
  authorEmail: string;
  loadNumber: string | null;
  salesOrderNumber: string | null;
  /** City and state, such as "Pecos, TX". Empty when the load has none. */
  destination?: string | null;
  /** loads.owner. Blank when the load has no owner. */
  owner?: string | null;
  preview: string;
  threadUrl: string;
  /**
   * Slack ts of the first post on this portal thread.
   * Set only when this note should be a reply under that post.
   */
  slackThreadTs?: string | null;
}

export interface MessageEmailDraft {
  to: string[];
  subject: string;
  text: string;
}

/** Short preview. Sensitive sentences are dropped. The rest of the message is not included. */
export function messagePreview(body: string): string {
  const flat = redactSensitiveText(body).replace(/\s+/g, " ").trim();
  const text = flat || "New message";
  if (text.length <= MESSAGE_PREVIEW_LIMIT) return text;
  return `${text.slice(0, MESSAGE_PREVIEW_LIMIT - 1).trimEnd()}…`;
}

export function messageThreadUrl(
  env: Record<string, string | undefined> = process.env,
  ref?: { loadId?: string | null; threadId?: string | null },
): string {
  const base = (env.PORTAL_PUBLIC_URL?.trim() || portalPublicUrl()).replace(/\/$/, "");
  const root = base ? `${base}/messages` : "/messages";
  const loadId = ref?.loadId?.trim() ?? "";
  const threadId = ref?.threadId?.trim() ?? "";
  if (loadId) return `${root}?load=${encodeURIComponent(loadId)}`;
  if (threadId) return `${root}?thread=${encodeURIComponent(threadId)}`;
  return root;
}

/** Slack Web API target. Both values are required. A blank or invalid pair means "not set". */
export function slackBotTarget(env: Record<string, string | undefined> = process.env): { token: string; channel: string } | null {
  const token = env.SLACK_BOT_TOKEN?.trim() ?? "";
  const channel = env.SLACK_MESSAGES_CHANNEL_ID?.trim() ?? "";
  if (!token || !channel) return null;
  if (token.length < 10 || /\s/.test(token) || /^https?:/i.test(token)) return null;
  if (!/^[CGD][A-Z0-9]{8,}$/.test(channel)) return null;
  return { token, channel };
}

const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";

export function messageWebhookUrl(env: Record<string, string | undefined> = process.env): string | null {
  const url = env.SLACK_MESSAGES_WEBHOOK_URL?.trim() ?? "";
  if (!url.startsWith("https://") && !url.startsWith("http://")) return null;
  return url;
}

export function messageNotifyEmails(env: Record<string, string | undefined> = process.env): string[] {
  return (env.MESSAGE_NOTIFY_EMAILS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item, index, all) => EMAIL.test(item) && all.indexOf(item) === index);
}

function salesOrderText(value: string | null): string | null {
  const text = value?.trim() ?? "";
  return text ? text.toUpperCase() : null;
}

export function messageLoadLine(notice: Pick<MessageNotice, "loadNumber" | "salesOrderNumber">): string {
  const salesOrder = salesOrderText(notice.salesOrderNumber);
  if (notice.loadNumber) {
    return salesOrder ? `Load ${notice.loadNumber} · ${salesOrder}` : `Load ${notice.loadNumber}`;
  }
  if (salesOrder) return `Load number pending · ${salesOrder}`;
  return "No load attached";
}

interface CityState {
  city: string;
  state: string;
}

function parseJson(value: string | null | undefined): unknown {
  if (!value?.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readPlace(value: unknown): CityState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { city: "", state: "" };
  const record = value as Record<string, unknown>;
  const city = typeof record.city === "string" ? record.city.trim() : "";
  const rawState = typeof record.state === "string" ? record.state.trim() : "";
  const state = /^[A-Za-z]{2}$/.test(rawState) ? rawState.toUpperCase() : rawState;
  return { city, state };
}

function formatCityState(place: CityState): string {
  if (place.city && place.state) return `${place.city}, ${place.state}`;
  return place.city || place.state;
}

function placeOfStop(stop: unknown): CityState {
  if (!stop || typeof stop !== "object" || Array.isArray(stop)) return { city: "", state: "" };
  const record = stop as { place?: unknown };
  if (record.place && typeof record.place === "object") return readPlace(record.place);
  return readPlace(stop);
}

function isMultiStop(stops: unknown[]): boolean {
  if (stops.length > 2) return true;
  let drops = 0;
  for (const stop of stops) {
    if (stop && typeof stop === "object" && !Array.isArray(stop) && (stop as { kind?: unknown }).kind === "drop") {
      drops += 1;
    }
  }
  return drops > 1;
}

/**
 * City and state for the Slack line. A pickup plus one drop uses destination_json.
 * A multi-stop load uses the last stop in stops_json. Only city and state are read.
 */
export function messageDestinationLabel(
  destinationJson: string | null | undefined,
  stopsJson?: string | null,
): string {
  const destination = readPlace(parseJson(destinationJson));
  const parsedStops = parseJson(stopsJson);
  const stops = Array.isArray(parsedStops) ? parsedStops : [];
  if (isMultiStop(stops)) {
    const finalStop = formatCityState(placeOfStop(stops[stops.length - 1]));
    if (finalStop) return finalStop;
  }
  return formatCityState(destination);
}

function ownerSlack(owner: string): { slackId: string; envKey: string } | null {
  const key = Object.keys(MESSAGE_OWNER_SLACK).find((name) => name.toLowerCase() === owner.toLowerCase());
  return key ? MESSAGE_OWNER_SLACK[key] : null;
}

function mentionId(config: { slackId: string; envKey: string }, env: Record<string, string | undefined>): string | null {
  const override = env[config.envKey]?.trim() ?? "";
  if (SLACK_USER_ID.test(override)) return override;
  const fallback = config.slackId.trim();
  return SLACK_USER_ID.test(fallback) ? fallback : null;
}

/** Slack owner line. Unknown, blank, and unmapped owners are not mentioned. */
export function messageOwnerLine(
  owner: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = owner?.trim() ?? "";
  if (!raw) return "Owner: unassigned";
  const config = ownerSlack(raw);
  const id = config ? mentionId(config, env) : null;
  if (!id) return `Owner: ${raw}`;
  return `Owner: <@${id}>`;
}

/** Shorter note for a reply under the first Slack post. The parent already has the lane. */
export function messageReplyText(notice: MessageNotice): string {
  return [`Reply from ${notice.authorName} (${notice.authorEmail})`, messageLoadLine(notice), notice.preview, notice.threadUrl].join(
    "\n",
  );
}

/** Allowlisted Slack text. The full message is not a field on the notice. */
export function messageNoticeText(
  notice: MessageNotice,
  env: Record<string, string | undefined> = process.env,
): string {
  const destination = notice.destination?.trim() ?? "";
  return [
    `New portal message from ${notice.authorName} (${notice.authorEmail})`,
    messageLoadLine(notice),
    `Destination: ${destination || "not set"}`,
    messageOwnerLine(notice.owner, env),
    notice.preview,
    notice.threadUrl,
  ].join("\n");
}

/**
 * What an email would say. This repo has no mail provider, so nothing is sent.
 * A later provider can send this draft without reading the stored message.
 */
export function messageEmailDraft(
  notice: MessageNotice,
  env: Record<string, string | undefined> = process.env,
): MessageEmailDraft | null {
  const to = messageNotifyEmails(env);
  if (!to.length) return null;
  const subject = notice.loadNumber ? `EMIT portal message · Load ${notice.loadNumber}` : "EMIT portal message";
  return { to, subject, text: messageNoticeText(notice, env) };
}

export interface MessageNotifyResult {
  slack: boolean;
  email: "unset" | "skipped_no_provider";
  /** ts from chat.postMessage. Null for the webhook path and for a failed post. */
  ts: string | null;
  mode: "bot" | "webhook" | "off";
}

function emailStatus(env: Record<string, string | undefined>): "unset" | "skipped_no_provider" {
  const email = messageNotifyEmails(env).length > 0 ? "skipped_no_provider" : "unset";
  if (email === "skipped_no_provider" && !emailSkipWarned) {
    emailSkipWarned = true;
    console.warn("MESSAGE_NOTIFY_EMAILS is set, but message notes are not emailed.");
  }
  return email;
}

/**
 * Tell Select that an EMIT person posted.
 * SLACK_BOT_TOKEN and SLACK_MESSAGES_CHANNEL_ID post through chat.postMessage.
 * A reply uses thread_ts when the thread already has a parent ts.
 * When those two variables are unset, the incoming webhook posts a new top-level note.
 * A failed Slack post does not fail the message. The bot token is not logged.
 * Email addresses are accepted and not delivered: there is no mail sender in this app.
 */
export async function notifySelectOfEmitMessage(
  notice: MessageNotice,
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<MessageNotifyResult> {
  const email = emailStatus(env);
  const parentTs = notice.slackThreadTs?.trim() ?? "";
  const text = parentTs ? messageReplyText(notice) : messageNoticeText(notice, env);
  const bot = slackBotTarget(env);
  if (bot) {
    try {
      const payload: Record<string, string> = { channel: bot.channel, text };
      if (parentTs) payload.thread_ts = parentTs;
      const response = await fetchImpl(SLACK_POST_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bot.token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8_000),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; ts?: unknown } | null;
      const ts = data?.ok === true && typeof data.ts === "string" && data.ts.trim() ? data.ts.trim() : null;
      return { slack: Boolean(ts), email, ts, mode: "bot" };
    } catch {
      return { slack: false, email, ts: null, mode: "bot" };
    }
  }

  const url = messageWebhookUrl(env);
  let slack = false;
  if (url) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Incoming webhook. `text` is mrkdwn, and JSON.stringify leaves < and > alone, so <@U...> mentions.
        // No thread_ts: a webhook cannot reply under an existing Slack message.
        body: JSON.stringify({ text: messageNoticeText(notice, env) }),
        signal: AbortSignal.timeout(8_000),
      });
      slack = response.ok;
    } catch {
      slack = false;
    }
  }
  return { slack, email, ts: null, mode: url ? "webhook" : "off" };
}
