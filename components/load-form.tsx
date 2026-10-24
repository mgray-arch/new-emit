"use client";

import { useEffect, useId, useRef, useState } from "react";
import { StopPlace, type DraftStop } from "@/components/stop-place";
import Timeline from "@/components/timeline";
import TrackLink from "@/components/track-link";
import { formatWhen } from "@/lib/dates";
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

export interface Draft {
  salesOrderNumber: string;
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
    salesOrderNumber: "",
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
    salesOrderNumber: order.salesOrderNumber,
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

export function payloadFromDraft(draft: Draft, options?: { includePricing?: boolean }) {
  const includePricing = options?.includePricing !== false;
  return {
    salesOrderNumber: draft.salesOrderNumber,
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
      <div className="field">
        <label>Sales Order Number</label>
        <input value={draft.salesOrderNumber} onChange={(event) => setDraft({ ...draft, salesOrderNumber: event.target.value })} />
      </div>
      <div className="grid-2">
        <div className="field">
          <label>Truck Type (optional)</label>
          <select value={draft.truckType} onChange={(event) => setDraft({ ...draft, truckType: event.target.value })}>
            <option value="">Select truck type</option>
            {TRUCK_TYPES.map((type) => (
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
