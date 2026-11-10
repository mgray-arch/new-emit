import type { ReactNode } from "react";

/**
 * Display-only sales order number. CSS uppercases and bolds it.
 * The text node stays the stored value, so search, Slack, APIs, and matching are unchanged.
 */
export default function SoNumber({ children }: { children: ReactNode }) {
  return <span className="so-number">{children}</span>;
}
