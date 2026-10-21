"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BrandLogo } from "@/components/brand-logo";

interface Me {
  name: string;
  email: string;
  role: "customer" | "emit_viewer" | "emit_admin" | "admin";
  actorRole?: "customer" | "emit_viewer" | "emit_admin" | "admin";
  viewAs?: "customer" | "emit_viewer" | "emit_admin" | null;
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [demo, setDemo] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [toastMessage, setToastMessage] = useState("");
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);

  useEffect(() => {
    setMenu(false);
  }, [pathname]);

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

  async function setView(role: string) {
    const response = await fetch("/api/view-as", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: role === "admin" ? null : role }),
    });
    if (!response.ok) return;
    window.location.href = "/";
  }

  const initials = (me?.name || "EM")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const links = [
    { href: "/", label: "Loads", on: pathname === "/" },
    { href: "/ask", label: "Ask", on: pathname === "/ask", title: "Ask about an order" },
    ...(me?.role === "admin" || me?.role === "emit_admin"
      ? [{ href: "/locations", label: "Locations", on: pathname === "/locations" }]
      : []),
    ...(me?.role === "admin"
      ? [
          { href: "/admin", label: "Review", on: pathname === "/admin" },
          { href: "/admin/users", label: "Users", on: pathname.startsWith("/admin/users") },
          { href: "/admin/settings", label: "Settings", on: pathname.startsWith("/admin/settings") },
        ]
      : []),
    { href: "/account", label: "Password", on: pathname === "/account" },
  ];

  return (
    <div className="app-shell">
      {menu ? <button className="nav-scrim" type="button" aria-label="Close menu" onClick={() => setMenu(false)} /> : null}
      <aside className={menu ? "sidenav open" : "sidenav"}>
        <Link href="/" className="brand">
          <BrandLogo />
          <div>
            <div className="brand-name">EMIT</div>
            <div className="brand-sub">Load portal</div>
          </div>
        </Link>
        <nav className="sidenav-links" aria-label="Main">
          {links.map((link) => (
            <Link key={link.href} href={link.href} className={link.on ? "active" : ""} title={link.title}>
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="sidenav-foot">
          {me?.actorRole === "admin" ? (
            <label className="view-as">
              <span>View as</span>
              <select aria-label="View as" value={me.viewAs || "admin"} onChange={(event) => void setView(event.target.value)}>
                <option value="admin">Select view</option>
                <option value="emit_admin">View as EMIT admin</option>
                <option value="customer">View as EMIT regular user</option>
                <option value="emit_viewer">View as view only</option>
              </select>
            </label>
          ) : null}
          <button
            className="logout"
            type="button"
            onClick={toggleTheme}
            title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          >
            {theme === "light" ? "Dark mode" : "Light mode"}
          </button>
          <span className="who" title={me?.email || "Signed in"}>
            <span className="avatar" title={me?.name || "Your account"}>
              {initials}
            </span>
            <span className="who-name">{me?.name || "…"}</span>
          </span>
          <button className="logout" onClick={logout} type="button" title="Sign out">
            Log out
          </button>
        </div>
      </aside>
      <div className="app-main">
        <header className="mobile-bar">
          <button className="logout" type="button" onClick={() => setMenu(true)} aria-label="Open menu">
            Menu
          </button>
          <Link href="/" className="brand">
            <BrandLogo />
            <span className="brand-name">Loads</span>
          </Link>
        </header>
        {demo && <div className="demo-bar">Test environment. These shipments are not live SAM data.</div>}
        {me?.viewAs ? (
          <div className="view-as-bar" role="status">
            <span>
              {me.viewAs === "emit_admin"
                ? "Viewing as an EMIT admin. You see EMIT's cost and can add loads. Carrier pay stays hidden."
                : me.viewAs === "emit_viewer"
                  ? "Viewing as view only. You cannot add loads, and pricing is hidden."
                  : "Viewing as an EMIT regular user. You can add loads. Pricing is hidden."}
            </span>
            <button className="btn secondary" type="button" onClick={() => void setView("admin")}>
              Back to Select view
            </button>
          </div>
        ) : null}
        {children}
      </div>
      {toastMessage ? (
        <div className="toast" role="status">
          {toastMessage}
        </div>
      ) : null}
    </div>
  );
}
