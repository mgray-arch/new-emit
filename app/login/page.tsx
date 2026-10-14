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
  const googleError = params.get("google");
  const queryError = params.get("error");

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
        <p className="lede">EMIT and receivers sign in with Microsoft. Select staff sign in with Google.</p>
        {showHint && (
          <div className="demo-hint">
            <strong>Test sign-in</strong>
            <p>EMIT: m.gray@emit.example</p>
            <p>Select: mgray@goselect.com, dmartin@goselect.com</p>
            <p>Receiver: ops@enchantedrock.example</p>
            <p>Password: Emit-Demo-2026</p>
          </div>
        )}
        {(error || queryError || microsoftError || googleError) && (
          <p className="error">
            {error ||
              queryError ||
              (microsoftError
                ? "Microsoft sign-in needs an Entra app registration. Set AZURE_AD_TENANT_ID, AZURE_AD_CLIENT_ID, and AZURE_AD_CLIENT_SECRET."
                : "Google sign-in needs a Workspace OAuth client. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.")}
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
        <button
          className="btn secondary"
          type="button"
          style={{ width: "100%", marginTop: 8 }}
          onClick={() => {
            window.location.href = "/api/auth/google";
          }}
        >
          Sign in with Google
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
