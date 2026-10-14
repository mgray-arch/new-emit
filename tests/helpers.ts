import { openDatabase, useTestPortal, type PortalContext } from "@/lib/db";
import { seedDemo } from "@/lib/seed";
import { signSession } from "@/lib/session";
import type { Session } from "@/lib/types";

export const SECRET_MARKERS = [
  "8765.43",
  "8,765.43",
  "876543",
  "BLACKHAWK",
  "998877",
  "INTERNAL-ONLY-SENTINEL",
  "carrierPay",
  "carrier_pay",
  "carrierRate",
  "carrierCost",
  "carrier_name",
  "staff_notes",
  "staffNotes",
];

export function expectNoSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const marker of SECRET_MARKERS) {
    if (text.includes(marker)) {
      throw new Error(`Customer-visible payload contained ${marker}`);
    }
  }
}

export async function seededPortal(): Promise<PortalContext> {
  const ctx: PortalContext = {
    db: openDatabase(":memory:"),
    now: () => new Date("2026-10-14T18:00:00Z"),
  };
  await seedDemo(ctx);
  useTestPortal(ctx);
  return ctx;
}

export async function sessionCookie(session: Session): Promise<string> {
  const token = await signSession(session);
  return `portal_session=${token}`;
}

export function customerSession(): Session {
  return { userId: "customer-1", email: "m.gray@emit.example", name: "M. Gray", role: "customer" };
}

export function adminSession(): Session {
  return { userId: "admin-1", email: "mike@select.example", name: "Mike", role: "admin" };
}
