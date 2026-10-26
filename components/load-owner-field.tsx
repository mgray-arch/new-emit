"use client";

import { useState } from "react";
import type { CustomerOrder } from "@/lib/types";

export default function LoadOwnerField({
  orderId,
  owner,
  needsCheck,
  onUpdated,
}: {
  orderId: string;
  owner: "Drew" | "Ainsley" | null;
  needsCheck: boolean;
  onUpdated: (order: CustomerOrder) => void;
}) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function save(next: "Drew" | "Ainsley") {
    if (next === owner || pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/orders/${orderId}/owner`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: next }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not save the owner");
      onUpdated(body.order);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the owner");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="field">
      <label htmlFor={`owner-${orderId}`}>Owner</label>
      <select
        id={`owner-${orderId}`}
        aria-label="Load owner"
        value={owner ?? ""}
        disabled={pending}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "Drew" || next === "Ainsley") void save(next);
        }}
      >
        <option value="" disabled>
          Not set
        </option>
        <option value="Drew">Drew</option>
        <option value="Ainsley">Ainsley</option>
      </select>
      {needsCheck ? <p className="mini">Needs a check. Equipment or destination was missing when this load was created.</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
