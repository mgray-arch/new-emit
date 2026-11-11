import { carrierBoxState, previousCarrierLine, type CarrierBoxOrder } from "@/lib/carrier-box";

/**
 * Carrier company and MC in one box.
 * Green once a carrier is assigned, red after a carrier change that has not been
 * printed, and neutral when nobody is assigned. Pay is not a field here.
 */
export default function CarrierBox({
  order,
  showDriver = true,
}: {
  order: CarrierBoxOrder & { driverName?: string | null };
  showDriver?: boolean;
}) {
  const state = carrierBoxState(order);
  const was = previousCarrierLine(state);
  const driver = order.driverName?.trim() || "—";
  return (
    <div className="carrier-box-block">
      <div className="carrier-box" data-tone={state.tone}>
        {state.tone === "changed" ? <p className="carrier-box-flag">Carrier changed</p> : null}
        {state.tone === "none" ? (
          <p className="carrier-box-name">No carrier yet</p>
        ) : (
          <>
            <p className="carrier-box-name">{state.name || "Name not provided"}</p>
            <p className="carrier-box-mc">{state.mc ? `MC ${state.mc}` : "MC not provided"}</p>
          </>
        )}
        {was ? <p className="carrier-box-was">{was}</p> : null}
      </div>
      {showDriver ? <p className="load-meta">Driver: {driver}</p> : null}
    </div>
  );
}
