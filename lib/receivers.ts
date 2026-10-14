import { randomUUID } from "node:crypto";
import type { PortalContext } from "@/lib/db";
import { PortalError } from "@/lib/http";
import type { CustomerOrder, Session } from "@/lib/types";

export interface ReceiverAccess {
  id: string;
  matchValue: string;
  company: string;
}

export interface AccessScope {
  /** Set only for a receiver. EMIT staff and Select admins see every EMIT load. */
  receiverCompany: string | null;
}

export function listReceiverAccess(ctx: PortalContext): ReceiverAccess[] {
  const rows = ctx.db
    .prepare(`SELECT id, match_value, company FROM receiver_access ORDER BY company, match_value`)
    .all() as Array<{ id: string; match_value: string; company: string }>;
  return rows.map((row) => ({ id: row.id, matchValue: row.match_value, company: row.company }));
}

export function replaceReceiverAccess(
  ctx: PortalContext,
  entries: Array<{ matchValue: string; company: string }>,
): ReceiverAccess[] {
  const seen = new Set<string>();
  ctx.db.exec("DELETE FROM receiver_access");
  const insert = ctx.db.prepare(
    `INSERT INTO receiver_access (id, match_value, company, created_at) VALUES (?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  for (const entry of entries) {
    const matchValue = entry.matchValue.trim().toLowerCase();
    if (seen.has(matchValue)) continue;
    seen.add(matchValue);
    insert.run(randomUUID(), matchValue, entry.company.trim(), now);
  }
  return listReceiverAccess(ctx);
}

/** Exact email wins, then the email's domain. Values are stored lowercase. */
export function receiverCompanyForEmail(ctx: PortalContext, email: string): string | null {
  const normalized = email.trim().toLowerCase();
  const exact = ctx.db.prepare(`SELECT company FROM receiver_access WHERE match_value = ?`).get(normalized) as
    | { company: string }
    | undefined;
  if (exact) return exact.company;
  const domain = normalized.split("@")[1];
  if (!domain) return null;
  const byDomain = ctx.db.prepare(`SELECT company FROM receiver_access WHERE match_value = ?`).get(domain) as
    | { company: string }
    | undefined;
  return byDomain?.company ?? null;
}

export function accessScope(ctx: PortalContext, session: Session): AccessScope {
  if (session.role !== "receiver") return { receiverCompany: null };
  const company = receiverCompanyForEmail(ctx, session.email);
  if (!company) {
    throw new PortalError("This receiver account is not assigned to a destination company.", 403);
  }
  return { receiverCompany: company };
}

/** Receivers get tracking for their loads, not EMIT's rate with Select. */
export function forViewer(order: CustomerOrder, scope: AccessScope): CustomerOrder {
  if (!scope.receiverCompany) return order;
  return { ...order, customerCost: null, rateReason: null, pendingReviewCount: 0 };
}

export function assertCanChangeOrders(session: Session): void {
  if (session.role === "receiver") {
    throw new PortalError("Receivers can view their loads but cannot change them.", 403);
  }
}
