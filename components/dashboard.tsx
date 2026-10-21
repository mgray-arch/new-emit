"use client";

import { useEffect, useMemo, useState } from "react";
import LoadForm, { draftFromOrder, emptyDraft, payloadFromDraft, useSites, type Draft } from "@/components/load-form";
import PhotoGallery from "@/components/photo-gallery";
import SelectLoadField from "@/components/select-load-field";
import TrackLink from "@/components/track-link";
import TrackingLinkField from "@/components/tracking-link-field";
import { formatDay } from "@/lib/dates";
import {
  LOAD_TABS,
  LOAD_TAB_LABEL,
  PICKUP_GROUP_LABEL,
  attentionReasons,
  pickupGroup,
  type LoadTab,
  type PickupGroup,
} from "@/lib/load-list";
import {
  STATUS_LABEL,
  canSeePricing,
  formatLoadNumber,
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
  counts: Record<LoadTab, number>;
  today: string;
  tomorrow: string;
  weekEnd: string;
  scope: "tab" | "all";
  tab: LoadTab;
  receivers: string[];
}

const PAGE_SIZE = 25;

export default function Dashboard({ startNew = false }: { startNew?: boolean }) {
  const sites = useSites();
  const [tab, setTab] = useState<LoadTab>("attention");
  const [status, setStatus] = useState<string>("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [shipFrom, setShipFrom] = useState("");
  const [shipTo, setShipTo] = useState("");
  const [pickup, setPickup] = useState("");
  const [receiver, setReceiver] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResponse | null>(null);
  const [rows, setRows] = useState<CustomerOrder[]>([]);
  const [reload, setReload] = useState(0);
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
    params.set("tab", tab);
    if (status) params.set("status", status);
    if (query.trim()) params.set("q", query.trim());
    if (shipFrom) params.set("shipFrom", shipFrom);
    if (shipTo) params.set("shipTo", shipTo);
    if (pickup) params.set("pickup", pickup);
    if (receiver) params.set("receiver", receiver);
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    fetch(`/api/orders?${params}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load orders");
        return response.json();
      })
      .then((body: ListResponse) => {
        setData(body);
        setRows((current) => {
          if (page === 1) return body.orders;
          const seen = new Set(current.map((order) => order.id));
          return [...current, ...body.orders.filter((order) => !seen.has(order.id))];
        });
        setError("");
      })
      .catch(() => setError("Could not load orders"));
  }, [tab, status, query, shipFrom, shipTo, pickup, receiver, page, reload]);

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
      setPage(1);
      setReload((value) => value + 1);
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
    setPage(1);
    setReload((value) => value + 1);
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

  const counts = data?.counts ?? { attention: 0, active: 0, delivered: 0, history: 0 };
  const groups = useMemo(() => {
    if (!data) return [];
    const blocks: Array<{ id: PickupGroup; orders: CustomerOrder[] }> = [];
    for (const order of rows) {
      const id = pickupGroup(order.shipDate, data.today, data.tomorrow, data.weekEnd);
      const last = blocks[blocks.length - 1];
      if (!last || last.id !== id) blocks.push({ id, orders: [order] });
      else last.orders.push(order);
    }
    return blocks;
  }, [rows, data]);

  function exportHistory() {
    const params = new URLSearchParams();
    params.set("tab", "history");
    if (status) params.set("status", status);
    if (query.trim()) params.set("q", query.trim());
    if (shipFrom) params.set("shipFrom", shipFrom);
    if (shipTo) params.set("shipTo", shipTo);
    if (pickup) params.set("pickup", pickup);
    if (receiver) params.set("receiver", receiver);
    window.location.href = `/api/orders/export?${params}`;
  }

  return (
    <main className="page">
      <h1>BROKER DASHBOARD</h1>
      <p className="lede">View and track all incoming shipment loads</p>
      <div className="tabs" role="tablist" aria-label="Load lists">
        {LOAD_TABS.map((item) => (
          <button
            key={item}
            className={tab === item ? "tab on" : "tab"}
            type="button"
            role="tab"
            aria-selected={tab === item}
            onClick={() => {
              setTab(item);
              setPage(1);
            }}
          >
            <strong>{counts[item]}</strong>
            <span>{LOAD_TAB_LABEL[item]}</span>
          </button>
        ))}
      </div>
      <div className="filters">
        <input
          className="search board-search"
          placeholder="Search load number, order, city, or receiver"
          value={q}
          onChange={(event) => {
            setQ(event.target.value);
            setPage(1);
          }}
          aria-label="Search loads"
        />
        <input aria-label="Pickup from" type="date" value={shipFrom} onChange={(event) => { setShipFrom(event.target.value); setPage(1); }} />
        <input aria-label="Pickup to" type="date" value={shipTo} onChange={(event) => { setShipTo(event.target.value); setPage(1); }} />
        <select aria-label="Pickup site" value={pickup} onChange={(event) => { setPickup(event.target.value); setPage(1); }}>
          <option value="">All pickup sites</option>
          {sites.map((site) => (
            <option key={site.id} value={site.company}>
              {site.company}
            </option>
          ))}
        </select>
        <select aria-label="Receiver" value={receiver} onChange={(event) => { setReceiver(event.target.value); setPage(1); }}>
          <option value="">All receivers</option>
          {(data?.receivers ?? []).map((company) => (
            <option key={company} value={company}>
              {company}
            </option>
          ))}
        </select>
        <select
          aria-label="Status"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
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
        {tab === "history" && (
          <button className="btn secondary" type="button" onClick={exportHistory}>
            Export CSV
          </button>
        )}
      </div>
      {data?.scope === "all" && query.trim() ? <p className="mini">Showing matches from every tab.</p> : null}
      {error && <p className="error">{error}</p>}
      <div className="board">
        {groups.map((group) => (
          <section key={group.id}>
            <div className="group-head" role="heading" aria-level={2}>
              {PICKUP_GROUP_LABEL[group.id]}
            </div>
            {group.orders.map((order) => {
              const reasons = data ? attentionReasons(order, data.today) : [];
              return (
                <article
                  key={order.id}
                  className="load-row"
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
                  <div className="load-row-top">
                    <strong className="so">{order.salesOrderNumber}</strong>
                    <span className="pill">{STATUS_LABEL[order.portalStatus]}</span>
                  </div>
                  <div className={order.loadNumber ? "mini" : "mini pending"}>
                    Select load {formatLoadNumber(order.loadNumber)}
                    {order.shipDate ? ` · Ship ${formatDay(order.shipDate)}${order.shipTime ? ` ${order.shipTime}` : ""}` : ""}
                  </div>
                  <div>
                    {order.origin.company} · {order.origin.city}, {order.origin.state}
                    {" → "}
                    {order.destination.company} · {order.destination.city}, {order.destination.state}
                    {order.stops.length > 2 ? ` · ${order.stops.length} stops` : ""}
                  </div>
                  {reasons.length > 0 && <div className="hold">{reasons.join(" · ")}</div>}
                  <div className="load-row-actions">
                    <TrackLink href={order.trackingLink} />
                    {showPricing && (
                      <span className="mini">
                        {order.customerCost == null ? "Cost not set" : order.customerCost.toLocaleString("en-US", { style: "currency", currency: "USD" })}
                      </span>
                    )}
                    <select
                      aria-label={`Status for ${order.salesOrderNumber}`}
                      value={order.portalStatus}
                      onChange={(event) => changeStatus(order, event.target.value as PortalStatus)}
                    >
                      {Object.entries(STATUS_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                </article>
              );
            })}
          </section>
        ))}
        {data && rows.length === 0 ? <p className="mini">No loads in this list.</p> : null}
      </div>
      <div className="pager">
        <span>{data ? `${rows.length} of ${data.total}` : ""}</span>
        {data && rows.length < data.total ? (
          <button className="btn secondary" type="button" onClick={() => setPage((value) => value + 1)}>
            Load more
          </button>
        ) : null}
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
