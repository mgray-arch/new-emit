import Link from "next/link";
import { updateBannerText } from "@/lib/carrier-seen";

/** Tap to show only the loads with a carrier update this person has not opened. */
export default function UpdateBanner({ count }: { count: number }) {
  if (count < 1) return null;
  return (
    <Link href="/?updated=1" className="update-banner">
      {updateBannerText(count)}
    </Link>
  );
}
