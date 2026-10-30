"use client";

import { useEffect, useId, useRef, useState } from "react";
import { StopPlace, type DraftStop } from "@/components/stop-place";
import Timeline from "@/components/timeline";
import TrackLink from "@/components/track-link";
import { formatWhen } from "@/lib/dates";
import { applyStopOrder, type RoutePlan } from "@/lib/route-optimize";
import { normalizeSalesOrder, parseLegacySalesOrders, salesOrderError, salesOrderLineErrors } from "@/lib/sales-orders";
import { timeSelectOptions } from "@/lib/ship-time";
import {
  RATE_REASONS,
  STATUS_LABEL,
  TRANSIT_OPTIONS,
  TRUCK_TYPES,
  formatLoadNumber,
  type CustomerOrder,
  type Place,
  type PortalStatus,
  type Site,
  type Stop,
  type StopKind,
} from "@/lib/types";

export interface DraftSalesOrder {
  number: string;
  /** Drop stop id. Ignored when the load has one drop. */
  stopId: string | null;
}

export interface SoHint {
  suggestion: string | null;
  highestInUse: string | null;
  tooLong: boolean;
}

export interface Draft {
  salesOrders: DraftSalesOrder[];
  /** Shown under each SO while copying a load. Index matches salesOrders. */
  soHints?: Array<SoHint | null>;
  copiedFromId?: string | null;
  origin: Place;
  destination: Place;
  stops: DraftStop[];
  portalStatus: PortalStatus;
  truckType: string;
  transit: string;
  shipDate: string;
  shipTime: string;
  mustDeliverDate: string;
  truckEta: string;
  customerCost: string;
  rateReason: string;
  comments: string;
}

const emptyPlace = (): Place => ({
  company: "",
  address1: "",
  address2: "",
  city: "",
  state: "",
  postalCode: "",
  country: "US",
});

function newStopId(): string {
  return crypto.randomUUID();
}

function endsFrom(stops: Stop[]): { origin: Place; destination: Place } {
  const pickup = stops.find((stop) => stop.kind === "pickup");
  const drop = [...stops].reverse().find((stop) => stop.kind === "drop");
  return {
    origin: pickup?.place ?? emptyPlace(),
    destination: drop?.place ?? emptyPlace(),
  };
}

export function emptyDraft(): Draft {
  const stops: Stop[] = [
    { id: newStopId(), kind: "pickup", place: emptyPlace() },
    { id: newStopId(), kind: "drop", place: emptyPlace() },
  ];
  return {
    salesOrders: [{ number: "", stopId: null }],
    stops,
    ...endsFrom(stops),
    portalStatus: "being_prepared",
    truckType: "",
    transit: "",
    shipDate: "",
    shipTime: "",
    mustDeliverDate: "",
    truckEta: "",
    customerCost: "",
    rateReason: "",
    comments: "",
  };
}

export function draftFromOrder(order: CustomerOrder): Draft {
  const stops = order.stops.length
    ? order.stops
    : [
        { id: "stop-1", kind: "pickup" as const, place: order.origin },
        { id: "stop-2", kind: "drop" as const, place: order.destination },
      ];
  return {
    salesOrders: order.salesOrders?.length
      ? order.salesOrders.map((line) => ({ number: line.number, stopId: line.stopId }))
      : parseLegacySalesOrders(order.salesOrderNumber).map((number) => ({ number, stopId: null as string | null })),
    stops,
    ...endsFrom(stops),
    portalStatus: order.portalStatus,
    truckType: order.truckType ?? "",
    transit: order.transit ?? "",
    shipDate: order.shipDate ?? "",
    shipTime: order.shipTime ?? "",
    mustDeliverDate: order.mustDeliverDate ?? "",
    truckEta: order.truckEta ?? "",
    customerCost: order.customerCost == null ? "" : String(order.customerCost),
    rateReason: order.rateReason ?? "",
    comments: order.comments ?? "",
  };
}

