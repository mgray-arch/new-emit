"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BrandLogo } from "@/components/brand-logo";
import Timeline from "@/components/timeline";
import TrackLink from "@/components/track-link";
import { formatDay, formatWhen } from "@/lib/dates";
import { STAGE_LABEL, STATUS_LABEL, formatLoadNumber, type PortalStatus, type TimelineEvent, type TrackingStage } from "@/lib/types";

interface ReceiverPhoto {
  id: string;
  filename: string;
  receivedAt: string;
}

interface ReceiverLoad {
  id: string;
  salesOrderNumber: string;
  loadNumber: string | null;
  portalStatus: PortalStatus;
  trackingStage: TrackingStage;
  timeline: TimelineEvent[];
  stops: Array<{ kind: "pickup" | "drop"; company: string; city: string; state: string }>;
  shipDate: string | null;
  mustDeliverDate: string | null;
  latestEta: string | null;
  truckType: string | null;
  trackingUrl: string;
  trackingLink: string | null;
  photos: ReceiverPhoto[];
}

export default function ReceiverLinkPage() {
  const params = useParams<{ token: string }>();
  const [company, setCompany] = useState("");
  const [loads, setLoads] = useState<ReceiverLoad[]>([]);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!params.token) return;
    fetch(`/api/r/${params.token}`)
      .then(async (response) => {
        if (!response.ok) {
          setMissing(true);
          return;
        }
        const body = await response.json();
        setCompany(body.company);
        setLoads(body.loads);
      })
      .catch(() => setMissing(true));
  }, [params.token]);

  return (
    <main className="public">
      <header>
        <BrandLogo />
        <div>
          <div className="brand-name">YOUR DELIVERIES</div>
          <div className="brand-sub">{company || "Select Transport Partners"}</div>
        </div>
      </header>
      {missing && <p>This link is not valid.</p>}
      {!missing && loads.length === 0 && company && <p>No deliveries are posted for {company} yet.</p>}
      {loads.map((load) => (
        <article className="receiver-card" key={load.id}>
          <h2>
            {load.salesOrderNumber} · Select load {formatLoadNumber(load.loadNumber)}
          </h2>
          <p className="lede">
            {STAGE_LABEL[load.trackingStage]} · {STATUS_LABEL[load.portalStatus]}
          </p>
          <Timeline order={load} />
          <ol className="stop-list">
            {load.stops.map((stop, index) => (
              <li key={`${stop.kind}-${index}`}>
                {stop.kind === "pickup" ? "Pickup" : "Drop"} · {stop.company} · {stop.city}, {stop.state}
              </li>
            ))}
          </ol>
          <p className="mini">
            Ship {formatDay(load.shipDate)} · Must deliver {formatDay(load.mustDeliverDate)}
            {load.truckType ? ` · ${load.truckType}` : ""}
          </p>
          <p>Latest ETA: {load.latestEta ? formatWhen(load.latestEta) : "Not posted yet"}</p>
          <TrackLink href={load.trackingLink} />
          {load.trackingUrl && (
            <p>
              <a href={load.trackingUrl}>Portal status</a>
            </p>
          )}
          {load.photos.length > 0 && (
            <div className="photo-grid">
              {load.photos.map((photo) => (
                <figure className="photo-card" key={photo.id}>
                  <img src={`/api/r/${params.token}/photos/${photo.id}`} alt={photo.filename} />
                  <figcaption>{photo.filename}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </article>
      ))}
    </main>
  );
}
