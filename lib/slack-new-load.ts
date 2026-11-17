import { customerFacingText } from "@/lib/customer-copy";
import { formatEnteredBy } from "@/lib/entered-by";
import { mappedLoadStops } from "@/lib/load-stops";
import { assignLoadOwner, type LoadOwner } from "@/lib/load-owner";
import type { SalesOrderLine } from "@/lib/sales-orders";
import { redactSensitiveText, sensitiveReason } from "@/lib/sensitive";
import { formatStopSchedule } from "@/lib/stop-schedule";
import type { CustomerOrder, Place, Stop, StopKind, StopSchedule } from "@/lib/types";

const SLACK_USER_ID = /^[UW][A-Z0-9]+$/i;

/** Street address as the order form stores it. Empty parts are omitted from the Slack line. */
export interface SlackPlace {
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  /** Shown with the state, as stored. A short zip is not padded. */
  postalCode?: string | null;
  country?: string | null;
}

export interface SlackStop {
  id: string;
  kind: StopKind;
  place: SlackPlace;
  schedule?: StopSchedule | null;
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
  /** Full route. When set, the note lists every stop. Origin and destination stay the first pickup and last drop. */
  stops?: SlackStop[];
  /** Per-drop sales orders. When omitted, the SO line is split the same way as the load-builder payload. */
  salesOrders?: SalesOrderLine[];
  /** Order comments. Posted as Notes after price, carrier pay, and SAM are removed. */
  comments?: string | null;
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
 * A stored zip sits with the state: "Sheridan, WY 82801, USA".
 * Company, street, zip, and country are included only when the order stored them.
 */
export function slackPlaceLine(place: SlackPlace): string {
  const company = text(place.company);
  const street = [text(place.address1), text(place.address2)].filter(Boolean).join(", ");
  const stateZip = [text(place.state), text(place.postalCode)].filter(Boolean).join(" ");
  const locality = [text(place.city), stateZip].filter(Boolean).join(", ");
  const country = countryLabel(place.country);
  const address = [street, locality, country].filter(Boolean).join(", ");
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

function countWord(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function stopsForMapping(notice: NewLoadNotice): Stop[] {
  return (notice.stops ?? []).map((stop) => ({
    id: stop.id,
    kind: stop.kind,
    place: {
      company: text(stop.place.company),
      address1: text(stop.place.address1),
      address2: text(stop.place.address2),
      city: text(stop.place.city),
      state: text(stop.place.state),
      postalCode: text(stop.place.postalCode),
      country: text(stop.place.country),
    },
    ...(stop.schedule ? { schedule: stop.schedule } : {}),
  }));
}

/** Every stop, in route order, using the same per-drop sales orders as loadBuilderPayload. */
function stopSection(notice: NewLoadNotice): string[] {
  const stops = stopsForMapping(notice);
  if (!stops.length) return [];
  const mapped = mappedLoadStops({
    salesOrderNumber: notice.salesOrderNumber,
    salesOrders: notice.salesOrders,
    stops,
  });
  const pickups = mapped.stops.filter((stop) => stop.kind === "pickup").length;
  const drops = mapped.stops.filter((stop) => stop.kind === "drop").length;
  const seen = { pickup: 0, drop: 0 };
  const lines = mapped.stops.map((stop) => {
    seen[stop.kind] += 1;
    const total = stop.kind === "pickup" ? pickups : drops;
    const label = stop.kind === "pickup" ? "Pickup" : "Drop";
    const parts = [`${label} ${seen[stop.kind]} of ${total}: ${slackPlaceLine(stop.place)}`];
    const schedule = formatStopSchedule(stop.schedule).replace(/\|/g, "/");
    if (schedule) parts.push(`Schedule: ${schedule}`);
    if (stop.salesOrders.length) parts.push(`SO: ${stop.salesOrders.join(", ")}`);
    return parts.join(" | ");
  });
  return [`Stops: ${mapped.stops.length} (${countWord(pickups, "pickup")}, ${countWord(drops, "drop")})`, ...lines];
}

/** Price, EMIT cost, carrier pay, and SAM stay out of the note. */
const PRICE_NOTE = /\b(prices?|emit\s+cost|customer\s*costs?)\b|\$\s?\d/i;

function slackNoteLine(comments: string | null | undefined): string | null {
  const redacted = customerFacingText(redactSensitiveText(comments ?? ""));
  const kept = redacted
    .split(/\n+|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part && !PRICE_NOTE.test(part) && !sensitiveReason(part));
  const note = kept.join(" ").replace(/\s+/g, " ").trim();
  return note ? `Notes: ${note}` : null;
}

function detailLines(notice: NewLoadNotice, env: Record<string, string | undefined>): string[] {
  const notes = slackNoteLine(notice.comments);
  return [
    `SO: ${salesOrderLabel(notice.salesOrderNumber)}`,
    `Origin: ${slackPlaceLine(notice.origin)}`,
    `Destination: ${slackPlaceLine(notice.destination)}`,
    ...stopSection(notice),
    equipmentLine(notice.equipment),
    ...scheduleLines(notice),
    ownerLine(notice.owner, env),
    ...(notes ? [notes] : []),
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
    postalCode: place?.postalCode ?? "",
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
    stops: order.stops.map((stop) => ({
      id: stop.id,
      kind: stop.kind,
      place: placeNotice(stop.place),
      schedule: stop.schedule ?? null,
    })),
    salesOrders: order.salesOrders,
    comments: order.comments,
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

/**
 * The only stages that post a Slack note for Load Builder.
 * In Transit, Delivered, the old Shipped name, and Cancelled do not.
 */
export function loadBuilderNotice(status: string): "being_prepared" | "ready_to_ship" | null {
  if (status === "being_prepared" || status === "ready_to_ship") return status;
  return null;
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
