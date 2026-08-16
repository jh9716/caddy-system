import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import ManageShell from "@/components/manage/ManageShell";
import { resolveAuthFromCookieStore } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function ManageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await resolveAuthFromCookieStore(await cookies());
  if (!auth || auth.role !== "admin") {
    redirect("/login?callbackUrl=/manage");
  }

  return <ManageShell>{children}</ManageShell>;
}
