import { Suspense } from "react";
import { cookies } from "next/headers";
import { getVerifiedSessionFromCookies } from "@/lib/sessionCookies";
import { redirect } from "next/navigation";
import LoginClient from "./LoginClient";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const store = await cookies();
  const role = (await getVerifiedSessionFromCookies(store))?.role ?? null;

  if (role === "admin") redirect("/manage");
  if (role === "caddy" || role === "leader") redirect("/caddy");

  return (
    <Suspense
      fallback={
        <div className="vh-auth-hero">
          <div
            className="vh-auth-bg"
            style={{ backgroundImage: "url(/brand/hero-fairway.jpg)" }}
            aria-hidden
          />
          <div className="vh-auth-overlay" aria-hidden />
          <div className="vh-auth-frame">
            <p style={{ color: "rgba(255,255,255,0.75)", marginTop: 40 }}>
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
