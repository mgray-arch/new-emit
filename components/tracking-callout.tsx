import TrackLink from "@/components/track-link";
import { formatWhen } from "@/lib/dates";

/** Customer tracking has started. The link is the public share page. No pay. */
export default function TrackingCallout({
  at,
  href,
  fresh,
}: {
  at: string;
  href: string;
  fresh?: boolean;
}) {
  return (
    <section className="carrier-callout tracking-callout" data-fresh={fresh ? "true" : "false"} aria-label="Tracking started">
      {fresh ? <span className="carrier-badge" data-kind="tracking">Tracking started</span> : null}
      <h2>Tracking started</h2>
      <p className="mini">Updated {formatWhen(at)}</p>
      <TrackLink href={href} label="Track shipment" />
    </section>
  );
}
