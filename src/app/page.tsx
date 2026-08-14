import Link from "next/link";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const store = await cookies();
  const role =
    store.get("role")?.value ||
    store.get("session_role")?.value ||
    (store.get("admin")?.value === "1" ? "admin" : null);

  const target =
    role === "admin" ? "/manage" : role === "caddy" ? "/caddy" : "/login";
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
            VERTHILL <span>Caddy</span>
          </div>
          {!role && (
            <Link href="/login" className="vh-home-top-link">
              로그인
            </Link>
          )}
        </header>

        <div className="vh-home-center">
          <p className="vh-auth-eyebrow">Premium Golf Resort</p>
          <h1 className="vh-home-title">VERTHILL Caddy</h1>
          <div className="vh-auth-rule" aria-hidden />
          <p className="vh-home-lead">
            {role
              ? `현재 역할 · ${role}`
              : "캐디 · 가용 · 배치를 하나의 운영 흐름으로"}
          </p>
          <div className="vh-home-cta">
            <Link href={target} className="vh-auth-submit vh-home-btn">
              {cta}
            </Link>
          </div>
        </div>

        <footer className="vh-home-foot">
          <span>Operations Console</span>
        </footer>
      </div>
    </div>
  );
}
