import Link from "next/link";
import { cookies } from "next/headers";
import { getVerifiedSessionFromCookies } from "@/lib/sessionCookies";
import { PWA_MONOGRAM, PWA_SPLASH_COURSE } from "@/lib/pwaManifest";
import PwaInstallHomeCta from "@/components/PwaInstallHomeCta";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const store = await cookies();
  const role = (await getVerifiedSessionFromCookies(store))?.role ?? null;

  const target =
    role === "admin" ? "/manage" : role === "caddy" || role === "leader" ? "/caddy" : "/login";
  const cta = role ? "대시보드로 이동" : "로그인";

  return (
    <div className="vh-auth-hero vh-home-hero vh-splash-ivory">
      <div
        className="vh-auth-bg vh-splash-course"
        style={{ backgroundImage: `url(${PWA_SPLASH_COURSE})` }}
        aria-hidden
      />
      <div className="vh-auth-overlay vh-splash-ivory-overlay" aria-hidden />

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
            src={PWA_MONOGRAM}
            alt=""
            width={88}
            height={64}
          />
          <h1 className="vh-home-title">VERTHILL</h1>
          <p className="vh-splash-subtitle">Caddy System</p>
          <p className="vh-splash-kicker">Premium Golf Operations</p>
          {role ? <p className="vh-home-lead">현재 역할 · {role}</p> : null}
          <div className="vh-home-cta">
            <Link href={target} className="vh-auth-submit vh-home-btn">
              {cta}
            </Link>
            <PwaInstallHomeCta />
          </div>
        </div>
      </div>
    </div>
  );
}
