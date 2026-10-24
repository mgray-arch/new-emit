"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/shell";

interface EmitUser {
  id: string;
  email: string;
  name: string;
  active: boolean;
  access: "admin" | "regular";
  permission: "view" | "add" | "pricing" | "full";
  emitAdmin: boolean;
  hasPassword: boolean;
  createdAt: string;
}

const PERMISSIONS: Array<{ value: EmitUser["permission"]; label: string; detail: string }> = [
  { value: "view", label: "View only", detail: "Can look at loads. Cannot add loads. No pricing." },
  { value: "add", label: "Add loads", detail: "Can add and edit loads. No pricing." },
  { value: "pricing", label: "See pricing", detail: "Sees the price EMIT pays Select. Cannot add loads. Never carrier pay." },
  { value: "full", label: "Full access", detail: "Can add loads and see the price EMIT pays. Never carrier pay." },
];

export default function UsersPage() {
  const [users, setUsers] = useState<EmitUser[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sharedPassword, setSharedPassword] = useState("");
  const [permission, setPermission] = useState<EmitUser["permission"]>("add");
  const [access, setAccess] = useState<EmitUser["access"]>("regular");
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  async function load() {
    const response = await fetch("/api/admin/users");
    if (!response.ok) return;
    const body = await response.json();
    setUsers(body.users ?? []);
  }

  useEffect(() => {
    void load();
  }, []);

  function showResult(body: { temporaryPassword?: string; user?: EmitUser }, fallback: string) {
    if (body.temporaryPassword) {
      setSharedPassword(body.temporaryPassword);
      setMessage(`${fallback} Share this temporary password. It is shown once.`);
    } else {
      setSharedPassword("");
      setMessage(fallback);
    }
  }

  async function create(generate: boolean) {
    setError("");
    setMessage("");
    setSharedPassword("");
    const response = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        email,
        password: generate ? undefined : password,
        generatePassword: generate,
        access,
        permission,
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
    showResult(body, `Created ${body.user.email}.`);
    await load();
  }

  async function setActive(user: EmitUser, active: boolean) {
    setError("");
    const response = await fetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error || "Could not update that user");
      return;
    }
    setMessage(active ? `${user.email} can sign in again.` : `${user.email} is deactivated.`);
    await load();
  }

  async function saveUser(user: EmitUser, patch: { access?: EmitUser["access"]; permission?: EmitUser["permission"] }) {
    setError("");
    const response = await fetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error || "Could not update that user");
      return;
    }
    const nextPermission = patch.permission ?? user.permission;
    const nextAccess = patch.access ?? user.access;
    const label = PERMISSIONS.find((item) => item.value === nextPermission)?.label ?? nextPermission;
    setMessage(`${user.email} is ${nextAccess === "admin" ? "an EMIT admin" : "a regular EMIT user"} with ${label}.`);
    await load();
  }

  async function reset(user: EmitUser, generate: boolean) {
    setError("");
    setSharedPassword("");
    const response = await fetch(`/api/admin/users/${user.id}/password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password: generate ? undefined : resetPassword,
        generatePassword: generate,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error || "Could not reset that password");
      return;
    }
    setResetFor(null);
    setResetPassword("");
    showResult(body, `Password updated for ${user.email}.`);
    await load();
  }

  return (
    <Shell>
      <main className="page">
        <h1>EMIT users</h1>
        <p className="lede">
          Only Select can add someone here. An email that is not on this list cannot sign in as EMIT. Each person is an EMIT admin or a regular user, and has one permission. See pricing and full access show the price EMIT pays Select. They never show carrier pay. An EMIT admin can manage saved locations unless the permission is view only.
        </p>
        {error && <p className="error">{error}</p>}
        {message && <p className="mini">{message}</p>}
        {sharedPassword && (
          <div className="confirm">
            <strong>Temporary password</strong>
            <p className="pair">
              <b>{sharedPassword}</b>
            </p>
            <p className="mini">Copy it now and send it to the person. The portal does not email passwords and will not show this again.</p>
          </div>
        )}
        <div className="receiver-card">
          <div className="grid-2">
            <div className="field">
              <label htmlFor="new-name">Name</label>
              <input id="new-name" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="new-email">Email</label>
              <input id="new-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="new-access">Access</label>
            <select id="new-access" value={access} onChange={(event) => setAccess(event.target.value as EmitUser["access"])}>
              <option value="regular">Regular EMIT user</option>
              <option value="admin">EMIT admin</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="new-permission">Permission</label>
            <select id="new-permission" value={permission} onChange={(event) => setPermission(event.target.value as EmitUser["permission"])}>
              {PERMISSIONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label} — {item.detail}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="new-password">Temporary password</label>
            <input
              id="new-password"
              type="text"
              autoComplete="off"
              value={password}
              placeholder="At least 10 characters, or generate one"
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <div className="actions" style={{ justifyContent: "flex-start" }}>
            <button className="btn" type="button" onClick={() => create(false)}>
              Create user
            </button>
            <button className="btn secondary" type="button" onClick={() => create(true)}>
              Create and generate password
            </button>
          </div>
        </div>
        {users.length === 0 && <p className="mini">No EMIT users yet.</p>}
        {users.map((user) => (
          <article className="receiver-card" key={user.id}>
            <h2>
              {user.name} {!user.active && <span className="mini">· deactivated</span>}
            </h2>
            <p className="mini">{user.email}</p>
            <label className="field">
              <span>Access for {user.email}</span>
              <select
                aria-label={`Access for ${user.email}`}
                value={user.access}
                onChange={(event) => saveUser(user, { access: event.target.value as EmitUser["access"] })}
              >
                <option value="regular">Regular EMIT user</option>
                <option value="admin">EMIT admin</option>
              </select>
            </label>
            <label className="field">
              <span>Permission for {user.email}</span>
              <select
                aria-label={`Permission for ${user.email}`}
                value={user.permission}
                onChange={(event) => saveUser(user, { permission: event.target.value as EmitUser["permission"] })}
              >
                {PERMISSIONS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="mini">{PERMISSIONS.find((item) => item.value === user.permission)?.detail}</p>
            <div className="actions" style={{ justifyContent: "flex-start" }}>
              <button className="btn secondary" type="button" onClick={() => setActive(user, !user.active)}>
                {user.active ? "Deactivate" : "Activate"}
              </button>
              <button className="btn secondary" type="button" onClick={() => setResetFor(resetFor === user.id ? null : user.id)}>
                Reset password
              </button>
            </div>
            {resetFor === user.id && (
              <div className="confirm-box">
                <input
                  aria-label={`New password for ${user.email}`}
                  type="text"
                  autoComplete="off"
                  value={resetPassword}
                  placeholder="Temporary password"
                  onChange={(event) => setResetPassword(event.target.value)}
                />
                <div className="actions" style={{ justifyContent: "flex-start" }}>
                  <button className="btn" type="button" onClick={() => reset(user, false)}>
                    Set password
                  </button>
                  <button className="btn secondary" type="button" onClick={() => reset(user, true)}>
                    Generate password
                  </button>
                </div>
              </div>
            )}
          </article>
        ))}
      </main>
    </Shell>
  );
}
