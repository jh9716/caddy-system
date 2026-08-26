import type { AppRole } from "@/lib/sessionCookies";

/**
 * /board 는 캐디 공용 화면이다. 관리자 셸(사이드바/햄버거)은 admin만 재사용한다.
 * 캐디·조장에게 ManageShell을 씌우면 관리 메뉴가 새로 노출된다.
 */
export function shouldUseManageShellForBoard(
  role: AppRole | string | null | undefined
): boolean {
  return role === "admin";
}

/** 공통 상단 헤더에서 현재 페이지 active 표시. `/` 는 정확 일치. */
export function isAppNavActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
