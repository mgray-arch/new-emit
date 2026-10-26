import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicPath } from "@/lib/session";

function walk(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    if (/\.(ts|tsx)$/.test(entry.name)) return [full];
    return [];
  });
}

describe("boundaries", () => {
  it("keeps server-only modules out of client components", () => {
    const files = [...walk("components"), ...walk("app")];
    const forbidden = /@\/lib\/(seed|db|orders|documents|sam|portal|passwords|email|session|guard|photos|users|select-load|bot-documents)/;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const client = text.includes('"use client"') || text.includes("'use client'");
      if (!client) continue;
      expect(text, file).not.toMatch(forbidden);
      expect(text, file).not.toContain("BLACKHAWK");
      expect(text, file).not.toContain("8765.43");
      expect(text, file).not.toContain("INTERNAL-ONLY-SENTINEL");
    }
  });

  it("does not leave order or admin APIs public", () => {
    expect(isPublicPath("/api/orders")).toBe(false);
    expect(isPublicPath("/api/admin/review")).toBe(false);
    expect(isPublicPath("/api/ask")).toBe(false);
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/auth/login")).toBe(true);
    expect(isPublicPath("/api/auth/providers")).toBe(true);
    expect(isPublicPath("/api/admin/users")).toBe(false);
    expect(isPublicPath("/api/me/password")).toBe(false);
    expect(isPublicPath("/api/auth/google")).toBe(true);
    expect(isPublicPath("/api/auth/google/callback")).toBe(true);
    expect(isPublicPath("/api/admin/receivers")).toBe(false);
    expect(isPublicPath("/r/demo-receiver-token")).toBe(true);
    expect(isPublicPath("/api/r/demo-receiver-token")).toBe(true);
    expect(isPublicPath("/api/r/demo-receiver-token/photos/abc")).toBe(true);
    expect(isPublicPath("/track/demo-token")).toBe(true);
    expect(isPublicPath("/api/ingest/carrier-photos")).toBe(true);
    expect(isPublicPath("/api/integrations/documents")).toBe(true);
    expect(isPublicPath("/api/integrations/tracking-link")).toBe(true);
    expect(isPublicPath("/api/integrations/sam-load")).toBe(true);
    expect(isPublicPath("/api/integrations")).toBe(false);
    expect(isPublicPath("/api/documents/abc")).toBe(false);
    expect(isPublicPath("/api/carrier-photos/abc")).toBe(false);
    expect(isPublicPath("/api/orders/abc/photos")).toBe(false);
    expect(isPublicPath("/messages")).toBe(false);
    expect(isPublicPath("/api/messages")).toBe(false);
    expect(isPublicPath("/api/messages/unread")).toBe(false);
    expect(isPublicPath("/api/messages/read")).toBe(false);
    expect(isPublicPath("/api/messages/loads")).toBe(false);
  });
});
