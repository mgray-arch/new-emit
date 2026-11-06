"use client";

import { Suspense } from "react";
import Dashboard from "@/components/dashboard";
import Shell from "@/components/shell";

export default function NewOrderPage() {
  return (
    <Shell>
      <Suspense fallback={<main className="page"><p className="mini">Loading loads…</p></main>}>
        <Dashboard startNew />
      </Suspense>
    </Shell>
  );
}
