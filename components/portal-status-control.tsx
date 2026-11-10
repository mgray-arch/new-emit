import { LIST_PORTAL_STATUSES, isListPortalStatus, type ListPortalStatus } from "@/lib/load-stage";
import { STATUS_LABEL, type PortalStatus } from "@/lib/types";

/** The portal stage on a load card. The tracking pill next to it stays a separate display. */
export default function PortalStatusControl({
  status,
  salesOrderNumber,
  canChange,
  confirming,
  busy,
  error,
  onPick,
  onConfirm,
  onCancel,
}: {
  status: PortalStatus;
  salesOrderNumber: string;
  canChange: boolean;
  confirming: boolean;
  busy: boolean;
  error?: string;
  onPick: (next: ListPortalStatus) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!canChange || !isListPortalStatus(status)) {
    return (
      <span className="stage-name" data-stage-control="portal" data-editable="false">
        {STATUS_LABEL[status]}
      </span>
    );
  }
  const shown: ListPortalStatus = confirming ? "ready_to_ship" : status;
  return (
    <div
      className="stage-menu"
      data-stage-control="portal"
      data-editable="true"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <select
        aria-label={`Stage for ${salesOrderNumber}`}
        value={shown}
        disabled={busy}
        onChange={(event) => {
          const next = event.target.value;
          if (isListPortalStatus(next)) onPick(next);
        }}
      >
        {LIST_PORTAL_STATUSES.map((value) => (
          <option key={value} value={value}>
            {STATUS_LABEL[value]}
          </option>
        ))}
      </select>
      {confirming ? (
        <div className="confirm-box ready-confirm" role="status">
          <button className="btn" type="button" disabled={busy} onClick={onConfirm}>
            {busy ? "Saving…" : "Save as Ready to Ship"}
          </button>
          <button className="btn secondary" type="button" disabled={busy} onClick={onCancel}>
            Go back
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
