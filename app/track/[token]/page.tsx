"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Timeline from "@/components/timeline";
import { formatDay, formatWhen } from "@/lib/dates";
import { STAGE_LABEL, STATUS_LABEL, type PublicTracking } from "@/lib/types";

export default function TrackPage() {
  const params = useParams<{ token: string }>();
  const [data, setData] = useState<PublicTracking | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!params.token) return;
    fetch(`/api/track/${params.token}`)
      .then(async (response) => {
        if (!response.ok) {
          setMissing(true);
          return;
        }
        setData(await response.json());
      })
      .catch(() => setMissing(true));
  }, [params.token]);

  return (
    <main className="public">
      <header>
        <img src="/brand/emit-logo.png" alt="EMIT" style={{ height: 36 }} />
        <div>
          <div className="brand-name">EMIT SHIPMENT TRACKING</div>
          <div className="brand-sub">Select Transport Partners</div>
        </div>
      </header>
      {missing && <p>This tracking link is not valid.</p>}
      {data && (
        <>
          <h1 style={{ letterSpacing: "0.04em", fontSize: 22 }}>
            {data.salesOrderNumber} · {data.loadNumber}
          </h1>
          <p className="lede">
            {STAGE_LABEL[data.trackingStage]} · {STATUS_LABEL[data.portalStatus]}
          </p>
          <Timeline order={data} />
          <ol className="stop-list">
            {(data.stops?.length ? data.stops : [{ kind: "pickup" as const, city: data.originCity, state: data.originState }, { kind: "drop" as const, city: data.destinationCity, state: data.destinationState }]).map(
              (stop, index) => (
                <li key={`${stop.kind}-${index}`}>
                  {stop.kind === "pickup" ? "Pickup" : "Drop"} · {stop.city}, {stop.state}
                </li>
              ),
            )}
          </ol>
          <p className="mini">Ship date {formatDay(data.shipDate)} · Must deliver {formatDay(data.mustDeliverDate)}</p>
          <p>Latest ETA: {data.latestEta ? formatWhen(data.latestEta) : "Not posted yet"}</p>
          {data.truckType && <p className="mini">{data.truckType}</p>}
        </>
      )}
    </main>
  );
}
