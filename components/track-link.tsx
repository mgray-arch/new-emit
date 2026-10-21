"use client";

export default function TrackLink({
  href,
  onClick,
}: {
  href: string | null | undefined;
  onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  if (!href) return null;
  return (
    <a className="btn secondary track-btn" href={href} target="_blank" rel="noreferrer" onClick={onClick}>
      Track
    </a>
  );
}
