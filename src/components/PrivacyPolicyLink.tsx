import Link from "next/link";
import { PRIVACY_LINK_LABEL, PRIVACY_PATH } from "@/lib/privacy";

export default function PrivacyPolicyLink({
  className = "vh-privacy-link",
}: {
  className?: string;
}) {
  return (
    <Link href={PRIVACY_PATH} className={className}>
      {PRIVACY_LINK_LABEL}
    </Link>
  );
}
