"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/shell";

interface SelectStaff {
  id: string;
  email: string;
  name: string;
  active: boolean;
  hasPassword: boolean;
}

interface EmitUser {
  id: string;
  email: string;
  name: string;
  active: boolean;
  access: "admin" | "regular";
  permission: "view" | "add" | "pricing" | "full";
  emitAdmin: boolean;
  chatEnabled: boolean;
  hasPassword: boolean;
  createdAt: string;
}

const PERMISSIONS: Array<{ value: EmitUser["permission"]; label: string; detail: string }> = [
  { value: "view", label: "View only", detail: "Can look at loads. Cannot add loads. No pricing." },
  { value: "add", label: "Add loads", detail: "Can add and edit loads. No pricing." },
  { value: "pricing", label: "See pricing", detail: "An EMIT admin sees the price EMIT pays Select. A regular user does not. Cannot add loads. Never carrier pay." },
  { value: "full", label: "Full access", detail: "Can add loads. An EMIT admin also sees the price EMIT pays. A regular user does not. Never carrier pay." },
];

export default function UsersPage() {
  const [users, setUsers] = useState<EmitUser[]>([]);
  const [staff, setStaff] = useState<SelectStaff[]>([]);
  const [staffName, setStaffName] = useState("");
  const [staffEmail, setStaffEmail] = useState("");
  const [staffPassword, setStaffPassword] = useState("");
  const [staffResetFor, setStaffResetFor] = useState<string | null>(null);
  const [staffResetPassword, setStaffResetPassword] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sharedPassword, setSharedPassword] = useState("");
  const [permission, setPermission] = useState<EmitUser["permission"]>("add");
  const [access, setAccess] = useState<EmitUser["access"]>("regular");
  const [chatEnabled, setChatEnabled] = useState(false);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  async function load() {
    const [people, selectStaff] = await Promise.all([fetch("/api/admin/users"), fetch("/api/admin/staff")]);
    if (people.ok) {
      const body = await people.json();
      setUsers(body.users ?? []);
    }
    if (selectStaff.ok) {
      const body = await selectStaff.json();
      setStaff(body.staff ?? []);
    }
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
        chatEnabled,
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
    setChatEnabled(false);
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

  async function saveUser(user: EmitUser, patch: { access?: EmitUser["access"]; permission?: EmitUser["permission"]; chatEnabled?: boolean }) {
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
    if (patch.chatEnabled !== undefined && patch.access === undefined && patch.permission === undefined) {
      setMessage(patch.chatEnabled ? `${user.email} can use Messages.` : `${user.email} cannot use Messages.`);
      await load();
      return;
    }
    const nextPermission = patch.permission ?? user.permission;
    const nextAccess = patch.access ?? user.access;
    const label = PERMISSIONS.find((item) => item.value === nextPermission)?.label ?? nextPermission;
    setMessage(`${user.email} is ${nextAccess === "admin" ? "an EMIT admin" : "a regular EMIT user"} with ${label}.`);
    await load();
  }

  async function saveStaff(generate: boolean) {
    setError("");
    setMessage("");
    setSharedPassword("");
    const response = await fetch("/api/admin/staff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: staffName,
        email: staffEmail,
        password: generate ? undefined : staffPassword,
        generatePassword: generate,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error || "Could not add that Select account");
      return;
    }
    setStaffName("");
    setStaffEmail("");
    setStaffPassword("");
    showResult(body, `Added ${body.user.email} as Select staff.`);
    await load();
  }

  async function setStaffActive(person: SelectStaff, active: boolean) {
    setError("");
    const response = await fetch(`/api/admin/staff/${person.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error || "Could not update that account");
      return;
    }
    setMessage(active ? `${person.email} can sign in again.` : `${person.email} is deactivated.`);
    await load();
  }

  async function resetStaff(person: SelectStaff, generate: boolean) {
    setError("");
    setSharedPassword("");
    const response = await fetch(`/api/admin/staff/${person.id}/password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password: generate ? undefined : staffResetPassword,
        generatePassword: generate,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error || "Could not reset that password");
      return;
    }
    setStaffResetFor(null);
    setStaffResetPassword("");
    showResult(body, `Password updated for ${person.email}.`);
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
        <h1>Users</h1>
        <h2>Select staff</h2>
        <p className="lede">
          Mike, Drew, Ainsley, and other Select admins sign in with email and password. An address has to be on SELECT_ADMIN_EMAILS before it can be added here. They keep Select admin access. This does not change EMIT permissions.
        </p>
        <div className="receiver-card">
          <div className="grid-2">
            <div className="field">
              <label htmlFor="staff-name">Name</label>
              <input id="staff-name" value={staffName} onChange={(event) => setStaffName(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="staff-email">Email</label>
              <input id="staff-email" type="email" value={staffEmail} onChange={(event) => setStaffEmail(event.target.value)} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="staff-password">Temporary password</label>
            <input
              id="staff-password"
              type="text"
              autoComplete="off"
              value={staffPassword}
              placeholder="At least 10 characters, or generate one"
              onChange={(event) => setStaffPassword(event.target.value)}
            />
          </div>
          <div className="actions" style={{ justifyContent: "flex-start" }}>
            <button className="btn" type="button" onClick={() => void saveStaff(false)}>
              Add Select staff
            </button>
            <button className="btn secondary" type="button" onClick={() => void saveStaff(true)}>
              Add and generate password
            </button>
          </div>
        </div>
        {staff.length === 0 && <p className="mini">No Select staff yet.</p>}
        {staff.map((person) => (
          <article className="receiver-card" key={person.id}>
            <h2>
              {person.name} {!person.active && <span className="mini">· deactivated</span>}
            </h2>
            <p className="mini">{person.email} · Select admin</p>
            <div className="actions" style={{ justifyContent: "flex-start" }}>
              <button className="btn secondary" type="button" onClick={() => void setStaffActive(person, !person.active)}>
                {person.active ? "Deactivate" : "Activate"}
              </button>
              <button
                className="btn secondary"
                type="button"
                onClick={() => setStaffResetFor(staffResetFor === person.id ? null : person.id)}
              >
                Reset password
              </button>
            </div>
            {staffResetFor === person.id && (
              <div className="confirm-box">
                <input
                  aria-label={`New password for ${person.email}`}
                  type="text"
                  autoComplete="off"
                  value={staffResetPassword}
                  placeholder="Temporary password"
                  onChange={(event) => setStaffResetPassword(event.target.value)}
                />
                <div className="actions" style={{ justifyContent: "flex-start" }}>
                  <button className="btn" type="button" onClick={() => void resetStaff(person, false)}>
                    Set password
                  </button>
                  <button className="btn secondary" type="button" onClick={() => void resetStaff(person, true)}>
                    Generate password
                  </button>
                </div>
              </div>
            )}
          </article>
        ))}
        <h2>EMIT users</h2>
        <p className="lede">
          Only Select can add someone here. An email that is not on this list cannot sign in as EMIT. Each person is an EMIT admin or a regular user, and has one permission. A regular user never sees the price EMIT pays Select. An EMIT admin with see pricing or full access does. They never show carrier pay. An EMIT admin can manage saved locations unless the permission is view only.
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
          <label className="check-row">
            <input
              type="checkbox"
              checked={chatEnabled}
              onChange={(event) => setChatEnabled(event.target.checked)}
            />
            <span>Chat enabled</span>
          </label>
          <p className="mini">Off by default. This person can open Messages only when this is checked. Select always can.</p>
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
            <label className="check-row">
              <input
                type="checkbox"
                checked={user.chatEnabled}
                aria-label={`Chat enabled for ${user.email}`}
                onChange={(event) => void saveUser(user, { chatEnabled: event.target.checked })}
              />
              <span>Chat enabled</span>
            </label>
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
