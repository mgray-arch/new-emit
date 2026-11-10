"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import CarrierBadge from "@/components/carrier-badge";
import DocumentLinks from "@/components/document-links";
import LoadForm, { draftFromCopy, draftFromOrder, draftSalesOrderErrors, emptyDraft, payloadFromDraft, useSites, type Draft } from "@/components/load-form";
import BuildStatus from "@/components/build-status";
import PhotoGallery from "@/components/photo-gallery";
import PortalStatusControl from "@/components/portal-status-control";
import SelectLoadField from "@/components/select-load-field";
import ListStopNames from "@/components/list-stop-names";
import SoNumber from "@/components/so-number";
import StatusPill from "@/components/status-pill";
import TrackLink from "@/components/track-link";
import TrackingLinkField from "@/components/tracking-link-field";
import { carrierIdentityLabel } from "@/lib/carrier";
import { formatWhenBoise } from "@/lib/dates";
import { reprintMessage } from "@/lib/reprint";
import { deleteConfirmText } from "@/lib/delete-confirm";
import { listStageChoice, stageBecomesReadyToShip, type ListPortalStatus } from "@/lib/load-stage";
import { formatEnteredBy } from "@/lib/entered-by";
import {
  LOAD_TAB_LABEL,
  attentionReasons,
  displayStatus,
  emptyListMessage,
  fileSummary,
  replaceListedOrder,
  visibleLoadTabs,
  type LoadTab,
  type LoadTabCounts,
} from "@/lib/load-list";
import { toast } from "@/lib/toast";
import {
  STATUS_LABEL,
  canAddLoads,
  canPrintBol,
  canSeeCarrierIdentity,
  canSeePricing,
  formatLoadNumber,
  type CustomerDocument,
  type CustomerOrder,
  type PortalRole,
  type ViewAsPreview,
} from "@/lib/types";

interface Me {
  role: PortalRole;
  permission?: "view" | "add" | "pricing" | "full" | null;
  profile?: "sales" | "loader" | null;
  viewAs?: ViewAsPreview | null;
  readOnly?: boolean;
}

