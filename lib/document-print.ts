import { documentOpensInline } from "@/lib/document-view";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A phone-friendly page for one customer file. The Print button is a real tap target.
 * The page does not include prices.
 */
function previewMarkup(input: { src: string; filename: string; mediaType: string }): string {
  const src = escapeHtml(input.src);
  const name = escapeHtml(input.filename || "Document");
  const inline = documentOpensInline(input.mediaType);
  const image = input.mediaType.startsWith("image/");
  if (!inline) {
    return `<p class="note">This file downloads instead of opening on the page.</p><p><a class="btn" href="${src}?download=1">Download ${name}</a></p>`;
  }
  if (image) return `<img alt="${name}" src="${src}" />`;
  return `<iframe title="${name}" src="${src}"></iframe>`;
}

export function documentPrintHtml(input: { src: string; filename: string; mediaType: string }): string {
  const name = escapeHtml(input.filename || "Document");
  return printDocument(`Print ${name}`, name, previewMarkup(input));
}

/** One phone-friendly page for every page of the uploaded BOL. No prices. */
export function bolPrintHtml(pages: Array<{ src: string; filename: string; mediaType: string }>): string {
  const name = escapeHtml(pages[0]?.filename || "BOL");
  const body = pages.map((page) => previewMarkup(page)).join("\n");
  return printDocument(`Print ${name}`, name, body);
}

function printDocument(title: string, heading: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${title}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 16px/1.4 "Segoe UI", sans-serif; color: #1c1916; background: #f6f3ee; }
    header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); }
    h1 { font-size: 16px; margin: 0; overflow-wrap: anywhere; }
    button, a.btn { appearance: none; display: inline-flex; align-items: center; justify-content: center; min-height: 48px; min-width: 48px; padding: 10px 18px; border-radius: 10px; border: 0; background: #e08a2f; color: #1a1208; font: inherit; font-weight: 750; text-decoration: none; }
    iframe, img { display: block; width: 100%; min-height: 70vh; border: 0; background: white; }
    img { height: auto; min-height: 0; object-fit: contain; }
    .note { padding: 0 16px; }
    @media print {
      header, .note { display: none; }
      iframe, img { min-height: 100vh; }
      body { background: white; }
    }
  </style>
</head>
<body>
  <header>
    <h1>${heading}</h1>
    <button type="button" id="print">Print</button>
  </header>
  ${body}
  <script>
    document.getElementById("print").addEventListener("click", function () {
      var frame = document.querySelector("iframe");
      try {
        if (frame && frame.contentWindow) {
          frame.contentWindow.focus();
          frame.contentWindow.print();
          return;
        }
      } catch (e) {}
      window.print();
    });
  </script>
</body>
</html>`;
}
