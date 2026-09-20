import { Suspense } from "react";
import { redirect } from "next/navigation";
import LoginClient from "./LoginClient";
import { getRequestAuthUser } from "@/lib/getRequestAuthUser";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const auth = await getRequestAuthUser();
  if (shouldForcePasswordChange(auth)) redirect("/change-password");
  if (auth?.role === "admin") redirect("/manage");
  if (auth?.role === "caddy" || auth?.role === "leader") redirect("/caddy");

  return (
    <Suspense
      fallback={
        <div className="vh-auth-hero vh-splash-ivory">
          <div
            className="vh-auth-bg vh-splash-course"
            style={{ backgroundImage: "url(/brand/splash-course.jpg)" }}
            aria-hidden
          />
          <div className="vh-auth-overlay vh-splash-ivory-overlay" aria-hidden />
          <div className="vh-auth-frame">
            <p style={{ color: "#163028", marginTop: 40 }}>
              로그인 준비 중…
            </p>
          </div>
        </div>
      }
    >
      <LoginClient />
    </Suspense>
  );
}
