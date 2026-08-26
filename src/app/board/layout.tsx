import { redirect } from "next/navigation";
import { canReadPublishedBoard } from "@/lib/auth";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";

export const dynamic = "force-dynamic";

export default async function BoardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getRequestAuthUser();
  if (!auth || !canReadPublishedBoard(auth.role)) {
    redirect("/login?callbackUrl=/board");
  }
  if (shouldForcePasswordChange(auth)) {
    redirect("/change-password");
  }
  return <>{children}</>;
}
