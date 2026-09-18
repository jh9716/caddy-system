import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import NewNoticeForm from "./ui/NewNoticeForm";
import { resolveAuthFromCookieStore } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function NewNoticePage() {
  const auth = await resolveAuthFromCookieStore(await cookies());
  if (!auth || auth.role !== "admin") redirect("/login");
  if (auth.mustChangePassword) redirect("/change-password");

  return (
    <div className="notice-page">
      <h1 className="ui-page-title">새 공지</h1>
      <NewNoticeForm />
    </div>
  );
}
