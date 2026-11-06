import { carrierBadgeLabel, type CarrierBadge as CarrierBadgeKind } from "@/lib/carrier-seen";

/** Colored label for a carrier update this person has not opened. */
export default function CarrierBadge({ kind }: { kind: CarrierBadgeKind }) {
  return (
    <span className="carrier-badge" data-kind={kind}>
      {carrierBadgeLabel(kind)}
    </span>
  );
}
