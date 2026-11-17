import type { PortalStatus } from "@/lib/types";

/** Mark Delivered, or move a delivered load back to In Transit. Select and EMIT admins only. */
export default function DeliveredActions({
  status,
  busy,
  onMark,
  onUndo,
}: {
  status: PortalStatus;
  busy?: boolean;
  onMark: () => void;
  onUndo: () => void;
}) {
  const delivered = status === "delivered";
  const inTransit = status === "in_transit";
  if (!delivered && !inTransit) return null;
  return (
    <button
      className="stage-action"
      type="button"
      disabled={busy}
      onClick={(event) => {
        event.stopPropagation();
        if (delivered) onUndo();
        else onMark();
      }}
    >
      {busy ? "Saving…" : delivered ? "Back to In Transit" : "Mark Delivered"}
    </button>
  );
}
