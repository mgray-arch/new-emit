import { randomUUID } from "node:crypto";
import type { PortalContext } from "@/lib/db";
import type { CustomerOrder, OrderConfirmation } from "@/lib/types";
import { STATUS_LABEL, formatPlace } from "@/lib/types";

export function emailSender(): string | null {
  const from = process.env.EMAIL_FROM?.trim();
  return from || null;
}

export function gmailReady(): boolean {
  return Boolean(
    emailSender() && process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN,
  );
}

export function confirmationMessage(order: CustomerOrder, to: string): { subject: string; body: string } {
  const subject = `EMIT order confirmed — ${order.salesOrderNumber} is Select load ${order.loadNumber}`;
  const body = [
    `Your order ${order.salesOrderNumber} has been submitted to Select Transport Partners.`,
    `Select load number: ${order.loadNumber}`,
    ``,
    `Stops:`,
    ...order.stops.map(
      (stop, index) =>
        `${index + 1}. ${stop.kind === "pickup" ? "Pickup" : "Drop"} — ${formatPlace(stop.place)}`,
    ),
    `Ship date: ${order.shipDate ?? "not set"}${order.shipTime ? ` ${order.shipTime}` : ""}`,
    `Status: ${STATUS_LABEL[order.portalStatus]}`,
    ``,
    order.trackingUrl ? `Tracking link: ${order.trackingUrl}` : "",
    ``,
    `This confirmation pairs your sales order with the Select load number.`,
  ]
    .filter((line) => line !== "")
    .join("\n");
  void to;
  return { subject, body };
}

export async function sendOrderConfirmation(
  ctx: PortalContext,
  order: CustomerOrder,
  to: string,
): Promise<OrderConfirmation> {
  const message = confirmationMessage(order, to);
  const id = randomUUID();
  const createdAt = ctx.now().toISOString();
  const sender = emailSender();
  ctx.db
    .prepare(
      `INSERT INTO outbox (id, to_email, subject, body, load_id, created_at, delivered, from_email)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(id, to, message.subject, message.body, order.id, createdAt, sender);
  const delivered = await sendViaGmail(to, message.subject, message.body);
  if (delivered) ctx.db.prepare(`UPDATE outbox SET delivered = 1 WHERE id = ?`).run(id);
  return {
    salesOrderNumber: order.salesOrderNumber,
    loadNumber: order.loadNumber,
    emailedTo: to,
    subject: message.subject,
    body: message.body,
    sender,
    delivered,
    createdAt,
  };
}

export function gmailRawMessage(from: string, to: string, subject: string, body: string): string {
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    body,
  ].join("\r\n");
  return Buffer.from(message).toString("base64url");
}

async function sendViaGmail(to: string, subject: string, body: string): Promise<boolean> {
  const from = emailSender();
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!from || !clientId || !clientSecret || !refreshToken) return false;
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok) {
      console.error("Gmail token refresh failed", tokenResponse.status);
      return false;
    }
    const tokens = (await tokenResponse.json()) as { access_token?: string };
    if (!tokens.access_token) return false;
    const send = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ raw: gmailRawMessage(from, to, subject, body) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!send.ok) console.error("Gmail send failed", send.status);
    return send.ok;
  } catch (error) {
    console.error("Gmail send failed", error);
    return false;
  }
}

export function latestConfirmation(ctx: PortalContext, loadId: string): { subject: string; body: string; to: string } | null {
  const row = ctx.db
    .prepare(`SELECT to_email, subject, body FROM outbox WHERE load_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(loadId) as { to_email: string; subject: string; body: string } | undefined;
  if (!row) return null;
  return { to: row.to_email, subject: row.subject, body: row.body };
}
