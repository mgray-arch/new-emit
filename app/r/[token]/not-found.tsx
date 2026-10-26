import { BrandLogo } from "@/components/brand-logo";

export default function ReceiverLinkMissing() {
  return (
    <main className="public">
      <header>
        <BrandLogo />
        <div>
          <div className="brand-name">YOUR DELIVERIES</div>
          <div className="brand-sub">Select Transport Partners</div>
        </div>
      </header>
      <p>This link is not valid.</p>
    </main>
  );
}
