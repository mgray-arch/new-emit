import { formatWhen } from "@/lib/dates";
import type { OrderNotice } from "@/lib/types";

/** Carrier updates on this load. There is no edit control and no pay. */
export default function OrderHistory({ notices }: { notices?: OrderNotice[] | null }) {
  const rows = notices ?? [];
  return (
    <section className="detail-section" aria-label="Order history">
      <h2>History</h2>
      {rows.length === 0 ? (
        <p className="empty">No carrier updates yet.</p>
      ) : (
        <ul className="notice-log">
          {rows.map((notice) => (
            <li key={`${notice.at}-${notice.kind}-${notice.text}`} data-notice={notice.kind}>
              <time className="mini" dateTime={notice.at}>
                {formatWhen(notice.at)}
              </time>
              <p>{notice.text}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
