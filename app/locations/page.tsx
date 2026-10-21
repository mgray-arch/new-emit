"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Shell from "@/components/shell";
import type { Site } from "@/lib/types";

interface SavedLocation {
  id: string;
  company: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  contact: string;
  phone: string;
  notes: string;
  receiverCompany: string | null;
  active: boolean;
  useCount: number;
}

export default function LocationsPage() {
  const [role, setRole] = useState<string | null>(null);
  const [locations, setLocations] = useState<SavedLocation[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<SavedLocation | null>(null);
  const [mergeInto, setMergeInto] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    const [me, drops, yards] = await Promise.all([
      fetch("/api/me").then((response) => (response.ok ? response.json() : null)),
      fetch("/api/locations?manage=1").then(async (response) => {
        if (response.status === 403) return { forbidden: true, locations: [] };
        if (!response.ok) throw new Error("Could not load locations");
        return response.json();
      }),
      fetch("/api/sites").then((response) => (response.ok ? response.json() : { sites: [] })),
    ]);
    setRole(me?.role ?? null);
    if (drops.forbidden) {
      setLocations([]);
      setError("Locations are managed by a Select admin or an EMIT admin.");
    } else {
      setLocations(drops.locations ?? []);
      setError("");
    }
    setSites(yards.sites ?? []);
  }

  useEffect(() => {
    void load().catch(() => setError("Could not load locations"));
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return locations;
    return locations.filter((location) =>
      [location.company, location.city, location.address1, location.address2, location.postalCode, location.receiverCompany ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [locations, query]);

  async function saveEdit() {
    if (!editing) return;
    setError("");
    const response = await fetch(`/api/locations/${editing.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        company: editing.company,
        address1: editing.address1,
        address2: editing.address2,
        city: editing.city,
        state: editing.state,
        postalCode: editing.postalCode,
        country: editing.country || "US",
        contact: editing.contact,
        phone: editing.phone,
        notes: editing.notes,
        active: editing.active,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error || "Could not save that location");
      return;
    }
    setEditing(null);
    setNotice("Location saved.");
    await load();
  }

  async function setActive(location: SavedLocation, active: boolean) {
    const response = await fetch(`/api/locations/${location.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...location, active }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error || "Could not update that location");
      return;
    }
    setNotice(active ? "Location is active again." : "Location deactivated. It stays off the search list.");
    await load();
  }

  async function merge(sourceId: string) {
    const intoId = mergeInto[sourceId];
    if (!intoId) {
      setError("Choose the location to keep.");
      return;
    }
    setError("");
    const response = await fetch(`/api/locations/${sourceId}/merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intoId }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error || "Could not merge those locations");
      return;
    }
    setNotice("Loads now point at the location you kept.");
    await load();
  }

  const canEdit = role === "admin" || role === "emit_admin";

  return (
    <Shell>
      <main className="page">
        <h1>LOCATIONS</h1>
        <p className="lede">Saved delivery locations. Search by company, city, or street.</p>
        {error ? <p className="error">{error}</p> : null}
        {notice ? <p className="mini">{notice}</p> : null}
        {canEdit && (
          <>
            <input
              className="search loc-search"
              aria-label="Search locations"
              placeholder="Search company, city, or street"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="loc-list">
              {shown.map((location) => {
                const open = editing?.id === location.id;
                const cityLine = [location.city, location.state].filter(Boolean).join(", ");
                return (
                  <article key={location.id} className="loc-card">
                    {open && editing ? (
                      <div className="field">
                        <input aria-label="Company" value={editing.company} onChange={(event) => setEditing({ ...editing, company: event.target.value })} />
                        <input aria-label="Street" value={editing.address1} onChange={(event) => setEditing({ ...editing, address1: event.target.value })} />
                        <input
                          aria-label="Address line 2"
                          placeholder="Suite or dock"
                          value={editing.address2}
                          onChange={(event) => setEditing({ ...editing, address2: event.target.value })}
                        />
                        <div className="grid-3">
                          <input aria-label="City" value={editing.city} onChange={(event) => setEditing({ ...editing, city: event.target.value })} />
                          <input
                            aria-label="State"
                            maxLength={2}
                            value={editing.state}
                            onChange={(event) => setEditing({ ...editing, state: event.target.value.toUpperCase() })}
                          />
                          <input
                            aria-label="Postal code"
                            value={editing.postalCode}
                            onChange={(event) => setEditing({ ...editing, postalCode: event.target.value })}
                          />
                        </div>
                        <input aria-label="Contact" placeholder="Contact" value={editing.contact} onChange={(event) => setEditing({ ...editing, contact: event.target.value })} />
                        <input aria-label="Phone" placeholder="Phone" value={editing.phone} onChange={(event) => setEditing({ ...editing, phone: event.target.value })} />
                        <textarea aria-label="Notes" rows={2} value={editing.notes} onChange={(event) => setEditing({ ...editing, notes: event.target.value })} />
                        <div className="actions">
                          <button className="btn secondary" type="button" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                          <button className="btn" type="button" onClick={() => void saveEdit()}>
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <strong>{location.company}</strong>
                        <span>
                          {[location.address1, location.address2, cityLine, location.postalCode].filter(Boolean).join(", ")}
                        </span>
                        <span className="mini">
                          Used {location.useCount} {location.useCount === 1 ? "time" : "times"}
                          {location.receiverCompany ? ` · Receiver ${location.receiverCompany}` : ""}
                          {location.active ? "" : " · Inactive"}
                        </span>
                        <div className="loc-actions">
                          <button className="btn secondary" type="button" onClick={() => setEditing(location)}>
                            Edit
                          </button>
                          <button className="btn secondary" type="button" onClick={() => void setActive(location, !location.active)}>
                            {location.active ? "Deactivate" : "Activate"}
                          </button>
                          <select
                            aria-label={`Merge ${location.company} into`}
                            value={mergeInto[location.id] ?? ""}
                            onChange={(event) => setMergeInto({ ...mergeInto, [location.id]: event.target.value })}
                          >
                            <option value="">Merge into…</option>
                            {locations
                              .filter((item) => item.id !== location.id && item.active)
                              .map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.company} — {item.city}
                                </option>
                              ))}
                          </select>
                          <button className="btn secondary" type="button" onClick={() => void merge(location.id)}>
                            Merge
                          </button>
                        </div>
                      </>
                    )}
                  </article>
                );
              })}
              {shown.length === 0 ? <p className="mini">No delivery locations match that search.</p> : null}
            </div>
          </>
        )}

        <h2>Pickup sites</h2>
        <p className="lede">These yards are the one-tap choices on a pickup. A one-off pickup is not added here.</p>
        <div className="loc-list">
          {sites.map((site) => (
            <article key={site.id} className="loc-card">
              <strong>{site.company}</strong>
              <span>
                {site.address1}, {site.city}, {site.state} {site.postalCode}
              </span>
            </article>
          ))}
        </div>
        {role === "admin" ? (
          <Link className="text-link" href="/admin/settings">
            Edit pickup sites
          </Link>
        ) : (
          <p className="mini">Select admins edit these yards.</p>
        )}
      </main>
    </Shell>
  );
}