/** The copy-draft API response, mapped into the form. Cost, documents, and load number are not included. */
export function draftFromCopy(draft: {
  copiedFromId: string;
  portalStatus: Draft["portalStatus"];
  stops: Draft["stops"];
  truckType: string | null;
  transit: string | null;
  shipDate: string | null;
  shipTime: string | null;
  mustDeliverDate: string | null;
  truckEta: string | null;
  comments: string;
  salesOrders: Array<DraftSalesOrder & SoHint>;
}): Draft {
  const stops = draft.stops.length ? draft.stops : emptyDraft().stops;
  return {
    salesOrders: draft.salesOrders.map((line) => ({ number: line.number, stopId: line.stopId })),
    soHints: draft.salesOrders.map((line) => ({
      suggestion: line.suggestion,
      highestInUse: line.highestInUse,
      tooLong: line.tooLong,
    })),
    copiedFromId: draft.copiedFromId,
    stops,
    ...endsFrom(stops),
    portalStatus: "being_prepared",
    truckType: draft.truckType ?? "",
    transit: draft.transit ?? "",
    shipDate: draft.shipDate ?? "",
    shipTime: draft.shipTime ?? "",
    mustDeliverDate: draft.mustDeliverDate ?? "",
    truckEta: draft.truckEta ?? "",
    customerCost: "",
    rateReason: "",
    comments: draft.comments ?? "",
  };
}

export function payloadFromDraft(draft: Draft, options?: { includePricing?: boolean }) {
  const includePricing = options?.includePricing !== false;
  const drops = draft.stops.filter((stop) => stop.kind === "drop");
  return {
    salesOrders: draft.salesOrders
      .filter((line) => line.number.trim())
      .map((line) => ({
        number: normalizeSalesOrder(line.number),
        stopId: drops.length === 1 ? drops[0].id : line.stopId,
      })),
    origin: draft.origin,
    destination: draft.destination,
    stops: draft.stops.map((stop) => ({
      id: stop.id,
      kind: stop.kind,
      place: {
        company: stop.place.company,
        address1: stop.place.address1,
        address2: stop.place.address2 ?? "",
        city: stop.place.city,
        state: stop.place.state,
        postalCode: stop.place.postalCode,
        country: stop.place.country || "US",
      },
      locationId: stop.locationId ?? null,
      ...(stop.saveAsNew ? { saveAsNew: true } : {}),
      ...(stop.contact ? { contact: stop.contact } : {}),
      ...(stop.phone ? { phone: stop.phone } : {}),
      ...(stop.notes ? { notes: stop.notes } : {}),
    })),
    portalStatus: draft.portalStatus,
    truckType: draft.truckType || null,
    transit: draft.transit || null,
    shipDate: draft.shipDate || null,
    shipTime: draft.shipTime || null,
    mustDeliverDate: draft.mustDeliverDate || null,
    truckEta: draft.truckEta || null,
    ...(includePricing
      ? {
          customerCost: draft.customerCost === "" ? null : Number(draft.customerCost),
          rateReason: draft.rateReason || null,
        }
      : {}),
    comments: draft.comments,
    ...(draft.copiedFromId ? { copiedFromId: draft.copiedFromId } : {}),
  };
}

