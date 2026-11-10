import { formatDay } from "@/lib/dates";
import { listEndpointNames } from "@/lib/load-list";

/** Pickup and delivery names on a loads-list card. First pickup and final delivery only. */
export default function ListStopNames({
  order,
}: {
  order: {
    origin: { company?: string | null };
    destination: { company?: string | null };
    stops?: Array<{ kind: string; place?: { company?: string | null } | null }> | null;
    shipDate: string | null;
    shipTime: string | null;
    mustDeliverDate: string | null;
  };
}) {
  const names = listEndpointNames(order);
  const extra =
    names.extraStops > 0 ? `+${names.extraStops} ${names.extraStops === 1 ? "stop" : "stops"}` : "";
  return (
    <div className="date-grid">
      <div className="date-pair">
        <span className="k">Pickup</span>
        {names.pickup ? (
          <span className="place-name" title={names.pickup}>
            {names.pickup}
          </span>
        ) : null}
        <span>{order.shipDate ? `${formatDay(order.shipDate)}${order.shipTime ? `, ${order.shipTime}` : ""}` : "Not set"}</span>
      </div>
      <div className="date-pair">
        <span className="k">Delivery</span>
        {names.delivery ? (
          <span className="place-name" title={names.delivery}>
            {names.delivery}
          </span>
        ) : null}
        <span>{order.mustDeliverDate ? formatDay(order.mustDeliverDate) : "Not set"}</span>
        {extra ? <span className="place-extra">{extra}</span> : null}
      </div>
    </div>
  );
}
