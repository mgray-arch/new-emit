"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { safeNextPath } from "@/lib/paths";

interface DemoHint {
  emit: string;
  emitViewer?: string;
  emitPricing?: string;
  emitFull?: string;
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
  const [selectSetup, setSelectSetup] = useState(false);
  const [setup, setSetup] = useState<string[]>([]);
  const [setupKey, setSetupKey] = useState("");
  const [setupEmail, setSetupEmail] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupMessage, setSetupMessage] = useState("");
  const microsoftError = params.get("microsoft");
  const queryError = params.get("error");

  useEffect(() => {
    fetch("/api/auth/providers")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        setDemoHint(body?.demoHint ?? null);
        setMicrosoft(Boolean(body?.microsoft));
        setSelectSetup(Boolean(body?.selectSetup));
        setSetup(Array.isArray(body?.setup) ? body.setup.filter((item: unknown) => typeof item === "string") : []);
      })
      .catch(() => {
        setDemoHint(null);
        setMicrosoft(false);
        setSelectSetup(false);
        setSetup([]);
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

  async function claimPassword(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    setSetupMessage("");
    const response = await fetch("/api/auth/select-setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: setupEmail, password: setupPassword, setupKey }),
    });
    const body = await response.json().catch(() => ({}));
    setPending(false);
    if (!response.ok) {
      setError(body.error || "Could not set that password");
      return;
    }
    setSetupKey("");
    setSetupPassword("");
    setEmail(setupEmail);
    setPassword("");
    setSetupMessage("Password saved. Sign in above with that email and password.");
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <BrandLogo height={42} />
        <h1>Sign in</h1>
        <p className="lede">
          EMIT staff and Select staff use this form. Sign in with your email and password. Receivers open a private link and do not sign in here.
        </p>
        {demoHint && (
          <div className="demo-hint">
            <strong>Test sign-in</strong>
            <p>Sales or Loader, add loads: {demoHint.emit}</p>
            {demoHint.emitViewer ? <p>Sales or Loader, view only: {demoHint.emitViewer}</p> : null}
            {demoHint.emitPricing ? <p>Sales or Loader, see pricing: {demoHint.emitPricing}</p> : null}
            {demoHint.emitFull ? <p>EMIT admin, full access: {demoHint.emitFull}</p> : null}
            <p>Select: {demoHint.select.join(", ")}</p>
            <p>Password for every test account: {demoHint.password}</p>
          </div>
        )}
        {setup.length > 0 && (
          <div className="demo-hint">
            <strong>This deployment is not ready for sign-in</strong>
            {setup.map((item) => (
              <p key={item}>{item}</p>
            ))}
          </div>
        )}
        {(error || queryError || microsoftError) && (
          <p className="error">
            {error ||
              queryError ||
              "Microsoft sign-in is optional and is not configured. EMIT staff use email and password."}
          </p>
        )}
        <section className="login-section login-emit" aria-labelledby="sign-in-form">
          <h2 id="sign-in-form">Email and password</h2>
          <p className="lede">
            EMIT admins, Sales, Loader, and Select staff all sign in here. Use the email on your account. EMIT IT is not involved.
          </p>
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
        </section>
      </form>
      {selectSetup ? (
        <form className="login-card" onSubmit={claimPassword} style={{ marginTop: 16 }}>
          <section className="login-section login-select" aria-labelledby="select-setup">
            <p className="login-kicker">First Select password</p>
            <h2 id="select-setup">Set a Select password</h2>
            <p className="lede">
              This stays open while a setup key is configured. Use it for a Select staff email, then remove the key. The portal does not email the password.
            </p>
            {setupMessage ? <p className="mini">{setupMessage}</p> : null}
            <div className="field">
              <label htmlFor="setup-key">Setup key</label>
              <input
                id="setup-key"
                type="password"
                autoComplete="off"
                value={setupKey}
                onChange={(event) => setSetupKey(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="setup-email">Select email</label>
              <input
                id="setup-email"
                type="email"
                autoComplete="username"
                value={setupEmail}
                onChange={(event) => setSetupEmail(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="setup-password">New password</label>
              <input
                id="setup-password"
                type="password"
                autoComplete="new-password"
                value={setupPassword}
                onChange={(event) => setSetupPassword(event.target.value)}
                required
                minLength={10}
              />
            </div>
            <button className="btn secondary" type="submit" disabled={pending} style={{ width: "100%" }}>
              {pending ? "Saving…" : "Save Select password"}
            </button>
          </section>
        </form>
      ) : null}
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
