"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/shell";

interface EmitUser {
  id: string;
  email: string;
  name: string;
  active: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<EmitUser[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [generate, setGenerate] = useState(true);
  const [message, setMessage] = useState("");
  const [sharedPassword, setSharedPassword] = useState("");
  const [resetPassword, setResetPassword] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  async function load() {
    const response = await fetch("/api/admin/users");
    if (!response.ok) return;
    const body = await response.json();
    setUsers(body.users ?? []);
  }

  useEffect(() => {
    void load();
  }, []);

  function showShared(value: string | null | undefined, note: string) {
    setMessage(note);
    setSharedPassword(value || "");
  }

  async function createUser(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const response = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        email,
        generatePassword: generate,
        password: generate ? undefined : password,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error || "Could not create that user");
      return;
    }
    setName("");
    setEmail("");
    setPassword("");
    showShared(body.temporaryPassword, `Created ${body.user.email}. Share this temporary password. It will not be shown again.`);
    await load();
  }

  async function patch(id: string, payload: Record<string, unknown>, note: string): Promise<boolean> {
    setError("");
    const response = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error || "Could not update that user");
      return false;
    }
    showShared(body.temporaryPassword, note);
    await load();
    return true;
  }

  return (
    <Shell>
      <main className="page">
        <h1>EMIT USERS</h1>
        <p className="lede">
          Select admins create EMIT staff here. They sign in with email and password. Share the temporary password with them. They can change it after signing in.
        </p>
        {error && <p className="error">{error}</p>}
        {message && <p className="mini">{message}</p>}
        {sharedPassword && (
          <div className="receiver-card">
            <label htmlFor="shared-password">Temporary password</label>
            <input id="shared-password" readOnly value={sharedPassword} />
          </div>
        )}
        <form className="receiver-card" onSubmit={createUser}>
          <div className="field">
            <label htmlFor="user-name">Name</label>
            <input id="user-name" value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="user-email">Email</label>
            <input id="user-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </div>
          <label className="mini">
            <input type="checkbox" checked={generate} onChange={(event) => setGenerate(event.target.checked)} /> Generate a temporary password
          </label>
          {!generate && (
            <div className="field">
              <label htmlFor="user-password">Temporary password</label>
              <input
                id="user-password"
                type="text"
                autoComplete="off"
                minLength={10}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
          )}
          <button className="btn" type="submit">
            Create EMIT user
          </button>
        </form>
        {users.length === 0 && <p className="mini">No EMIT users yet.</p>}
        {users.map((user) => (
          <article className="receiver-card" key={user.id}>
            <strong>{user.name}</strong>
            <div className="mini">{user.email}</div>
            <div className="mini">{user.active ? "Active" : "Deactivated"}{user.mustChangePassword ? " · temporary password" : ""}</div>
            <div className="field">
              <label htmlFor={`reset-${user.id}`}>Set a temporary password</label>
              <input
                id={`reset-${user.id}`}
                type="text"
                autoComplete="off"
                value={resetPassword[user.id] ?? ""}
                onChange={(event) => setResetPassword({ ...resetPassword, [user.id]: event.target.value })}
              />
            </div>
            <div className="actions" style={{ justifyContent: "flex-start" }}>
              <button
                className="btn secondary"
                type="button"
                disabled={(resetPassword[user.id] ?? "").length < 10}
                onClick={() => {
                  const nextPassword = resetPassword[user.id] ?? "";
                  void patch(user.id, { password: nextPassword }, `Temporary password for ${user.email} was set. Share it. It will not be shown again.`).then(
                    (ok) => {
                      if (ok) setResetPassword((current) => ({ ...current, [user.id]: "" }));
                    },
                  );
                }}
              >
                Set password
              </button>
              <button
                className="btn secondary"
                type="button"
                onClick={() =>
                  patch(user.id, { generatePassword: true }, `New temporary password for ${user.email}. Share it. It will not be shown again.`)
                }
              >
                Generate password
              </button>
              {user.active ? (
                <button className="btn danger" type="button" onClick={() => patch(user.id, { active: false }, `${user.email} is deactivated.`)}>
                  Deactivate
                </button>
              ) : (
                <button className="btn secondary" type="button" onClick={() => patch(user.id, { active: true }, `${user.email} is active again.`)}>
                  Reactivate
                </button>
              )}
            </div>
          </article>
        ))}
      </main>
    </Shell>
  );
}
