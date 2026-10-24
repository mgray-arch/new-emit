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
  owner: LoadOwner;
  enteredByName: string | null;
  enteredByEmail: string | null;
}

/** Slack user id for an owner, or null when the env var is missing or not a user id. */
export function slackUserIdForOwner(owner: LoadOwner, env: Record<string, string | undefined> = process.env): string | null {
  if (owner === "Unassigned") return null;
  const raw = owner === "Drew" ? env.SLACK_USER_ID_DREW : env.SLACK_USER_ID_AINSLEY;
  const id = raw?.trim() ?? "";
  return SLACK_USER_ID.test(id) ? id : null;
}

export function ownerLine(owner: LoadOwner, env: Record<string, string | undefined> = process.env): string {
  const id = slackUserIdForOwner(owner, env);
  if (id) return `Owner: <@${id}>`;
  return `Owner: ${owner}`;
}

/**
 * Incoming-webhook text for a new portal load. The fields are an allowlist:
 * there is no price, carrier pay, or carrier name.
 */
export function newLoadSlackText(notice: NewLoadNotice, env: Record<string, string | undefined> = process.env): string {
  const equipment = notice.equipment?.trim() || "not set";
  const lane = `${notice.originCity}, ${notice.originState} → ${notice.destinationCity}, ${notice.destinationState}`;
  return [
    `New load ${notice.salesOrderNumber}`,
    lane,
    `Equipment: ${equipment}`,
    ownerLine(notice.owner, env),
    `Entered by: ${formatEnteredBy(notice.enteredByName, notice.enteredByEmail)}`,
  ].join("\n");
}

export function newLoadWebhookUrl(env: Record<string, string | undefined> = process.env): string | null {
  const url = env.SLACK_NEW_LOADS_WEBHOOK_URL?.trim() ?? "";
  if (!url.startsWith("https://") && !url.startsWith("http://")) return null;
  return url;
}

/** Post a new-load note when the webhook is set. A missing URL or a failed post does not fail the load. */
export async function notifyNewLoad(
  order: CustomerOrder,
  enteredBy: { name: string; email: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = newLoadWebhookUrl();
  if (!url) return;
  const notice: NewLoadNotice = {
    salesOrderNumber: order.salesOrderNumber,
    originCity: order.origin.city,
    originState: order.origin.state,
    destinationCity: order.destination.city,
    destinationState: order.destination.state,
    equipment: order.truckType,
    owner: assignLoadOwner({
      customer: "EMIT",
      destinationState: order.destination.state,
      equipment: order.truckType,
    }),
    enteredByName: enteredBy.name,
    enteredByEmail: enteredBy.email,
  };
  try {
    await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: newLoadSlackText(notice) }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    /* The load is already saved. Slack can miss a note without losing the order. */
  }
}
