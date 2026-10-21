"use client";

import { useEffect, useMemo, useState } from "react";
import LoadForm, { draftFromOrder, emptyDraft, payloadFromDraft, useSites, type Draft } from "@/components/load-form";
import PhotoGallery from "@/components/photo-gallery";
import SelectLoadField from "@/components/select-load-field";
import TrackLink from "@/components/track-link";
import TrackingLinkField from "@/components/tracking-link-field";
import { formatDay } from "@/lib/dates";
import {
  STATUS_LABEL,
  canSeePricing,
  formatLoadNumber,
  formatPlace,
  type CustomerDocument,
  type CustomerOrder,
  type PortalRole,
  type PortalStatus,
} from "@/lib/types";

interface ListResponse {
  orders: CustomerOrder[];
  total: number;
  page: number;
  pageSize: number;
  stats: Record<PortalStatus | "total", number>;
}

const STATS: Array<{ key: PortalStatus | "total"; label: string; color: string; icon: string }> = [
  { key: "total", label: "Total Loads", color: "var(--orange)", icon: "box" },
  { key: "being_prepared", label: "Being Prepared", color: "var(--gold)", icon: "clock" },
  { key: "ready_to_ship", label: "Ready to Ship", color: "var(--green)", icon: "check" },
  { key: "shipped", label: "Shipped", color: "var(--blue)", icon: "truck" },
  { key: "cancelled", label: "Cancelled", color: "var(--red)", icon: "x" },
];

function Icon({ name, color }: { name: string; color: string }) {
  const common = { width: 18, height: 18, fill: "none", stroke: color, strokeWidth: 1.8 };
  if (name === "clock") {
    return (
      <svg {...common} viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v5l3 2" />
      </svg>
    );
  }
  if (name === "check") {
    return (
      <svg {...common} viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8" />
        <path d="M8 12.5l2.5 2.5L16 9" />
      </svg>
    );
  }
  if (name === "truck") {
    return (
      <svg {...common} viewBox="0 0 24 24">
        <path d="M3 7h11v8H3zM14 10h4l3 3v2h-7z" />
        <circle cx="7" cy="17" r="1.5" />
        <circle cx="17" cy="17" r="1.5" />
      </svg>
    );
  }
  if (name === "x") {
    return (
      <svg {...common} viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8" />
        <path d="M9 9l6 6M15 9l-6 6" />
      </svg>
    );
  }
  return (
    <svg {...common} viewBox="0 0 24 24">
      <path d="M4 8l8-4 8 4-8 4-8-4zM4 8v8l8 4 8-4V8" />
    </svg>
  );
}

function DateStack({ date, time }: { date: string | null; time?: string | null }) {
  if (!date) return <span className="mini">—</span>;
  const [year] = date.split("-");
  return (
    <span className="datestack">
      <span>{formatDay(date)},</span>
      <span>
        {year}
        {time ? ` ${time}` : ""}
      </span>
    </span>
  );
}

