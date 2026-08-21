import { redirect } from "next/navigation";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";
import ChangePasswordClient from "./ChangePasswordClient";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage() {
  const auth = await getRequestAuthUser();
  if (!auth) redirect("/login?callbackUrl=/change-password");
  if (auth.userId == null) redirect("/manage");

  return (
    <ChangePasswordClient
      forced={shouldForcePasswordChange(auth)}
      username={auth.username}
    />
  );
}
