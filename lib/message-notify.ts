import { portalPublicUrl } from "@/lib/public-url";
import { redactSensitiveText } from "@/lib/sensitive";

/** Slack incoming webhook for a portal message. Separate from the new-load webhook. */
export const MESSAGE_PREVIEW_LIMIT = 80;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let emailSkipWarned = false;

export interface MessageNotice {
  authorName: string;
  authorEmail: string;
  loadNumber: string | null;
  salesOrderNumber: string | null;
  preview: string;
  threadUrl: string;
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

export function messageThreadUrl(env: Record<string, string | undefined> = process.env): string {
  const base = (env.PORTAL_PUBLIC_URL?.trim() || portalPublicUrl()).replace(/\/$/, "");
  return base ? `${base}/messages` : "/messages";
}

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

export function messageLoadLine(notice: Pick<MessageNotice, "loadNumber" | "salesOrderNumber">): string {
  if (notice.loadNumber) {
    return notice.salesOrderNumber ? `Load ${notice.loadNumber} · ${notice.salesOrderNumber}` : `Load ${notice.loadNumber}`;
  }
  if (notice.salesOrderNumber) return `Load number pending · ${notice.salesOrderNumber}`;
  return "No load attached";
}

/** Allowlisted Slack text. The full message is not a field on the notice. */
export function messageNoticeText(notice: MessageNotice): string {
  return [
    `New portal message from ${notice.authorName} (${notice.authorEmail})`,
    messageLoadLine(notice),
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
  return { to, subject, text: messageNoticeText(notice) };
}

/**
 * Tell Select that an EMIT person posted. A missing webhook does nothing.
 * Email addresses are accepted and not delivered: there is no mail sender in this app.
 * A failed Slack post does not fail the message.
 */
export async function notifySelectOfEmitMessage(
  notice: MessageNotice,
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<{ slack: boolean; email: "unset" | "skipped_no_provider" }> {
  const url = messageWebhookUrl(env);
  let slack = false;
  if (url) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: messageNoticeText(notice) }),
        signal: AbortSignal.timeout(8_000),
      });
      slack = response.ok;
    } catch {
      slack = false;
    }
  }
  const email = messageNotifyEmails(env).length > 0 ? "skipped_no_provider" : "unset";
  if (email === "skipped_no_provider" && !emailSkipWarned) {
    emailSkipWarned = true;
    console.warn("MESSAGE_NOTIFY_EMAILS is set, but this portal has no email provider, so no message email was sent.");
  }
  return { slack, email };
}
