import { listBolPages } from "@/lib/bol-print";
import { recordBolPrint } from "@/lib/bol-prints";
import { bolPrintHtml } from "@/lib/document-print";
import { documentOpensInline } from "@/lib/document-view";
import { isSession, rejectIfViewingAs, requireSession } from "@/lib/guard";
import { errorResponse, json, PortalError } from "@/lib/http";
import { getOrder } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";
import { canPrintBol } from "@/lib/types";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  documentId: z.string().trim().min(1).max(80),
});

/**
 * Opens the uploaded BOL file for printing and records that print.
 * This does not generate a BOL and it does not print the order screen.
 * View-as cannot record a print. Rate confirmations are not in this list.
 */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const readonly = rejectIfViewingAs(session);
    if (readonly) return readonly;
    if (!canPrintBol(session)) throw new PortalError("This account cannot print a BOL.", 403);
    const { id } = await context.params;
    const ctx = await readyPortal();
    const order = await getOrder(ctx, id);
    if (!order) return json({ error: "Order not found" }, 404);
    const pages = await listBolPages(ctx, id);
    if (!pages.length) return json({ error: "BOL not uploaded yet" }, 404);
    await recordBolPrint(ctx, {
      loadId: id,
      documentId: pages[0].id,
      printedById: session.userId,
      printedByName: session.name,
      carrier: {
        carrierName: order.carrierName ?? null,
        carrierMc: order.carrierMc ?? null,
        driverName: order.driverName ?? null,
      },
    });
    // The browser's own viewer shows one PDF or image and prints that file.
    if (pages.length === 1 && documentOpensInline(pages[0].mediaType)) {
      return new Response(null, {
        status: 302,
        headers: {
          location: `/api/documents/${encodeURIComponent(pages[0].id)}`,
          "cache-control": "no-store",
        },
      });
    }
    const html = bolPrintHtml(
      pages.map((page) => ({
        src: `/api/documents/${encodeURIComponent(page.id)}`,
        filename: page.filename,
        mediaType: page.mediaType,
      })),
    );
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Records a print of one uploaded BOL page. The file itself is opened separately. */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const readonly = rejectIfViewingAs(session);
    if (readonly) return readonly;
    if (!canPrintBol(session)) throw new PortalError("This account cannot print a BOL.", 403);
    const { id } = await context.params;
    const { documentId } = bodySchema.parse(await req.json());
    const ctx = await readyPortal();
    const order = await getOrder(ctx, id);
    if (!order) return json({ error: "Order not found" }, 404);
    const result = await recordBolPrint(ctx, {
      loadId: id,
      documentId,
      printedById: session.userId,
      printedByName: session.name,
      carrier: {
        carrierName: order.carrierName ?? null,
        carrierMc: order.carrierMc ?? null,
        driverName: order.driverName ?? null,
      },
    });
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
