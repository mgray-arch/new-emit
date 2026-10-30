"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import DocumentLinks from "@/components/document-links";
import LoadOwnerField from "@/components/load-owner-field";
import PhotoGallery from "@/components/photo-gallery";
import SamBuildButton from "@/components/sam-build-button";
import SelectLoadField from "@/components/select-load-field";
import Shell from "@/components/shell";
import StatusPill from "@/components/status-pill";
import Timeline from "@/components/timeline";
import TrackLink from "@/components/track-link";
import TrackingLinkField from "@/components/tracking-link-field";
import { carrierIdentityLabel } from "@/lib/carrier";
import { denverDate, formatDay, formatWhen, formatWhenBoise } from "@/lib/dates";
import { formatStopSchedule } from "@/lib/stop-schedule";
import { formatEnteredBy } from "@/lib/entered-by";
import { displayStatus, fileSummary } from "@/lib/load-list";
import { reprintMessage } from "@/lib/reprint";
import { salesOrdersForStop } from "@/lib/sales-orders";
import { toast } from "@/lib/toast";
import {
  canAddLoads,
  canPrintBol,
  canSeeCarrierIdentity,
  canSeePricing,
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
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [problem, setProblem] = useState("");
  const [printing, setPrinting] = useState<string | null>(null);
  const [printError, setPrintError] = useState("");
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
  const allowPhotos = canUploadPhotos(me) && !readOnly;

  async function printBol(documentId: string) {
    if (!order) return;
    setPrinting(documentId);
    setPrintError("");
    try {
      const response = await fetch(`/api/orders/${order.id}/bol/print`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not record that print");
      window.open(body.documentUrl || `/api/documents/${documentId}`, "_blank", "noopener");
      const refreshed = await fetch(`/api/orders/${order.id}`);
      if (refreshed.ok) setOrder((await refreshed.json()).order);
    } catch (err) {
      setPrintError(err instanceof Error ? err.message : "Could not record that print");
    } finally {
      setPrinting(null);
    }
  }

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
    fetch(`/api/orders/${params.id}`)
      .then(async (response) => {
        if (response.status === 404) {
          setProblem("We couldn't find that load. It may have been removed, or the link is wrong.");
          return null;
        }
        if (!response.ok) {
          setProblem("We couldn't open this load. Refresh the page and try again.");
          return null;
        }
        return response.json();
      })
      .then((body) => {
        if (!body) return;
        setOrder(body.order);
        setCarrierDraft({
          carrierName: body.order.carrierName ?? "",
          carrierMc: body.order.carrierMc ?? "",
          driverName: body.order.driverName ?? "",
        });
        setProblem("");
      })
      .catch(() => setProblem("We couldn't open this load. Refresh the page and try again."));
  }, [params.id]);

  const today = denverDate(new Date());

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
              {order.salesOrderNumber} · Select load {formatLoadNumber(order.loadNumber)}
            </p>
            {showCarrier ? <p className="load-meta">{carrierIdentityLabel(order)}</p> : null}
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
              <p className="mini">Select has not entered the load number yet. This page is the confirmation. No email is sent.</p>
            )}
            <div className="load-row-actions">
              {selectView ? (
                <SamBuildButton
                  order={order}
                  onUpdated={(next) => {
                    setOrder(next);
                  }}
                />
              ) : null}
              <TrackLink href={order.trackingLink} />
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
            </div>

            <section className="detail-section">
              <h2>Progress</h2>
              <Timeline order={order} />
              <p className="mini">Latest ETA: {order.latestEta ? formatWhen(order.latestEta) : "Not posted yet"}</p>
            </section>

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
                          <div className="mini">SO: {salesOrdersForStop(order.salesOrders, stop.id).join(", ")}</div>
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
                <p className="empty">No documents yet. Add a BOL or another file from Edit load.</p>
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
                  {printError ? <p className="error">{printError}</p> : null}
                  {order.documents.map((doc) => (
                    <div key={doc.id} className={doc.kind === "bol" && order.bolPrint?.reprint ? "bol-reprint" : undefined}>
                      <DocumentLinks doc={doc} label={`${doc.kind === "bol" ? "BOL" : "File"} · ${doc.filename}`} />
                      {allowPrint && doc.kind === "bol" ? (
                        <button className="btn secondary" type="button" disabled={printing === doc.id} onClick={() => void printBol(doc.id)}>
                          {printing === doc.id ? "Printing…" : "Print BOL"}
                        </button>
                      ) : null}
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
              {allowDocs ? (
                <div className="grid-2">
                  <div className="field">
                    <label htmlFor="detail-bol">Upload BOL</label>
                    <input id="detail-bol" type="file" onChange={(event) => event.target.files?.[0] && void uploadFile("bol", event.target.files[0])} />
                  </div>
                  <div className="field">
                    <label htmlFor="detail-file">Upload another file</label>
                    <input id="detail-file" type="file" onChange={(event) => event.target.files?.[0] && void uploadFile("attachment", event.target.files[0])} />
                  </div>
                </div>
              ) : null}
              <PhotoGallery orderId={order.id} loadNumber={order.loadNumber} canUpload={allowPhotos} />
            </section>

            <section className="detail-section">
              <h2>Tracking</h2>
              {canUpload && (
                <>
                  <SelectLoadField
                    orderId={order.id}
                    loadNumber={order.loadNumber}
                    onUpdated={(next) => {
                      setOrder(next);
                      toast("Select load number saved.");
                    }}
                  />
                  <TrackingLinkField
                    orderId={order.id}
                    trackingLink={order.trackingLink}
                    onUpdated={(next) => {
                      setOrder(next);
                      toast("Tracking link saved.");
                    }}
                  />
                </>
              )}
              {order.trackingLink ? (
                <p className="mini">Live tracking is the Track button above.</p>
              ) : (
                <p className="empty">No live tracking link yet. Select adds one when the truck is on the way.</p>
              )}
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
                <p>
                  {order.customerCost == null
                    ? "Not set yet."
                    : order.customerCost.toLocaleString("en-US", { style: "currency", currency: "USD" })}
                  {order.rateReason ? ` · ${order.rateReason}` : ""}
                </p>
              </section>
            )}
          </>
        )}
      </main>
    </Shell>
  );
}
