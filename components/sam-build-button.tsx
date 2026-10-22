"use client";

import { useEffect, useState } from "react";
import type { CustomerOrder } from "@/lib/types";

export default function SamBuildButton({
  order,
  onUpdated,
}: {
  order: CustomerOrder;
  onUpdated: (order: CustomerOrder) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (order.samBuildStatus !== "building") return;
    const timer = window.setInterval(() => {
      fetch(`/api/orders/${order.id}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((body) => {
          if (body?.order) onUpdated(body.order);
        })
        .catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [order.id, order.samBuildStatus, onUpdated]);

  async function build() {
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/orders/${order.id}/build`, {
        method: "POST",
      });
      const body = await response.json();
      if (body.order) onUpdated(body.order);
      if (!response.ok) setError(body.order?.samBuildError || body.error || "SAM did not accept this load.");
    } catch {
      setError("SAM did not accept this load. Try again.");
    } finally {
      setPending(false);
    }
  }

  if (order.loadNumber) {
    const label = `SAM ${order.loadNumber}`;
    const link = order.samUrl ? (
      <a className="btn secondary" href={order.samUrl} target="_blank" rel="noreferrer">
        {label}
      </a>
    ) : (
      <button className="btn secondary" type="button" disabled title="The SAM link is not configured on this site yet.">
        {label}
      </button>
    );
    return (
      <span className="sam-build" data-sam-state="built">
        <span className="sam-state">Built</span>
        {link}
      </span>
    );
  }

  const started = order.samBuildAt ? Date.parse(order.samBuildAt) : NaN;
  const stale = order.samBuildStatus === "building" && Number.isFinite(started) && Date.now() - started > 2 * 60 * 1000;
  const building = pending || (order.samBuildStatus === "building" && !stale);
  const failed = !building && (order.samBuildStatus === "failed" || Boolean(error));
  const state = building ? "building" : failed ? "failed" : "not-built";
  const stateLabel = building ? "Building" : failed ? "Failed" : "Not built";
  return (
    <span className="sam-build" data-sam-state={state}>
      <span className="sam-state">{stateLabel}</span>
      <button className="btn" type="button" onClick={build} disabled={building}>
        {building ? "Building in SAM…" : failed ? "Try build again" : "Build load in SAM"}
      </button>
      {(error || order.samBuildError) && !building ? <span className="error">{error || order.samBuildError}</span> : null}
    </span>
  );
}
