import type { PortalContext } from "@/lib/db";
import { emailConfig, sendEmail } from "@/lib/email";
import { PortalError } from "@/lib/http";
import { sensitiveReason } from "@/lib/sensitive";
import type { CustomerOrder } from "@/lib/types";

const RATE_KEY = /pay|rate|margin|cost|price|charge|line[\s_-]*haul|rate[\s_-]*con/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type CarrierNoticeResult = "assigned" | "changed" | "unchanged" | "skipped";

export interface CarrierIdentity {
  name: string;
  mc: string;
}

export interface CarrierUpdate {
  name?: string;
  mc?: string;
  nameProvided: boolean;
  mcProvided: boolean;
}

/** Any object key that names a rate, a price, or a rate confirmation. Nested keys count. */
export function findRateField(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRateField(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (RATE_KEY.test(key)) return key;
    const found = findRateField(child);
    if (found) return found;
  }
  return null;
}

export function normalizeCarrierName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** "MC 445566" and "445566" are the same number. */
export function normalizeMc(value: string): string {
  return value.trim().replace(/^mc[\s#-]*/i, "").replace(/\s+/g, "");
}

export function sameCarrier(left: CarrierIdentity, right: CarrierIdentity): boolean {
  return (
    normalizeCarrierName(left.name).toLowerCase() === normalizeCarrierName(right.name).toLowerCase() &&
    normalizeMc(left.mc).toLowerCase() === normalizeMc(right.mc).toLowerCase()
  );
}

export function carrierEmail(input: {
  kind: "assigned" | "changed";
  salesOrderNumber: string;
  orderId: string;
  loadNumber: string | null;
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
  shipDate: string | null;
  mustDeliverDate: string | null;
  carrierName: string;
  mc: string;
}): { subject: string; text: string } {
  const change = input.kind === "changed";
  const subject = change
    ? `Carrier changed for ${input.salesOrderNumber}`
    : `Carrier assigned for ${input.salesOrderNumber}`;
  const pickupWhen = input.shipDate ? ` on ${input.shipDate}` : "";
  const deliverWhen = input.mustDeliverDate ? ` on ${input.mustDeliverDate}` : "";
  const lines = [
    `SO number: ${input.salesOrderNumber}`,
    `Order: ${input.orderId}`,
    `Select load: ${input.loadNumber?.trim() || "Pending"}`,
    `Pickup: ${input.originCity}, ${input.originState}${pickupWhen}`,
    `Delivery: ${input.destinationCity}, ${input.destinationState}${deliverWhen}`,
    `Carrier: ${input.carrierName}`,
    `MC: ${input.mc || "not provided"}`,
    change ? "The assigned carrier changed." : "This is a new carrier assignment.",
  ];
  return { subject, text: lines.join("\n") };
}

export function carrierNoticeText(kind: "assigned" | "changed", to: string, carrier: CarrierIdentity): string {
  const lead = kind === "changed" ? "Carrier change email sent" : "New carrier assignment email sent";
  const mc = carrier.mc ? ` MC ${carrier.mc}.` : " MC not provided.";
  return `${lead} to ${to}. Carrier: ${carrier.name}.${mc}`;
}

interface NoticeEntry {
  at: string;
  kind: "assigned" | "changed";
  text: string;
}

function parseLog(raw: unknown): NoticeEntry[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is NoticeEntry => {
      if (!item || typeof item !== "object") return false;
      const row = item as Record<string, unknown>;
      return (row.kind === "assigned" || row.kind === "changed") && typeof row.text === "string" && typeof row.at === "string";
    });
  } catch {
    return [];
  }
}

/**
 * Store a new or changed carrier and email the person who submitted the order.
 * The same carrier again does not send mail. A failed send leaves the stored carrier alone.
 * Carrier pay is not a parameter and is not written.
 */
export async function recordCarrierAssignment(
  ctx: PortalContext,
  order: CustomerOrder,
  incoming: CarrierUpdate,
  fetchImpl: typeof fetch = fetch,
): Promise<CarrierNoticeResult> {
  const row = await ctx.db
    .prepare(`SELECT carrier_name, carrier_mc, carrier_notice_log FROM loads WHERE id = ?`)
    .get(order.id);
  const stored: CarrierIdentity = {
    name: normalizeCarrierName(String(row?.carrier_name ?? "")),
    mc: normalizeMc(String(row?.carrier_mc ?? "")),
  };
  const providedName = incoming.nameProvided ? normalizeCarrierName(incoming.name ?? "") : "";
  const providedMc = incoming.mcProvided ? normalizeMc(incoming.mc ?? "") : "";
  const next: CarrierIdentity = {
    name: providedName || stored.name,
    mc: providedMc || stored.mc,
  };
  if ((!next.name && !next.mc) || sameCarrier(stored, next)) return "unchanged";
  if (sensitiveReason(next.name) || sensitiveReason(next.mc)) {
    throw new PortalError("Carrier details cannot include rates or pay.");
  }

  const kind = stored.name || stored.mc ? "changed" : "assigned";
  const to = order.enteredByEmail?.trim() ?? "";
  const now = ctx.now().toISOString();
  if (!EMAIL.test(to)) {
    await ctx.db
      .prepare(`UPDATE loads SET carrier_name = ?, carrier_mc = ?, updated_at = ? WHERE id = ?`)
      .run(next.name || null, next.mc || null, now, order.id);
    return "skipped";
  }

  const mail = carrierEmail({
    kind,
    salesOrderNumber: order.salesOrderNumber,
    orderId: order.id,
    loadNumber: order.loadNumber,
    originCity: order.origin.city,
    originState: order.origin.state,
    destinationCity: order.destination.city,
    destinationState: order.destination.state,
    shipDate: order.shipDate,
    mustDeliverDate: order.mustDeliverDate,
    carrierName: next.name,
    mc: next.mc,
  });
  if (sensitiveReason(mail.text) || sensitiveReason(mail.subject)) {
    throw new PortalError("Carrier details cannot include rates or pay.");
  }
  if (!emailConfig()) {
    throw new PortalError(
      "Email is not configured. Set EMAIL_FROM and EMAIL_API_KEY (at least 16 characters). The carrier was not saved.",
      503,
    );
  }
  let sent = false;
  try {
    sent = await sendEmail({ to, subject: mail.subject, text: mail.text }, fetchImpl);
  } catch {
    sent = false;
  }
  if (!sent) {
    throw new PortalError("The carrier email could not be sent. The carrier was not saved.", 503);
  }

  const log = parseLog(row?.carrier_notice_log);
  log.push({ at: now, kind, text: carrierNoticeText(kind, to, next) });
  await ctx.db
    .prepare(`UPDATE loads SET carrier_name = ?, carrier_mc = ?, carrier_notice_log = ?, updated_at = ? WHERE id = ?`)
    .run(next.name || null, next.mc || null, JSON.stringify(log), now, order.id);
  return kind;
}
