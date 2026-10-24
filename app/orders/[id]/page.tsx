"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import DocumentLinks from "@/components/document-links";
import PhotoGallery from "@/components/photo-gallery";
import SamBuildButton from "@/components/sam-build-button";
import SelectLoadField from "@/components/select-load-field";
import Shell from "@/components/shell";
import StatusPill from "@/components/status-pill";
import Timeline from "@/components/timeline";
import TrackLink from "@/components/track-link";
import TrackingLinkField from "@/components/tracking-link-field";
import { denverDate, formatDay, formatWhen } from "@/lib/dates";
import { formatEnteredBy } from "@/lib/entered-by";
import { displayStatus, fileSummary } from "@/lib/load-list";
import { toast } from "@/lib/toast";
import { canAddLoads, canSeePricing, formatLoadNumber, formatPlace, type CustomerOrder, type PortalRole } from "@/lib/types";

interface Me {
  role: PortalRole;
  permission?: "view" | "add" | "pricing" | "full" | null;
  readOnly?: boolean;
}

export default function OrderPage() {
  const params = useParams<{ id: string }>();
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [problem, setProblem] = useState("");

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
                  {order.stops.map((stop) => (
                    <li key={stop.id}>
                      <strong>{stop.kind === "pickup" ? "Pickup" : "Delivery"}</strong>
                      <div className="company">{stop.place.company}</div>
                      <div className="addr">{formatPlace(stop.place)}</div>
                    </li>
                  ))}
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
                  {order.documents.map((doc) => (
                    <DocumentLinks
                      key={doc.id}
                      doc={doc}
                      label={`${doc.kind === "bol" ? "BOL" : "File"} · ${doc.filename}`}
                    />
                  ))}
                </div>
              )}
              <PhotoGallery orderId={order.id} loadNumber={order.loadNumber} canUpload={canUpload} />
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
              {selectView ? (
                <p className="mini">Entered by: {formatEnteredBy(order.enteredByName, order.enteredByEmail)}</p>
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
