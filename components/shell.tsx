"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BrandLogo } from "@/components/brand-logo";
import UpdateBanner from "@/components/update-banner";
import { PERMISSION_LABEL, type EmitPermission, type ViewAsPreview } from "@/lib/types";

interface Me {
  name: string;
  email: string;
  role: "customer" | "emit_viewer" | "emit_admin" | "admin";
  actorRole?: "customer" | "emit_viewer" | "emit_admin" | "admin";
  profile?: "sales" | "loader" | null;
  viewAs?: ViewAsPreview | null;
  readOnly?: boolean;
  chatEnabled?: boolean;
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [demo, setDemo] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [toastMessage, setToastMessage] = useState("");
  const [menu, setMenu] = useState(false);
  const [unread, setUnread] = useState(0);
  const [updates, setUpdates] = useState(0);

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

  const chatEnabled = Boolean(me?.chatEnabled);

  useEffect(() => {
    if (!chatEnabled) {
      setUnread(0);
      return;
    }
    let stop = false;
    async function pullUnread() {
      try {
        const response = await fetch("/api/messages/unread");
        if (!response.ok) return;
        const body = (await response.json()) as { count?: number };
        if (!stop) setUnread(Number(body.count) || 0);
      } catch {
        /* The nav still works when the count cannot be loaded. */
      }
    }
    void pullUnread();
    const timer = window.setInterval(() => void pullUnread(), 15_000);
    window.addEventListener("emit-messages-read", pullUnread);
    return () => {
      stop = true;
      window.clearInterval(timer);
      window.removeEventListener("emit-messages-read", pullUnread);
    };
  }, [pathname, chatEnabled]);

  useEffect(() => {
    let stop = false;
    fetch("/api/updates")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { count?: number } | null) => {
        if (!stop) setUpdates(Number(body?.count) || 0);
      })
      .catch(() => {
        if (!stop) setUpdates(0);
      });
    return () => {
      stop = true;
    };
  }, [pathname]);

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

  async function setView(access: "select" | "admin" | "sales" | "loader", permission?: EmitPermission) {
    const nextPermission = permission ?? me?.viewAs?.permission ?? "full";
    const response = await fetch("/api/view-as", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(access === "select" ? { access: null } : access === "admin" ? { access, permission: nextPermission } : { access }),
    });
    if (!response.ok) return;
    window.location.href = "/";
  }

  const viewChoice = me?.viewAs?.profile === "sales" || me?.viewAs?.profile === "loader" ? me.viewAs.profile : (me?.viewAs?.access ?? "select");
  const viewAsName =
    me?.viewAs?.profile === "sales"
      ? "Sales"
      : me?.viewAs?.profile === "loader"
        ? "Loader"
        : me?.viewAs?.access === "admin"
          ? "an EMIT admin"
          : "an EMIT user";

  const initials = (me?.name || "EM")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const links = [
    { href: "/", label: "Loads", on: pathname === "/" },
    ...(chatEnabled
      ? [
          {
            href: "/messages",
            label: "Messages",
            on: pathname === "/messages",
            title: unread > 0 ? `Messages, ${unread} unread` : "Messages with Select",
          },
        ]
      : []),
    { href: "/ask", label: "Ask", on: pathname === "/ask", title: "Ask about an order" },
    ...((me?.role === "admin" || me?.role === "emit_admin") && (me.viewAs?.profile ?? me.profile) !== "sales" && (me.viewAs?.profile ?? me.profile) !== "loader"
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
              <span>{link.label}</span>
              {link.href === "/messages" && unread > 0 ? (
                <span className="nav-count">{unread > 99 ? "99+" : unread}</span>
              ) : null}
            </Link>
          ))}
        </nav>
        <div className="sidenav-foot">
          {me?.actorRole === "admin" ? (
            <div className="view-as">
              <label>
                <span>View as</span>
                <select
                  aria-label="View as"
                  value={viewChoice}
                  onChange={(event) => void setView(event.target.value as "select" | "admin" | "sales" | "loader")}
                >
                  <option value="select">Select view</option>
                  <option value="admin">View as EMIT admin</option>
                  <option value="sales">View as Sales</option>
                  <option value="loader">View as Loader</option>
                </select>
              </label>
              {me.viewAs?.access === "admin" && !me.viewAs.profile ? (
                <label>
                  <span>Permission</span>
                  <select
                    aria-label="Permission to preview"
                    value={me.viewAs.permission}
                    onChange={(event) => void setView("admin", event.target.value as EmitPermission)}
                  >
                    {(Object.keys(PERMISSION_LABEL) as EmitPermission[])
                      .filter((permission) => {
                        if (me.viewAs?.profile === "loader" || me.viewAs?.profile === "sales") return permission === "view";
                        return true;
                      })
                      .map((permission) => (
                      <option key={permission} value={permission}>
                        {PERMISSION_LABEL[permission]}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
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
          {chatEnabled ? (
            <Link
              href="/messages"
              className="mobile-messages"
              aria-label={unread > 0 ? `Messages, ${unread} unread` : "Messages"}
            >
              <span>Messages</span>
              {unread > 0 ? <span className="nav-count">{unread > 99 ? "99+" : unread}</span> : null}
            </Link>
          ) : null}
        </header>
        {demo && <div className="demo-bar">Test environment. These shipments are not live SAM data.</div>}
        {me?.viewAs ? (
          <div className="view-as-bar" role="status">
            <span>
              Read-only. Viewing as {viewAsName}
              {me.viewAs.profile ? ". Sales and Loader can look, and they do not see EMIT's cost." : me.viewAs.access === "admin" ? ` with ${PERMISSION_LABEL[me.viewAs.permission]}.` : "."}{" "}
              You see what that account sees. Nothing is saved. Carrier pay stays hidden.
            </span>
            <button className="btn secondary" type="button" onClick={() => void setView("select")}>
              Back to Select view
            </button>
          </div>
        ) : null}
        <UpdateBanner count={updates} />
        {children}
      </div>
      <nav className="bottom-nav" aria-label="Mobile">
        <Link href="/" className={pathname === "/" ? "on" : ""}>
          Loads
        </Link>
        {chatEnabled ? (
          <Link
            href="/messages"
            className={pathname === "/messages" ? "on" : ""}
            aria-label={unread > 0 ? `Messages, ${unread} unread` : "Messages"}
          >
            <span>Messages</span>
            {unread > 0 ? <span className="nav-count">{unread > 99 ? "99+" : unread}</span> : null}
          </Link>
        ) : null}
        <Link href="/ask" className={pathname === "/ask" ? "on" : ""}>
          Ask
        </Link>
        <button type="button" onClick={() => setMenu(true)}>
          More
        </button>
      </nav>
      {toastMessage ? (
        <div className="toast" role="status">
          {toastMessage}
        </div>
      ) : null}
    </div>
  );
}
