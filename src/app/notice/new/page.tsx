import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import NewNoticeForm from "./ui/NewNoticeForm";

export const dynamic = "force-dynamic";

export default async function NewNoticePage() {
  const role = (await cookies()).get("role")?.value ?? null;
  if (role !== "admin") redirect("/login");

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-4 text-xl font-bold">새 공지</h1>
      <NewNoticeForm />
    </div>
  );
}
