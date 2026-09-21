"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import PwaInstallCard from "@/components/PwaInstallCard";
import { PWA_MONOGRAM, PWA_SPLASH_COURSE } from "@/lib/pwaManifest";
import { resolvePostLoginHref } from "@/lib/roleRouting";
import { safeReturnPath } from "@/lib/safeReturnPath";

const KAKAO_ERROR_MESSAGES: Record<string, string> = {
  kakao_config: "카카오 로그인 설정이 없습니다. 관리자에게 문의하세요.",
  kakao_denied: "카카오 로그인이 취소되었습니다.",
  kakao_state: "카카오 로그인 보안 검증에 실패했습니다. 다시 시도해 주세요.",
  kakao_token: "카카오 인증에 실패했습니다. 잠시 후 다시 시도해 주세요.",
  kakao_user: "카카오 계정 처리 중 오류가 발생했습니다.",
};

export default function LoginClient() {
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState(() => {
    const code = searchParams.get("error") || "";
    return KAKAO_ERROR_MESSAGES[code] || (code ? "로그인에 실패했습니다." : "");
  });
  const [loading, setLoading] = useState(false);

  const safeCallback = safeReturnPath(searchParams.get("callbackUrl"));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || data?.message || "로그인 실패");

      location.href = resolvePostLoginHref({
        role: data.role,
        mustChangePassword: !!data.mustChangePassword,
        callbackUrl: safeCallback,
      });
    } catch (e: any) {
      setErr(e.message || "로그인 실패");
    } finally {
      setLoading(false);
    }
  };

  const onKakao = () => {
    const qs = safeCallback
      ? `?callbackUrl=${encodeURIComponent(safeCallback)}`
      : "";
    location.href = `/api/auth/kakao/start${qs}`;
  };

  return (
    <div className="vh-auth-hero vh-splash-ivory">
      <div
        className="vh-auth-bg vh-splash-course"
        style={{ backgroundImage: `url(${PWA_SPLASH_COURSE})` }}
        aria-hidden
      />
      <div className="vh-auth-overlay vh-splash-ivory-overlay" aria-hidden />

      <div className="vh-auth-frame">
        <header className="vh-auth-top">
          <Link href="/" className="vh-auth-brand">
            VERTHILL <span>Caddy System</span>
          </Link>
        </header>

        <div className="vh-auth-stage">
          <div className="vh-auth-intro">
            <img
              className="vh-splash-mark vh-splash-mark-sm"
              src={PWA_MONOGRAM}
              alt=""
              width={72}
              height={52}
            />
            <h1 className="vh-auth-title">VERTHILL</h1>
            <p className="vh-splash-subtitle">Caddy System</p>
          </div>

          <div className="vh-auth-login-col">
            <form onSubmit={onSubmit} className="vh-auth-card">
            <h2 className="vh-auth-card-title">로그인</h2>
            <p className="vh-auth-card-sub">관리자 및 캐디 계정으로 입장합니다</p>

            <button
              type="button"
              onClick={onKakao}
              className="vh-auth-kakao"
            >
              카카오로 시작
            </button>

            <div className="vh-auth-or">
              <span>또는 아이디로 로그인</span>
            </div>

            <label className="vh-auth-label" htmlFor="login-username">
              아이디
            </label>
            <input
              id="login-username"
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="vh-auth-input"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
            />

            <label className="vh-auth-label" htmlFor="login-password">
              비밀번호
            </label>
            <input
              id="login-password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="vh-auth-input"
              autoComplete="current-password"
            />

            {err && <div className="vh-auth-error">{err}</div>}

            <button
              type="submit"
              disabled={loading}
              className="vh-auth-submit"
            >
              {loading ? "로그인 중…" : "로그인"}
            </button>
          </form>
          <PwaInstallCard />
          </div>
        </div>
      </div>
    </div>
  );
}
