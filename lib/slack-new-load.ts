import { formatEnteredBy } from "@/lib/entered-by";
import { assignLoadOwner, type LoadOwner } from "@/lib/load-owner";
import type { CustomerOrder, Place } from "@/lib/types";

const SLACK_USER_ID = /^[UW][A-Z0-9]+$/i;

/** Street address as the order form stores it. Empty parts are omitted from the Slack line. */
export interface SlackPlace {
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

export interface NewLoadNotice {
  salesOrderNumber: string;
  origin: SlackPlace;
  destination: SlackPlace;
  equipment: string | null;
  shipDate?: string | null;
  shipTime?: string | null;
  /** Must-deliver date from the form, when it is separate from the ship date. */
  deliveryDate?: string | null;
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

function text(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

/** US is stored as a 2-letter code. The old portal wrote that country as USA. */
function countryLabel(country: string | null | undefined): string {
  const value = text(country);
  if (!value) return "";
  if (/^usa?$/i.test(value) || /^united states$/i.test(value)) return "USA";
  return value;
}

/**
 * Old portal address: "EMIT TECHNOLOGIES — 2437 Allen Avenue, Sheridan, WY, USA".
 * Company, street, and country are included only when the order stored them.
 */
export function slackPlaceLine(place: SlackPlace): string {
  const company = text(place.company);
  const street = [text(place.address1), text(place.address2)].filter(Boolean).join(", ");
  const cityState = [text(place.city), text(place.state)].filter(Boolean).join(", ");
  const country = countryLabel(place.country);
  const address = [street, [cityState, country].filter(Boolean).join(", ")].filter(Boolean).join(", ");
  if (company && address) return `${company} — ${address}`;
  return company || address || "not set";
}

function equipmentLine(equipment: string | null | undefined): string {
  return `Equipment: ${text(equipment) || "not set"}`;
}

function scheduleLines(notice: Pick<NewLoadNotice, "shipDate" | "shipTime" | "deliveryDate">): string[] {
  const date = text(notice.shipDate);
  const time = text(notice.shipTime);
  const lines: string[] = [];
  if (date && time) lines.push(`Ship date: ${date} at ${time}`);
  else if (date) lines.push(`Ship date: ${date}`);
  else lines.push("Ship date: not set");
  if (!date && time) lines.push(`Ship time: ${time}`);
  const delivery = text(notice.deliveryDate);
  if (delivery) lines.push(`Delivery date: ${delivery}`);
  return lines;
}

function detailLines(notice: NewLoadNotice, env: Record<string, string | undefined>): string[] {
  return [
    `SO: ${salesOrderLabel(notice.salesOrderNumber)}`,
    `Origin: ${slackPlaceLine(notice.origin)}`,
    `Destination: ${slackPlaceLine(notice.destination)}`,
    equipmentLine(notice.equipment),
    ...scheduleLines(notice),
    ownerLine(notice.owner, env),
  ];
}

/**
 * Slack text for a load that is still Being Prepared.
 * Load Builder listens for "New load request" and "Ready to Ship", so this note
 * must not contain "New load request". There is no price, carrier pay, or carrier name.
 */
export function newLoadSlackText(notice: NewLoadNotice, env: Record<string, string | undefined> = process.env): string {
  const lines = [
    "Order received - Being Prepared",
    ...detailLines(notice, env),
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
  const lines = ["Ready to Ship", ...detailLines(notice, env)];
  if (notice.needsCheck) lines.push("Needs a human check. Equipment or destination was missing.");
  return lines.join("\n");
}

export function newLoadWebhookUrl(env: Record<string, string | undefined> = process.env): string | null {
  const url = env.SLACK_NEW_LOADS_WEBHOOK_URL?.trim() ?? "";
  if (!url.startsWith("https://") && !url.startsWith("http://")) return null;
  return url;
}

function placeNotice(place: Place | null | undefined): SlackPlace {
  return {
    company: place?.company ?? "",
    address1: place?.address1 ?? "",
    address2: place?.address2 ?? "",
    city: place?.city ?? "",
    state: place?.state ?? "",
    country: place?.country ?? "",
  };
}

function noticeFromOrder(order: CustomerOrder, enteredBy?: { name: string; email: string }): NewLoadNotice {
  return {
    salesOrderNumber: order.salesOrderNumber,
    origin: placeNotice(order.origin),
    destination: placeNotice(order.destination),
    equipment: order.truckType,
    shipDate: order.shipDate,
    shipTime: order.shipTime,
    deliveryDate: order.mustDeliverDate,
    ...ownerNotice(order),
    enteredByName: enteredBy?.name ?? order.enteredByName ?? null,
    enteredByEmail: enteredBy?.email ?? order.enteredByEmail ?? null,
  };
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
  const notice = noticeFromOrder(order, enteredBy);
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
  const notice = noticeFromOrder(order);
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
