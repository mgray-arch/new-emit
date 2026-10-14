"use client";

import { useEffect, useState } from "react";
import { formatWhen } from "@/lib/dates";

interface PhotoItem {
  id: string;
  filename: string;
  mediaType: string;
  source: string;
  subject: string | null;
  receivedAt: string;
  held: boolean;
  holdReason: string | null;
}

export default function PhotoGallery({
  orderId,
  loadNumber,
  canUpload,
}: {
  orderId: string;
  loadNumber: string;
  canUpload: boolean;
}) {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [source, setSource] = useState("Select admin");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const response = await fetch(`/api/orders/${orderId}/photos`);
    if (!response.ok) {
      setError("Could not load carrier photos");
      return;
    }
    const body = await response.json();
    setPhotos(body.photos ?? []);
    setError("");
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/orders/${orderId}/photos`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("load"))))
      .then((body) => {
        if (!cancelled) {
          setPhotos(body.photos ?? []);
          setError("");
        }
      })
      .catch(() => {
        if (!cancelled) setError("Could not load carrier photos");
      });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  async function upload(file: File) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("loadNumber", loadNumber);
      form.set("source", source.trim() || "Select admin");
      form.set("receivedAt", new Date().toISOString());
      const response = await fetch("/api/ingest/carrier-photos", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not attach photo");
      if (body.duplicate) setNotice("That image is already on this load.");
      else if (!body.visibleToCustomer) setNotice("Held from EMIT. It looked like a rate confirmation.");
      else setNotice("Photo attached.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not attach photo");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="photo-gallery" aria-label="Carrier photos">
      <div className="label">Carrier photos</div>
      <p className="mini">Images from the carrier. PDFs and documents are not accepted here.</p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="mini">{notice}</p>}
      {photos.length === 0 ? <p className="mini">No carrier photos yet.</p> : null}
      <div className="photo-grid">
        {photos.map((photo) => (
          <figure className={photo.held ? "photo-card held" : "photo-card"} key={photo.id}>
            <a href={`/api/carrier-photos/${photo.id}`} target="_blank" rel="noreferrer">
              <img src={`/api/carrier-photos/${photo.id}`} alt={photo.filename} />
            </a>
            <figcaption>
              <div>{photo.filename}</div>
              <div>
                {photo.source} · {formatWhen(photo.receivedAt)}
              </div>
              {photo.subject ? <div>{photo.subject}</div> : null}
              {photo.held ? <div className="held-flag">Held — not shown to EMIT</div> : null}
            </figcaption>
          </figure>
        ))}
      </div>
      {canUpload && (
        <div className="photo-upload">
          <input
            aria-label="Photo source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="Source, such as gmail"
          />
          <input
            aria-label="Upload carrier photo"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
        </div>
      )}
    </section>
  );
}