function StopsEditor({
  draft,
  setDraft,
  sites,
  readOnly,
}: {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  sites: Site[];
  readOnly: boolean;
}) {
  const warning = sequenceWarning(draft.stops);
  const missingPickup = !draft.stops.some((stop) => stop.kind === "pickup");
  const missingDrop = !draft.stops.some((stop) => stop.kind === "drop");
  const dragFrom = useRef<number | null>(null);

  function commit(stops: Stop[]) {
    setDraft({ ...draft, stops, ...endsFrom(stops) });
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= draft.stops.length || from === to) return;
    const stops = [...draft.stops];
    const [item] = stops.splice(from, 1);
    stops.splice(to, 0, item);
    commit(stops);
  }

  function add(kind: StopKind) {
    commit([...draft.stops, { id: newStopId(), kind, place: emptyPlace() }]);
  }

  function clearDragOver() {
    document.querySelectorAll(".stop-card.drag-over").forEach((el) => el.classList.remove("drag-over"));
  }

  function cardIndexAt(x: number, y: number): number {
    const target = document.elementFromPoint(x, y);
    const card = target?.closest(".stop-card");
    if (!card) return -1;
    return [...document.querySelectorAll(".stop-card")].indexOf(card);
  }

  return (
    <div className="field">
      <label>Stops</label>
      <p className="mini">Add pickups and drops in the order the truck should run them. Drag a stop by its handle, or use Up and Down.</p>
      {missingPickup || missingDrop ? <p className="error">Add at least one pickup and one drop.</p> : null}
      {warning ? <p className="warn">{warning}</p> : null}
      {draft.stops.map((stop, index) => (
        <article key={stop.id} className="stop-card">
          <div className="stop-head">
            <strong>
              {index + 1}. {stop.kind === "pickup" ? "Pickup" : "Drop"}
            </strong>
            {!readOnly && (
              <div className="stop-actions">
                <button
                  className="btn secondary drag-handle"
                  type="button"
                  aria-label={`Drag stop ${index + 1}`}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    dragFrom.current = index;
                  }}
                  onPointerMove={(event) => {
                    if (dragFrom.current == null) return;
                    clearDragOver();
                    const over = cardIndexAt(event.clientX, event.clientY);
                    if (over >= 0) document.querySelectorAll(".stop-card")[over]?.classList.add("drag-over");
                  }}
                  onPointerUp={(event) => {
                    const from = dragFrom.current;
                    dragFrom.current = null;
                    clearDragOver();
                    if (from == null) return;
                    const to = cardIndexAt(event.clientX, event.clientY);
                    if (to >= 0) move(from, to);
                  }}
                  onPointerCancel={() => {
                    dragFrom.current = null;
                    clearDragOver();
                  }}
                >
                  Drag
                </button>
                <button className="btn secondary" type="button" onClick={() => move(index, index - 1)} disabled={index === 0}>
                  Up
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => move(index, index + 1)}
                  disabled={index === draft.stops.length - 1}
                >
                  Down
                </button>
                <button
                  className="btn danger"
                  type="button"
                  onClick={() => commit(draft.stops.filter((item) => item.id !== stop.id))}
                  disabled={draft.stops.length <= 1}
                >
                  Remove
                </button>
              </div>
            )}
          </div>
          <div className="field">
            <label htmlFor={`stop-kind-${stop.id}`}>Stop type</label>
            <select
              id={`stop-kind-${stop.id}`}
              aria-label={`Stop ${index + 1} type`}
              value={stop.kind}
              disabled={readOnly}
              onChange={(event) =>
                commit(
                  draft.stops.map((item) =>
                    item.id === stop.id
                      ? {
                          ...item,
                          kind: event.target.value as StopKind,
                          locationId: null,
                          saveAsNew: false,
                          duplicateOf: null,
                        }
                      : item,
                  ),
                )
              }
            >
              <option value="pickup">Pickup</option>
              <option value="drop">Drop</option>
            </select>
          </div>
          {stop.kind === "drop" && soLabel(draft, stop.id) ? <p className="mini">{soLabel(draft, stop.id)}</p> : null}
          <StopPlace
            stop={stop}
            sites={stop.kind === "pickup" ? sites : []}
            readOnly={readOnly}
            onChange={(next) => commit(draft.stops.map((item) => (item.id === stop.id ? next : item)))}
          />
        </article>
      ))}
      {!readOnly && (
        <div className="actions" style={{ justifyContent: "flex-start" }}>
          <button className="btn secondary" type="button" onClick={() => add("pickup")}>
            Add pickup
          </button>
          <button className="btn secondary" type="button" onClick={() => add("drop")}>
            Add drop
          </button>
        </div>
      )}
      {!readOnly && <RouteOptimizer stops={draft.stops} onApply={commit} />}
    </div>
  );
}

/** Sales orders tied to one drop, for the stop card. */
export function soLabel(draft: Draft, stopId: string): string {
  const drops = draft.stops.filter((stop) => stop.kind === "drop");
  const numbers = draft.salesOrders
    .filter((line) => line.number.trim() && (drops.length === 1 ? drops[0].id === stopId : line.stopId === stopId))
    .map((line) => normalizeSalesOrder(line.number));
  return numbers.length ? `SO: ${numbers.join(", ")}` : "";
}

function stopName(stop: Stop, index: number): string {
  const where = [stop.place.city, stop.place.state].filter(Boolean).join(", ");
  return `${index + 1}. ${stop.kind === "pickup" ? "Pickup" : "Drop"}: ${stop.place.company || "Unnamed"}${where ? ` (${where})` : ""}`;
}

