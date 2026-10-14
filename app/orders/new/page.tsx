"use client";

import Dashboard from "@/components/dashboard";
import Shell from "@/components/shell";

export default function NewOrderPage() {
  return (
    <Shell>
      <Dashboard startNew />
    </Shell>
  );
}
