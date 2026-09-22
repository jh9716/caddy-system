import Link from "next/link";
import {
  ACCOUNT_DELETION_LINK_LABEL,
  ACCOUNT_DELETION_PATH,
} from "@/lib/privacy";

export default function AccountDeletionLink({
  className = "vh-privacy-link",
}: {
  className?: string;
}) {
  return (
    <Link href={ACCOUNT_DELETION_PATH} className={className}>
      {ACCOUNT_DELETION_LINK_LABEL}
    </Link>
  );
}
