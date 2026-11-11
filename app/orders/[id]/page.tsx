"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import CostField from "@/components/cost-field";
import DeleteLoadButton from "@/components/delete-load";
import CarrierCallout from "@/components/carrier-callout";
import DocumentLinks from "@/components/document-links";
import LoadOwnerField from "@/components/load-owner-field";
import PhotoGallery from "@/components/photo-gallery";
import BuildStatus from "@/components/build-status";
import OrderHistory from "@/components/order-history";
import StageField from "@/components/stage-field";
import TrackingCallout from "@/components/tracking-callout";
import SelectLoadField from "@/components/select-load-field";
import Shell from "@/components/shell";
import SoNumber from "@/components/so-number";
import StatusPill from "@/components/status-pill";
import Timeline from "@/components/timeline";
import TrackLink from "@/components/track-link";
import TrackingLinkField from "@/components/tracking-link-field";
import { denverDate, formatDay, formatWhen, formatWhenBoise } from "@/lib/dates";
import { formatStopSchedule } from "@/lib/stop-schedule";
import { formatEnteredBy } from "@/lib/entered-by";
import { displayStatus, fileSummary } from "@/lib/load-list";
import { reprintMessage } from "@/lib/reprint";
import { salesOrdersForStop } from "@/lib/sales-orders";
import { toast } from "@/lib/toast";
import {
  canAddLoads,
  canDeleteLoad,
  canPrintBol,
  canSeeCarrierIdentity,
  canSeePricing,
  canUploadBol,
  canUploadDocs,
  canUploadPhotos,
  formatLoadNumber,
  formatPlace,
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
  chatEnabled?: boolean;
}

