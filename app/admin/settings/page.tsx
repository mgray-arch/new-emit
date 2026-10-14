"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/shell";
import type { Site } from "@/lib/types";

interface ReceiverRow {
  id: string;
  company: string;
  contactEmails: string[];
  enabled: boolean;
  token: string;
  url: string;
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

function emailsText(emails: string[]): string {
  return emails.join(", ");
}

function parseEmails(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export default function SettingsPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [receivers, setReceivers] = useState<ReceiverRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { company: string; emails: string }>>({});
  const [company, setCompany] = useState("");
  const [emails, setEmails] = useState("");
  const [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/sites")
      .then((response) => (response.ok ? response.json() : { sites: [] }))
      .then((body) => setSites(body.sites));
    void loadReceivers();
  }, []);

  async function loadReceivers() {
    const response = await fetch("/api/admin/receivers");
    if (!response.ok) return;
    const body = await response.json();
    const rows = body.receivers as ReceiverRow[];
    setReceivers(rows);
    setDrafts(
      Object.fromEntries(rows.map((row) => [row.id, { company: row.company, emails: emailsText(row.contactEmails) }])),
    );
  }

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

  async function addReceiver() {
    const response = await fetch("/api/admin/receivers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company, contactEmails: parseEmails(emails) }),
    });
    const body = await response.json();
    if (!response.ok) {
      setMessage(body.error || "Could not add that receiver");
      return;
    }
    setCompany("");
    setEmails("");
    setMessage(`Private link created for ${body.receiver.company}.`);
    await loadReceivers();
  }

  async function saveReceiver(id: string) {
    const draft = drafts[id];
    const response = await fetch(`/api/admin/receivers/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company: draft.company, contactEmails: parseEmails(draft.emails) }),
    });
    const body = await response.json();
    if (!response.ok) {
      setMessage(body.error || "Could not save that receiver");
      return;
    }
    setMessage(`Saved ${body.receiver.company}.`);
    await loadReceivers();
  }

  async function setEnabled(id: string, enabled: boolean) {
    const response = await fetch(`/api/admin/receivers/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const body = await response.json();
    if (!response.ok) {
      setMessage(body.error || "Could not update that link");
      return;
    }
    setConfirming(null);
    setMessage(enabled ? "Link enabled." : "Link disabled. The old URL no longer opens.");
    await loadReceivers();
  }

  async function regenerate(id: string) {
    const response = await fetch(`/api/admin/receivers/${id}/regenerate`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) {
      setMessage(body.error || "Could not regenerate that link");
      return;
    }
    setConfirming(null);
    setMessage("New link created. The previous URL no longer opens.");
    await loadReceivers();
  }

  async function remove(id: string) {
    const response = await fetch(`/api/admin/receivers/${id}`, { method: "DELETE" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(body.error || "Could not remove that receiver");
      return;
    }
    setConfirming(null);
    setMessage("Receiver removed.");
    await loadReceivers();
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setMessage("Link copied.");
    } catch {
      setMessage(url);
    }
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
          Receivers do not sign in. Each company gets a private link that shows only loads with a drop at that company, plus tracking and photos.
          The company name has to match the drop on the load. Nothing is loaded until you add it here.
        </p>
        <div className="receiver-card">
          <input aria-label="New receiver company" placeholder="Company name" value={company} onChange={(event) => setCompany(event.target.value)} />
          <input
            aria-label="New receiver emails"
            placeholder="Contact emails, separated by commas"
            value={emails}
            onChange={(event) => setEmails(event.target.value)}
          />
          <div className="actions" style={{ justifyContent: "flex-start" }}>
            <button className="btn" type="button" onClick={addReceiver} disabled={!company.trim()}>
              Add receiver
            </button>
          </div>
        </div>
        {receivers.length === 0 && <p className="mini">No receiver companies yet.</p>}
        {receivers.map((row) => {
          const draft = drafts[row.id] ?? { company: row.company, emails: emailsText(row.contactEmails) };
          return (
            <article className="receiver-card" key={row.id}>
              <input
                aria-label={`Company for ${row.company}`}
                value={draft.company}
                onChange={(event) => setDrafts({ ...drafts, [row.id]: { ...draft, company: event.target.value } })}
              />
              <input
                aria-label={`Emails for ${row.company}`}
                value={draft.emails}
                onChange={(event) => setDrafts({ ...drafts, [row.id]: { ...draft, emails: event.target.value } })}
              />
              <p className="mini">{row.enabled ? "Link is on" : "Link is disabled"}</p>
              {row.enabled && row.url && (
                <input className="link-box" aria-label={`Link for ${row.company}`} readOnly value={row.url} />
              )}
              <div className="actions" style={{ justifyContent: "flex-start" }}>
                <button className="btn" type="button" onClick={() => saveReceiver(row.id)}>
                  Save
                </button>
                {row.enabled && (
                  <button className="btn secondary" type="button" onClick={() => copy(row.url)}>
                    Copy link
                  </button>
                )}
                <button className="btn secondary" type="button" onClick={() => setConfirming(`regen:${row.id}`)}>
                  Regenerate
                </button>
                {row.enabled ? (
                  <button className="btn secondary" type="button" onClick={() => setConfirming(`off:${row.id}`)}>
                    Disable
                  </button>
                ) : (
                  <button className="btn secondary" type="button" onClick={() => setEnabled(row.id, true)}>
                    Enable
                  </button>
                )}
                <button className="btn danger" type="button" onClick={() => setConfirming(`remove:${row.id}`)}>
                  Remove
                </button>
              </div>
              {row.enabled && confirming === `off:${row.id}` && (
                <div className="confirm-box">
                  <p>Disable this link? The current URL will stop opening until you enable it again.</p>
                  <div className="actions">
                    <button className="btn danger" type="button" onClick={() => setEnabled(row.id, false)}>
                      Yes, disable it
                    </button>
                    <button className="btn secondary" type="button" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {confirming === `regen:${row.id}` && (
                <div className="confirm-box">
                  <p>Regenerate this link? The current URL stops working.</p>
                  <div className="actions">
                    <button className="btn" type="button" onClick={() => regenerate(row.id)}>
                      Yes, regenerate
                    </button>
                    <button className="btn secondary" type="button" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {confirming === `remove:${row.id}` && (
                <div className="confirm-box">
                  <p>Remove {row.company}? Their link stops working.</p>
                  <div className="actions">
                    <button className="btn danger" type="button" onClick={() => remove(row.id)}>
                      Yes, remove
                    </button>
                    <button className="btn secondary" type="button" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </main>
    </Shell>
  );

  function update(index: number, patch: Partial<Site>) {
    setSites(sites.map((site, item) => (item === index ? { ...site, ...patch } : site)));
  }
}
