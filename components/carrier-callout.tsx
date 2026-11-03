import CarrierBadge from "@/components/carrier-badge";
import { formatWhen } from "@/lib/dates";
import type { HaulCallout } from "@/lib/types";

/** The assigned company and MC. Highlighted on the load page. No pay. */
export default function CarrierCallout({
  haul,
  badge,
}: {
  haul: HaulCallout;
  badge?: "assigned" | "changed" | null;
}) {
  return (
    <section className="carrier-callout" data-kind={haul.kind} data-fresh={badge ? "true" : "false"} aria-label="Assigned carrier">
      {badge ? <CarrierBadge kind={badge} /> : null}
      <h2>Carrier</h2>
      <p className="carrier-name">{haul.company || "Name not provided"}</p>
      <p className="carrier-mc">MC {haul.mc || "not provided"}</p>
      <p className="mini">Updated {formatWhen(haul.at)}</p>
    </section>
  );
}
