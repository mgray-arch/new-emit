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

  useEffect(() => {
    setValue(trackingLink ?? "");
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
      onUpdated(body.order);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the tracking link");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="field">
      <label htmlFor={`tracking-link-${orderId}`}>Tracking link</label>
      <div className="inline-field">
        <input
          id={`tracking-link-${orderId}`}
          aria-label="Tracking link"
          value={value}
          placeholder="https://"
          onChange={(event) => setValue(event.target.value)}
        />
        <button className="btn" type="button" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save tracking link"}
        </button>
      </div>
      <p className="mini">Paste the public SAM or MacroPoint share link. EMIT and receivers see it as Track.</p>
      {error && <p className="error">{error}</p>}
      {saved && <p className="mini">{saved}</p>}
    </div>
  );
}
