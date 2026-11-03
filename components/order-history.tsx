import { formatWhen } from "@/lib/dates";
import type { OrderNotice } from "@/lib/types";

/** Sent carrier notices. There is no edit control. */
export default function OrderHistory({ notices }: { notices?: OrderNotice[] | null }) {
  const rows = notices ?? [];
  return (
    <section className="detail-section" aria-label="Order history">
      <h2>History</h2>
      {rows.length === 0 ? (
        <p className="empty">No carrier notices yet.</p>
      ) : (
        <ul className="notice-log">
          {rows.map((notice) => (
            <li key={`${notice.at}-${notice.kind}-${notice.text}`}>
              <span className="mini">{formatWhen(notice.at)}</span>
              <p>{notice.text}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
