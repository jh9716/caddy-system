import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { canManageOffRequests } from "@/lib/offRequestAuth";
import OffRequestMemberClient from "./OffRequestMemberClient";

export const dynamic = "force-dynamic";

export default async function OffRequestsPage() {
  const auth = await getRequestAuthUser();
  if (!auth) return null;

  const actor = {
    role: auth.role,
    username: auth.username,
    userId: auth.userId,
    caddyId: auth.caddyId,
    managedTeams: auth.managedTeams,
  };

  return (
    <OffRequestMemberClient
      linked={auth.caddyId != null}
      showInbox={canManageOffRequests(actor)}
      managedTeams={auth.managedTeams}
    />
  );
}