/** Errors that block saving the SO list, for the form to show before it calls the API. */
export function draftSalesOrderErrors(draft: Draft): string[] {
  return salesOrderLineErrors(draft.salesOrders, draft.stops, { required: true });
}

function SalesOrdersEditor({ draft, setDraft, readOnly }: { draft: Draft; setDraft: (draft: Draft) => void; readOnly: boolean }) {
  const drops = draft.stops.filter((stop) => stop.kind === "drop");
  const multiDrop = drops.length > 1;
  const rows: DraftSalesOrder[] = draft.salesOrders.length ? draft.salesOrders : [{ number: "", stopId: null }];
  const last = rows[rows.length - 1];
  const canAdd = !readOnly && last.number.trim() !== "" && salesOrderError(last.number) === null;

  function update(index: number, patch: Partial<DraftSalesOrder>) {
    setDraft({ ...draft, salesOrders: rows.map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  }

  if (readOnly) {
    return (
      <div className="field">
        <label>Sales Orders</label>
        <ul className="mini">
          {rows.filter((row) => row.number).map((row) => {
            const dropIndex = draft.stops.findIndex((stop) => stop.id === row.stopId);
            return (
              <li key={row.number}>
                {row.number}
                {multiDrop ? ` · ${dropIndex >= 0 ? stopName(draft.stops[dropIndex], dropIndex) : "Drop not set"}` : ""}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <div className="field">
      <label>Sales Orders</label>
      <p className="mini">One sales order per field. Use + to add another.{multiDrop ? " Choose the drop each SO goes to." : ""}</p>
      {rows.map((row, index) => {
        const problem = row.number.trim() ? salesOrderError(row.number) : null;
        const duplicate =
          row.number.trim() &&
          rows.findIndex((other) => normalizeSalesOrder(other.number) === normalizeSalesOrder(row.number)) !== index;
        const dropMissing = multiDrop && row.number.trim() && !drops.some((stop) => stop.id === row.stopId);
        return (
          <div key={index} className="so-row" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
            <input
              aria-label={`Sales order ${index + 1}`}
              placeholder="e.g., SO12345"
              value={row.number}
              onChange={(event) => update(index, { number: event.target.value.toUpperCase() })}
              aria-invalid={Boolean(problem || duplicate)}
              style={{ flex: "1 1 160px" }}
            />
            {multiDrop && (
              <select
                aria-label={`Drop for sales order ${index + 1}`}
                value={drops.some((stop) => stop.id === row.stopId) ? (row.stopId ?? "") : ""}
                onChange={(event) => update(index, { stopId: event.target.value || null })}
                aria-invalid={Boolean(dropMissing)}
                style={{ flex: "1 1 220px" }}
              >
                <option value="">Which drop?</option>
                {drops.map((stop) => {
                  const stopIndex = draft.stops.indexOf(stop);
                  return (
                    <option key={stop.id} value={stop.id}>
                      {stopName(stop, stopIndex)}
                    </option>
                  );
                })}
              </select>
            )}
            {rows.length > 1 && (
              <button
                className="btn danger"
                type="button"
                aria-label={`Remove sales order ${index + 1}`}
                onClick={() => setDraft({ ...draft, salesOrders: rows.filter((_, i) => i !== index) })}
              >
                Remove
              </button>
            )}
            {index === rows.length - 1 && canAdd && (
              <button
                className="btn secondary"
                type="button"
                aria-label="Add another sales order"
                onClick={() => setDraft({ ...draft, salesOrders: [...rows, { number: "", stopId: null }] })}
              >
                +
              </button>
            )}
            {problem && <p className="error" style={{ flexBasis: "100%", margin: 0 }}>{problem}</p>}
            {!problem && duplicate && <p className="error" style={{ flexBasis: "100%", margin: 0 }}>This sales order is already listed.</p>}
            {!problem && !duplicate && dropMissing && (
              <p className="error" style={{ flexBasis: "100%", margin: 0 }}>Unassigned. Choose which drop this SO goes to.</p>
            )}
            {!problem && !duplicate && !dropMissing && draft.soHints?.[index] && (
              <p className="mini" style={{ flexBasis: "100%", margin: 0 }}>
                {draft.soHints[index]?.tooLong
                  ? "The next SO is longer than 40 characters. Enter one manually."
                  : draft.soHints[index]?.suggestion
                    ? `Suggested ${draft.soHints[index]?.suggestion}${draft.soHints[index]?.highestInUse ? ` (highest in use: ${draft.soHints[index]?.highestInUse})` : ""}.`
                    : "Enter a sales order."}
                {draft.soHints[index]?.suggestion && row.number !== draft.soHints[index]?.suggestion && (
                  <>
                    {" "}
                    <button
                      className="text-link"
                      type="button"
                      onClick={() => update(index, { number: draft.soHints?.[index]?.suggestion ?? row.number })}
                    >
                      Use suggestion
                    </button>
                  </>
                )}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RouteOptimizer({ stops, onApply }: { stops: Stop[]; onApply: (stops: Stop[]) => void }) {
  const [plan, setPlan] = useState<RoutePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const drops = stops.filter((stop) => stop.kind === "drop").length;
  if (drops < 2) return null;
  const byId = new Map(stops.map((stop) => [stop.id, stop]));

  async function optimize() {
    setBusy(true);
    setMessage("");
    setPlan(null);
    try {
      const response = await fetch("/api/route-optimize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stops: stops.map((stop) => ({ id: stop.id, kind: stop.kind, place: stop.place })) }),
      });
      const body = await response.json();
      if (!response.ok) {
        const missing = Array.isArray(body.missing)
          ? (body.missing as string[]).map((id) => {
              const index = stops.findIndex((stop) => stop.id === id);
              return index >= 0 ? stopName(stops[index], index) : id;
            })
          : [];
        setMessage([body.error || "Could not optimize the route.", ...missing].join(" "));
        return;
      }
      const next = body.plan as RoutePlan;
      if (next.unchanged) {
        setMessage(`The current route is already the shortest (about ${next.currentMiles} miles).`);
        return;
      }
      setPlan(next);
    } catch {
      setMessage("Could not optimize the route. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function apply() {
    if (!plan) return;
    try {
      onApply(applyStopOrder(stops, plan.optimizedOrder));
      setMessage("Route updated. Save the load to keep it.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Optimize again.");
    }
    setPlan(null);
  }

  const list = (order: string[]) => (
    <ol className="mini" style={{ paddingLeft: 18 }}>
      {order.map((id, index) => {
        const stop = byId.get(id);
        return <li key={id}>{stop ? stopName(stop, index).replace(/^\d+\. /, "") : id}</li>;
      })}
    </ol>
  );

  return (
    <div className="route-optimizer" style={{ marginTop: 8 }}>
      <button className="btn secondary" type="button" onClick={optimize} disabled={busy}>
        {busy ? "Optimizing..." : "Optimize route"}
      </button>
      <p className="mini">Keeps pickups first and reorders the drops for the fewest miles. Miles are estimates.</p>
      {message && <p className="mini">{message}</p>}
      {plan && (
        <div className="route-preview" role="dialog" aria-label="Optimized route preview">
          <div className="grid-2">
            <div>
              <strong>Current route · about {plan.currentMiles} mi</strong>
              {list(plan.currentOrder)}
            </div>
            <div>
              <strong>Optimized route · about {plan.optimizedMiles} mi</strong>
              {list(plan.optimizedOrder)}
            </div>
          </div>
          <p>
            <strong>Update the route?</strong> Saves about {Math.max(0, plan.currentMiles - plan.optimizedMiles)} miles. Sales orders stay with their drops.
          </p>
          <div className="actions" style={{ justifyContent: "flex-start" }}>
            <button className="btn" type="button" onClick={apply}>
              Yes
            </button>
            <button className="btn secondary" type="button" onClick={() => setPlan(null)}>
              No
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function sequenceWarning(stops: Stop[]): string | null {
  const firstPickup = stops.findIndex((stop) => stop.kind === "pickup");
  const firstDrop = stops.findIndex((stop) => stop.kind === "drop");
  if (firstPickup < 0 || firstDrop < 0) return null;
  if (firstDrop < firstPickup) {
    return "A drop is listed before every pickup. Save only if that sequence is intentional.";
  }
  return null;
}

export default function LoadForm({
  draft,
  setDraft,
  order,
  sites,
  hideCommercial = false,
  readOnly = false,
}: {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  order?: CustomerOrder | null;
  sites: Site[];
  hideCommercial?: boolean;
  readOnly?: boolean;
}) {
  const shipTimeId = useId();
  return (
    <>
      {order && (
        <section>
          <div className="label">Tracking</div>
          <Timeline order={order} />
          <div className="mini">
            Latest ETA: {order.latestEta ? formatWhen(order.latestEta) : "Not posted yet"}
            {order.portalStatus === "cancelled" ? " · Cancelled" : ""}
          </div>
          <TrackLink href={order.trackingLink} />
          {order.trackingUrl && (
            <a className="track-link" href={order.trackingUrl} target="_blank" rel="noreferrer">
              Public tracking link
            </a>
          )}
          <div className="mini" style={{ marginTop: 8 }}>
            Select load {formatLoadNumber(order.loadNumber)} · created by {order.createdBy}
          </div>
        </section>
      )}
      <StopsEditor draft={draft} setDraft={setDraft} sites={sites} readOnly={readOnly} />
      <div className="field">
        <label>Status</label>
        <select value={draft.portalStatus} onChange={(event) => setDraft({ ...draft, portalStatus: event.target.value as PortalStatus })}>
          {Object.entries(STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <SalesOrdersEditor draft={draft} setDraft={setDraft} readOnly={readOnly} />
      <div className="grid-2">
        <div className="field">
          <label>Truck Type (optional)</label>
          <select value={draft.truckType} onChange={(event) => setDraft({ ...draft, truckType: event.target.value })}>
            <option value="">Select truck type</option>
            {(draft.truckType && !(TRUCK_TYPES as readonly string[]).includes(draft.truckType)
              ? [draft.truckType, ...TRUCK_TYPES]
              : TRUCK_TYPES
            ).map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Transit Time (optional)</label>
          <select value={draft.transit} onChange={(event) => setDraft({ ...draft, transit: event.target.value })}>
            <option value="">Select transit</option>
            {TRANSIT_OPTIONS.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </div>
      </div>
      {!hideCommercial && (
        <div className="grid-2">
          <div className="field">
            <label>Cost (optional)</label>
            <input
              inputMode="decimal"
              placeholder="e.g., 1500.00"
              value={draft.customerCost}
              onChange={(event) => setDraft({ ...draft, customerCost: event.target.value })}
            />
          </div>
          <div className="field">
            <label>Rate Reason Code (optional)</label>
            <select value={draft.rateReason} onChange={(event) => setDraft({ ...draft, rateReason: event.target.value })}>
              <option value="">Select reason code</option>
              {RATE_REASONS.map((reason) => (
                <option key={reason}>{reason}</option>
              ))}
            </select>
          </div>
        </div>
      )}
      <div className="grid-2">
        <div className="field">
          <label>Expected Ship Date</label>
          <input type="date" value={draft.shipDate} onChange={(event) => setDraft({ ...draft, shipDate: event.target.value })} />
        </div>
        <div className="field">
          <label htmlFor={shipTimeId}>Expected Ship Time (optional)</label>
          <select
            id={shipTimeId}
            value={draft.shipTime}
            onChange={(event) => setDraft({ ...draft, shipTime: event.target.value })}
          >
            <option value="">Select time</option>
            {timeSelectOptions(draft.shipTime).map((time) => (
              <option key={time} value={time}>
                {time}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid-2">
        <div className="field">
          <label>Must Deliver Date</label>
          <input type="date" value={draft.mustDeliverDate} onChange={(event) => setDraft({ ...draft, mustDeliverDate: event.target.value })} />
        </div>
        <div className="field">
          <label>Truck ETA</label>
          <input type="date" value={draft.truckEta} onChange={(event) => setDraft({ ...draft, truckEta: event.target.value })} />
        </div>
      </div>
      <div className="field">
        <label>Comments</label>
        <textarea rows={3} value={draft.comments} onChange={(event) => setDraft({ ...draft, comments: event.target.value })} />
      </div>
    </>
  );
}

export function useSites() {
  const [sites, setSites] = useState<Site[]>([]);
  useEffect(() => {
    fetch("/api/sites")
      .then((response) => (response.ok ? response.json() : { sites: [] }))
      .then((data) => setSites(data.sites ?? []))
      .catch(() => setSites([]));
  }, []);
  return sites;
}
