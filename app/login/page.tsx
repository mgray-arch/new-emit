"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { safeNextPath } from "@/lib/paths";

interface DemoHint {
  emit: string;
  select: string[];
  password: string;
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [demoHint, setDemoHint] = useState<DemoHint | null>(null);
  const [microsoft, setMicrosoft] = useState(false);
  const microsoftError = params.get("microsoft");
  const googleError = params.get("google");
  const queryError = params.get("error");

  useEffect(() => {
    fetch("/api/auth/providers")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        setDemoHint(body?.demoHint ?? null);
        setMicrosoft(Boolean(body?.microsoft));
      })
      .catch(() => {
        setDemoHint(null);
        setMicrosoft(false);
      });
  }, []);

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
        <h1>Sign in</h1>
        <p className="lede">
          EMIT uses the email and password from Select. Select staff use Google. Receivers open a private link and do not sign in here.
        </p>
        {demoHint && (
          <div className="demo-hint">
            <strong>Test sign-in</strong>
            <p>EMIT: {demoHint.emit}</p>
            <p>Select: {demoHint.select.join(", ")}</p>
            <p>Password: {demoHint.password}</p>
          </div>
        )}
        {(error || queryError || microsoftError || googleError) && (
          <p className="error">
            {error ||
              queryError ||
              (microsoftError
                ? "Microsoft sign-in is optional and is not configured. EMIT staff use email and password."
                : "Google sign-in needs a Workspace OAuth client. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.")}
          </p>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        <button className="btn" type="submit" disabled={pending} style={{ width: "100%" }}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
        <button
          className="btn secondary"
          type="button"
          style={{ width: "100%", marginTop: 8 }}
          onClick={() => {
            window.location.href = "/api/auth/google";
          }}
        >
          Select staff — Google
        </button>
        {microsoft && (
          <button
            className="btn secondary"
            type="button"
            style={{ width: "100%", marginTop: 8 }}
            onClick={() => {
              window.location.href = "/api/auth/microsoft";
            }}
          >
            EMIT staff — Microsoft (optional)
          </button>
        )}
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
