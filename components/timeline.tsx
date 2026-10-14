"use client";

import { STAGE_LABEL, TRACKING_STAGES, type CustomerOrder, type PublicTracking } from "@/lib/types";

export default function Timeline({ order }: { order: Pick<CustomerOrder, "trackingStage" | "portalStatus"> | PublicTracking }) {
  const current = TRACKING_STAGES.indexOf(order.trackingStage);
  return (
    <div className="timeline" aria-label="Shipment status">
      {TRACKING_STAGES.map((stage, index) => {
        const done = order.portalStatus !== "cancelled" && index <= current;
        const state = index === current ? "current" : done ? "done" : "";
        return (
          <div className={`step ${state}`} key={stage}>
            {index > 0 && <div className="bar" />}
            <div className="dot" />
            <small>{STAGE_LABEL[stage]}</small>
          </div>
        );
      })}
    </div>
  );
}
