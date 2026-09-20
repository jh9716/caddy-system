import Link from "next/link";
import { cookies } from "next/headers";
import { getVerifiedSessionFromCookies } from "@/lib/sessionCookies";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const store = await cookies();
  const role = (await getVerifiedSessionFromCookies(store))?.role ?? null;

  const target =
    role === "admin" ? "/manage" : role === "caddy" || role === "leader" ? "/caddy" : "/login";
  const cta = role ? "대시보드로 이동" : "로그인";

  return (
    <div className="vh-auth-hero vh-home-hero">
      <div
        className="vh-auth-bg"
        style={{ backgroundImage: "url(/brand/hero-green.jpg)" }}
        aria-hidden
      />
      <div className="vh-auth-overlay vh-home-overlay" aria-hidden />

      <div className="vh-auth-frame">
        <header className="vh-auth-top">
          <div className="vh-auth-brand">
            VERTHILL <span>Caddy System</span>
          </div>
          {!role && (
            <Link href="/login" className="vh-home-top-link">
              로그인
            </Link>
          )}
        </header>

        <div className="vh-home-center vh-splash-center">
          <img
            className="vh-splash-mark"
            src="/icons/icon-192.png"
            alt=""
            width={72}
            height={72}
          />
          <h1 className="vh-home-title">VERTHILL</h1>
          <p className="vh-splash-subtitle">Caddy System</p>
          {role ? <p className="vh-home-lead">현재 역할 · {role}</p> : null}
          <div className="vh-home-cta">
            <Link href={target} className="vh-auth-submit vh-home-btn">
              {cta}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
