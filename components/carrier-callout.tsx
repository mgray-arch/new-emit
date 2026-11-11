import CarrierBadge from "@/components/carrier-badge";
import CarrierBox from "@/components/carrier-box";
import { formatWhen } from "@/lib/dates";
import type { CustomerOrder } from "@/lib/types";

/** The same carrier box as the load list, plus the unseen badge and the last update time. No pay. */
export default function CarrierCallout({
  order,
  badge,
}: {
  order: Pick<CustomerOrder, "carrierName" | "carrierMc" | "driverName" | "notices" | "bolPrint" | "haulCallout">;
  badge?: "assigned" | "changed" | null;
}) {
  return (
    <section className="carrier-panel" aria-label="Assigned carrier">
      {badge ? <CarrierBadge kind={badge} /> : null}
      <CarrierBox order={order} />
      {order.haulCallout?.at ? <p className="mini">Updated {formatWhen(order.haulCallout.at)}</p> : null}
    </section>
  );
}
