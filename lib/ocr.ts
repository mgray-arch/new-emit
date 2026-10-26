import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Worker } from "tesseract.js";

/**
 * Reads words out of an uploaded image or a rendered PDF page before the file
 * is shown to anyone.
 *
 * tesseract.js runs inside the Node server, including Vercel, and does not need
 * an API key. English data comes from @tesseract.js-data/eng (the LSTM
 * best_int set the library uses). PDF pages are rasterized with unpdf and
 * @napi-rs/canvas first, so a scanned page with no text layer is still read.
 * A thrown worker, a missing language file, or a render error is a failed read.
 */

export interface OcrRead {
  ok: boolean;
  text: string;
  confidence: number;
  reason: string | null;
}

const FAIL_REASON = "OCR could not read this file. It stays with Select until someone reviews it.";
const CACHE_DIR = process.env.OCR_CACHE_DIR || "/tmp/emit-ocr-cache";
const LANG_CACHE = "/tmp/tesseract-lang";

const langPath = path.join(process.cwd(), "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int");

let workerPromise: Promise<Worker> | null = null;
let inflight = 0;
let idle: NodeJS.Timeout | null = null;

function cachePath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

function readCache(key: string): OcrRead | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(key), "utf8")) as OcrRead;
    if (!parsed || parsed.ok !== true || typeof parsed.text !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(key: string, value: OcrRead): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath(key), JSON.stringify(value));
  } catch {
    // A full disk must not turn a successful read into a failure.
  }
}

async function shutdown(): Promise<void> {
  const pending = workerPromise;
  workerPromise = null;
  if (!pending) return;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    // The next read starts a new worker.
  }
}

function scheduleIdle(): void {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    if (inflight === 0) void shutdown();
  }, 1000);
  idle.unref?.();
}

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    const { createWorker } = await import("tesseract.js");
    workerPromise = createWorker("eng", 1, {
      langPath,
      cachePath: LANG_CACHE,
      errorHandler: () => {},
    }).catch((error: unknown) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

async function recognize(bytes: Uint8Array): Promise<{ text: string; confidence: number }> {
  inflight += 1;
  if (idle) clearTimeout(idle);
  try {
    const worker = await getWorker();
    const result = await Promise.race([
      worker.recognize(Buffer.from(bytes)),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("OCR timed out")), 25_000);
        timer.unref?.();
      }),
    ]);
    return { text: result.data.text ?? "", confidence: Number(result.data.confidence ?? 0) };
  } catch (error) {
    await shutdown();
    throw error;
  } finally {
    inflight -= 1;
    scheduleIdle();
  }
}

/** OCR one image. The same bytes are not read twice in this process or later ones on this machine. */
export async function readImageText(bytes: Uint8Array): Promise<OcrRead> {
  const key = createHash("sha256").update(bytes).digest("hex");
  const cached = readCache(key);
  if (cached) return cached;
  try {
    const result = await recognize(bytes);
    const value: OcrRead = { ok: true, text: result.text, confidence: result.confidence, reason: null };
    writeCache(key, value);
    return value;
  } catch {
    return { ok: false, text: "", confidence: 0, reason: FAIL_REASON };
  }
}

/** Rasterize one single-page PDF, then OCR the pixels. A render failure is a failed read. */
export async function readPdfPageText(pageBytes: Uint8Array): Promise<OcrRead> {
  try {
    const { renderPageAsImage } = await import("unpdf");
    // Copy first. Rendering can detach the buffer it was given, and that buffer is what we store.
    const rendered = await renderPageAsImage(new Uint8Array(pageBytes), 1, {
      scale: 2,
      canvasImport: () => import("@napi-rs/canvas"),
    });
    return readImageText(new Uint8Array(rendered));
  } catch {
    return { ok: false, text: "", confidence: 0, reason: FAIL_REASON };
  }
}
