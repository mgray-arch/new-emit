"use client";

import { useEffect, useRef, useState } from "react";
import { mapsUrl, type Place, type Site, type Stop } from "@/lib/types";

export interface LocationHit {
  id: string;
  company: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  receiverCompany?: string | null;
  useCount?: number;
}

export interface DraftStop extends Stop {
  saveAsNew?: boolean;
  duplicateOf?: LocationHit | null;
  contact?: string;
  phone?: string;
  notes?: string;
}

function hitFrom(raw: LocationHit): LocationHit {
  return {
    id: raw.id,
    company: raw.receiverCompany || raw.company,
    address1: raw.address1,
    address2: raw.address2 ?? "",
    city: raw.city,
    state: raw.state,
    postalCode: raw.postalCode ?? "",
    country: raw.country || "US",
    receiverCompany: raw.receiverCompany ?? null,
    useCount: raw.useCount ?? 0,
  };
}

function placeFromHit(hit: LocationHit): Place {
  return {
    company: hit.receiverCompany || hit.company,
    address1: hit.address1,
    address2: hit.address2 ?? "",
    city: hit.city,
    state: hit.state,
    postalCode: hit.postalCode ?? "",
    country: hit.country || "US",
  };
}

function sameSite(place: Place, site: Site): boolean {
  const fold = (value: string | undefined) => (value ?? "").trim().toLowerCase();
  return (
    fold(place.company) === fold(site.company) &&
    fold(place.address1) === fold(site.address1) &&
    fold(place.city) === fold(site.city) &&
    fold(place.state) === fold(site.state)
  );
}

function line(place: Place): string {
  const cityLine = [place.city, place.state].filter(Boolean).join(", ");
  return [place.address1, place.address2, cityLine, place.postalCode].filter(Boolean).join(", ");
}

