/**
 * Re-run a customer_documents attachment through the bill-of-lading screen.
 *
 * Dry-run is the default. Nothing is written until --apply.
 * This does not talk to production unless you point TURSO_DATABASE_URL,
 * TURSO_AUTH_TOKEN, and BLOB_READ_WRITE_TOKEN at that database yourself.
 *
 * Look up the file, then apply it:
 *
 *   npx --yes tsx scripts/refile-attachment.ts \
 *     --load 5c68a9d5-998d-4e3d-b5c4-74a3d8578609 \
 *     --filename "Select-BOL-468322-1_111126-1043.pdf"
 *
 *   npx --yes tsx scripts/refile-attachment.ts \
 *     --load 5c68a9d5-998d-4e3d-b5c4-74a3d8578609 \
 *     --filename "Select-BOL-468322-1_111126-1043.pdf" \
 *     --apply
 *
 * Or one row:
 *
 *   npx --yes tsx scripts/refile-attachment.ts --document <customer_documents.id> --apply
 */
import { getPortalContext } from "@/lib/db";
import { findRefileTargets, refileCustomerAttachment, type RefileOutcome } from "@/lib/refile-attachment";

function flag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Refile failed.";
  return message
    .replace(/libsql:\/\/\S+/gi, "libsql://…")
    .replace(/Bearer\s+\S+/gi, "Bearer …")
    .replace(/[\w.+-]+@[\w.-]+/g, "…")
    .slice(0, 300);
}

function line(label: string, value: string | null): string {
  return `${label}: ${value && value.trim() ? value.trim() : "(none)"}`;
}

function describe(outcome: RefileOutcome): string[] {
  return [
    outcome.note,
    `Document ${outcome.documentId}`,
    `File ${outcome.filename}`,
    `Screen: ${outcome.blocked ? "block" : outcome.held ? "held" : "pass"}`,
    `Slot: ${outcome.slot}`,
    line("Header load number", outcome.parsedLoadNumber),
    line("Carrier", outcome.parsedCarrierName),
    line("MC", outcome.parsedCarrierMc),
    line("Load number on the order now", outcome.currentLoadNumber),
    outcome.applied ? "Wrote the change." : "Nothing was written.",
  ];
}

async function main(): Promise<void> {
  if (!process.env.TURSO_DATABASE_URL?.trim()) {
    console.error("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN from the production environment. This script will not open a local database.");
    process.exitCode = 1;
    return;
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    console.error("Set BLOB_READ_WRITE_TOKEN from the production environment so the file bytes can be read. The value was not printed.");
    process.exitCode = 1;
    return;
  }

  const apply = process.argv.includes("--apply");
  const documentId = flag("--document");
  const loadId = flag("--load");
  const filename = flag("--filename");
  if (!documentId && !(loadId && filename)) {
    console.error('Pass --document <id> or --load <loads.id> --filename "Select-BOL-468322-1_111126-1043.pdf"');
    process.exitCode = 1;
    return;
  }

  const ctx = await getPortalContext();
  const targets = await findRefileTargets(ctx, { documentId, loadId, filename });
  if (!targets.length) {
    console.error("No customer document matched. Nothing was written.");
    process.exitCode = 1;
    return;
  }

  const attachments = targets.filter((target) => target.kind === "attachment");
  const bols = targets.filter((target) => target.kind === "bol");
  if (!attachments.length) {
    console.log(`Already filed as a BOL (${bols.length} row${bols.length === 1 ? "" : "s"}). Nothing was written.`);
    return;
  }

  console.log(apply ? "Applying." : "Dry run. Nothing is written until you pass --apply.");
  let failed = false;
  for (const target of attachments) {
    try {
      const outcome = await refileCustomerAttachment(ctx, target.id, apply);
      console.log(describe(outcome).join("\n"));
      console.log("");
    } catch (error) {
      failed = true;
      console.error(publicError(error));
    }
  }
  if (failed) process.exitCode = 1;
  else if (!apply) console.log("Run the same command with --apply to write.");
}

main().catch((error: unknown) => {
  console.error(publicError(error));
  process.exitCode = 1;
});
