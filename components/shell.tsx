"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface Me {
  name: string;
  email: string;
  role: "customer" | "emit_admin" | "admin";
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [demo, setDemo] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [toastMessage, setToastMessage] = useState("");

  useEffect(() => {
    const stored = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    setTheme(stored);
  }, []);

  useEffect(() => {
    let timer = 0;
    function onToast(event: Event) {
      const message = (event as CustomEvent<string>).detail;
      if (!message) return;
      setToastMessage(message);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setToastMessage(""), 3200);
    }
    window.addEventListener("emit-toast", onToast);
    return () => {
      window.removeEventListener("emit-toast", onToast);
      window.clearTimeout(timer);
    };
  }, []);

  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("emit-theme", next);
    setTheme(next);
  }

  useEffect(() => {
    fetch("/api/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => setMe(data))
      .catch(() => setMe(null));
    fetch("/api/auth/providers")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => setDemo(Boolean(body?.demoHint)))
      .catch(() => setDemo(false));
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const initials = (me?.name || "EM")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand">
          <img src="/brand/emit-logo.png" alt="EMIT" />
          <div>
            <div className="brand-name">EMIT LOAD ORDER PORTAL</div>
            <div className="brand-sub">Load Entry</div>
          </div>
        </Link>
        <div className="top-actions">
          <Link href="/" className={pathname === "/" ? "active" : ""}>
            Dashboard
          </Link>
          <Link href="/ask" className={pathname === "/ask" ? "active" : ""}>
            Ask about an SO
          </Link>
          {(me?.role === "admin" || me?.role === "emit_admin") && (
            <Link href="/locations" className={pathname === "/locations" ? "active" : ""}>
              Locations
            </Link>
          )}
          {me?.role === "admin" && (
            <>
              <Link href="/admin" className={pathname === "/admin" ? "active" : ""}>
                Review
              </Link>
              <Link href="/admin/users" className={pathname.startsWith("/admin/users") ? "active" : ""}>
                Users
              </Link>
              <Link href="/admin/settings" className={pathname.startsWith("/admin/settings") ? "active" : ""}>
                Settings
              </Link>
            </>
          )}
          <Link href="/account" className={pathname === "/account" ? "active" : ""}>
            Password
          </Link>
          <button
            className="logout"
            type="button"
            onClick={toggleTheme}
            title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
            aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          >
            {theme === "light" ? "Dark mode" : "Light mode"}
          </button>
          <span className="who" title={me?.email || "Signed in"}>
            <span className="avatar" title={me?.name || "Your account"}>
              {initials}
            </span>
            {me?.name || "…"}
          </span>
          <button className="logout" onClick={logout} type="button" title="Sign out">
            Logout
          </button>
        </div>
      </header>
      <div className="accent-line" />
      {demo && <div className="demo-bar">Test environment · simulated shipments, not live SAM data</div>}
      {children}
      {toastMessage ? (
        <div className="toast" role="status">
          {toastMessage}
        </div>
      ) : null}
    </>
  );
}
