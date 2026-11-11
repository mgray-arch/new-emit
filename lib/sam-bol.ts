import { extractPdfLiteralText } from "@/lib/documents";
import { sensitiveReason } from "@/lib/sensitive";

/**
 * Carrier identity printed on a Select SAM bill of lading.
 * Company name, MC number, and the BOL header load number only.
 * Pay, rate, DOT, driver, email, and phone are not read.
 */
export interface SamBolFields {
  loadNumber: string | null;
  carrierName: string | null;
  carrierMc: string | null;
}

const LOAD_NUMBER = /BOL\s*#\s*:\s*(\d{4,10})\s*-\s*(\d{1,3})(?!\d)/i;
const MC_NUMBER = /MC\s*#\s*:?\s*(\d{1,8})\b/i;
const NAME_STOP = /\s+(?=MC\s*#|DOT\s*#|Truck\s*#|Trailer\s*#|Driver\b|Bill\s+To\b|3rd\s+Party\b|Shipper\b|Consignee\b|Load\s+Instructions\b)/i;

function cleanCarrierName(raw: string): string | null {
  const value = raw.replace(/\s+/g, " ").trim().split(NAME_STOP)[0]?.trim() ?? "";
  if (value.length < 2 || value.length > 120) return null;
  if (/\$|@/.test(value)) return null;
  if (/^(signature|acknowledges)\b/i.test(value)) return null;
  if (sensitiveReason(value)) return null;
  return value;
}

/** Read the carrier company, MC, and BOL # from SAM bill-of-lading text. */
export function parseSamBol(text: string): SamBolFields {
  const load = text.match(LOAD_NUMBER);
  const loadNumber = load ? `${load[1]}-${load[2]}` : null;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let carrierName: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^carrier\s+(signature|acknowledges)\b/i.test(line)) continue;
    if (/^carrier\s*:?\s*$/i.test(line)) {
      carrierName = cleanCarrierName(lines[index + 1] ?? "");
      break;
    }
    const inline = line.match(/^carrier\s*:?\s+(.+)$/i);
    if (inline) {
      carrierName = cleanCarrierName(inline[1]);
      break;
    }
  }
  const mc = text.match(MC_NUMBER);
  return { loadNumber, carrierName, carrierMc: mc ? mc[1] : null };
}

function foldName(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function foldMc(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/^mc[\s#-]*/i, "").replace(/\s+/g, "");
}

const BOL_FILENAME =
  /(?:^|[^A-Za-z0-9])(?:select[-_\s]*)?bol[-_\s]+(\d{4,10})[-_](\d{1,3})(?!\d)/i;

/** Load number in Select-BOL-468322-1….pdf, BOL-468322-1.pdf, or bol_467623-1.txt. */
export function bolLoadNumberFromFilename(filename: string): string | null {
  const match = filename.match(BOL_FILENAME);
  if (!match) return null;
  return `${match[1]}-${match[2]}`;
}

/**
 * A bill of lading names itself and its BOL number, and does not read as carrier pay.
 * A rate confirmation that also says "bill of lading" is not this.
 */
export function recognizableBolText(text: string): boolean {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length < 20) return false;
  if (sensitiveReason(text)) return false;
  if (!/bill\s+of\s+lading/i.test(text)) return false;
  return /(?:bol|load)\s*#\s*:?\s*\d{4,10}\s*-\s*\d{1,3}(?!\d)/i.test(text);
}

/**
 * The slot the user picked, upgraded when the file is a Select bill of lading.
 * Filename Select-BOL-<load> or BOL-<load>, or a BOL header in the text.
 */
export function customerUploadSlot(
  requested: "attachment" | "bol",
  filename: string,
  text: string,
): "attachment" | "bol" {
  if (requested === "bol") return "bol";
  if (bolLoadNumberFromFilename(filename)) return "bol";
  if (recognizableBolText(text)) return "bol";
  return "attachment";
}

/** True when the stored company and MC are the carrier printed on the BOL. */
export function sameBolCarrier(
  bol: { carrierName: string | null; carrierMc: string | null },
  stored: { carrierName: string | null; carrierMc: string | null },
): boolean {
  const bolName = foldName(bol.carrierName);
  const storedName = foldName(stored.carrierName);
  const bolMc = foldMc(bol.carrierMc);
  const storedMc = foldMc(stored.carrierMc);
  if (!bolName && !bolMc) return false;
  if (!storedName && !storedMc) return false;
  return bolName === storedName && bolMc === storedMc;
}

/** Text layer of a released BOL. Images are left alone; screening already read those. */
export async function textFromBolBytes(mediaType: string, bytes: Uint8Array): Promise<string> {
  if (mediaType === "text/plain") return Buffer.from(bytes).toString("utf8");
  if (mediaType !== "application/pdf") return "";
  const copy = bytes.slice();
  const literal = extractPdfLiteralText(copy).trim();
  try {
    const { extractText } = await import("unpdf");
    const result = await extractText(copy, { mergePages: true });
    const raw: unknown = result.text;
    const fromPdf = (Array.isArray(raw) ? raw.join("\n") : typeof raw === "string" ? raw : "").trim();
    return [fromPdf, literal].filter(Boolean).join("\n");
  } catch {
    return literal;
  }
}
