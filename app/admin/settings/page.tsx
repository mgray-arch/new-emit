"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/shell";
import type { Site } from "@/lib/types";

interface ReceiverRow {
  id: string;
  matchValue: string;
  company: string;
}

const blank = (): Site => ({
  id: "",
  company: "",
  address1: "",
  city: "",
  state: "",
  postalCode: "",
  country: "US",
  active: true,
  sortOrder: 0,
});

export default function SettingsPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [receivers, setReceivers] = useState<ReceiverRow[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch("/api/admin/sites")
      .then((response) => (response.ok ? response.json() : { sites: [] }))
      .then((body) => setSites(body.sites));
    fetch("/api/admin/receivers")
      .then((response) => (response.ok ? response.json() : { receivers: [] }))
      .then((body) => setReceivers(body.receivers));
  }, []);

  async function save() {
    const response = await fetch("/api/admin/sites", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sites: sites.map((site) => ({ ...site, id: site.id || undefined })),
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      setMessage(body.error || "Could not save sites");
      return;
    }
    setSites(body.sites);
    setMessage("Ship-from sites saved.");
  }

  return (
    <Shell>
      <main className="page">
        <h1>SHIP-FROM SITES</h1>
        <p className="lede">EMIT ships from more than one site. This list fills the origin fields on a new load.</p>
        {message && <p className="mini">{message}</p>}
        {sites.map((site, index) => (
          <div className="site-row" key={site.id || index}>
            <input aria-label="Company" value={site.company} onChange={(event) => update(index, { company: event.target.value })} placeholder="Company" />
            <input aria-label="Street" value={site.address1} onChange={(event) => update(index, { address1: event.target.value })} placeholder="Street" />
            <input aria-label="City" value={site.city} onChange={(event) => update(index, { city: event.target.value })} placeholder="City" />
            <input aria-label="State" value={site.state} maxLength={2} onChange={(event) => update(index, { state: event.target.value.toUpperCase() })} placeholder="ST" />
            <input aria-label="Postal code" value={site.postalCode} onChange={(event) => update(index, { postalCode: event.target.value })} placeholder="Postal" />
            <button className="btn danger" type="button" onClick={() => setSites(sites.filter((_, item) => item !== index))}>
              Remove
            </button>
          </div>
        ))}
        <div className="actions" style={{ justifyContent: "flex-start" }}>
          <button className="btn secondary" type="button" onClick={() => setSites([...sites, blank()])}>
            Add site
          </button>
          <button className="btn" type="button" onClick={save}>
            Save sites
          </button>
        </div>
        <h2 style={{ marginTop: 28 }}>RECEIVERS</h2>
        <p className="lede">
          A receiver signs in with Microsoft and sees only loads whose destination company matches. Use a full email or a domain such as enchantedrock.com. The company text must match the destination on the load.
        </p>
        {receivers.map((row, index) => (
          <div className="site-row" key={row.id || index}>
            <input
              aria-label="Receiver email or domain"
              value={row.matchValue}
              placeholder="email or domain"
              onChange={(event) =>
                setReceivers(receivers.map((item, itemIndex) => (itemIndex === index ? { ...item, matchValue: event.target.value } : item)))
              }
            />
            <input
              aria-label="Destination company"
              value={row.company}
              placeholder="Destination company"
              onChange={(event) =>
                setReceivers(receivers.map((item, itemIndex) => (itemIndex === index ? { ...item, company: event.target.value } : item)))
              }
            />
            <button className="btn danger" type="button" onClick={() => setReceivers(receivers.filter((_, itemIndex) => itemIndex !== index))}>
              Remove
            </button>
          </div>
        ))}
        <div className="actions" style={{ justifyContent: "flex-start" }}>
          <button className="btn secondary" type="button" onClick={() => setReceivers([...receivers, { id: "", matchValue: "", company: "" }])}>
            Add receiver
          </button>
          <button className="btn" type="button" onClick={saveReceivers}>
            Save receivers
          </button>
        </div>
      </main>
    </Shell>
  );

  async function saveReceivers() {
    const response = await fetch("/api/admin/receivers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receivers }),
    });
    const body = await response.json();
    if (!response.ok) {
      setMessage(body.error || "Could not save receivers");
      return;
    }
    setReceivers(body.receivers);
    setMessage("Receivers saved.");
  }

  function update(index: number, patch: Partial<Site>) {
    setSites(sites.map((site, item) => (item === index ? { ...site, ...patch } : site)));
  }
}
