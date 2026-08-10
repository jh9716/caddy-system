import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import LoginClient from "./LoginClient";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const store = await cookies();
  const role =
    store.get("role")?.value ||
    store.get("session_role")?.value ||
    null;

  if (role === "admin") redirect("/manage");
  if (role === "caddy") redirect("/caddy");

  return (
    <Suspense fallback={<div className="p-8 text-center text-slate-500">로그인 준비 중…</div>}>
      <LoginClient />
    </Suspense>
  );
}
