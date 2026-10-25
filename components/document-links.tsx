import { documentOpensInline } from "@/lib/document-view";
import type { CustomerDocument } from "@/lib/types";

/** View opens a PDF or image in a new tab. Download always saves the file. */
export default function DocumentLinks({ doc, label }: { doc: CustomerDocument; label?: string }) {
  const name = label || doc.filename;
  const viewPdf = doc.mediaType === "application/pdf";
  const viewLabel = viewPdf ? "View PDF" : "View";
  return (
    <div className="doc-links">
      <span className="doc-name">{name}</span>
      {documentOpensInline(doc.mediaType) ? (
        <a href={`/api/documents/${doc.id}`} target="_blank" rel="noopener noreferrer" aria-label={`${viewLabel} ${doc.filename}`}>
          {viewLabel}
        </a>
      ) : null}
      <a
        href={`/api/documents/${doc.id}?download=1`}
        download={doc.filename}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Download ${doc.filename}`}
      >
        Download
      </a>
    </div>
  );
}
