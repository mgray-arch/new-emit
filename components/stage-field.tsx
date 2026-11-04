"use client";

import { PORTAL_STATUSES, STATUS_LABEL, type CustomerOrder, type PortalStatus } from "@/lib/types";

/** Being Prepared, Ready to Ship, Shipped, or Cancelled. View only can see the name. */
export default function StageField({
  order,
  canChange,
  busy,
  onChange,
}: {
  order: CustomerOrder;
  canChange: boolean;
  busy?: boolean;
  onChange: (status: PortalStatus) => void;
}) {
  return (
    <label className="field stage-field">
      <span>Stage</span>
      {canChange ? (
        <select
          aria-label="Stage"
          value={order.portalStatus}
          disabled={busy}
          onChange={(event) => onChange(event.target.value as PortalStatus)}
        >
          {PORTAL_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABEL[status]}
            </option>
          ))}
        </select>
      ) : (
        <strong>{STATUS_LABEL[order.portalStatus]}</strong>
      )}
    </label>
  );
}
