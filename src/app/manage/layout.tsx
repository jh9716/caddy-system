import { redirect } from "next/navigation";
import ManageShell from "@/components/manage/ManageShell";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";

export const dynamic = "force-dynamic";

export default async function ManageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getRequestAuthUser();
  if (!auth || auth.role !== "admin") {
    redirect("/login?callbackUrl=/manage");
  }
  if (shouldForcePasswordChange(auth)) {
    redirect("/change-password");
  }

  return <ManageShell>{children}</ManageShell>;
}
