"use client";

import { useEffect, useState } from "react";
import type { CustomerOrder } from "@/lib/types";

export default function SelectLoadField({
  orderId,
  loadNumber,
  onUpdated,
}: {
  orderId: string;
  loadNumber: string | null;
  onUpdated: (order: CustomerOrder) => void;
}) {
  const [value, setValue] = useState(loadNumber ?? "");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setValue(loadNumber ?? "");
  }, [loadNumber, orderId]);

  async function save() {
    setPending(true);
    setError("");
    setSaved("");
    try {
      const response = await fetch(`/api/admin/orders/${orderId}/load-number`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loadNumber: value }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not save the Select load number");
      setSaved(body.order.loadNumber ? `Saved Select load ${body.order.loadNumber}.` : "Cleared. EMIT sees this load as pending.");
      onUpdated(body.order);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the Select load number");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="field">
      <label htmlFor={`select-load-${orderId}`}>Select load number</label>
      <div className="inline-field">
        <input
          id={`select-load-${orderId}`}
          aria-label="Select load number"
          value={value}
          placeholder="458934-1"
          onChange={(event) => setValue(event.target.value)}
        />
        <button className="btn" type="button" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save load number"}
        </button>
      </div>
      <p className="mini">
        Enter the load number from SAM after the order is built there. Leave it blank until then. EMIT sees Pending, not a made-up number.
      </p>
      {error && <p className="error">{error}</p>}
      {saved && <p className="mini">{saved}</p>}
    </div>
  );
}
