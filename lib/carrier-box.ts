import type { BolPrintSummary, OrderNotice } from "@/lib/types";

/**
 * Green, red, or neutral carrier box for the load list and the load page.
 * Company and MC only. Pay is never read. The driver is not part of this comparison.
 *
 * Red when the company or MC on the load differs from the carrier recorded on the
 * latest BOL print (the carrier-change half of the reprint warning), or when
 * History's latest line is a carrier change that a print of the current company
 * and MC has not acknowledged.
 *
 * It returns to green when Print records the current company and MC, the same
 * event that clears that half of the reprint warning. A later file-only reprint
 * leaves the box green. A driver-only difference can still ask for a reprint,
 * and the box stays green because the company did not change.
 *
 * No company and no MC is the neutral state, including after a carrier is cleared.
 */

export type CarrierBoxTone = "assigned" | "changed" | "none";

export interface CarrierBoxOrder {
  carrierName?: string | null;
  carrierMc?: string | null;
  notices?: OrderNotice[] | null;
  bolPrint?: Pick<BolPrintSummary, "carrierName" | "carrierMc" | "reasons"> | null;
}

export interface CarrierBoxState {
  tone: CarrierBoxTone;
  /** Current company, with surrounding space collapsed. Empty in the neutral state. */
  name: string;
  /** Current MC, digits only. Empty when it was not provided. */
  mc: string;
  /** Previous company when the box is red and a name was recorded. */
  previousName: string | null;
  previousMc: string | null;
}

interface Identity {
  name: string;
  mc: string;
}

const CHANGED_FROM = /^Carrier changed from (.+?)(?: \(MC ([^)]+)\))? to /i;

function normalizeName(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeMc(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/^mc[\s#-]*/i, "").replace(/\s+/g, "");
}

function identity(name: string | null | undefined, mc: string | null | undefined): Identity {
  return { name: normalizeName(name), mc: normalizeMc(mc) };
}

function occupied(value: Identity): boolean {
  return Boolean(value.name || value.mc);
}

function same(left: Identity, right: Identity): boolean {
  return left.name.toLowerCase() === right.name.toLowerCase() && left.mc.toLowerCase() === right.mc.toLowerCase();
}

/** Drop the history placeholder. A carrier that matches the current one is not "previous". */
function different(value: Identity, current: Identity): Identity | null {
  const name = /^the previous carrier$/i.test(value.name) ? "" : value.name;
  const next = { name, mc: value.mc };
  if (!occupied(next) || same(next, current)) return null;
  return next;
}

function previousFromText(text: string | undefined, current: Identity): Identity | null {
  if (!text) return null;
  const match = text.trim().match(CHANGED_FROM);
  if (!match) return null;
  return different(identity(match[1], match[2] ?? ""), current);
}

function previousCarrier(
  current: Identity,
  notices: OrderNotice[],
  printed: Identity | null,
): Identity | null {
  if (printed && occupied(printed)) {
    const fromPrint = different(printed, current);
    if (fromPrint) return fromPrint;
  }
  const prior = notices.length >= 2 ? notices[notices.length - 2] : null;
  const fromPrior = prior ? different(identity(prior.company, prior.mc), current) : null;
  if (fromPrior) return fromPrior;
  const latest = notices[notices.length - 1];
  return previousFromText(latest?.text, current);
}

export function carrierBoxState(order: CarrierBoxOrder): CarrierBoxState {
  const current = identity(order.carrierName, order.carrierMc);
  if (!occupied(current)) {
    return { tone: "none", name: "", mc: "", previousName: null, previousMc: null };
  }

  const notices = (order.notices ?? []).filter((notice) => notice.kind === "assigned" || notice.kind === "changed");
  const latest = notices[notices.length - 1] ?? null;
  const print = order.bolPrint ?? null;
  const printed = print ? identity(print.carrierName, print.carrierMc) : null;
  const printSaysCarrierChanged = Boolean(print?.reasons?.includes("carrier_changed"));
  const printedMatches = Boolean(printed && occupied(printed) && same(printed, current));
  // A print that stored no carrier, when the reprint check does not call it a change,
  // already showed this company on the file.
  const blankPrintAcknowledges = Boolean(print && printed && !occupied(printed) && !printSaysCarrierChanged);
  const printAcknowledges = printedMatches || blankPrintAcknowledges;
  const printedDiffers = Boolean(printed && occupied(printed) && !same(printed, current));
  const blankPrintIsAChange = Boolean(print && printed && !occupied(printed) && printSaysCarrierChanged);
  const historyChanged = latest?.kind === "changed";
  const changed = printedDiffers || blankPrintIsAChange || (historyChanged && !printAcknowledges);

  if (!changed) {
    return { tone: "assigned", name: current.name, mc: current.mc, previousName: null, previousMc: null };
  }

  const previous = previousCarrier(current, notices, printed);
  return {
    tone: "changed",
    name: current.name,
    mc: current.mc,
    previousName: previous?.name || null,
    previousMc: previous?.mc || null,
  };
}

/** Short line under the new carrier. Name and MC only. */
export function previousCarrierLine(state: CarrierBoxState): string | null {
  if (state.tone !== "changed") return null;
  if (state.previousName && state.previousMc) return `Was ${state.previousName} · MC ${state.previousMc}`;
  if (state.previousName) return `Was ${state.previousName}`;
  if (state.previousMc) return `Was MC ${state.previousMc}`;
  return null;
}
