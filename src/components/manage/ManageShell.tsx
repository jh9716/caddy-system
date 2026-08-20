"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import LogoutButton from "@/components/LogoutButton";

const NAV = [
  { href: "/manage", label: "대시보드", match: (p: string) => p === "/manage" },
  {
    href: "/manage/caddies",
    label: "캐디 관리",
    match: (p: string) => p.startsWith("/manage/caddies"),
  },
  {
    href: "/manage/availability",
    label: "가용표",
    match: (p: string) => p.startsWith("/manage/availability"),
  },
  {
    href: "/manage/reservations",
    label: "예약표 파싱",
    match: (p: string) => p.startsWith("/manage/reservations"),
  },
  {
    href: "/manage/assignments",
    label: "자동배치",
    match: (p: string) =>
      p.startsWith("/manage/assignments") && !p.includes("/preview"),
  },
  {
    href: "/manage/assignments/preview",
    label: "배치 미리보기",
    match: (p: string) => p.startsWith("/manage/assignments/preview"),
  },
  {
    href: "/manage/users",
    label: "계정 연결",
    match: (p: string) => p.startsWith("/manage/users"),
  },
  { href: "/notice", label: "공지", match: (p: string) => p.startsWith("/notice") },
  {
    href: "/schedule",
    label: "스케줄",
    match: (p: string) => p.startsWith("/schedule"),
  },
] as const;

function IconHome() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M6 10.5V20h12v-9.5" />
    </svg>
  );
}
function IconDash() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
function IconCaddy() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c1.5-3.2 4-5 7-5s5.5 1.8 7 5" />
    </svg>
  );
}
function IconMenu() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

const BOTTOM = [
  { href: "/", label: "홈", Icon: IconHome },
  { href: "/manage", label: "대시보드", Icon: IconDash },
  { href: "/manage/caddies", label: "캐디", Icon: IconCaddy },
  { href: "#menu", label: "메뉴", Icon: IconMenu },
] as const;

export default function ManageShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/manage";
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.body.classList.add("manage-mode");

    const toPrefetch = [
      "/manage",
      "/manage/caddies",
      "/manage/assignments",
      "/manage/availability",
    ].filter((href) => href !== pathname);

    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      for (const href of toPrefetch) router.prefetch(href);
    };

    let idleId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (typeof requestIdleCallback === "function") {
      idleId = requestIdleCallback(run, { timeout: 1200 });
    } else {
      timeoutId = setTimeout(run, 400);
    }

    return () => {
      cancelled = true;
      document.body.classList.remove("manage-mode");
      if (idleId != null && typeof cancelIdleCallback === "function") {
        cancelIdleCallback(idleId);
      }
      if (timeoutId != null) clearTimeout(timeoutId);
    };
  }, [router, pathname]);

  return (
    <div className="vh-manage">
      <aside className="vh-sidebar" aria-label="관리 메뉴">
        <div className="vh-sidebar-brand">
          <span className="vh-sidebar-mark">V</span>
          <div>
            <div className="vh-sidebar-title">VERTHILL</div>
            <div className="vh-sidebar-sub">Caddy Admin</div>
          </div>
        </div>
        <nav className="vh-sidebar-nav">
          {NAV.map((item) => {
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch
                className={`vh-sidebar-link${active ? " is-active" : ""}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="vh-sidebar-foot">
          <div className="vh-sidebar-admin">관리자님</div>
          <div className="vh-sidebar-meta">운영 콘솔</div>
          <LogoutButton />
        </div>
      </aside>

      <div className="vh-work">
        <header className="vh-mobile-bar">
          <button
            type="button"
            className="vh-icon-btn"
            aria-label="메뉴 열기"
            onClick={() => setMenuOpen(true)}
          >
            <IconMenu />
          </button>
          <div className="vh-mobile-brand">VERTHILL</div>
          <Link href="/manage" className="vh-icon-btn" aria-label="대시보드">
            <IconDash />
          </Link>
        </header>

        <div className="vh-work-inner">{children}</div>

        <nav className="vh-bottom-tabs" aria-label="모바일 탭">
          {BOTTOM.map((item) => {
            const Icon = item.Icon;
            if (item.href === "#menu") {
              return (
                <button
                  key={item.label}
                  type="button"
                  className="vh-tab"
                  onClick={() => setMenuOpen(true)}
                >
                  <span className="vh-tab-icon">
                    <Icon />
                  </span>
                  <span>{item.label}</span>
                </button>
              );
            }
            const active =
              item.href === "/manage"
                ? pathname === "/manage"
                : pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch
                className={`vh-tab${active ? " is-active" : ""}`}
              >
                <span className="vh-tab-icon">
                  <Icon />
                </span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      {menuOpen && (
        <div className="vh-drawer" role="dialog" aria-modal="true">
          <button
            type="button"
            className="vh-drawer-backdrop"
            aria-label="메뉴 닫기"
            onClick={() => setMenuOpen(false)}
          />
          <div className="vh-drawer-panel">
            <div className="vh-drawer-head">
              <div className="vh-sidebar-title">관리 메뉴</div>
              <button
                type="button"
                className="vh-icon-btn light"
                aria-label="닫기"
                onClick={() => setMenuOpen(false)}
              >
                <IconClose />
              </button>
            </div>
            <nav className="vh-drawer-nav">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`vh-sidebar-link${item.match(pathname) ? " is-active" : ""}`}
                  onClick={() => setMenuOpen(false)}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="vh-drawer-foot">
              <LogoutButton />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
