"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { safeNextPath } from "@/lib/paths";

interface DemoHint {
  emit: string;
  emitViewer?: string;
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
  const [google, setGoogle] = useState(false);
  const [setup, setSetup] = useState<string[]>([]);
  const microsoftError = params.get("microsoft");
  const queryError = params.get("error");

  useEffect(() => {
    fetch("/api/auth/providers")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        setDemoHint(body?.demoHint ?? null);
        setMicrosoft(Boolean(body?.microsoft));
        setGoogle(Boolean(body?.google));
        setSetup(Array.isArray(body?.setup) ? body.setup.filter((item: unknown) => typeof item === "string") : []);
      })
      .catch(() => {
        setDemoHint(null);
        setMicrosoft(false);
        setGoogle(false);
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

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <BrandLogo height={42} />
        <h1>Sign in</h1>
        <p className="lede">Two different sign-ins. EMIT staff use email and password. Select staff use Google. Receivers open a private link and do not sign in here.</p>
        {demoHint && (
          <div className="demo-hint">
            <strong>Test sign-in</strong>
            <p>EMIT add loads: {demoHint.emit}</p>
            {demoHint.emitViewer ? <p>EMIT view only: {demoHint.emitViewer}</p> : null}
            {demoHint.emitFull ? <p>EMIT full access: {demoHint.emitFull}</p> : null}
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
        <section className="login-section" aria-labelledby="emit-sign-in">
          <h2 id="emit-sign-in">EMIT staff</h2>
          <p className="lede">For EMIT people Select has already added: view only, add loads, and full access. Use the email and password from Select.</p>
          <div className="field">
            <label htmlFor="email">EMIT email</label>
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
            {pending ? "Signing in…" : "Sign in as EMIT"}
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
        <section className="login-section" aria-labelledby="select-sign-in">
          <h2 id="select-sign-in">Select staff</h2>
          <p className="lede">For Select people, including staff beyond the first two admins. This is not an EMIT sign-in.</p>
          {google ? (
            <button
              className="btn secondary"
              type="button"
              style={{ width: "100%" }}
              onClick={() => {
                window.location.href = "/api/auth/google";
              }}
            >
              Sign in with Google
            </button>
          ) : (
            <>
              <p className="lede">Google sign-in isn't set up on this site yet. Use email and password.</p>
              <p className="lede">A Select account that already has a password uses the form above.</p>
            </>
          )}
        </section>
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
