"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/shell";

export default function AccountPage() {
  const [hasPassword, setHasPassword] = useState(true);
  const [mustChange, setMustChange] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    fetch("/api/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!body) return;
        setHasPassword(Boolean(body.hasPassword));
        setMustChange(Boolean(body.mustChangePassword));
      })
      .catch(() => undefined);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    if (newPassword !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    setPending(true);
    const response = await fetch("/api/account/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const body = await response.json().catch(() => ({}));
    setPending(false);
    if (!response.ok) {
      setError(body.error || "Could not change the password");
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirm("");
    setMustChange(false);
    setMessage("Password updated.");
  }

  return (
    <Shell>
      <main className="page">
        <h1>PASSWORD</h1>
        {mustChange && (
          <p className="lede">Select set a temporary password. Choose a new one before you keep using the portal.</p>
        )}
        {!hasPassword && (
          <p className="lede">Select admins sign in with Google and do not have a portal password.</p>
        )}
        {hasPassword && (
          <form className="receiver-card" onSubmit={submit}>
            {error && <p className="error">{error}</p>}
            {message && <p className="mini">{message}</p>}
            <div className="field">
              <label htmlFor="current-password">Current password</label>
              <input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="new-password">New password</label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                minLength={10}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="confirm-password">Confirm new password</label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                minLength={10}
                required
              />
            </div>
            <button className="btn" type="submit" disabled={pending}>
              {pending ? "Saving…" : "Change password"}
            </button>
          </form>
        )}
      </main>
    </Shell>
  );
}
