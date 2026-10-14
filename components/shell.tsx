"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface Me {
  name: string;
  email: string;
  role: "customer" | "admin";
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    fetch("/api/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => setMe(data))
      .catch(() => setMe(null));
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
          {me?.role === "admin" && (
            <>
              <Link href="/admin" className={pathname === "/admin" ? "active" : ""}>
                Review
              </Link>
              <Link href="/admin/settings" className={pathname.startsWith("/admin/settings") ? "active" : ""}>
                Sites
              </Link>
            </>
          )}
          <span className="who">
            <span className="avatar">{initials}</span>
            {me?.name || "…"}
          </span>
          <button className="logout" onClick={logout} type="button">
            Logout
          </button>
        </div>
      </header>
      <div className="accent-line" />
      {process.env.NEXT_PUBLIC_DEMO_HINT !== "false" && (
        <div className="demo-bar">Test environment · simulated shipments, not live SAM data</div>
      )}
      {children}
    </>
  );
}
