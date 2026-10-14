"use client";

import { useEffect, useState } from "react";
import Timeline from "@/components/timeline";
import { formatWhen } from "@/lib/dates";
import {
  RATE_REASONS,
  STATUS_LABEL,
  TRANSIT_OPTIONS,
  TRUCK_TYPES,
  mapsUrl,
  type CustomerOrder,
  type Place,
  type PortalStatus,
  type Site,
} from "@/lib/types";

export interface Draft {
  salesOrderNumber: string;
  origin: Place;
  destination: Place;
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

const emptyPlace = (): Place => ({ company: "", address1: "", city: "", state: "", postalCode: "", country: "US" });

export function emptyDraft(): Draft {
  return {
    salesOrderNumber: "",
    origin: emptyPlace(),
    destination: emptyPlace(),
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
  return {
    salesOrderNumber: order.salesOrderNumber,
    origin: order.origin,
    destination: order.destination,
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

export function payloadFromDraft(draft: Draft) {
  return {
    salesOrderNumber: draft.salesOrderNumber,
    origin: draft.origin,
    destination: draft.destination,
    portalStatus: draft.portalStatus,
    truckType: draft.truckType || null,
    transit: draft.transit || null,
    shipDate: draft.shipDate || null,
    shipTime: draft.shipTime || null,
    mustDeliverDate: draft.mustDeliverDate || null,
    truckEta: draft.truckEta || null,
    customerCost: draft.customerCost === "" ? null : Number(draft.customerCost),
    rateReason: draft.rateReason || null,
    comments: draft.comments,
  };
}

function PlaceFields({
  label,
  place,
  sites,
  onChange,
}: {
  label: string;
  place: Place;
  sites: Site[];
  onChange: (place: Place) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {sites.length > 0 && (
        <select
          aria-label={`${label} site`}
          value=""
          onChange={(event) => {
            const site = sites.find((item) => item.id === event.target.value);
            if (!site) return;
            onChange({
              company: site.company,
              address1: site.address1,
              city: site.city,
              state: site.state,
              postalCode: site.postalCode,
              country: site.country || "US",
            });
          }}
        >
          <option value="">Fill from a ship-from site</option>
          {sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.company} — {site.city}, {site.state}
            </option>
          ))}
        </select>
      )}
      <input
        aria-label={`${label} company`}
        placeholder="Company name"
        value={place.company}
        onChange={(event) => onChange({ ...place, company: event.target.value })}
      />
      <input
        aria-label={`${label} street`}
        placeholder="Street address"
        value={place.address1}
        onChange={(event) => onChange({ ...place, address1: event.target.value })}
      />
      <div className="grid-3">
        <input
          aria-label={`${label} city`}
          placeholder="City"
          value={place.city}
          onChange={(event) => onChange({ ...place, city: event.target.value })}
        />
        <input
          aria-label={`${label} state`}
          placeholder="ST"
          maxLength={2}
          value={place.state}
          onChange={(event) => onChange({ ...place, state: event.target.value.toUpperCase() })}
        />
        <input
          aria-label={`${label} postal code`}
          placeholder="Postal"
          value={place.postalCode}
          onChange={(event) => onChange({ ...place, postalCode: event.target.value })}
        />
      </div>
      {place.address1 && place.city && (
        <a className="track-link" href={mapsUrl(place)} target="_blank" rel="noreferrer">
          Open address in Google Maps
        </a>
      )}
    </div>
  );
}

export default function LoadForm({
  draft,
  setDraft,
  order,
  sites,
}: {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  order?: CustomerOrder | null;
  sites: Site[];
}) {
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
          {order.trackingUrl && (
            <a className="track-link" href={order.trackingUrl} target="_blank" rel="noreferrer">
              Public tracking link
            </a>
          )}
          <div className="mini" style={{ marginTop: 8 }}>
            Select load {order.loadNumber} · created by {order.createdBy}
          </div>
        </section>
      )}
      <PlaceFields label="Origin" place={draft.origin} sites={sites} onChange={(origin) => setDraft({ ...draft, origin })} />
      <PlaceFields
        label="Destination"
        place={draft.destination}
        sites={[]}
        onChange={(destination) => setDraft({ ...draft, destination })}
      />
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
      <div className="grid-2">
        <div className="field">
          <label>Expected Ship Date</label>
          <input type="date" value={draft.shipDate} onChange={(event) => setDraft({ ...draft, shipDate: event.target.value })} />
        </div>
        <div className="field">
          <label>Expected Ship Time (optional)</label>
          <input type="time" value={draft.shipTime} onChange={(event) => setDraft({ ...draft, shipTime: event.target.value })} />
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
