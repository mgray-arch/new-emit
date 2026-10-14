import { randomUUID } from "node:crypto";
import type { PortalContext } from "@/lib/db";
import type { CustomerOrder, OrderConfirmation } from "@/lib/types";
import { STATUS_LABEL, formatPlace } from "@/lib/types";

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

export function sendOrderConfirmation(ctx: PortalContext, order: CustomerOrder, to: string): OrderConfirmation {
  const message = confirmationMessage(order, to);
  const id = randomUUID();
  const createdAt = ctx.now().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO outbox (id, to_email, subject, body, load_id, created_at, delivered)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(id, to, message.subject, message.body, order.id, createdAt);
  const delivered = false;
  void maybeSendSmtp(to, message.subject, message.body).then((ok) => {
    if (ok) ctx.db.prepare(`UPDATE outbox SET delivered = 1 WHERE id = ?`).run(id);
  });
  return {
    salesOrderNumber: order.salesOrderNumber,
    loadNumber: order.loadNumber,
    emailedTo: to,
    subject: message.subject,
    body: message.body,
    delivered,
    createdAt,
  };
}

async function maybeSendSmtp(to: string, subject: string, body: string): Promise<boolean> {
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) return false;
  try {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_PORT === "465",
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    await transport.sendMail({ from: process.env.SMTP_FROM, to, subject, text: body });
    return true;
  } catch (error) {
    console.error("SMTP send failed", error);
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
