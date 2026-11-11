import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as uploadDocument } from "@/app/api/orders/[id]/documents/route";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { GET as receiverPortalRoute } from "@/app/api/r/[token]/route";
import type { PortalContext } from "@/lib/db";
import { findUser, sessionFromUser } from "@/lib/passwords";
import { canUploadBol, canUploadDocs, type Session } from "@/lib/types";
import { adminSession, customerSession, expectNoSecrets, seededPortal, sessionCookie } from "./helpers";

let ctx: PortalContext;

beforeAll(async () => {
  ctx = await seededPortal();
});

function headers(cookie: string): HeadersInit {
  return { cookie, host: "portal.test", origin: "http://portal.test" };
}

const emitViewers: Session[] = [
  { userId: "v", email: "viewer@emit.example", name: "View Only", role: "customer", permission: "view" },
  { userId: "a", email: "add@emit.example", name: "Add", role: "customer", permission: "add" },
  { userId: "p", email: "pricing@emit.example", name: "Pricing", role: "customer", permission: "pricing" },
  { userId: "f", email: "lead@emit.example", name: "Lead", role: "emit_admin", permission: "full" },
  { userId: "s", email: "sales@emit.example", name: "Sales", role: "customer", permission: "view", profile: "sales" },
  { userId: "l", email: "loader@emit.example", name: "Loader", role: "customer", permission: "view", profile: "loader" },
];

async function upload(orderId: string, cookie: string, filename: string, text: string, slot: "bol" | "attachment" = "bol") {
  const form = new FormData();
  form.set("file", new File([new TextEncoder().encode(text)], filename, { type: "text/plain" }));
  form.set("slot", slot);
  return uploadDocument(
    new Request(`http://portal.test/api/orders/${orderId}/documents`, { method: "POST", headers: headers(cookie), body: form }),
    { params: Promise.resolve({ id: orderId }) },
  );
}

describe("Select staff BOL upload", () => {
  it("lets every Select staff member upload a BOL, and keeps EMIT rules the same", () => {
    expect(canUploadBol({ role: "admin" })).toBe(true);
    expect(canUploadBol({ role: "admin", permission: null })).toBe(true);
    expect(canUploadBol(adminSession())).toBe(true);
    for (const viewer of emitViewers) {
      expect(canUploadBol(viewer)).toBe(canUploadDocs(viewer));
    }
    expect(canUploadBol(emitViewers[0])).toBe(false);
    expect(canUploadBol(emitViewers[1])).toBe(true);

    const page = readFileSync(path.join(process.cwd(), "app/orders/[id]/page.tsx"), "utf8");
    expect(page).toContain("const allowBol = canUploadBol(me)");
    expect(page).toContain('aria-label="Upload BOL"');
  });

  it("screens a manual BOL from a Select user who is not the load owner", async () => {
    const load = (await ctx.db.prepare(`SELECT id, owner FROM loads WHERE sales_order_number = ?`).get("SO4501")) as {
      id: string;
      owner: string;
    };
    expect(load.owner).toBe("Ainsley");
    const drew = await sessionCookie({
      userId: "drew-1",
      email: "dmartin@goselect.com",
      name: "Drew Martin",
      role: "admin",
    });
    const clean = await upload(
      load.id,
      drew,
      "drew-bol.txt",
      "BILL OF LADING\nPieces: 4\nWeight 1200 pounds\nShipper EMIT Technologies Sheridan",
    );
    expect(clean.status).toBe(200);
    const cleanBody = await clean.json();
    expect(cleanBody.released).toBe(1);
    expect(cleanBody.heldForReview).toBe(0);
    expect(cleanBody.order.documents.some((doc: { filename: string; kind: string }) => doc.filename === "drew-bol.txt" && doc.kind === "bol")).toBe(true);
    expect(cleanBody.order.owner).toBe("Ainsley");

    const held = await upload(
      load.id,
      drew,
      "rate-con.txt",
      "RATE CONFIRMATION\nCarrier pay $8,765.43\nThis page is a rate confirmation for the carrier.",
    );
    expect(held.status).toBe(200);
    const heldBody = await held.json();
    expect(heldBody.heldForReview).toBeGreaterThan(0);
    expect(heldBody.released).toBe(0);
    expect(JSON.stringify(heldBody.order.documents)).not.toContain("rate-con.txt");
    const stored = (await ctx.db.prepare(`SELECT screen_result, review_status, kind FROM internal_documents WHERE filename = ?`).get("rate-con.txt")) as {
      screen_result: string;
      review_status: string;
      kind: string;
    };
    expect(stored).toMatchObject({ screen_result: "block", review_status: "pending", kind: "rate_confirmation" });
    expect(await ctx.db.prepare(`SELECT id FROM customer_documents WHERE filename = ?`).get("rate-con.txt")).toBeUndefined();

    const emit = await sessionCookie(customerSession());
    const detail = await getOrderRoute(new Request(`http://portal.test/api/orders/${load.id}`, { headers: headers(emit) }), {
      params: Promise.resolve({ id: load.id }),
    });
    expect(detail.status).toBe(200);
    const emitBody = await detail.json();
    expect(JSON.stringify(emitBody)).not.toContain("rate-con.txt");
    expect(JSON.stringify(emitBody)).not.toMatch(/heldForReview|pendingReviewCount|carrierPay|8,765/);
    expect(emitBody.order.documents.some((doc: { filename: string }) => doc.filename === "drew-bol.txt")).toBe(true);
    expectNoSecrets(emitBody);

    const viewerRow = await findUser(ctx, "viewer@emit.example");
    if (!viewerRow) throw new Error("view-only user missing");
    const viewer = await sessionCookie(sessionFromUser(viewerRow));
    const denied = await upload(load.id, viewer, "viewer-bol.txt", "BILL OF LADING\nPieces: 1\nWeight 100 pounds\nNo rate on this page.");
    expect(denied.status).toBe(403);

    const preview = await upload(
      load.id,
      `${drew}; portal_view_as=regular:add`,
      "preview-bol.txt",
      "BILL OF LADING\nPieces: 1\nWeight 100 pounds\nPreview must not store this.",
    );
    expect(preview.status).toBe(403);
    expect(await ctx.db.prepare(`SELECT id FROM customer_documents WHERE filename = ?`).get("preview-bol.txt")).toBeUndefined();

    const stillAllowed = await upload(
      load.id,
      emit,
      "emit-bol.txt",
      "BILL OF LADING\nPieces: 2\nWeight 400 pounds\nShipper EMIT Technologies Sheridan",
    );
    expect(stillAllowed.status).toBe(200);
    const emitUpload = await stillAllowed.json();
    expect(emitUpload).not.toHaveProperty("heldForReview");
    expect(emitUpload).not.toHaveProperty("released");
    expectNoSecrets(emitUpload);

    const token = (await ctx.db.prepare(`SELECT access_token FROM receivers LIMIT 1`).get()) as { access_token: string };
    const receiver = await receiverPortalRoute(new Request(`http://portal.test/api/r/${token.access_token}`), {
      params: Promise.resolve({ token: token.access_token }),
    });
    expect(receiver.status).toBe(200);
    const receiverBody = await receiver.json();
    expect(JSON.stringify(receiverBody)).not.toMatch(/drew-bol|rate-con|emit-bol|documents|carrierPay|8,765/);
    expectNoSecrets(receiverBody);
  });
});
