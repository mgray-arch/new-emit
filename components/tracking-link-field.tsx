"use client";

import { useEffect, useState } from "react";
import type { CustomerOrder } from "@/lib/types";

export default function TrackingLinkField({
  orderId,
  trackingLink,
  onUpdated,
}: {
  orderId: string;
  trackingLink: string | null;
  onUpdated: (order: CustomerOrder) => void;
}) {
  const [value, setValue] = useState(trackingLink ?? "");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const stored = trackingLink?.trim() ?? "";

  useEffect(() => {
    setValue(trackingLink ?? "");
    setEditing(false);
  }, [trackingLink, orderId]);

  async function save() {
    setPending(true);
    setError("");
    setSaved("");
    try {
      const response = await fetch(`/api/admin/orders/${orderId}/tracking-link`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trackingLink: value }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not save the tracking link");
      setSaved(body.order.trackingLink ? "Saved the tracking link." : "Cleared the tracking link.");
      setEditing(false);
      onUpdated(body.order);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the tracking link");
    } finally {
      setPending(false);
    }
  }

  if (!editing && stored) {
    return (
      <div className="sam-status" data-sam="link">
        <div className="sam-copy">
          <span className="k">Tracking link</span>
          <a className="sam-link" href={stored}>
            {stored}
          </a>
          {saved && <p className="mini">{saved}</p>}
        </div>
        <button className="text-link" type="button" onClick={() => { setError(""); setSaved(""); setEditing(true); }}>
          Change
        </button>
      </div>
    );
  }

  if (!editing) {
    return (
      <div>
        <p className="empty">No live tracking link yet. Select adds one when the truck is on the way.</p>
        <button className="text-link" type="button" onClick={() => setEditing(true)}>
          Add tracking link
        </button>
      </div>
    );
  }

  return (
    <div className="field sam-edit">
      <label htmlFor={`tracking-link-${orderId}`}>Tracking link</label>
      <div className="inline-field">
        <input
          id={`tracking-link-${orderId}`}
          aria-label="Tracking link"
          value={value}
          placeholder="https://"
          onChange={(event) => setValue(event.target.value)}
        />
        <button className="btn secondary" type="button" onClick={save} disabled={pending}>
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
      <p className="mini">Public SAM or MacroPoint link. EMIT and receivers see it as Track.</p>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
