import AccountDeletionLink from "@/components/AccountDeletionLink";
import PrivacyPolicyLink from "@/components/PrivacyPolicyLink";

export default function LegalLinks({
  className = "vh-auth-legal",
}: {
  className?: string;
}) {
  return (
    <p className={className}>
      <PrivacyPolicyLink />
      <span aria-hidden> · </span>
      <AccountDeletionLink />
    </p>
  );
}
