"use client";

import { useEffect, useState } from "react";
import type { CustomerOrder } from "@/lib/types";

export default function SelectLoadField({
  orderId,
  loadNumber,
  canCorrect = false,
  onUpdated,
}: {
  orderId: string;
  loadNumber: string | null;
  /** Select staff only. EMIT never gets a way to type a SAM number. */
  canCorrect?: boolean;
  onUpdated: (order: CustomerOrder) => void;
}) {
  const [value, setValue] = useState(loadNumber ?? "");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const stored = loadNumber?.trim() ?? "";

  useEffect(() => {
    setValue(loadNumber ?? "");
    setEditing(false);
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
      setSaved(body.order.loadNumber ? `Saved Select load ${body.order.loadNumber}.` : "Cleared. This load is pending again.");
      setEditing(false);
      onUpdated(body.order);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the Select load number");
    } finally {
      setPending(false);
    }
  }

  if (!canCorrect || !editing) {
    return (
      <div className="sam-status" data-sam={stored ? "built" : "pending"} role="status">
        <div className="sam-copy">
          <span className="k">{stored ? "Built in SAM" : "Waiting for SAM build"}</span>
          <strong className="sam-number">{stored || "Pending"}</strong>
        </div>
        {canCorrect ? (
          <button className="text-link" type="button" onClick={() => { setError(""); setSaved(""); setEditing(true); }}>
            Correct
          </button>
        ) : null}
        {saved && <p className="mini">{saved}</p>}
      </div>
    );
  }

  return (
    <div className="field sam-edit">
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
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      <button
        className="text-link"
        type="button"
        onClick={() => {
          setValue(stored);
          setError("");
          setEditing(false);
        }}
      >
        Cancel
      </button>
      <p className="mini">Replaces the number stored from SAM.</p>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