export default function OrderPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [problem, setProblem] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [carrierDraft, setCarrierDraft] = useState({ carrierName: "", carrierMc: "", driverName: "" });
  const [carrierError, setCarrierError] = useState("");

  useEffect(() => {
    fetch("/api/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => setMe(body))
      .catch(() => setMe(null));
  }, []);

  const role = me?.role ?? null;
  const readOnly = Boolean(me?.readOnly);
  const selectView = role === "admin" && !readOnly;
  const canUpload = selectView;
  const showPricing = canSeePricing(me);
  const allowLoads = canAddLoads(me);
  const showCarrier = canSeeCarrierIdentity(me);
  const allowPrint = canPrintBol(me) && !readOnly;
  const allowDocs = canUploadDocs(me) && !readOnly;
  const allowBol = canUploadBol(me) && !readOnly;
  const allowPhotos = canUploadPhotos(me) && !readOnly;
  const canDelete = canDeleteLoad(me) && !readOnly;

  async function uploadFile(slot: "attachment" | "bol", file: File) {
    if (!order) return;
    const form = new FormData();
    form.set("file", file);
    form.set("slot", slot);
    const response = await fetch(`/api/orders/${order.id}/documents`, { method: "POST", body: form });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setProblem(typeof body.error === "string" ? body.error : "Could not upload that file");
      return;
    }
    if (body.order) setOrder(body.order);
  }

  async function saveCarrier() {
    if (!order) return;
    setCarrierError("");
    const response = await fetch(`/api/admin/orders/${order.id}/carrier`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        carrierName: carrierDraft.carrierName,
        carrierMc: carrierDraft.carrierMc,
        driverName: carrierDraft.driverName,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setCarrierError(typeof body.error === "string" ? body.error : "Could not save the carrier");
      return;
    }
    setOrder(body.order);
    toast("Carrier saved.");
  }

  useEffect(() => {
    if (!params.id) return;
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/orders/${params.id}`);
        if (cancelled) return;
        if (response.status === 404) {
          setProblem("We couldn't find that load. It may have been removed, or the link is wrong.");
          return;
        }
        if (!response.ok) {
          setProblem("We couldn't open this load. Refresh the page and try again.");
          return;
        }
        const body = await response.json();
        if (cancelled) return;
        setOrder(body.order);
        setCarrierDraft({
          carrierName: body.order.carrierName ?? "",
          carrierMc: body.order.carrierMc ?? "",
          driverName: body.order.driverName ?? "",
        });
        setProblem("");
      } catch {
        if (!cancelled) setProblem("We couldn't open this load. Refresh the page and try again.");
      }
    }
    void load();
    let armed = false;
    const arm = window.setTimeout(() => {
      armed = true;
    }, 500);
    function refreshIfShown() {
      if (!armed || document.visibilityState === "hidden") return;
      void load();
    }
    window.addEventListener("focus", refreshIfShown);
    window.addEventListener("pageshow", refreshIfShown);
    document.addEventListener("visibilitychange", refreshIfShown);
    return () => {
      cancelled = true;
      window.clearTimeout(arm);
      window.removeEventListener("focus", refreshIfShown);
      window.removeEventListener("pageshow", refreshIfShown);
      document.removeEventListener("visibilitychange", refreshIfShown);
    };
  }, [params.id]);

  const today = denverDate(new Date());
  const bolAttached = Boolean(order?.documents.some((doc) => doc.kind === "bol"));
  const trackingStarted = order?.trackingEvents?.at(-1);

  return (
    <Shell>
      <main className="page">
        <p>
          <Link href="/" className="text-link">
            Back to loads
          </Link>
        </p>
        {problem && <p className="empty">{problem}</p>}
        {!order && !problem && <p className="mini">Loading this load…</p>}
        {order && (
          <>
            <div className="load-row-top">
              <h1 className="lane">
                {order.origin.city}, {order.origin.state} → {order.destination.city}, {order.destination.state}
              </h1>
              <StatusPill status={displayStatus(order, today, { needsAttention: selectView })} />
            </div>
            <p className="lede">
              <SoNumber>{order.salesOrderNumber}</SoNumber>
              {" · Select load "}
              {formatLoadNumber(order.loadNumber)}
            </p>
            <StageField order={order} canEdit={allowLoads && !readOnly} />
            <BuildStatus status={order.buildStatus} />
            {showCarrier ? <CarrierCallout order={order} badge={order.carrierBadge} /> : null}
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
            {order.trackingLink && trackingStarted ? (
              <TrackingCallout at={trackingStarted.at} href={order.trackingLink} fresh={Boolean(order.trackingBadge)} />
            ) : null}
            {me?.chatEnabled ? (
              <p>
                <Link href={`/messages?load=${order.id}`} className="text-link">
                  Message about this load
                </Link>
              </p>
            ) : null}
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
            {!order.loadNumber && (
              <p className="mini">The load number is not stored yet. This page is the confirmation. Submitting an order does not send email.</p>
            )}
            <div className="load-row-actions">
              <TrackLink href={order.trackingLink} label="Track shipment" />
              {allowPrint && bolAttached ? (
                <a className="btn secondary" href={`/api/orders/${order.id}/bol/print`} target="_blank" rel="noopener noreferrer">
                  Print
                </a>
              ) : allowPrint ? (
                <button className="btn secondary" type="button" disabled>
                  BOL not uploaded yet
                </button>
              ) : null}
              {order.bolPrintCount ? <p className="mini">BOL printed {order.bolPrintCount === 1 ? "1 time" : `${order.bolPrintCount} times`}.</p> : null}
              {allowLoads ? (
                readOnly ? (
                  <button className="btn secondary" type="button" disabled title="Read-only preview">
                    Edit load
                  </button>
                ) : (
                  <Link className="btn secondary" href={`/?edit=${order.id}`}>
                    Edit load
                  </Link>
                )
              ) : null}
              {allowLoads && !readOnly ? (
                <Link className="btn secondary" href={`/?copy=${order.id}`}>
                  Copy load
                </Link>
              ) : null}
              {canDelete ? (
                <DeleteLoadButton
                  orderId={order.id}
                  salesOrderNumber={order.salesOrderNumber}
                  loadNumber={order.loadNumber}
                  onDeleted={() => {
                    toast("Deleted.");
                    router.push("/");
                  }}
                />
              ) : null}
            </div>

            <section className="detail-section">
              <h2>Progress</h2>
              <Timeline order={order} />
              <p className="mini">Latest ETA: {order.latestEta ? formatWhen(order.latestEta) : "Not posted yet"}</p>
            </section>

            <OrderHistory notices={order.notices} stages={order.stageEvents} tracking={order.trackingEvents} audit={order.auditEvents} />

            <section className="detail-section">
              <h2>Stops</h2>
              {order.stops.length === 0 ? (
                <p className="empty">No stops on this load yet.</p>
              ) : (
                <ol className="stop-list">
                  {order.stops.map((stop) => {
                    const schedule = formatStopSchedule(stop.schedule);
                    return (
                      <li key={stop.id}>
                        <strong>{stop.kind === "pickup" ? "Pickup" : "Delivery"}</strong>
                        <div className="company">{stop.place.company}</div>
                        <div className="addr">{formatPlace(stop.place)}</div>
                        {schedule ? <div className="mini">{schedule}</div> : null}
                        {stop.kind === "drop" && salesOrdersForStop(order.salesOrders, stop.id).length ? (
                          <div className="mini">
                            <SoNumber>SO: {salesOrdersForStop(order.salesOrders, stop.id).join(", ")}</SoNumber>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            <section className="detail-section">
              <h2>Documents and photos</h2>
              <p className="mini">
                {fileSummary({ ...order, pendingReviewCount: selectView ? order.pendingReviewCount : 0 })}
              </p>
              {selectView && (order.pendingReviewCount ?? 0) > 0 && <p className="hold">{order.pendingReviewCount} in review</p>}
              {order.documents.length === 0 ? (
                <p className="empty">
                  {allowBol || allowDocs ? "No documents yet." : "No documents yet. Add a BOL or another file from Edit load."}
                </p>
              ) : (
                <div className="refs">
                  {order.bolPrint ? (
                    <p className="mini">
                      Printed v{order.bolPrint.version} · {formatWhenBoise(order.bolPrint.printedAt)} · {order.bolPrint.printedByName}
                      {order.bolPrint.carrierName ? ` · Carrier ${order.bolPrint.carrierName}` : ""}
                      {order.bolPrint.carrierMc ? ` (MC ${order.bolPrint.carrierMc})` : ""}
                      {order.bolPrint.bolRemoved ? " · BOL removed" : ""}
                    </p>
                  ) : null}
                  {order.documents.map((doc) => (
                    <div key={doc.id} className={doc.kind === "bol" && order.bolPrint?.reprint ? "bol-reprint" : undefined}>
                      <DocumentLinks doc={doc} label={`${doc.kind === "bol" ? "BOL" : "File"} · ${doc.filename}`} />
                    </div>
                  ))}
                  {order.documents.some((doc) => doc.kind === "bol") ? (
                    <p className="mini">Print BOL records the version. View, Download, and the browser print dialog are not recorded.</p>
                  ) : null}
                  {(order.bolPrints?.length ?? 0) > 0 ? (
                    <div>
                      <button className="btn secondary" type="button" onClick={() => setHistoryOpen((open) => !open)}>
                        {historyOpen ? "Hide print history" : "Print history"}
                      </button>
                      {historyOpen ? (
                        <ul className="mini">
                          {order.bolPrints?.map((print) => (
                            <li key={print.version}>
                              v{print.version} · {formatWhenBoise(print.printedAt)} · {print.printedByName}
                              {print.carrierName ? ` · ${print.carrierName}` : ""}
                              {print.carrierMc ? ` MC ${print.carrierMc}` : ""}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}
              {allowBol || allowDocs ? (
                <div className="grid-2">
                  {allowBol ? (
                    <div className="field">
                      <label className="btn file-btn" htmlFor="detail-bol">
                        Upload BOL
                        <input
                          id="detail-bol"
                          aria-label="Upload BOL"
                          type="file"
                          onChange={(event) => event.target.files?.[0] && void uploadFile("bol", event.target.files[0])}
                        />
                      </label>
                      <p className="mini">The bill of lading. This fills the load number, the carrier company, and the MC.</p>
                    </div>
                  ) : null}
                  {allowDocs ? (
                    <div className="field">
                      <label className="btn secondary file-btn" htmlFor="detail-file">
                        Other file
                        <input
                          id="detail-file"
                          aria-label="Upload other file"
                          type="file"
                          onChange={(event) => event.target.files?.[0] && void uploadFile("attachment", event.target.files[0])}
                        />
                      </label>
                      <p className="mini">A POD or other paperwork. A bill of lading goes in Upload BOL. A file that is a bill of lading is still filed as the BOL.</p>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <PhotoGallery
                orderId={order.id}
                loadNumber={order.loadNumber}
                canUpload={allowPhotos}
                onOrder={(next) => {
                  setOrder(next);
                  setCarrierDraft({
                    carrierName: next.carrierName ?? "",
                    carrierMc: next.carrierMc ?? "",
                    driverName: next.driverName ?? "",
                  });
                }}
              />
            </section>

            <section className="detail-section">
              <h2>Tracking</h2>
              <SelectLoadField
                orderId={order.id}
                loadNumber={order.loadNumber}
                canCorrect={canUpload}
                trackingStage={order.trackingStage}
                carrierAssigned={Boolean(order.carrierName?.trim() || order.carrierMc?.trim())}
                cancelled={order.portalStatus === "cancelled"}
                trackingLink={order.trackingLink}
                onUpdated={(next) => {
                  setOrder(next);
                  toast("Select load number saved.");
                }}
              />
              {canUpload ? (
                <TrackingLinkField
                  orderId={order.id}
                  trackingLink={order.trackingLink}
                  onUpdated={(next) => {
                    setOrder(next);
                    toast("Tracking link saved.");
                  }}
                />
              ) : order.trackingLink ? (
                <p className="mini">Live tracking is the Track button above.</p>
              ) : null}
              {canUpload && order.trackingLink ? <p className="mini">Live tracking is the Track button above.</p> : null}
              <p>
                <a className="track-link" href={order.trackingUrl} title="Shareable status page">
                  Shareable status page
                </a>
              </p>
              <p className="mini">
                {order.truckType || "Truck type not set"} · {order.transit || "Transit not set"} · Created by {order.createdBy}
              </p>
              <p className="mini">Entered by: {formatEnteredBy(order.enteredByName, order.enteredByEmail)}</p>
              {selectView ? (
                <div className="field">
                  <label>Driver, carrier, and MC</label>
                  <div className="grid-2">
                    <input aria-label="Driver name" placeholder="Driver name" value={carrierDraft.driverName} onChange={(event) => setCarrierDraft({ ...carrierDraft, driverName: event.target.value })} />
                    <input aria-label="Carrier company" placeholder="Carrier company" value={carrierDraft.carrierName} onChange={(event) => setCarrierDraft({ ...carrierDraft, carrierName: event.target.value })} />
                    <input aria-label="MC number" placeholder="MC number" value={carrierDraft.carrierMc} onChange={(event) => setCarrierDraft({ ...carrierDraft, carrierMc: event.target.value })} />
                  </div>
                  {carrierError ? <p className="error">{carrierError}</p> : null}
                  <button className="btn secondary" type="button" onClick={() => void saveCarrier()}>
                    Save carrier
                  </button>
                </div>
              ) : null}
              {selectView ? (
                <LoadOwnerField
                  orderId={order.id}
                  owner={order.owner ?? null}
                  needsCheck={order.ownerNeedsCheck === true}
                  onUpdated={(next) => {
                    setOrder(next);
                    toast("Owner saved.");
                  }}
                />
              ) : null}
            </section>

            <section className="detail-section">
              <h2>Notes</h2>
              {order.comments ? <p className="note">{order.comments}</p> : <p className="empty">No notes on this load.</p>}
            </section>

            {showPricing && (
              <section className="detail-section">
                <h2>EMIT cost</h2>
                {readOnly ? (
                  <p>
                    {order.customerCost == null
                      ? "Not set yet."
                      : order.customerCost.toLocaleString("en-US", { style: "currency", currency: "USD" })}
                    {order.rateReason ? ` · ${order.rateReason}` : ""}
                  </p>
                ) : (
                  <>
                    <CostField
                      orderId={order.id}
                      customerCost={order.customerCost ?? null}
                      onUpdated={(next) => {
                        setOrder(next);
                        toast("Cost saved.");
                      }}
                    />
                    {order.rateReason ? <p className="mini">{order.rateReason}</p> : null}
                  </>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </Shell>
  );
}
