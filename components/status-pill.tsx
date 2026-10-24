import { DISPLAY_STATUS_LABEL, type DisplayStatus } from "@/lib/load-list";

export default function StatusPill({ status }: { status: DisplayStatus }) {
  const label = DISPLAY_STATUS_LABEL[status];
  return (
    <span className={`pill status-${status}`} title={label}>
      {label}
    </span>
  );
}
