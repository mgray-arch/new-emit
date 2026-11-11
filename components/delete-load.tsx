"use client";

import { useState } from "react";
import { deleteConfirmText } from "@/lib/delete-confirm";

/** Asks for an explicit confirm, then soft-deletes the load. The caller decides where to go next. */
export default function DeleteLoadButton({
  orderId,
  salesOrderNumber,
  loadNumber,
  onDeleted,
}: {
  orderId: string;
  salesOrderNumber: string;
  loadNumber: string | null;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/orders/${orderId}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.error === "string" ? body.error : "Could not delete that load");
        setBusy(false);
        return;
      }
      onDeleted();
    } catch {
      setError("Could not delete that load");
      setBusy(false);
    }
  }

  return (
    <div
      className="delete-load"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {open ? (
        <div className="confirm-box" role="dialog" aria-label="Confirm delete">
          <p>{deleteConfirmText({ salesOrderNumber, loadNumber })}</p>
          {error ? <p className="error">{error}</p> : null}
          <div className="actions">
            <button className="btn danger" type="button" disabled={busy} onClick={() => void confirm()}>
              {busy ? "Deleting…" : "Delete"}
            </button>
            <button className="btn secondary" type="button" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="btn danger" type="button" onClick={() => setOpen(true)}>
          Delete
        </button>
      )}
    </div>
  );
}
