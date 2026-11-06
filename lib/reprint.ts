/** Wording for the reprint banner. Times stay on the status line; this is the warning. */

export function reprintMessage(input: {
  version: number;
  reasons: Array<"carrier_changed" | "bol_updated">;
  bolRemoved: boolean;
  printedCarrierName: string | null;
  printedCarrierMc: string | null;
  currentCarrierName: string | null;
  currentCarrierMc: string | null;
}): string {
  const version = `v${input.version}`;
  const was = who(input.printedCarrierName, input.printedCarrierMc);
  const now = who(input.currentCarrierName, input.currentCarrierMc);
  if (input.bolRemoved) {
    return `REPRINT: the BOL was removed after ${version} was printed. Earlier printed BOLs may show the wrong carrier.`;
  }
  if (input.reasons.includes("carrier_changed") && input.reasons.includes("bol_updated")) {
    return `REPRINT: carrier changed since ${version} was printed (was ${was}, now ${now}) and the BOL file changed. Earlier printed BOLs may show the wrong carrier.`;
  }
  if (input.reasons.includes("carrier_changed")) {
    return `REPRINT: carrier changed since ${version} was printed (was ${was}, now ${now}). Earlier printed BOLs may show the wrong carrier.`;
  }
  return `REPRINT: the BOL file changed since ${version} was printed. Earlier printed BOLs may show the wrong carrier.`;
}

function who(name: string | null, mc: string | null): string {
  const carrier = name?.trim() || "no carrier";
  return mc?.trim() ? `${carrier} MC ${mc.trim()}` : carrier;
}
