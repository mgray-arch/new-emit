import { readFileSync } from "node:fs";
import path from "node:path";
import { extractText } from "unpdf";
import { describe, expect, it } from "vitest";
import { extractPdfLiteralText, screenPageBytes, screenPageText } from "@/lib/documents";
import { sensitiveReason } from "@/lib/sensitive";

const DOLLAR_HELD = "A dollar amount is tied to carrier or line-haul language.";

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(process.cwd(), "tests/fixtures", name)));
}

/** Same text layer the ingester passes into screenPageBytes. */
async function extractedPageText(bytes: Uint8Array): Promise<string> {
  const literal = extractPdfLiteralText(bytes).trim();
  const result = await extractText(bytes, { mergePages: true });
  const raw: unknown = result.text;
  const fromPdf = (Array.isArray(raw) ? raw.join("\n") : typeof raw === "string" ? raw : "").trim();
  return [fromPdf, literal].filter(Boolean).join("\n");
}

describe("SAM bill of lading screening", () => {
  it("passes the real Select BOLs, including the OCR pickup-number misread", async () => {
    const samples = [
      { file: "bol_461169-1.pdf", load: "461169-1", pickup: "SO-002002", misread: "$0-002002" },
      { file: "bol_461940-1.pdf", load: "461940-1", pickup: "so-65920, so-64451", misread: "$0-65920, s0-64451" },
    ];
    for (const sample of samples) {
      const bytes = fixture(sample.file);
      // extractText detaches the buffer it is given. Ingest screens a fresh page copy.
      const text = await extractedPageText(bytes.slice());
      expect(text).toMatch(/bill of lading/i);
      expect(text).toMatch(new RegExp(`bol\\s*#:\\s*${sample.load}`, "i"));
      expect(text).toContain(sample.pickup);

      expect(screenPageText(text).decision).toBe("pass");
      expect(sensitiveReason(text)).toBeNull();

      const misread = text.replaceAll(sample.pickup, sample.misread);
      expect(misread).toContain(sample.misread);
      expect(screenPageText(misread).decision).toBe("pass");
      expect(sensitiveReason(misread)).toBeNull();

      const screened = await screenPageBytes({ bytes: bytes.slice(), text, mediaType: "application/pdf" });
      expect(screened.decision).toBe("pass");
    }
  });

  it("does not treat a dashed reference as a dollar amount, even with carrier context", () => {
    expect(sensitiveReason("Carrier MC # 1046091 will pick up $0-002002 at the dock this morning.")).toBeNull();
    expect(sensitiveReason("Carrier MC # 1659149 pickup $0-65920, s0-64451 leaves Sheridan today.")).toBeNull();
    expect(sensitiveReason("Carrier MC # 1046091 reference $12-345 is written on the tender.")).toBeNull();
    expect(sensitiveReason("Carrier MC # 1046091 pickup $12-345 and also $0-002002 on the form.")).toBeNull();
  });

  it("still holds real amounts next to carrier language when the page is not a SAM BOL", () => {
    expect(
      screenPageText("Invoice\nCarrier: ACME TRUCKING LLC\nPlease remit $1,850.00 for this shipment today."),
    ).toMatchObject({ decision: "block", reason: DOLLAR_HELD });
    expect(
      screenPageText("Invoice\nCarrier: ACME TRUCKING LLC\nPlease remit $2500 for this shipment today."),
    ).toMatchObject({ decision: "block", reason: DOLLAR_HELD });
    expect(
      screenPageText("Invoice\nCarrier: ACME TRUCKING LLC\nQuote $1,200-$1,500 for this shipment today."),
    ).toMatchObject({ decision: "block", reason: DOLLAR_HELD });
    expect(sensitiveReason("Carrier MC # 1046091 pickup $0-002002 but the balance is $1,850.00 today.")).toBe(
      DOLLAR_HELD,
    );
    expect(
      screenPageText("BILL OF LADING\nShipper EMIT Technologies\nCarrier ACME\nDeclared value $1,850.00\nFreight prepaid Sheridan WY"),
    ).toMatchObject({ decision: "block", reason: DOLLAR_HELD });
  });

  it("still holds a SAM BOL when an explicit rate-confirmation phrase is present", async () => {
    const text = await extractedPageText(fixture("bol_461169-1.pdf"));
    expect(screenPageText(`${text}\nDeclared value $1,850.00`).decision).toBe("pass");

    const phrases = [
      "Rate Confirmation",
      "See the rate con attached.",
      "Carrier Pay: $1,850.00",
      "Carrier rate $2,500.00",
      "Carrier cost $2500",
      "Load Confirmation",
      "Line haul $1,850.00",
      "Agreed rate $1,200-$1,500",
      "Carrier settlement",
      "Quick pay",
      "Amount due to the carrier $1,850.00",
      "Payable to the carrier $1,850.00",
      "Paid to the carrier $1,850.00",
      "Compensation to the motor carrier $1,850.00",
      "Total carrier pay $1,850.00",
      "Broker-carrier agreement",
    ];
    for (const phrase of phrases) {
      const screened = screenPageText(`${text}\n${phrase}`);
      expect(screened.decision, phrase).toBe("block");
    }
    expect(screenPageText(`${text}\nRate Confirmation`).reason).toMatch(/rate confirmation/i);
    expect(screenPageText(`${text}\nCarrier Pay: $1,850.00`).reason).toMatch(/carrier pay/i);

    const spaced =
      "bill   of   lading\nbol# : 461169 - 1\nCarrier CUSMIR EXPRESS LLC\nMC #: 1046091\nPickup #: $0-002002\nDeclared value $1,850.00";
    expect(screenPageText(spaced).decision).toBe("pass");
    expect(screenPageText(`${spaced}\nRate Confirmation`).reason).toMatch(/rate confirmation/i);
    expect(screenPageText(`${spaced}\nCarrier Pay: $1,850.00`).reason).toMatch(/carrier pay/i);
  });
});
