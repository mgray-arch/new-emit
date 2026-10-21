/** EMIT wordmark. White lettering for dark surfaces, ink lettering for light ones. */
export function BrandLogo({ height = 36 }: { height?: number }) {
  return (
    <span className="brand-logo" style={{ height }} role="img" aria-label="EMIT">
      <img className="logo-for-dark" src="/brand/emit-logo.png" alt="" />
      <img className="logo-for-light" src="/brand/emit-logo-ink.png" alt="" />
    </span>
  );
}
