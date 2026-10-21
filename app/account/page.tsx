"use client";

import { useState } from "react";
import Shell from "@/components/shell";

export default function AccountPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    setError("");
    const response = await fetch("/api/me/password", {
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
    setMessage("Password changed. Use it the next time you sign in.");
  }

  return (
    <Shell>
      <main className="page">
        <h1>PASSWORD</h1>
        <p className="lede">Change the password for this EMIT account. Select admins who use Google do not have a password here.</p>
        <form onSubmit={submit} style={{ maxWidth: 420 }}>
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
              required
              minLength={10}
            />
          </div>
          <button className="btn" type="submit" disabled={pending}>
            {pending ? "Saving…" : "Change password"}
          </button>
        </form>
      </main>
    </Shell>
  );
}
