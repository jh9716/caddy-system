import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import ManageShell from "@/components/manage/ManageShell";

export const dynamic = "force-dynamic";

export default async function ManageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const store = await cookies();
  const role =
    store.get("role")?.value ||
    store.get("session_role")?.value ||
    (store.get("admin")?.value === "1" ? "admin" : null);

  if (role !== "admin") {
    redirect("/login?callbackUrl=/manage");
  }

  return <ManageShell>{children}</ManageShell>;
}
