import { coverLoadFromReleasedBol } from "@/lib/bol-coverage";
import type { PortalContext } from "@/lib/db";
import { screenUpload, storeScreenedUpload, type IngestResult, type ScreenedUploadPage } from "@/lib/documents";
import { customerUploadSlot, parseSamBol, type SamBolFields } from "@/lib/sam-bol";
import { sensitiveReason } from "@/lib/sensitive";

export interface ClassifiedUpload {
  pages: ScreenedUploadPage[];
  text: string;
  slot: "attachment" | "bol";
  /** A page is unclear or blocked, so it must not be shown to EMIT yet. */
  held: boolean;
  /** Rate-confirmation language. Must not be released, including from the review page. */
  blocked: boolean;
  parsed: SamBolFields;
}

/**
 * Same page screen a manual upload uses. A Select bill of lading is a BOL
 * even when the control that received the file was the other-file input.
 */
export async function classifyCustomerUpload(
  filename: string,
  bytes: Uint8Array,
  requested: "attachment" | "bol",
): Promise<ClassifiedUpload> {
  const pages = await screenUpload(filename, bytes);
  const text = pages
    .map((page) => page.text ?? "")
    .filter((part) => part.trim())
    .join("\n");
  const slot = customerUploadSlot(requested, filename, text);
  const blocked = pages.some((page) => page.decision === "block") || Boolean(sensitiveReason(text));
  const held = blocked || pages.some((page) => page.decision !== "pass");
  const parsed =
    !blocked && slot === "bol" ? parseSamBol(text) : { loadNumber: null, carrierName: null, carrierMc: null };
  return { pages, text, slot, held, blocked, parsed };
}

/**
 * Screen, store, and when the file is a bill of lading fill the load number,
 * carrier company, and MC from the header. Held pages stay on the review queue.
 */
export async function fileCustomerDocument(
  ctx: PortalContext,
  input: {
    loadId: string;
    filename: string;
    bytes: Uint8Array;
    slot: "attachment" | "bol";
    uploadedBy?: string | null;
  },
): Promise<IngestResult & { slot: "attachment" | "bol" }> {
  const classified = await classifyCustomerUpload(input.filename, input.bytes, input.slot);
  const stored = await storeScreenedUpload(ctx, {
    loadId: input.loadId,
    filename: input.filename,
    slot: classified.slot,
    uploadedBy: input.uploadedBy,
    pages: classified.pages,
  });
  if (classified.slot === "bol" && stored.releasedIds.length > 0) {
    await coverLoadFromReleasedBol(ctx, input.loadId, stored.releasedTexts.join("\n"));
  }
  return { ...stored, slot: classified.slot };
}
