import { formatWhen } from "@/lib/dates";
import type { AuditEvent, OrderNotice, StageEvent, TrackingEvent } from "@/lib/types";

interface HistoryRow {
  at: string;
  kind: string;
  text: string;
}

/** Stage changes and carrier updates. There is no edit control and no pay. */
export default function OrderHistory({
  notices,
  stages,
  tracking,
  audit,
}: {
  notices?: OrderNotice[] | null;
  stages?: StageEvent[] | null;
  tracking?: TrackingEvent[] | null;
  audit?: AuditEvent[] | null;
}) {
  const rows: HistoryRow[] = [
    ...(stages ?? []).map((event) => ({ at: event.at, kind: "stage", text: event.text })),
    ...(notices ?? []).map((notice) => ({ at: notice.at, kind: notice.kind, text: notice.text })),
    ...(tracking ?? []).map((event) => ({ at: event.at, kind: "tracking", text: event.text })),
    ...(audit ?? []).map((event) => ({ at: event.at, kind: event.kind, text: event.text })),
  ].sort((left, right) => left.at.localeCompare(right.at) || left.text.localeCompare(right.text));
  return (
    <section className="detail-section" aria-label="Order history">
      <h2>History</h2>
      {rows.length === 0 ? (
        <p className="empty">No history yet.</p>
      ) : (
        <ul className="notice-log">
          {rows.map((row) => (
            <li key={`${row.at}-${row.kind}-${row.text}`} data-notice={row.kind}>
              <time className="mini" dateTime={row.at}>
                {formatWhen(row.at)}
              </time>
              <p>{row.text}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
