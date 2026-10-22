"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import LoadForm, { draftFromOrder, emptyDraft, payloadFromDraft, useSites, type Draft } from "@/components/load-form";
import SamBuildButton from "@/components/sam-build-button";
import PhotoGallery from "@/components/photo-gallery";
import SelectLoadField from "@/components/select-load-field";
import StatusPill from "@/components/status-pill";
import TrackLink from "@/components/track-link";
import TrackingLinkField from "@/components/tracking-link-field";
import { formatDay } from "@/lib/dates";
import {
  LOAD_TABS,
  LOAD_TAB_LABEL,
  PICKUP_GROUP_LABEL,
  attentionReasons,
  displayStatus,
  emptyListMessage,
  fileSummary,
  pickupGroup,
  type LoadTab,
  type PickupGroup,
} from "@/lib/load-list";
import { toast } from "@/lib/toast";
import {
  STATUS_LABEL,
  canAddLoads,
  canSeePricing,
  formatLoadNumber,
  type CustomerDocument,
  type CustomerOrder,
  type PortalRole,
} from "@/lib/types";

interface Me {
  role: PortalRole;
  permission?: "view" | "add" | "pricing" | "full" | null;
  readOnly?: boolean;
}

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

function Note({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 90;
  return (
    <div className="note-wrap">
      <p className={open || !long ? "note" : "note clamp"} title={text}>
        {text}
      </p>
      {long ? (
        <button
          className="text-btn"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
          }}
        >
          {open ? "Show less" : "Show note"}
        </button>
      ) : null}
    </div>
  );
}

