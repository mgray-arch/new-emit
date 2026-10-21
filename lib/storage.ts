import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PortalError } from "@/lib/http";

/**
 * Document and photo bytes. Vercel Blob when BLOB_READ_WRITE_TOKEN is set.
 * Tests keep bytes in memory. Local dev writes files under data/blobs.
 * The database stores the locator this module returns, never the bytes.
 */

type MemoryStore = Map<string, Uint8Array>;

function memoryStore(): MemoryStore {
  const g = globalThis as typeof globalThis & { __portalBlobs?: MemoryStore };
  g.__portalBlobs ??= new Map();
  return g.__portalBlobs;
}

function memoryMode(): boolean {
  return process.env.PORTAL_TEST_MODE === "1";
}

function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function fileRoot(): string {
  return process.env.PORTAL_BLOB_DIR || path.join(process.cwd(), "data", "blobs");
}

export async function writeStoredBytes(
  key: string,
  bytes: Uint8Array,
  contentType: string,
  options?: { overwrite?: boolean },
): Promise<string> {
  if (memoryMode()) {
    memoryStore().set(key, bytes);
    return `memory:${key}`;
  }
  if (process.env.VERCEL && !blobConfigured()) {
    throw new PortalError(
      "BLOB_READ_WRITE_TOKEN is not set for this deployment. Add it for Preview in Vercel and redeploy to upload files. Sign-in does not need it.",
      503,
    );
  }
  if (blobConfigured()) {
    const { put } = await import("@vercel/blob");
    const blob = await put(key, Buffer.from(bytes), {
      access: "private",
      contentType,
      addRandomSuffix: false,
      allowOverwrite: options?.overwrite === true,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    return blob.url;
  }
  const file = path.join(fileRoot(), key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return `file:${key}`;
}

export async function readStoredBytes(locator: string): Promise<Uint8Array> {
  if (locator.startsWith("memory:")) {
    const bytes = memoryStore().get(locator.slice("memory:".length));
    if (!bytes) throw new Error("Stored file is missing");
    return bytes;
  }
  if (locator.startsWith("file:")) {
    return new Uint8Array(readFileSync(path.join(fileRoot(), locator.slice("file:".length))));
  }
  const { get } = await import("@vercel/blob");
  const result = await get(locator, {
    access: "private",
    token: process.env.BLOB_READ_WRITE_TOKEN,
    useCache: false,
  });
  if (!result || result.statusCode !== 200 || !result.stream) throw new Error("Stored file is missing");
  const buffer = await new Response(result.stream).arrayBuffer();
  return new Uint8Array(buffer);
}
