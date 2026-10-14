"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { safeNextPath } from "@/lib/paths";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("m.gray@emit.example");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const showHint = process.env.NEXT_PUBLIC_DEMO_HINT !== "false";
  const microsoftError = params.get("microsoft");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(body.error || "Could not sign in");
      return;
    }
    const next = safeNextPath(params.get("next"));
    router.push(body.role === "admin" && next === "/" ? "/admin" : next);
    router.refresh();
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <img src="/brand/emit-logo.png" alt="EMIT" style={{ height: 42 }} />
        <h1>EMIT LOAD ORDER PORTAL</h1>
        <p className="lede">Sign in with your EMIT Microsoft account or the portal password.</p>
        {showHint && (
          <div className="demo-hint">
            <strong>Test sign-in</strong>
            <p>Customer: m.gray@emit.example</p>
            <p>Select staff: mike@select.example, drew@select.example</p>
            <p>Password: Emit-Demo-2026</p>
          </div>
        )}
        {(error || microsoftError) && (
          <p className="error">
            {error ||
              "Microsoft sign-in needs an Entra app registration. Set AZURE_AD_TENANT_ID, AZURE_AD_CLIENT_ID, and AZURE_AD_CLIENT_SECRET."}
          </p>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </div>
        <button className="btn" type="submit" disabled={pending} style={{ width: "100%" }}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
        <button
          className="btn secondary"
          type="button"
          style={{ width: "100%", marginTop: 8 }}
          onClick={() => {
            window.location.href = "/api/auth/microsoft";
          }}
        >
          Sign in with Microsoft
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
