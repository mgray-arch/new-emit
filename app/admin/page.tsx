"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/shell";
import SoNumber from "@/components/so-number";
import { formatWhen } from "@/lib/dates";
import { formatLoadNumber, type ReviewItem } from "@/lib/types";

interface DeletedLoad {
  id: string;
  salesOrderNumber: string;
  loadNumber: string | null;
  deletedAt: string;
  deletedBy: string;
}

export default function ReviewPage() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [deleted, setDeleted] = useState<DeletedLoad[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function load() {
    const [response, removed] = await Promise.all([fetch("/api/admin/review"), fetch("/api/admin/deleted")]);
    if (response.status === 403) {
      setError("Select staff only.");
      return;
    }
    if (!response.ok) {
      setError("Could not load the review queue.");
      return;
    }
    const body = await response.json();
    setItems(body.items);
    if (removed.ok) {
      const deletedBody = await removed.json();
      setDeleted(Array.isArray(deletedBody.loads) ? deletedBody.loads : []);
    }
  }

  async function restore(id: string) {
    const response = await fetch(`/api/admin/orders/${id}/restore`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(typeof body.error === "string" ? body.error : "Could not restore that load");
      return;
    }
    setNotice("Restored.");
    await load();
  }

  useEffect(() => {
    void load();
  }, []);

  async function decide(id: string, action: "approve" | "delete") {
    const response = await fetch(`/api/admin/review/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error || "Could not update that file");
      return;
    }
    setError("");
    if (action === "approve") {
      setNotice(`Released to EMIT by ${body.reviewedBy} at ${body.reviewedAt}.`);
    } else {
      setNotice("Deleted.");
    }
    await load();
  }

  return (
    <Shell>
      <main className="page">
        <h1>QUARANTINE</h1>
        <p className="lede">
          Uploads that look like rate confirmations, or that OCR could not read, stay here. EMIT cannot see them.
          A rate confirmation cannot be released. An unclear file can be approved after you look at it, or deleted.
        </p>
        {notice && <p className="mini">{notice}</p>}
        {error && <p className="error">{error}</p>}
        <div className="review">
          {items.length === 0 && <p className="mini">Nothing is waiting.</p>}
          {items.map((item) => (
            <article key={item.id}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className={`badge ${item.screenResult}`}>{item.screenResult === "block" ? "Rate confirmation" : "Uncertain"}</span>
                <strong>
                  {item.salesOrderNumber ? <SoNumber>{item.salesOrderNumber}</SoNumber> : "Order"}
                  {" · "}
                  {item.loadNumber ?? "Pending"}
                </strong>
                <span className="mini">
                  {item.source === "photo" ? "Photo" : `Page ${item.pageIndex} of ${item.pageCount}`} · {item.filename}
                </span>
              </div>
              <p>{item.screenReason}</p>
              {item.screenResult === "block" ? (
                <p className="warn">This matches a rate confirmation. It cannot be released to EMIT.</p>
              ) : (
                <p className="mini">OCR could not confirm this is safe. Approving it shows it to EMIT.</p>
              )}
              {item.textExcerpt && <pre className="excerpt">{item.textExcerpt}</pre>}
              <div className="actions">
                <a className="btn secondary" href={`/api/admin/review/${item.id}`}>
                  Download
                </a>
                {item.screenResult === "uncertain" && (
                  <button className="btn" type="button" onClick={() => decide(item.id, "approve")}>
                    Approve for EMIT
                  </button>
                )}
                <button className="btn danger" type="button" onClick={() => decide(item.id, "delete")}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
        <h2>Deleted loads</h2>
        <p className="lede">Removed from the lists. Restoring puts a load back. Nothing outside the portal is changed.</p>
        {deleted.length === 0 ? <p className="mini">No deleted loads.</p> : null}
        <div className="review">
          {deleted.map((load) => (
            <article key={load.id}>
              <strong>
                <SoNumber>{load.salesOrderNumber}</SoNumber>
                {" · Select load "}
                {formatLoadNumber(load.loadNumber)}
              </strong>
              <p className="mini">
                Deleted {formatWhen(load.deletedAt)} by {load.deletedBy}
              </p>
              <button className="btn secondary" type="button" onClick={() => void restore(load.id)}>
                Restore
              </button>
            </article>
          ))}
        </div>
      </main>
    </Shell>
  );
}