export function StopPlace({
  stop,
  sites,
  readOnly,
  onChange,
}: {
  stop: DraftStop;
  sites: Site[];
  readOnly: boolean;
  onChange: (stop: DraftStop) => void;
}) {
  const matchedSite = sites.find((site) => sameSite(stop.place, site));
  const [otherMode, setOtherMode] = useState<"auto" | "on" | "off">("auto");
  const [addingMode, setAddingMode] = useState<"auto" | "on" | "off">("auto");
  const other = otherMode === "on" || (otherMode === "auto" && !matchedSite && Boolean(stop.place.address1) && sites.length > 0);
  const dropFilled = Boolean(stop.place.company.trim() && stop.place.address1.trim());
  const adding = addingMode === "on";
  const showDropSummary = stop.kind === "drop" && dropFilled && !adding;
  const showDropSearch = stop.kind === "drop" && !dropFilled && !adding;
  const [more, setMore] = useState(Boolean(stop.contact || stop.phone || stop.notes));
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<LocationHit[]>([]);
  const [open, setOpen] = useState(false);
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (stop.kind !== "drop" || stop.locationId || adding || dropFilled) return;
    const handle = window.setTimeout(() => {
      const params = new URLSearchParams({ q: query, kind: "drop" });
      fetch(`/api/locations?${params}`)
        .then((response) => (response.ok ? response.json() : { locations: [] }))
        .then((body) => setHits((body.locations ?? []).map((row: LocationHit) => hitFrom(row))))
        .catch(() => setHits([]));
    }, 200);
    return () => window.clearTimeout(handle);
  }, [query, stop.kind, stop.locationId, adding, dropFilled]);

  useEffect(() => {
    if (readOnly || stop.saveAsNew || stop.locationId) return;
    if (stop.kind === "pickup" && (matchedSite || !other)) return;
    const place = stop.place;
    if (!place.company.trim() || !place.address1.trim() || !place.city.trim() || place.state.trim().length !== 2) return;
    const snapshot = JSON.stringify(place);
    const handle = window.setTimeout(() => {
      fetch("/api/locations/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: stop.kind === "pickup" ? "pickup_once" : "drop", place }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((body) => {
          const current = stopRef.current;
          if (JSON.stringify(current.place) !== snapshot || current.saveAsNew || current.locationId) return;
          const match = body?.match ? hitFrom(body.match) : null;
          if (match && current.duplicateOf?.id === match.id) return;
          if (!match && !current.duplicateOf) return;
          onChangeRef.current({ ...current, duplicateOf: match });
        })
        .catch(() => undefined);
    }, 400);
    return () => window.clearTimeout(handle);
  }, [
    readOnly,
    stop.saveAsNew,
    stop.locationId,
    stop.kind,
    stop.place.company,
    stop.place.address1,
    stop.place.address2,
    stop.place.city,
    stop.place.state,
    stop.place.postalCode,
    other,
    matchedSite,
  ]);

  function editPlace(place: Place) {
    onChange({ ...stop, place, locationId: null, saveAsNew: false, duplicateOf: null });
  }

  function useExisting(hit: LocationHit) {
    const fromSite = hit.id.startsWith("site:");
    onChange({
      ...stop,
      place: placeFromHit(hit),
      locationId: stop.kind === "drop" && !fromSite ? hit.id : null,
      saveAsNew: false,
      duplicateOf: null,
    });
    if (stop.kind === "pickup") setOtherMode(fromSite || sites.some((site) => sameSite(placeFromHit(hit), site)) ? "off" : "on");
    if (stop.kind === "drop") setAddingMode("off");
  }

  const duplicate = stop.duplicateOf && !stop.saveAsNew ? stop.duplicateOf : null;

  return (
    <div className="field">
      {stop.kind === "pickup" ? (
        <>
          <div className="site-chips" role="group" aria-label="Pickup sites">
            {sites.map((site) => {
              const on = Boolean(matchedSite && matchedSite.id === site.id);
              return (
                <button
                  key={site.id}
                  type="button"
                  className={on ? "site-chip on" : "site-chip"}
                  disabled={readOnly}
                  aria-pressed={on}
                  onClick={() => {
                    setOtherMode("off");
                    onChange({
                      ...stop,
                      place: {
                        company: site.company,
                        address1: site.address1,
                        address2: "",
                        city: site.city,
                        state: site.state,
                        postalCode: site.postalCode,
                        country: site.country || "US",
                      },
                      locationId: null,
                      saveAsNew: false,
                      duplicateOf: null,
                    });
                  }}
                >
                  <strong>{site.company}</strong>
                  <span>
                    {site.city}, {site.state}
                  </span>
                </button>
              );
            })}
          </div>
          {matchedSite && !other ? <p className="mini">{line(stop.place)}</p> : null}
          {!readOnly && (
            <button
              className="text-link"
              type="button"
              onClick={() => {
                setOtherMode("on");
                if (matchedSite) editPlace({ company: "", address1: "", address2: "", city: "", state: "", postalCode: "", country: "US" });
              }}
            >
              Other pickup location
            </button>
          )}
        </>
      ) : null}

      {showDropSummary ? (
        <div className="place-summary">
          <strong>{stop.place.company}</strong>
          <span>{line(stop.place)}</span>
          {!readOnly && (
            <button
              className="text-link"
              type="button"
              onClick={() => {
                setAddingMode("on");
                onChange({ ...stop, locationId: null, saveAsNew: false, duplicateOf: null });
              }}
            >
              Change
            </button>
          )}
        </div>
      ) : null}

      {showDropSearch ? (
        <>
          <input
            aria-label="Search saved drops"
            placeholder="Search company, city, or street"
            value={query}
            disabled={readOnly}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 180)}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
          />
          {open && hits.length > 0 && (
            <div className="loc-results">
              {hits.map((hit) => (
                <button
                  key={hit.id}
                  type="button"
                  className="loc-hit"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    useExisting(hit);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <strong>{hit.company}</strong>
                  <span>{line(placeFromHit(hit))}</span>
                </button>
              ))}
            </div>
          )}
          {!readOnly && (
            <button className="text-link" type="button" onClick={() => setAddingMode("on")}>
              Add new location
            </button>
          )}
        </>
      ) : null}

      {(stop.kind === "pickup" ? other : adding) && (
        <>
          <input
            aria-label="Company"
            placeholder="Company name"
            value={stop.place.company}
            disabled={readOnly}
            onChange={(event) => editPlace({ ...stop.place, company: event.target.value })}
          />
          <input
            aria-label="Street"
            placeholder="Street address"
            value={stop.place.address1}
            disabled={readOnly}
            onChange={(event) => editPlace({ ...stop.place, address1: event.target.value })}
          />
          <input
            aria-label="Address line 2"
            placeholder="Suite, dock, or building (optional)"
            value={stop.place.address2 ?? ""}
            disabled={readOnly}
            onChange={(event) => editPlace({ ...stop.place, address2: event.target.value })}
          />
          <div className="grid-3">
            <input
              aria-label="City"
              placeholder="City"
              value={stop.place.city}
              disabled={readOnly}
              onChange={(event) => editPlace({ ...stop.place, city: event.target.value })}
            />
            <input
              aria-label="State"
              placeholder="ST"
              maxLength={2}
              value={stop.place.state}
              disabled={readOnly}
              onChange={(event) => editPlace({ ...stop.place, state: event.target.value.toUpperCase() })}
            />
            <input
              aria-label="Postal code"
              placeholder="Postal"
              value={stop.place.postalCode}
              disabled={readOnly}
              onChange={(event) => editPlace({ ...stop.place, postalCode: event.target.value })}
            />
          </div>
          {!readOnly && (
            <button className="text-link" type="button" onClick={() => setMore((value) => !value)}>
              {more ? "Hide details" : "More details"}
            </button>
          )}
          {more && (
            <>
              <input
                aria-label="Contact"
                placeholder="Contact (optional)"
                value={stop.contact ?? ""}
                disabled={readOnly}
                onChange={(event) => onChange({ ...stop, contact: event.target.value })}
              />
              <input
                aria-label="Phone"
                placeholder="Phone (optional)"
                value={stop.phone ?? ""}
                disabled={readOnly}
                onChange={(event) => onChange({ ...stop, phone: event.target.value })}
              />
              <textarea
                aria-label="Notes"
                placeholder="Notes for this location (optional)"
                rows={2}
                value={stop.notes ?? ""}
                disabled={readOnly}
                onChange={(event) => onChange({ ...stop, notes: event.target.value })}
              />
            </>
          )}
          {stop.place.address1 && stop.place.city && (
            <a className="track-link" href={mapsUrl(stop.place)} target="_blank" rel="noreferrer">
              Open address in Google Maps
            </a>
          )}
          {stop.kind === "drop" && !readOnly && (
            <button
              className="text-link"
              type="button"
              onClick={() => {
                setAddingMode("off");
                onChange({
                  ...stop,
                  locationId: null,
                  saveAsNew: false,
                  duplicateOf: null,
                  place: { company: "", address1: "", address2: "", city: "", state: "", postalCode: "", country: "US" },
                });
              }}
            >
              Back to search
            </button>
          )}
        </>
      )}

      {duplicate && (
        <div className="dup-card" role="status">
          <p>
            This looks like a duplicate of <strong>{duplicate.company}</strong>
            {duplicate.city ? `, ${duplicate.city}` : ""}.
          </p>
          <div className="dup-actions">
            <button className="btn" type="button" onClick={() => useExisting(duplicate)}>
              Use existing
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={() => onChange({ ...stop, saveAsNew: true, duplicateOf: null })}
            >
              Save as new anyway
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
