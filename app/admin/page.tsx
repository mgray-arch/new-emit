"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/shell";
import type { ReviewItem } from "@/lib/types";

export default function ReviewPage() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [error, setError] = useState("");

  async function load() {
    const response = await fetch("/api/admin/review");
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
  }

  useEffect(() => {
    void load();
  }, []);

  async function decide(id: string, action: "approve" | "reject") {
    const response = await fetch(`/api/admin/review/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!response.ok) {
      const body = await response.json();
      setError(body.error || "Could not update that page");
      return;
    }
    await load();
  }

  return (
    <Shell>
      <main className="page">
        <h1>DOCUMENT REVIEW</h1>
        <p className="lede">
          Pages that look like rate confirmations, or that could not be read, stay here until a Select admin releases or keeps them.
          EMIT cannot see them.
        </p>
        {error && <p className="error">{error}</p>}
        <div className="review">
          {items.length === 0 && <p className="mini">Nothing is waiting.</p>}
          {items.map((item) => (
            <article key={item.id}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className={`badge ${item.screenResult}`}>{item.screenResult === "block" ? "Rate confirmation" : "Uncertain"}</span>
                <strong>
                  {item.salesOrderNumber || "Order"} · {item.loadNumber}
                </strong>
                <span className="mini">
                  {item.filename} · page {item.pageIndex} of {item.pageCount}
                </span>
              </div>
              <p>{item.screenReason}</p>
              {item.screenResult === "block" && (
                <p className="warn">Releasing this page makes it visible to EMIT. Keep it internal unless you are sure it is not a rate confirmation.</p>
              )}
              {item.textExcerpt && <pre className="excerpt">{item.textExcerpt}</pre>}
              <div className="actions">
                <a className="btn secondary" href={`/api/admin/review/${item.id}`}>
                  Download page
                </a>
                <button className="btn danger" type="button" onClick={() => decide(item.id, "reject")}>
                  Keep internal
                </button>
                <button className="btn" type="button" onClick={() => decide(item.id, "approve")}>
                  Release to EMIT
                </button>
              </div>
            </article>
          ))}
        </div>
      </main>
    </Shell>
  );
}
