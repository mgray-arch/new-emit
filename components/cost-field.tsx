"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { parseCustomerCost } from "@/lib/cost";
import type { CustomerOrder } from "@/lib/types";

function draftFrom(cost: number | null | undefined): string {
  if (cost == null) return "";
  return cost.toFixed(2);
}

export function formatCustomerCost(cost: number | null | undefined): string {
  if (cost == null) return "Cost not set";
  return cost.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Blank saves as not set. Same check and route as the load page and the list card. */
export async function requestCostSave(orderId: string, raw: string): Promise<CustomerOrder> {
  const parsed = parseCustomerCost(raw);
  if ("error" in parsed) throw new Error(parsed.error);
  const response = await fetch(`/api/orders/${orderId}/cost`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ customerCost: raw.trim() === "" ? null : raw.trim() }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.order) {
    throw new Error(typeof body.error === "string" ? body.error : "Could not save the cost");
  }
  return body.order as CustomerOrder;
}

/** Inline EMIT cost on the load page. Blank saves as not set. Enter saves. */
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
  const pendingRef = useRef(false);

  useEffect(() => {
    setValue(draftFrom(customerCost));
  }, [customerCost, orderId]);

  async function save() {
    if (pendingRef.current) return;
    const parsed = parseCustomerCost(value);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError("");
    try {
      onUpdated(await requestCostSave(orderId, value));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the cost");
    } finally {
      pendingRef.current = false;
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
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void save();
          }}
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

/** Cost on a loads-list card. Click the amount, type, then Enter or Save. Stays on the list. */
export function ListCostEditor({
  orderId,
  customerCost,
  onUpdated,
}: {
  orderId: string;
  customerCost: number | null | undefined;
  onUpdated: (order: CustomerOrder) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function open(event: MouseEvent) {
    event.stopPropagation();
    setValue(draftFrom(customerCost));
    setError("");
    setEditing(true);
  }

  async function save() {
    if (pendingRef.current) return;
    const parsed = parseCustomerCost(value);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError("");
    try {
      onUpdated(await requestCostSave(orderId, value));
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the cost");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  if (!editing) {
    return (
      <button className="text-link cost-edit" type="button" aria-label="Edit EMIT cost" onClick={open}>
        {formatCustomerCost(customerCost)}
      </button>
    );
  }

  return (
    <div
      className="list-cost"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="inline-field">
        <input
          ref={inputRef}
          aria-label="EMIT cost"
          inputMode="decimal"
          placeholder="1500.00"
          value={value}
          disabled={pending}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              void save();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
            }
          }}
        />
        <button className="btn compact" type="button" disabled={pending} onClick={() => void save()}>
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
