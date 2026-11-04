"use client";

export default function TrackLink({
  href,
  label = "Track",
  onClick,
}: {
  href: string | null | undefined;
  label?: string;
  onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  if (!href) return null;
  return (
    <a className="btn secondary track-btn" href={href} target="_blank" rel="noreferrer" title="Open live tracking" onClick={onClick}>
      {label}
    </a>
  );
}
