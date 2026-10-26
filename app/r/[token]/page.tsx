import { notFound } from "next/navigation";
import { BrandLogo } from "@/components/brand-logo";
import Timeline from "@/components/timeline";
import TrackLink from "@/components/track-link";
import { formatDay, formatWhen } from "@/lib/dates";
import { readyPortal } from "@/lib/portal";
import { receiverPortal } from "@/lib/receivers";
import { STAGE_LABEL, STATUS_LABEL, formatLoadNumber } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ReceiverLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = await receiverPortal(await readyPortal(), token);
  if (!body) notFound();

  return (
    <main className="public">
      <header>
        <BrandLogo />
        <div>
          <div className="brand-name">YOUR DELIVERIES</div>
          <div className="brand-sub">{body.company}</div>
        </div>
      </header>
      {body.loads.length === 0 && <p>No deliveries are posted for {body.company} yet.</p>}
      {body.loads.map((load) => (
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
                  <img src={`/api/r/${token}/photos/${photo.id}`} alt={photo.filename} />
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