interface ListResponse {
  orders: CustomerOrder[];
  total: number;
  page: number;
  pageSize: number;
  counts: LoadTabCounts;
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
  const searchParams = useSearchParams();
  const updatedOnly = searchParams.get("updated") === "1";
  const sites = useSites();
  const [tab, setTab] = useState<LoadTab>("active");
  const [listReady, setListReady] = useState(false);
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
  const [soWarning, setSoWarning] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmReady, setConfirmReady] = useState(false);
  const [pendingReadyId, setPendingReadyId] = useState<string | null>(null);
  const [stageBusyId, setStageBusyId] = useState<string | null>(null);
  const [stageError, setStageError] = useState<{ id: string; message: string } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const stageBusyRef = useRef(new Set<string>());
  const updatedRef = useRef(updatedOnly);

  useEffect(() => {
    if (updatedRef.current === updatedOnly) return;
    updatedRef.current = updatedOnly;
    setPage(1);
    setRows([]);
  }, [updatedOnly]);

  useEffect(() => {
    const handle = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(handle);
  }, [q]);

  useEffect(() => {
    fetch("/api/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: Me | null) => {
        setMe(body);
        const select = Boolean(body && body.role === "admin" && !body.readOnly);
        setTab((current) => (select ? "attention" : current === "attention" ? "active" : current));
        setListReady(true);
        const params = new URLSearchParams(window.location.search);
        const edit = params.get("edit");
        const copy = params.get("copy");
        if (edit && body && !body.readOnly && canAddLoads(body)) void openEdit(edit);
        else if (copy && body && !body.readOnly && canAddLoads(body)) void openCopy(copy);
      })
      .catch(() => {
        setMe(null);
        setTab("active");
        setListReady(true);
      });
  }, []);

  const role = me?.role ?? null;
  const readOnly = Boolean(me?.readOnly);
  const showPricing = canSeePricing(me);
  const allowLoads = canAddLoads(me);
  const showCarrier = canSeeCarrierIdentity(me);
  const allowPrint = canPrintBol(me);
  const selectView = role === "admin" && !readOnly;
  const canChangeStage = allowLoads && !readOnly;

  useEffect(() => {
    if (!allowLoads || readOnly) setCreating(false);
  }, [allowLoads, readOnly]);

  useEffect(() => {
    if (!role || role === "admin") return;
    if (window.localStorage.getItem("emit-tips-v1") === "1") return;
    setShowTips(true);
  }, [role]);

  const replaceOrder = useCallback((next: CustomerOrder) => {
    setRows((current) => replaceListedOrder(current, next));
    setEditing((current) => (current?.id === next.id ? next : current));
  }, []);

  useEffect(() => {
    if (!creating && !editing) return;
    document.documentElement.classList.add("dialog-open");
    return () => document.documentElement.classList.remove("dialog-open");
  }, [creating, editing]);

  useEffect(() => {
    if (!listReady) return;
    const params = new URLSearchParams();
    params.set("tab", tab);
    if (status) params.set("status", status);
    if (query.trim()) params.set("q", query.trim());
    if (shipFrom) params.set("shipFrom", shipFrom);
    if (shipTo) params.set("shipTo", shipTo);
    if (pickup) params.set("pickup", pickup);
    if (receiver) params.set("receiver", receiver);
    if (updatedOnly) params.set("updated", "1");
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
          const incoming = new Map(body.orders.map((order) => [order.id, order]));
          const merged = current.map((order) => incoming.get(order.id) ?? order);
          const seen = new Set(merged.map((order) => order.id));
          return [...merged, ...body.orders.filter((order) => !seen.has(order.id))];
        });
        setError("");
      })
      .catch(() => setError("We couldn't load your loads. Refresh the page and try again."));
  }, [listReady, tab, status, query, shipFrom, shipTo, pickup, receiver, page, reload, updatedOnly]);

  useEffect(() => {
    let armed = false;
    const arm = window.setTimeout(() => {
      armed = true;
    }, 500);
    function refreshIfShown() {
      if (!armed || document.visibilityState === "hidden") return;
      setReload((value) => value + 1);
    }
    window.addEventListener("focus", refreshIfShown);
    window.addEventListener("pageshow", refreshIfShown);
    document.addEventListener("visibilitychange", refreshIfShown);
    return () => {
      window.clearTimeout(arm);
      window.removeEventListener("focus", refreshIfShown);
      window.removeEventListener("pageshow", refreshIfShown);
      document.removeEventListener("visibilitychange", refreshIfShown);
    };
  }, []);

  async function openCopy(id: string) {
    const response = await fetch(`/api/orders/${id}/copy-draft`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(typeof body.error === "string" ? body.error : "Could not copy that load");
      return;
    }
    setDraft(draftFromCopy(body.draft));
    setEditing(null);
    setSubmitted(null);
    setFormError("");
    setSoWarning("");
    setCreating(true);
  }

  async function openEdit(id: string) {
    const response = await fetch(`/api/orders/${id}`);
    if (!response.ok) return;
    const body = await response.json();
    setEditing(body.order);
    replaceOrder(body.order);
    setDraft(draftFromOrder(body.order));
    setSubmitted(null);
    setFormError("");
    setSoWarning("");
    setCreating(false);
  }

  async function removeOrder(id: string) {
    setDeletingId(id);
    setError("");
    try {
      const response = await fetch(`/api/admin/orders/${id}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.error === "string" ? body.error : "Could not delete that order");
        return;
      }
      setConfirmDeleteId(null);
      setRows((current) => current.filter((order) => order.id !== id));
      setEditing((current) => (current?.id === id ? null : current));
      setPage(1);
      setReload((value) => value + 1);
      toast("Deleted.");
    } catch {
      setError("Could not delete that order");
    } finally {
      setDeletingId(null);
    }
  }

  function clearStagePrompt(id: string) {
    setPendingReadyId((current) => (current === id ? null : current));
  }

  function pickListStage(order: CustomerOrder, next: ListPortalStatus) {
    const choice = listStageChoice(order.portalStatus, next);
    if (choice === "noop") {
      clearStagePrompt(order.id);
      return;
    }
    if (choice === "confirm") {
      setPendingReadyId(order.id);
      setStageError((current) => (current?.id === order.id ? null : current));
      return;
    }
    clearStagePrompt(order.id);
    void changeListStage(order, next);
  }

  async function changeListStage(order: CustomerOrder, next: ListPortalStatus) {
    if (!canChangeStage || stageBusyRef.current.has(order.id)) return;
    stageBusyRef.current.add(order.id);
    setStageBusyId(order.id);
    setStageError((current) => (current?.id === order.id ? null : current));
    try {
      const response = await fetch(`/api/orders/${order.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ portalStatus: next }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStageError({
          id: order.id,
          message: typeof body.error === "string" ? body.error : "Could not change the stage",
        });
        return;
      }
      const updated = body.order as CustomerOrder;
      replaceOrder({
        ...updated,
        carrierBadge: updated.carrierBadge ?? order.carrierBadge,
        trackingBadge: updated.trackingBadge ?? order.trackingBadge,
      });
      clearStagePrompt(order.id);
      toast("Stage saved.");
    } catch {
      setStageError({ id: order.id, message: "Could not change the stage" });
    } finally {
      stageBusyRef.current.delete(order.id);
      setStageBusyId((current) => (current === order.id ? null : current));
    }
  }

  async function save(forceReady = false) {
    if (readOnly) {
      setFormError("View-as is read-only. Switch back to Select view to change anything.");
      return;
    }
    if (!draft.stops.some((stop) => stop.kind === "pickup") || !draft.stops.some((stop) => stop.kind === "drop")) {
      setConfirmReady(false);
      setFormError("Add at least one pickup and one drop.");
      return;
    }
    if (draft.stops.some((stop) => stop.duplicateOf && !stop.saveAsNew)) {
      setConfirmReady(false);
      setFormError("This looks like a duplicate. Use the existing location, or save it as new.");
      return;
    }
    const soErrors = draftSalesOrderErrors(draft);
    if (soErrors.length) {
      setFormError(soErrors[0]);
      return;
    }
    if (stageBecomesReadyToShip(editing?.portalStatus, draft.portalStatus) && !forceReady) {
      setConfirmReady(true);
      setFormError("");
      return;
    }
    setConfirmReady(false);
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
      const warningText = Array.isArray(body.warnings)
        ? body.warnings
            .map((item: { message?: string }) => (typeof item.message === "string" ? item.message : ""))
            .filter(Boolean)
            .join(" ")
        : "";
      setSoWarning(warningText);
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
      toast(warningText || (editing ? "Load saved." : "Load submitted. Select will add the load number."));
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

  const counts: LoadTabCounts = data?.counts ?? { active: 0, delivered: 0, history: 0 };

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
          <p className="lede">
            {selectView
              ? "What needs a look, what is moving, and what already delivered."
              : "What is moving, and what already delivered."}
          </p>
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
          <p>Search finds a load in any list. Click a card to open it.</p>
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
      {listReady ? (
        <div className="tabs" role="tablist" aria-label="Load lists">
          {visibleLoadTabs(selectView).map((item) => (
            <button
              key={item}
              className={tab === item ? "tab on" : "tab"}
              type="button"
              role="tab"
              aria-selected={tab === item}
              onClick={() => {
                setTab(item);
                setPage(1);
                if (updatedOnly) router.replace("/");
              }}
            >
              <strong>{counts[item] ?? 0}</strong>
              <span>{LOAD_TAB_LABEL[item]}</span>
            </button>
          ))}
        </div>
      ) : null}
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
      {updatedOnly ? (
        <p className="mini update-filter">
          Showing orders with a carrier update.{" "}
          <button className="text-btn" type="button" onClick={() => router.push("/")}>
            Show all loads
          </button>
        </p>
      ) : null}
      {data?.scope === "all" && query.trim() && !updatedOnly ? <p className="mini">Showing matches from every tab.</p> : null}
      {error && <p className="error">{error}</p>}
      <div className="board">
        {rows.map((order) => {
              const reasons = selectView && data ? attentionReasons(order, data.today) : [];
              const today = data?.today ?? "";
              return (
                <article
                  key={order.id}
                  className="load-row"
                  tabIndex={0}
                  aria-label={`Open ${order.salesOrderNumber}`}
                  onClick={(event) => {
                    const target = event.target as HTMLElement;
                    if (target.closest("a, button, select, input, label, option, .stage-menu, .confirm-box")) return;
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
                    <div className="load-row-status">
                      <PortalStatusControl
                        status={order.portalStatus}
                        salesOrderNumber={order.salesOrderNumber}
                        canChange={canChangeStage}
                        confirming={pendingReadyId === order.id && order.portalStatus !== "ready_to_ship"}
                        busy={stageBusyId === order.id}
                        error={stageError?.id === order.id ? stageError.message : ""}
                        onPick={(next) => pickListStage(order, next)}
                        onConfirm={() => void changeListStage(order, "ready_to_ship")}
                        onCancel={() => clearStagePrompt(order.id)}
                      />
                      {order.carrierBadge ? <CarrierBadge kind={order.carrierBadge} /> : null}
                      {order.trackingBadge ? (
                        <span className="carrier-badge" data-kind="tracking">
                          Tracking started
                        </span>
                      ) : null}
                      <StatusPill status={displayStatus(order, today, { needsAttention: selectView })} />
                    </div>
                  </div>
                  <ListStopNames order={order} />
                  <div className="load-meta">
                    <SoNumber>{order.salesOrderNumber}</SoNumber>
                    {" · Select load "}
                    {formatLoadNumber(order.loadNumber)}
                    {order.stops.length > 2 ? ` · ${order.stops.length} stops` : ""} · {fileSummary({ ...order, pendingReviewCount: 0 })}
                  </div>
                  <div className="load-meta">Entered by: {formatEnteredBy(order.enteredByName, order.enteredByEmail)}</div>
                  <BuildStatus status={order.buildStatus} />
                  {showCarrier ? <div className="load-meta">{carrierIdentityLabel(order)}</div> : null}
                  {order.bolPrint?.reprint ? (
                    <div className="reprint-banner" role="status">
                      {reprintMessage({
                        version: order.bolPrint.version,
                        reasons: order.bolPrint.reasons,
                        bolRemoved: order.bolPrint.bolRemoved,
                        printedCarrierName: order.bolPrint.carrierName,
                        printedCarrierMc: order.bolPrint.carrierMc,
                        currentCarrierName: order.carrierName ?? null,
                        currentCarrierMc: order.carrierMc ?? null,
                      })}
                    </div>
                  ) : null}
                  {selectView ? (
                    <div className="load-meta">
                      Owner: {order.owner ?? "Not set"}
                      {order.ownerNeedsCheck ? " · Needs a check" : ""}
                    </div>
                  ) : null}
                  {reasons.length > 0 && <div className="hold">{reasons.join(" · ")}</div>}
                  {selectView && (order.pendingReviewCount ?? 0) > 0 ? (
                    <div className="hold">{order.pendingReviewCount} in review</div>
                  ) : null}
                  {order.comments ? <Note text={order.comments} /> : null}
                  <div className="load-row-actions">
                    <TrackLink href={order.trackingLink} label="Track shipment" />
                    {showPricing && (
                      <span className="load-meta">
                        {order.customerCost == null ? "Cost not set" : order.customerCost.toLocaleString("en-US", { style: "currency", currency: "USD" })}
                      </span>
                    )}
                    {allowLoads && !readOnly ? (
                      <button className="btn secondary" type="button" onClick={() => void openCopy(order.id)}>
                        Copy load
                      </button>
                    ) : null}
                    {selectView && confirmDeleteId !== order.id ? (
                      <button className="btn danger" type="button" onClick={() => setConfirmDeleteId(order.id)}>
                        Delete
                      </button>
                    ) : null}
                  </div>
                  {selectView && confirmDeleteId === order.id ? (
                    <div className="confirm-box" onClick={(event) => event.stopPropagation()}>
                      <p>{deleteConfirmText(order.loadNumber)}</p>
                      <div className="actions">
                        <button
                          className="btn danger"
                          type="button"
                          disabled={deletingId === order.id}
                          onClick={() => void removeOrder(order.id)}
                        >
                          {deletingId === order.id ? "Deleting…" : "Delete"}
                        </button>
                        <button
                          className="btn secondary"
                          type="button"
                          disabled={deletingId === order.id}
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                </article>
        );
        })}
        {data && rows.length === 0 ? (
          <p className="empty">
            {updatedOnly
              ? "No carrier updates are waiting for you."
              : emptyListMessage(tab, Boolean(query.trim() || status || shipFrom || shipTo || pickup || receiver))}
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
                <h2 id="load-title">{editing ? "Edit load" : draft.copiedFromId ? "Copy load" : "New load"}</h2>
                <p className="sub">
                  {editing
                    ? "Update this load, then save."
                    : draft.copiedFromId
                      ? "Review the suggested sales orders, then save. Documents and cost are not copied."
                      : "Tell Select what you need moved."}
                </p>
              </div>
              <button className="icon-btn" type="button" aria-label="Close" title="Close" onClick={() => { setCreating(false); setEditing(null); }}>
                ✕
              </button>
            </div>
            {submitted && editing && submitted.id === editing.id && (
              <div className="confirm">
                <strong>Order submitted</strong>
                <div className="pair">
                  <span>
                    <SoNumber>{submitted.salesOrderNumber}</SoNumber>
                  </span>
                  <span>→</span>
                  <b>Select load {formatLoadNumber(submitted.loadNumber)}</b>
                </div>
                <p className="mini">
                  This screen is the confirmation. Submitting an order does not send email. The load number stays blank until Select adds it.
                </p>
              </div>
            )}
            {selectView && editing && (
              <>
                <BuildStatus status={editing.buildStatus} />
                <SelectLoadField
                  orderId={editing.id}
                  loadNumber={editing.loadNumber}
                  canCorrect
                  onUpdated={(order) => {
                    setEditing(order);
                    replaceOrder(order);
                    setSubmitted((current) => (current?.id === order.id ? order : current));
                  }}
                />
                <TrackingLinkField
                  orderId={editing.id}
                  trackingLink={editing.trackingLink}
                  onUpdated={(order) => {
                    setEditing(order);
                    replaceOrder(order);
                    setSubmitted((current) => (current?.id === order.id ? order : current));
                  }}
                />
              </>
            )}
            {formError && <p className="error">{formError}</p>}
            {soWarning && <p className="warn">{soWarning}</p>}
            <LoadForm draft={draft} setDraft={setDraft} order={editing} sites={sites} hideCommercial={!showPricing} readOnly={readOnly} />
            {confirmReady ? (
              <div className="confirm-box ready-confirm" role="status">
                <button className="btn" type="button" disabled={saving} onClick={() => void save(true)}>
                  {saving ? "Saving…" : "Save as Ready to Ship"}
                </button>
                <button className="btn secondary" type="button" onClick={() => setConfirmReady(false)}>
                  Go back
                </button>
              </div>
            ) : null}
            {editing && (
              <div className="grid-2">
                <div className="field">
                  <label>Attachments</label>
                  <label className="btn secondary file-btn">
                    Upload attachment
                    <input aria-label="Upload attachment" type="file" onChange={(event) => event.target.files?.[0] && upload("attachment", event.target.files[0])} />
                  </label>
                  <FileList docs={editing.documents.filter((doc) => doc.kind === "attachment")} />
                </div>
                <div className="field">
                  <label>BOL</label>
                  <label className="btn secondary file-btn">
                    Upload BOL
                    <input aria-label="Upload BOL" type="file" onChange={(event) => event.target.files?.[0] && upload("bol", event.target.files[0])} />
                  </label>
                  <FileList
                    docs={editing.documents.filter((doc) => doc.kind === "bol")}
                    order={editing}
                    canPrint={allowPrint && !readOnly}
                    onPrinted={replaceOrder}
                  />
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
              <button className="btn" type="button" disabled={saving || readOnly} onClick={() => void save()}>
                {saving ? "Saving…" : editing ? "Save changes" : "Submit order"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function FileList({
  docs,
  order,
  canPrint,
}: {
  docs: CustomerDocument[];
  order?: CustomerOrder;
  canPrint?: boolean;
  onPrinted?: (order: CustomerOrder) => void;
}) {
  if (!docs.length) return <div className="mini">None yet</div>;
  return (
    <div className="refs">
      {order?.bolPrint && docs.some((doc) => doc.kind === "bol") ? (
        <p className="mini">
          Printed v{order.bolPrint.version} · {formatWhenBoise(order.bolPrint.printedAt)} · {order.bolPrint.printedByName}
          {order.bolPrint.carrierName ? ` · Carrier ${order.bolPrint.carrierName}` : ""}
          {order.bolPrint.carrierMc ? ` (MC ${order.bolPrint.carrierMc})` : ""}
        </p>
      ) : null}
      {docs.map((doc) => (
        <div key={doc.id} className={doc.kind === "bol" && order?.bolPrint?.reprint ? "bol-reprint" : undefined}>
          <DocumentLinks doc={doc} />
        </div>
      ))}
      {canPrint && order && docs.some((doc) => doc.kind === "bol") ? (
        <a className="btn secondary" href={`/api/orders/${order.id}/bol/print`} target="_blank" rel="noopener noreferrer">
          Print BOL
        </a>
      ) : null}
      {docs.some((doc) => doc.kind === "bol") ? (
        <p className="mini">Print opens the uploaded BOL. View and Download are not recorded.</p>
      ) : null}
    </div>
  );
}
