"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import LogoutButton from "@/components/LogoutButton";
import AccountDeletionLink from "@/components/AccountDeletionLink";
import PrivacyPolicyLink from "@/components/PrivacyPolicyLink";

export type AppChromeNavItem = {
  href: string;
  label: string;
  match: (pathname: string) => boolean;
};

export type AppChromeBottomItem = {
  href: string;
  label: string;
  Icon: () => ReactNode;
};

export function IconHome() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M6 10.5V20h12v-9.5" />
    </svg>
  );
}
export function IconDash() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
export function IconCaddy() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c1.5-3.2 4-5 7-5s5.5 1.8 7 5" />
    </svg>
  );
}
export function IconMenu() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}
export function IconClose() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
export function IconNotice() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M5 7h14v11H5z" />
      <path d="M8 11h8M8 14h5" />
    </svg>
  );
}
export function IconReport() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <path d="M8 15l2.2-2.8 2.1 1.7L15.5 10 18 15" />
      <circle cx="9.2" cy="9" r="1.1" />
    </svg>
  );
}
export function IconBoard() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M5 6h14v12H5z" />
      <path d="M5 10h14M9 6v12M15 6v12" />
    </svg>
  );
}

export default function AppChrome({
  children,
  navItems,
  bottomItems,
  brandSub,
  drawerTitle,
  footerTitle,
  footerMeta,
  rightHref,
  rightAriaLabel,
  RightIcon,
  prefetchHrefs,
  bottomTabsClassName = "",
}: {
  children: ReactNode;
  navItems: readonly AppChromeNavItem[];
  bottomItems: readonly AppChromeBottomItem[];
  brandSub: string;
  drawerTitle: string;
  footerTitle: string;
  footerMeta: string;
  rightHref: string;
  rightAriaLabel: string;
  RightIcon: () => ReactNode;
  prefetchHrefs?: readonly string[];
  bottomTabsClassName?: string;
}) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.body.classList.add("manage-mode");

    const toPrefetch = (prefetchHrefs ?? navItems.map((item) => item.href)).filter(
      (href) => href !== pathname && href !== "#menu"
    );

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
  }, [router, pathname, navItems, prefetchHrefs]);

  return (
    <div className="vh-manage">
      <aside className="vh-sidebar" aria-label={drawerTitle}>
        <div className="vh-sidebar-brand">
          <span className="vh-sidebar-mark">V</span>
          <div>
            <div className="vh-sidebar-title">VERTHILL</div>
            <div className="vh-sidebar-sub">{brandSub}</div>
          </div>
        </div>
        <nav className="vh-sidebar-nav">
          {navItems.map((item) => {
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
          <div className="vh-sidebar-admin">{footerTitle}</div>
          <div className="vh-sidebar-meta">{footerMeta}</div>
          <PrivacyPolicyLink className="vh-privacy-link vh-privacy-link-chrome" />
          <AccountDeletionLink className="vh-privacy-link vh-privacy-link-chrome" />
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
          <Link href={rightHref} className="vh-icon-btn" aria-label={rightAriaLabel}>
            <RightIcon />
          </Link>
        </header>

        <div className="vh-work-inner">{children}</div>

        <nav
          className={`vh-bottom-tabs${bottomTabsClassName ? ` ${bottomTabsClassName}` : ""}`}
          aria-label="모바일 탭"
        >
          {bottomItems.map((item) => {
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
              item.href === "/" || item.href === "/manage"
                ? pathname === item.href
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
              <div className="vh-sidebar-title">{drawerTitle}</div>
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
              {navItems.map((item) => (
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
              <PrivacyPolicyLink className="vh-privacy-link vh-privacy-link-chrome" />
              <AccountDeletionLink className="vh-privacy-link vh-privacy-link-chrome" />
              <LogoutButton />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
