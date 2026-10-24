"use client";

import { SIMPLE_STEPS, simpleStepIndex, tripCaption } from "@/lib/load-list";
import type { CustomerOrder, PortalStatus, PublicTracking, TrackingStage } from "@/lib/types";

export default function Timeline({
  order,
}: {
  order: { trackingStage: TrackingStage; portalStatus: PortalStatus } | Pick<CustomerOrder, "trackingStage" | "portalStatus"> | PublicTracking;
}) {
  const current = simpleStepIndex(order.trackingStage);
  const cancelled = order.portalStatus === "cancelled";
  return (
    <div>
      <div className="timeline" aria-label="Shipment progress">
        {SIMPLE_STEPS.map((label, index) => {
          const done = !cancelled && index <= current;
          const state = !cancelled && index === current ? "current" : done ? "done" : "";
          return (
            <div className={`step ${state}`} key={label}>
              {index > 0 && <div className="bar" />}
              <div className="dot" title={label} />
              <small>{label}</small>
            </div>
          );
        })}
      </div>
      <p className="mini">{tripCaption(order.trackingStage, cancelled)}</p>
    </div>
  );
}
