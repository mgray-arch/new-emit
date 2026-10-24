export function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() || "document";
  const cleaned = base.replace(/[^\w.\- ()]+/g, "_").slice(0, 80);
  return cleaned || "document";
}

/** PDFs and images can open in a browser tab. Everything else stays a download. */
export function documentOpensInline(mediaType: string): boolean {
  return mediaType === "application/pdf" || mediaType === "image/png" || mediaType === "image/jpeg";
}

/** `?download=1` forces a download. Other values, including a missing flag, do not. */
export function wantsDocumentDownload(flag: string | null): boolean {
  return flag === "1";
}

export function documentContentDisposition(mediaType: string, filename: string, download: boolean): string {
  const mode = download || !documentOpensInline(mediaType) ? "attachment" : "inline";
  return `${mode}; filename="${safeFilename(filename)}"`;
}
