import { formatEnteredBy } from "@/lib/entered-by";
import { assignLoadOwner, type LoadOwner } from "@/lib/load-owner";
import type { CustomerOrder } from "@/lib/types";

const SLACK_USER_ID = /^[UW][A-Z0-9]+$/i;

export interface NewLoadNotice {
  salesOrderNumber: string;
  originCity: string;
  originState: string;
  destinationCity: string;
  destinationState: string;
  equipment: string | null;
  shipDate?: string | null;
  owner: LoadOwner;
  needsCheck?: boolean;
  enteredByName: string | null;
  enteredByEmail: string | null;
}

/** Slack user id for an owner, or null when the env var is missing or not a user id. */
export function slackUserIdForOwner(owner: LoadOwner, env: Record<string, string | undefined> = process.env): string | null {
  const raw = owner === "Drew" ? env.SLACK_USER_ID_DREW : env.SLACK_USER_ID_AINSLEY;
  const id = raw?.trim() ?? "";
  return SLACK_USER_ID.test(id) ? id : null;
}

export function ownerLine(owner: LoadOwner, env: Record<string, string | undefined> = process.env): string {
  const id = slackUserIdForOwner(owner, env);
  if (id) return `Owner: <@${id}>`;
  return `Owner: ${owner}`;
}

export function salesOrderLabel(value: string): string {
  return value.trim().toUpperCase();
}

function laneLine(notice: Pick<NewLoadNotice, "originCity" | "originState" | "destinationCity" | "destinationState">): string {
  return `${notice.originCity}, ${notice.originState} → ${notice.destinationCity}, ${notice.destinationState}`;
}

function shipDateLine(shipDate: string | null | undefined): string {
  const value = shipDate?.trim();
  return `Ship date: ${value || "not set"}`;
}

function equipmentLine(equipment: string | null | undefined): string {
  return `Equipment: ${equipment?.trim() || "not set"}`;
}

/**
 * Slack text for a load that is still Being Prepared.
 * Load Builder listens for "New load request" and "Ready to Ship", so this note
 * must not contain "New load request". There is no price, carrier pay, or carrier name.
 */
export function newLoadSlackText(notice: NewLoadNotice, env: Record<string, string | undefined> = process.env): string {
  const lines = [
    "Order received - Being Prepared",
    `SO: ${salesOrderLabel(notice.salesOrderNumber)}`,
    laneLine(notice),
    equipmentLine(notice.equipment),
    shipDateLine(notice.shipDate),
    ownerLine(notice.owner, env),
    `Entered by: ${formatEnteredBy(notice.enteredByName, notice.enteredByEmail)}`,
  ];
  if (notice.needsCheck) lines.push("Needs a human check. Equipment or destination was missing.");
  return lines.join("\n");
}

/**
 * Slack text when a load first reaches Ready to Ship. The first line is the
 * phrase Load Builder should recognize. There is no price or carrier pay.
 */
export function readyToShipSlackText(notice: NewLoadNotice, env: Record<string, string | undefined> = process.env): string {
  const lines = [
    "Ready to Ship",
    `SO: ${salesOrderLabel(notice.salesOrderNumber)}`,
    laneLine(notice),
    equipmentLine(notice.equipment),
    shipDateLine(notice.shipDate),
    ownerLine(notice.owner, env),
  ];
  if (notice.needsCheck) lines.push("Needs a human check. Equipment or destination was missing.");
  return lines.join("\n");
}

export function newLoadWebhookUrl(env: Record<string, string | undefined> = process.env): string | null {
  const url = env.SLACK_NEW_LOADS_WEBHOOK_URL?.trim() ?? "";
  if (!url.startsWith("https://") && !url.startsWith("http://")) return null;
  return url;
}

function ownerNotice(order: CustomerOrder): { owner: LoadOwner; needsCheck: boolean } {
  if (order.owner === "Drew" || order.owner === "Ainsley") {
    return { owner: order.owner, needsCheck: order.ownerNeedsCheck === true };
  }
  return assignLoadOwner({
    destinationCity: order.destination.city,
    destinationState: order.destination.state,
    equipment: order.truckType,
  });
}

/**
 * Post a new-load note when the webhook is set. A missing URL or a failed post does not fail the load.
 * Returns true only when Slack accepts the note. The text is unchanged.
 */
export async function notifyNewLoad(
  order: CustomerOrder,
  enteredBy: { name: string; email: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const url = newLoadWebhookUrl();
  if (!url) return false;
  const notice: NewLoadNotice = {
    salesOrderNumber: order.salesOrderNumber,
    originCity: order.origin.city,
    originState: order.origin.state,
    destinationCity: order.destination.city,
    destinationState: order.destination.state,
    equipment: order.truckType,
    shipDate: order.shipDate,
    ...ownerNotice(order),
    enteredByName: enteredBy.name,
    enteredByEmail: enteredBy.email,
  };
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: newLoadSlackText(notice) }),
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok;
  } catch {
    /* The load is already saved. Slack can miss a note without losing the order. */
    return false;
  }
}

/** Post the Ready to Ship note. A missing URL or a failed post does not change the load. */
export async function notifyReadyToShip(order: CustomerOrder, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const url = newLoadWebhookUrl();
  if (!url) return false;
  const notice: NewLoadNotice = {
    salesOrderNumber: order.salesOrderNumber,
    originCity: order.origin.city,
    originState: order.origin.state,
    destinationCity: order.destination.city,
    destinationState: order.destination.state,
    equipment: order.truckType,
    shipDate: order.shipDate,
    ...ownerNotice(order),
    enteredByName: order.enteredByName ?? null,
    enteredByEmail: order.enteredByEmail ?? null,
  };
  const text = readyToShipSlackText(notice);
  if (!text.startsWith("Ready to Ship")) return false;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