export default function Dashboard({ startNew = false }: { startNew?: boolean }) {
  const router = useRouter();
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
  const [me, setMe] = useState<Me | null>(null);
  const [showTips, setShowTips] = useState(false);
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
      .then((body: Me | null) => {
        setMe(body);
        const edit = new URLSearchParams(window.location.search).get("edit");
        if (edit && body && !body.readOnly && canAddLoads(body)) void openEdit(edit);
      })
      .catch(() => setMe(null));
  }, []);

  const role = me?.role ?? null;
  const readOnly = Boolean(me?.readOnly);
  const showPricing = canSeePricing(me);
  const allowLoads = canAddLoads(me);
  const selectView = role === "admin" && !readOnly;

  useEffect(() => {
    if (!allowLoads || readOnly) setCreating(false);
  }, [allowLoads, readOnly]);

  useEffect(() => {
    if (!role || role === "admin") return;
    if (window.localStorage.getItem("emit-tips-v1") === "1") return;
    setShowTips(true);
  }, [role]);

  const replaceOrder = useCallback((next: CustomerOrder) => {
    setRows((current) => current.map((item) => (item.id === next.id ? next : item)));
    setEditing((current) => (current?.id === next.id ? next : current));
  }, []);

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
      .catch(() => setError("We couldn't load your loads. Refresh the page and try again."));
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
    if (readOnly) {
      setFormError("View-as is read-only. Switch back to Select view to change anything.");
      return;
    }
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
      toast(editing ? "Load saved." : "Load submitted. Select will add the load number.");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "We couldn't save this load. Check the fields and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function upload(slot: "attachment" | "bol", file: File) {
    if (readOnly) {
      setFormError("View-as is read-only. Switch back to Select view to change anything.");
      return;
    }
    if (!editing) return;
    const form = new FormData();
    form.set("file", file);
    form.set("slot", slot);
    const response = await fetch(`/api/orders/${editing.id}/documents`, { method: "POST", body: form });
    const body = await response.json();
    if (!response.ok) {
      setFormError(body.error || "We couldn't upload that file. Try again.");
      return;
    }
    setEditing(body.order);
    setFormError("");
    toast(role === "admin" && body.heldForReview ? `${body.heldForReview} in review` : "Uploaded");
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
      <div className="page-head">
        <div>
          <h1>Loads</h1>
          <p className="lede">What needs a look, what is moving, and what already delivered.</p>
        </div>
        {allowLoads ? (
          <button
            className="btn"
            type="button"
            disabled={readOnly}
            title={readOnly ? "Read-only preview" : undefined}
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
        ) : null}
      </div>
      {showTips && (
        <aside className="tips">
          <strong>A few tips</strong>
          <p>Needs Attention is the short list: a missing Select load number, or a truck with no tracking link.</p>
          <p>Search finds a load in any tab. Click a card to open it.</p>
          <button
            className="btn secondary"
            type="button"
            onClick={() => {
              window.localStorage.setItem("emit-tips-v1", "1");
              setShowTips(false);
            }}
          >
            Got it
          </button>
        </aside>
      )}
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
        <label className="filter" style={{ flex: "1 1 220px" }}>
          <span>Search</span>
          <input
            className="search board-search"
            placeholder="Load number, order, city, or receiver"
            value={q}
            onChange={(event) => {
              setQ(event.target.value);
              setPage(1);
            }}
            aria-label="Search loads"
          />
        </label>
        <label className="filter">
          <span>Pickup from</span>
          <input aria-label="Pickup from" type="date" value={shipFrom} onChange={(event) => { setShipFrom(event.target.value); setPage(1); }} />
        </label>
        <label className="filter">
          <span>Pickup to</span>
          <input aria-label="Pickup to" type="date" value={shipTo} onChange={(event) => { setShipTo(event.target.value); setPage(1); }} />
        </label>
        <label className="filter">
          <span>Pickup site</span>
          <select aria-label="Pickup site" value={pickup} onChange={(event) => { setPickup(event.target.value); setPage(1); }}>
            <option value="">All sites</option>
            {sites.map((site) => (
              <option key={site.id} value={site.company}>
                {site.company}
              </option>
            ))}
          </select>
        </label>
        <label className="filter">
          <span>Receiver</span>
          <select aria-label="Receiver" value={receiver} onChange={(event) => { setReceiver(event.target.value); setPage(1); }}>
            <option value="">All receivers</option>
            {(data?.receivers ?? []).map((company) => (
              <option key={company} value={company}>
                {company}
              </option>
            ))}
          </select>
        </label>
        <label className="filter">
          <span>Status</span>
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
        </label>
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
              const reasons = (data ? attentionReasons(order, data.today) : []).filter((reason) => reason !== "Files in review");
              const today = data?.today ?? "";
              return (
                <article
                  key={order.id}
                  className="load-row"
                  tabIndex={0}
                  aria-label={`Open ${order.salesOrderNumber}`}
                  onClick={(event) => {
                    const target = event.target as HTMLElement;
                    if (target.closest("a, button, select, input, label, option")) return;
                    router.push(`/orders/${order.id}`);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && event.target === event.currentTarget) router.push(`/orders/${order.id}`);
                  }}
                >
                  <div className="load-row-top">
                    <div className="lane">
                      {order.origin.city}, {order.origin.state} → {order.destination.city}, {order.destination.state}
                    </div>
                    <StatusPill status={displayStatus(order, today)} />
                  </div>
                  <div className="date-grid">
                    <div className="date-pair">
                      <span className="k">Pickup</span>
                      <span>{order.shipDate ? `${formatDay(order.shipDate)}${order.shipTime ? `, ${order.shipTime}` : ""}` : "Not set"}</span>
                    </div>
                    <div className="date-pair">
                      <span className="k">Delivery</span>
                      <span>{order.mustDeliverDate ? formatDay(order.mustDeliverDate) : "Not set"}</span>
                    </div>
                  </div>
                  <div className="load-meta">
                    {order.salesOrderNumber} · Select load {formatLoadNumber(order.loadNumber)}
                    {order.stops.length > 2 ? ` · ${order.stops.length} stops` : ""} · {fileSummary({ ...order, pendingReviewCount: 0 })}
                  </div>
                  {reasons.length > 0 && <div className="hold">{reasons.join(" · ")}</div>}
                  {selectView && (order.pendingReviewCount ?? 0) > 0 ? (
                    <div className="hold">{order.pendingReviewCount} in review</div>
                  ) : null}
                  {order.comments ? <Note text={order.comments} /> : null}
                  <div className="load-row-actions">
                    {selectView ? <SamBuildButton order={order} onUpdated={replaceOrder} /> : null}
                    <TrackLink href={order.trackingLink} />
                    {showPricing && (
                      <span className="load-meta">
                        {order.customerCost == null ? "Cost not set" : order.customerCost.toLocaleString("en-US", { style: "currency", currency: "USD" })}
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        ))}
        {data && rows.length === 0 ? (
          <p className="empty">
            {emptyListMessage(tab, Boolean(query.trim() || status || shipFrom || shipTo || pickup || receiver))}
          </p>
        ) : null}
      </div>
      <div className="pager">
        <span>{data ? `Showing ${rows.length} of ${data.total}` : ""}</span>
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
                <h2 id="load-title">{editing ? "Edit load" : "New load"}</h2>
                <p className="sub">{editing ? "Update this load, then save." : "Tell Select what you need moved."}</p>
              </div>
              <button className="icon-btn" type="button" aria-label="Close" title="Close" onClick={() => { setCreating(false); setEditing(null); }}>
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
            {selectView && editing && (
              <>
                <SamBuildButton order={editing} onUpdated={replaceOrder} />
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
            {selectView && editing && (editing.pendingReviewCount ?? 0) > 0 && (
              <p className="hold">{editing.pendingReviewCount} in review</p>
            )}
            {editing && <PhotoGallery orderId={editing.id} loadNumber={editing.loadNumber} canUpload={selectView} />}
            <div className="actions">
              <button className="btn secondary" type="button" onClick={() => { setCreating(false); setEditing(null); }}>
                Close
              </button>
              <button className="btn" type="button" disabled={saving || readOnly} onClick={save}>
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
