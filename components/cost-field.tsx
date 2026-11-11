"use client";

import { useEffect, useState } from "react";
import { parseCustomerCost } from "@/lib/cost";
import type { CustomerOrder } from "@/lib/types";

function draftFrom(cost: number | null | undefined): string {
  if (cost == null) return "";
  return cost.toFixed(2);
}

/** Inline EMIT cost on the load page. Blank saves as not set. */
export default function CostField({
  orderId,
  customerCost,
  onUpdated,
}: {
  orderId: string;
  customerCost: number | null | undefined;
  onUpdated: (order: CustomerOrder) => void;
}) {
  const [value, setValue] = useState(() => draftFrom(customerCost));
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setValue(draftFrom(customerCost));
  }, [customerCost, orderId]);

  async function save() {
    const parsed = parseCustomerCost(value);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/orders/${orderId}/cost`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerCost: value.trim() === "" ? null : value.trim() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.error === "string" ? body.error : "Could not save the cost");
        return;
      }
      onUpdated(body.order);
    } catch {
      setError("Could not save the cost");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="field">
      <label htmlFor={`emit-cost-${orderId}`}>Cost</label>
      <div className="inline-field">
        <input
          id={`emit-cost-${orderId}`}
          aria-label="EMIT cost"
          inputMode="decimal"
          placeholder="1500.00"
          value={value}
          disabled={pending}
          onChange={(event) => setValue(event.target.value)}
        />
        <button className="btn" type="button" disabled={pending} onClick={() => void save()}>
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="mini">What EMIT pays Select for this load.</p>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
