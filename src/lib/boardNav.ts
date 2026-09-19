import type { AppRole } from "@/lib/sessionCookies";

/**
 * /board · /notice 는 캐디 공용 화면이다. 관리자 셸(사이드바/햄버거)은 admin만 재사용한다.
 * 캐디·조장에게 관리자 ManageShell을 씌우면 관리 메뉴가 새로 노출된다.
 * 캐디·조장은 같은 chrome(AppChrome)을 MemberShell로만 쓴다.
 */
export function shouldUseManageShellForBoard(
  role: AppRole | string | null | undefined
): boolean {
  return role === "admin";
}

export function shouldUseMemberShell(
  role: AppRole | string | null | undefined
): boolean {
  return role === "caddy" || role === "leader";
}

export function memberNavItems() {
  return [
    { href: "/", label: "홈", match: (p: string) => p === "/" },
    {
      href: "/notice",
      label: "공지",
      match: (p: string) => p.startsWith("/notice"),
    },
    {
      href: "/course-reports",
      label: "제보",
      match: (p: string) => p.startsWith("/course-reports"),
    },
    {
      href: "/board",
      label: "배치표",
      match: (p: string) => p.startsWith("/board"),
    },
    {
      href: "/caddy",
      label: "내 대시보드",
      match: (p: string) => p.startsWith("/caddy"),
    },
  ] as const;
}

const MEMBER_ADMIN_LABELS = [
  "캐디 관리",
  "자동배치",
  "직원 계정",
  "계정 연결",
  "예약표 파싱",
  "알림톡",
  "푸시 알림 테스트",
  "캐디 검색",
  "가용표",
  "스케줄",
];

export function memberNavExposesAdminMenu(): boolean {
  const labels = memberNavItems().map((item) => item.label);
  const hrefs = memberNavItems().map((item) => item.href);
  return (
    labels.some((label) => MEMBER_ADMIN_LABELS.includes(label)) ||
    hrefs.some((href) => href.startsWith("/manage"))
  );
}

export function shouldUseManageShellForNotice(
  role: AppRole | string | null | undefined
): boolean {
  return shouldUseManageShellForBoard(role);
}

export function shouldUseManageShellForCourseReport(
  role: AppRole | string | null | undefined
): boolean {
  return shouldUseManageShellForBoard(role);
}

/** 공통 상단 헤더에서 현재 페이지 active 표시. `/` 는 정확 일치. */
export function isAppNavActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
