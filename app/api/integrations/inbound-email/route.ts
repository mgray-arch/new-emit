import {
  consumeInboundEmail,
  receiveInboundEmail,
  senderAllowed,
  verifyInboundWebhook,
  type InboundAttachmentInput,
  type InboundEmailResult,
} from "@/lib/inbound-email";
import { MAX_UPLOAD_BYTES } from "@/lib/documents";
import { errorResponse, json, PortalError } from "@/lib/http";
import { clientIp } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resend receiving API. This route does not send mail. */
const RECEIVING_API = "https://api.resend.com/emails/receiving";

interface ListedAttachment {
  id: string;
  filename: string;
  content_type: string;
  content_disposition: string | null;
  download_url: string;
  size?: number;
}

function publicResult(result: InboundEmailResult) {
  return {
    ok: true,
    outcome: result.outcome,
    duplicate: result.duplicate,
    loadNumber: result.loadNumber,
    salesOrderNumber: result.salesOrderNumber,
    released: result.released,
    heldForReview: result.heldForReview,
  };
}

function safeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(trimmed)) return null;
  return trimmed;
}

function downloadUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return null;
    if (host !== "resend.com" && !host.endsWith(".resend.com")) return null;
    return url;
  } catch {
    return null;
  }
}

function shouldFetch(item: { filename: string; content_type: string; content_disposition: string | null; size?: number }): boolean {
  if (typeof item.size === "number" && item.size > MAX_UPLOAD_BYTES) return false;
  const type = item.content_type.toLowerCase();
  const name = item.filename.toLowerCase();
  if (item.content_disposition === "inline" && type.startsWith("image/") && !/bol|lading/.test(name)) return false;
  if (type === "application/pdf" || type === "image/png" || type === "image/jpeg" || type === "image/jpg" || type === "application/octet-stream" || type === "") {
    return true;
  }
  return name.endsWith(".pdf") || name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg");
}

async function providerGet(path: string, key: string): Promise<unknown> {
  const response = await fetch(`${RECEIVING_API}${path}`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new PortalError("The mail provider did not return the attachment.", 502);
  return response.json();
}

async function listAttachments(emailId: string, key: string): Promise<ListedAttachment[]> {
  const found: ListedAttachment[] = [];
  let after = "";
  for (let page = 0; page < 5; page += 1) {
    const query = after ? `?limit=100&after=${encodeURIComponent(after)}` : "?limit=100";
    const body = (await providerGet(`/${emailId}/attachments${query}`, key)) as { data?: unknown; has_more?: boolean };
    const data = Array.isArray(body.data) ? body.data : [];
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const id = safeId(row.id);
      if (!id) continue;
      found.push({
        id,
        filename: typeof row.filename === "string" && row.filename.trim() ? row.filename.trim().slice(0, 180) : "attachment",
        content_type: typeof row.content_type === "string" ? row.content_type.slice(0, 120) : "",
        content_disposition: typeof row.content_disposition === "string" ? row.content_disposition.slice(0, 40) : null,
        download_url: typeof row.download_url === "string" ? row.download_url : "",
        size: typeof row.size === "number" ? row.size : undefined,
      });
    }
    const last = found[found.length - 1];
    if (!body.has_more || data.length === 0 || !last) break;
    after = last.id;
  }
  return found;
}

async function downloadAttachments(emailId: string): Promise<InboundAttachmentInput[]> {
  const key = process.env.RESEND_API_KEY?.trim() ?? "";
  if (key.length < 16) throw new PortalError("Inbound mail is not configured.", 500);
  const listed = await listAttachments(emailId, key);
  const files: InboundAttachmentInput[] = [];
  for (const item of listed) {
    if (typeof item.size === "number" && item.size > MAX_UPLOAD_BYTES) {
      files.push({
        filename: item.filename,
        contentType: item.content_type,
        disposition: item.content_disposition,
        bytes: new Uint8Array(),
        declaredSize: item.size,
      });
      continue;
    }
    if (!shouldFetch(item)) continue;
    const url = downloadUrl(item.download_url);
    if (!url) throw new PortalError("The mail provider did not return the attachment.", 502);
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new PortalError("The mail provider did not return the attachment.", 502);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_UPLOAD_BYTES) {
      await response.body?.cancel();
      files.push({
        filename: item.filename,
        contentType: item.content_type,
        disposition: item.content_disposition,
        bytes: new Uint8Array(),
        declaredSize: length,
      });
      continue;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    files.push({
      filename: item.filename,
      contentType: item.content_type || "application/octet-stream",
      disposition: item.content_disposition,
      bytes,
      declaredSize: bytes.byteLength,
    });
  }
  return files;
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function POST(req: Request) {
  try {
    const ctx = await readyPortal();
    const budget = await consumeInboundEmail(ctx, clientIp(req));
    if (!budget.allowed) {
      return json({ error: "Too many requests. Try again shortly." }, 429, {
        "retry-after": String(budget.retryAfterSeconds),
      });
    }
    const payload = await req.text();
    const verified = verifyInboundWebhook({
      payload,
      headers: {
        id: req.headers.get("svix-id") ?? req.headers.get("webhook-id"),
        timestamp: req.headers.get("svix-timestamp") ?? req.headers.get("webhook-timestamp"),
        signature: req.headers.get("svix-signature") ?? req.headers.get("webhook-signature"),
      },
      secret: process.env.INBOUND_EMAIL_WEBHOOK_SECRET ?? "",
    });
    if (!verified) return json({ error: "Unauthorized" }, 401);

    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      return json({ error: "Invalid payload" }, 400);
    }
    if (!body || typeof body !== "object") return json({ error: "Invalid payload" }, 400);
    const event = body as { type?: unknown; data?: unknown };
    if (event.type !== "email.received") return json({ ok: true, ignored: true });
    const data = event.data;
    if (!data || typeof data !== "object") return json({ error: "Invalid payload" }, 400);
    const record = data as Record<string, unknown>;
    const providerId = safeId(record.email_id);
    if (!providerId) return json({ error: "Invalid payload" }, 400);
    const from = textField(record.from);
    const subject = textField(record.subject);
    if (!senderAllowed(from)) {
      const result = await receiveInboundEmail(ctx, { providerId, from, subject, attachments: [] });
      return json(publicResult(result));
    }
    const attachments = await downloadAttachments(providerId);
    const result = await receiveInboundEmail(ctx, { providerId, from, subject, attachments });
    return json(publicResult(result));
  } catch (error) {
    return errorResponse(error);
  }
}
