"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import PhotoGallery from "@/components/photo-gallery";
import Shell from "@/components/shell";
import Timeline from "@/components/timeline";
import { formatWhen } from "@/lib/dates";
import { STATUS_LABEL, formatPlace, type CustomerOrder, type OrderConfirmation } from "@/lib/types";

export default function OrderPage() {
  const params = useParams<{ id: string }>();
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [confirmation, setConfirmation] = useState<OrderConfirmation | null>(null);
  const [canUpload, setCanUpload] = useState(false);

  useEffect(() => {
    fetch("/api/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => setCanUpload(body?.role === "admin"))
      .catch(() => setCanUpload(false));
  }, []);

  useEffect(() => {
    if (!params.id) return;
    fetch(`/api/orders/${params.id}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!body) return;
        setOrder(body.order);
        setConfirmation(body.confirmation);
      });
  }, [params.id]);

  return (
    <Shell>
      <main className="page">
        {!order && <p className="mini">Loading shipment…</p>}
        {order && (
          <>
            <h1>{order.salesOrderNumber}</h1>
            <p className="lede">
              Select load {order.loadNumber} · {STATUS_LABEL[order.portalStatus]}
            </p>
            {confirmation && (
              <div className="confirm">
                <strong>Order confirmed</strong>
                <div className="pair">
                  <span>{confirmation.salesOrderNumber}</span>
                  <span>→</span>
                  <b>{confirmation.loadNumber}</b>
                </div>
                <pre className="email-preview">{confirmation.body}</pre>
              </div>
            )}
            <Timeline order={order} />
            <p>Latest ETA: {order.latestEta ? formatWhen(order.latestEta) : "Not posted yet"}</p>
            <a className="track-link" href={order.trackingUrl}>
              Public tracking link
            </a>
            <PhotoGallery orderId={order.id} loadNumber={order.loadNumber} canUpload={canUpload} />
            <ol className="stop-list">
              {order.stops.map((stop) => (
                <li key={stop.id}>
                  <strong>{stop.kind === "pickup" ? "Pickup" : "Drop"}</strong>
                  <div className="company">{stop.place.company}</div>
                  <div className="addr">{formatPlace(stop.place)}</div>
                </li>
              ))}
            </ol>
            <div className="grid-2" style={{ marginTop: 16 }}>
              <div>
                <div className="label">Origin</div>
                <div className="company">{order.origin.company}</div>
                <div className="addr">{formatPlace(order.origin)}</div>
              </div>
              <div>
                <div className="label">Destination</div>
                <div className="company">{order.destination.company}</div>
                <div className="addr">{formatPlace(order.destination)}</div>
              </div>
            </div>
            <p className="mini" style={{ marginTop: 16 }}>
              {order.truckType || "Truck type not set"} · {order.transit || "Transit not set"} · Created by {order.createdBy}
            </p>
            {order.pendingReviewCount > 0 && <p className="hold">{order.pendingReviewCount} page(s) held for Select review.</p>}
            <div className="refs">
              {order.documents.map((doc) => (
                <a key={doc.id} href={`/api/documents/${doc.id}`}>
                  {doc.kind === "bol" ? "BOL" : "File"} · {doc.filename}
                </a>
              ))}
            </div>
          </>
        )}
      </main>
    </Shell>
  );
}
