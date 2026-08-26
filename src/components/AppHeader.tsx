"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import LogoutButton from "@/components/LogoutButton";
import { isAppNavActive } from "@/lib/boardNav";
import type { AppRole } from "@/lib/sessionCookies";

function navClass(pathname: string, href: string, extra = "ui-btn ui-btn-ghost") {
  return `${extra}${isAppNavActive(pathname, href) ? " is-current" : ""}`;
}

export default function AppHeader({ role }: { role: AppRole | null }) {
  const pathname = usePathname() || "/";

  return (
    <header className="vh-header">
      <div className="vh-header-inner">
        <Link href="/" className="vh-brand">
          VERTHILL <span>• Caddy</span>
        </Link>

        <nav className="vh-nav" aria-label="사이트 메뉴">
          <Link
            className={navClass(pathname, "/")}
            href="/"
            aria-current={isAppNavActive(pathname, "/") ? "page" : undefined}
          >
            홈
          </Link>
          <Link
            className={navClass(pathname, "/notice")}
            href="/notice"
            aria-current={isAppNavActive(pathname, "/notice") ? "page" : undefined}
          >
            공지
          </Link>
          {role && (
            <Link
              className={navClass(pathname, "/board")}
              href="/board"
              aria-current={isAppNavActive(pathname, "/board") ? "page" : undefined}
            >
              배치표
            </Link>
          )}

          {role === "admin" && (
            <Link
              className={navClass(pathname, "/manage", "ui-btn ui-btn-gold")}
              href="/manage"
              aria-current={isAppNavActive(pathname, "/manage") ? "page" : undefined}
            >
              관리자
            </Link>
          )}
          {role === "caddy" && (
            <Link
              className={navClass(pathname, "/caddy", "ui-btn ui-btn-gold")}
              href="/caddy"
              aria-current={isAppNavActive(pathname, "/caddy") ? "page" : undefined}
            >
              내 대시보드
            </Link>
          )}

          {role ? (
            <LogoutButton />
          ) : (
            <Link className="ui-btn ui-btn-primary" href="/login">
              로그인
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