export default function Dashboard({ startNew = false }: { startNew?: boolean }) {
  const sites = useSites();
  const [status, setStatus] = useState<string>("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [shipFrom, setShipFrom] = useState("");
  const [shipTo, setShipTo] = useState("");
  const [showDates, setShowDates] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<CustomerOrder | null>(null);
  const [creating, setCreating] = useState(startNew);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [role, setRole] = useState<PortalRole | null>(null);
  const [submitted, setSubmitted] = useState<CustomerOrder | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    const handle = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(handle);
  }, [q]);

  useEffect(() => {
    fetch("/api/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => setRole(body?.role ?? null))
      .catch(() => setRole(null));
  }, []);

  const showPricing = canSeePricing(role);

  useEffect(() => {
    if (!creating && !editing) return;
    document.documentElement.classList.add("dialog-open");
    return () => document.documentElement.classList.remove("dialog-open");
  }, [creating, editing]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (query.trim()) params.set("q", query.trim());
    if (shipFrom) params.set("shipFrom", shipFrom);
    if (shipTo) params.set("shipTo", shipTo);
    params.set("page", String(page));
    fetch(`/api/orders?${params}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load orders");
        return response.json();
      })
      .then((body) => {
        setData(body);
        setError("");
      })
      .catch(() => setError("Could not load orders"));
  }, [status, query, shipFrom, shipTo, page, submitted, editing]);

  const stats = data?.stats ?? { total: 0, being_prepared: 0, ready_to_ship: 0, shipped: 0, cancelled: 0 };

  async function openEdit(id: string) {
    const response = await fetch(`/api/orders/${id}`);
    if (!response.ok) return;
    const body = await response.json();
    setEditing(body.order);
    setDraft(draftFromOrder(body.order));
    setSubmitted(null);
    setFormError("");
    setCreating(false);
  }

  async function save() {
    if (!draft.stops.some((stop) => stop.kind === "pickup") || !draft.stops.some((stop) => stop.kind === "drop")) {
      setFormError("Add at least one pickup and one drop.");
      return;
    }
    if (draft.stops.some((stop) => stop.duplicateOf && !stop.saveAsNew)) {
      setFormError("This looks like a duplicate. Use the existing location, or save it as new.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const payload = payloadFromDraft(draft, { includePricing: showPricing });
      const response = await fetch(editing ? `/api/orders/${editing.id}` : "/api/orders", {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (response.status === 409 && Array.isArray(body.duplicates)) {
        const duplicates = body.duplicates as Array<{
          stopId?: string;
          location?: {
            id: string;
            company: string;
            address1: string;
            address2?: string;
            city: string;
            state: string;
            postalCode?: string;
            country?: string;
            receiverCompany?: string | null;
          };
        }>;
        const warnings = new Map(duplicates.map((item) => [item.stopId, item.location]));
        setDraft({
          ...draft,
          stops: draft.stops.map((stop) => {
            const location = warnings.get(stop.id);
            if (!location) return stop;
            return {
              ...stop,
              saveAsNew: false,
              duplicateOf: {
                id: location.id,
                company: location.receiverCompany || location.company,
                address1: location.address1,
                address2: location.address2 ?? "",
                city: location.city,
                state: location.state,
                postalCode: location.postalCode ?? "",
                country: location.country || "US",
                receiverCompany: location.receiverCompany ?? null,
              },
            };
          }),
        });
        setFormError(body.error || "This looks like a duplicate.");
        return;
      }
      if (!response.ok) throw new Error(body.error || "Could not save");
      if (!editing) {
        setSubmitted(body.order);
        setEditing(body.order);
        setDraft(draftFromOrder(body.order));
        setCreating(false);
      } else {
        setEditing(body.order);
        setDraft(draftFromOrder(body.order));
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(order: CustomerOrder, portalStatus: PortalStatus) {
    await fetch(`/api/orders/${order.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portalStatus }),
    });
    setPage(page);
    setData((current) => (current ? { ...current } : current));
    const params = new URLSearchParams({ page: String(page) });
    if (status) params.set("status", status);
    const response = await fetch(`/api/orders?${params}`);
    if (response.ok) setData(await response.json());
  }

  async function upload(slot: "attachment" | "bol", file: File) {
    if (!editing) return;
    const form = new FormData();
    form.set("file", file);
    form.set("slot", slot);
    const response = await fetch(`/api/orders/${editing.id}/documents`, { method: "POST", body: form });
    const body = await response.json();
    if (!response.ok) {
      setFormError(body.error || "Upload failed");
      return;
    }
    setEditing(body.order);
    setFormError(
      body.heldForReview
        ? `${body.heldForReview} page${body.heldForReview === 1 ? "" : "s"} held for Select review. ${body.released} released.`
        : "",
    );
  }

  const rangeLabel = useMemo(() => {
    if (!data) return "";
    if (data.total === 0) return "No loads";
    const from = (data.page - 1) * data.pageSize + 1;
    const to = Math.min(data.total, data.page * data.pageSize);
    return `Showing ${from}–${to} of ${data.total}`;
  }, [data]);

  return (
    <main className="page">
      <h1>BROKER DASHBOARD</h1>
      <p className="lede">View and track all incoming shipment loads</p>
      <section className="stats">
        {STATS.map((stat) => (
          <button
            key={stat.key}
            className={`stat ${status === (stat.key === "total" ? "" : stat.key) && (stat.key === "total" ? !status : true) ? "on" : ""}`}
            style={{ borderLeftColor: stat.color, ["--accent" as string]: stat.color }}
            onClick={() => {
              setStatus(stat.key === "total" ? "" : stat.key);
              setPage(1);
            }}
            type="button"
          >
            <div className="ico">
              <Icon name={stat.icon} color={stat.color} />
            </div>
            <strong>{stats[stat.key] ?? 0}</strong>
            <em>{stat.label}</em>
          </button>
        ))}
      </section>
      <div className="filters">
        <select
          aria-label="Status"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All Statuses</option>
          {Object.entries(STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button className="btn secondary" type="button" onClick={() => setShowDates((value) => !value)}>
          Ship date range
        </button>
        {showDates && (
          <>
            <input aria-label="Ship from" type="date" value={shipFrom} onChange={(event) => { setShipFrom(event.target.value); setPage(1); }} />
            <input aria-label="Ship to" type="date" value={shipTo} onChange={(event) => { setShipTo(event.target.value); setPage(1); }} />
          </>
        )}
        <input
          className="search"
          placeholder="Search SO or city"
          value={q}
          onChange={(event) => {
            setQ(event.target.value);
            setPage(1);
          }}
          aria-label="Search by SO or city"
        />
        <button
          className="btn"
          type="button"
          onClick={() => {
            setCreating(true);
            setEditing(null);
            setDraft(emptyDraft());
            setSubmitted(null);
            setFormError("");
          }}
        >
          New load
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {["PO / Order #", "Select load", "Origin", "Destination", "Truck Type", "Transit", "Ship Date/Time", "Must Deliver", "Truck ETA", "Status", ...(showPricing ? ["Cost"] : []), "Notes", "Files", "BOL", "Created By"].map((heading) => (
                <th key={heading}>{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data?.orders.map((order) => (
              <tr
                key={order.id}
                className="click-row"
                tabIndex={0}
                aria-label={`Open ${order.salesOrderNumber}`}
                onClick={(event) => {
                  const target = event.target as HTMLElement;
                  if (target.closest("a, button, select, input, label, option")) return;
                  void openEdit(order.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && event.target === event.currentTarget) void openEdit(order.id);
                }}
              >
                <td>
                  <span className="so">{order.salesOrderNumber}</span>
                </td>
                <td className={order.loadNumber ? undefined : "pending"}>
                  {formatLoadNumber(order.loadNumber)}
                  <TrackLink href={order.trackingLink} />
                </td>
                <td>
                  <div className="company">{order.origin.company}</div>
                  <div className="addr">{formatPlace(order.origin).replace(`${order.origin.company}, `, "")}</div>
                </td>
                <td>
                  <div className="company">{order.destination.company}</div>
                  <div className="addr">{formatPlace(order.destination).replace(`${order.destination.company}, `, "")}</div>
                  {order.stops.length > 2 && <div className="mini">{order.stops.length} stops</div>}
                </td>
                <td>{order.truckType || "—"}</td>
                <td>{order.transit || "—"}</td>
                <td>
                  <DateStack date={order.shipDate} time={order.shipTime} />
                </td>
                <td>
                  <DateStack date={order.mustDeliverDate} />
                </td>
                <td>
                  <DateStack date={order.truckEta} />
                </td>
                <td>
                  <select aria-label={`Status for ${order.salesOrderNumber}`} value={order.portalStatus} onChange={(event) => changeStatus(order, event.target.value as PortalStatus)}>
                    {Object.entries(STATUS_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </td>
                {showPricing && (
                  <td>{order.customerCost == null ? "—" : order.customerCost.toLocaleString("en-US", { style: "currency", currency: "USD" })}</td>
                )}
                <td className="notes">{order.comments || "—"}</td>
                <td>
                  <div>{order.attachmentCount}</div>
                  {order.pendingReviewCount > 0 && <div className="hold">{order.pendingReviewCount} in review</div>}
                </td>
                <td>{order.bolCount}</td>
                <td>{order.createdBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="load-cards">
        {data?.orders.map((order) => (
          <article
            className="load-card clickable"
            key={order.id}
            tabIndex={0}
            aria-label={`Open ${order.salesOrderNumber}`}
            onClick={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest("a, button, select, input, label")) return;
              void openEdit(order.id);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.target === event.currentTarget) void openEdit(order.id);
            }}
          >
            <h3>{order.salesOrderNumber}</h3>
            <div className="pill">{STATUS_LABEL[order.portalStatus]}</div>
            <p className={order.loadNumber ? "mini" : "mini pending"}>Select load {formatLoadNumber(order.loadNumber)}</p>
            <p>
              {order.origin.city}, {order.origin.state} → {order.destination.city}, {order.destination.state}
              {order.stops.length > 2 ? ` · ${order.stops.length} stops` : ""}
            </p>
            <p className="mini">
              Ship {order.shipDate || "—"} {order.shipTime || ""} · ETA {order.latestEta ? formatDay(order.latestEta.slice(0, 10)) : order.truckEta || "—"}
            </p>
            {showPricing && (
              <p className="mini">{order.customerCost == null ? "Cost not set" : order.customerCost.toLocaleString("en-US", { style: "currency", currency: "USD" })}</p>
            )}
            <TrackLink href={order.trackingLink} />
          </article>
        ))}
      </div>
      <div className="pager">
        <span>{rangeLabel}</span>
        <div>
          <button className="btn secondary" type="button" disabled={!data || data.page <= 1} onClick={() => setPage((value) => value - 1)}>
            Previous
          </button>
          <button
            className="btn secondary"
            type="button"
            disabled={!data || data.page * data.pageSize >= data.total}
            onClick={() => setPage((value) => value + 1)}
          >
            Next
          </button>
        </div>
      </div>
      {(creating || editing) && (
        <div className="backdrop" role="presentation" onMouseDown={() => { setCreating(false); setEditing(null); }}>
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="load-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="dialog-head">
              <div>
                <h2 id="load-title">{editing ? "EDIT LOAD" : "NEW LOAD"}</h2>
                <p className="sub">{editing ? "Update load details." : "Submit a load to Select."}</p>
              </div>
              <button className="icon-btn" type="button" aria-label="Close" onClick={() => { setCreating(false); setEditing(null); }}>
                ✕
              </button>
            </div>
            {submitted && editing && submitted.id === editing.id && (
              <div className="confirm">
                <strong>Order submitted</strong>
                <div className="pair">
                  <span>{submitted.salesOrderNumber}</span>
                  <span>→</span>
                  <b>Select load {formatLoadNumber(submitted.loadNumber)}</b>
                </div>
                <p className="mini">
                  This screen is the confirmation. No email is sent. The Select load number stays pending until a Select admin enters the number from SAM.
                </p>
              </div>
            )}
            {role === "admin" && editing && (
              <>
                <SelectLoadField
                  orderId={editing.id}
                  loadNumber={editing.loadNumber}
                  onUpdated={(order) => {
                    setEditing(order);
                    setSubmitted((current) => (current?.id === order.id ? order : current));
                  }}
                />
                <TrackingLinkField
                  orderId={editing.id}
                  trackingLink={editing.trackingLink}
                  onUpdated={(order) => {
                    setEditing(order);
                    setSubmitted((current) => (current?.id === order.id ? order : current));
                  }}
                />
              </>
            )}
            {formError && <p className="error">{formError}</p>}
            <LoadForm draft={draft} setDraft={setDraft} order={editing} sites={sites} hideCommercial={!showPricing} />
            {editing && (
              <div className="grid-2">
                <div className="field">
                  <label>Attachments</label>
                  <input aria-label="Upload attachment" type="file" onChange={(event) => event.target.files?.[0] && upload("attachment", event.target.files[0])} />
                  <FileList docs={editing.documents.filter((doc) => doc.kind === "attachment")} />
                </div>
                <div className="field">
                  <label>BOL</label>
                  <input aria-label="Upload BOL" type="file" onChange={(event) => event.target.files?.[0] && upload("bol", event.target.files[0])} />
                  <FileList docs={editing.documents.filter((doc) => doc.kind === "bol")} />
                </div>
              </div>
            )}
            {editing && editing.pendingReviewCount > 0 && (
              <p className="hold">{editing.pendingReviewCount} page(s) are held for Select review and are not visible yet.</p>
            )}
            {editing && <PhotoGallery orderId={editing.id} loadNumber={editing.loadNumber} canUpload={role === "admin"} />}
            <div className="actions">
              <button className="btn secondary" type="button" onClick={() => { setCreating(false); setEditing(null); }}>
                Close
              </button>
              <button className="btn" type="button" disabled={saving} onClick={save}>
                {saving ? "Saving…" : editing ? "Save changes" : "Submit order"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function FileList({ docs }: { docs: CustomerDocument[] }) {
  if (!docs.length) return <div className="mini">None yet</div>;
  return (
    <div className="refs">
      {docs.map((doc) => (
        <a key={doc.id} href={`/api/documents/${doc.id}`}>
          {doc.filename}
        </a>
      ))}
    </div>
  );
}
