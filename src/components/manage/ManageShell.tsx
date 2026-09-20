"use client";

import AppChrome, {
  IconCaddy,
  IconDash,
  IconHome,
  IconMenu,
} from "@/components/manage/AppChrome";

const NAV = [
  { href: "/manage", label: "대시보드", match: (p: string) => p === "/manage" },
  {
    href: "/manage/caddies",
    label: "캐디 관리",
    match: (p: string) => p.startsWith("/manage/caddies"),
  },
  {
    href: "/manage/caddy-search",
    label: "캐디 검색",
    match: (p: string) => p.startsWith("/manage/caddy-search"),
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
    href: "/manage/alimtalk",
    label: "알림톡",
    match: (p: string) => p.startsWith("/manage/alimtalk"),
  },
  {
    href: "/manage/notifications",
    label: "알림 설정",
    match: (p: string) => p.startsWith("/manage/notifications"),
  },
  {
    href: "/manage/push-test",
    label: "푸시 알림 테스트",
    match: (p: string) => p.startsWith("/manage/push-test"),
  },
  {
    href: "/manage/users",
    label: "계정 연결",
    match: (p: string) => p.startsWith("/manage/users"),
  },
  {
    href: "/manage/staff-accounts",
    label: "직원 계정",
    match: (p: string) => p.startsWith("/manage/staff-accounts"),
    accountManagerOnly: true,
  },
  {
    href: "/board",
    label: "배치표",
    match: (p: string) => p.startsWith("/board"),
  },
  { href: "/notice", label: "공지", match: (p: string) => p.startsWith("/notice") },
  {
    href: "/course-reports",
    label: "코스 제보",
    match: (p: string) => p.startsWith("/course-reports"),
  },
  {
    href: "/schedule",
    label: "스케줄",
    match: (p: string) => p.startsWith("/schedule"),
  },
] as const;

export function manageNavItems(canManageStaffAccounts: boolean) {
  return NAV.filter(
    (item) =>
      !("accountManagerOnly" in item && item.accountManagerOnly) ||
      canManageStaffAccounts
  );
}

const BOTTOM = [
  { href: "/", label: "홈", Icon: IconHome },
  { href: "/manage", label: "대시보드", Icon: IconDash },
  { href: "/manage/caddies", label: "캐디", Icon: IconCaddy },
  { href: "#menu", label: "메뉴", Icon: IconMenu },
] as const;

const ADMIN_PREFETCH = [
  "/manage",
  "/manage/caddies",
  "/manage/caddy-search",
  "/manage/assignments",
  "/manage/availability",
] as const;

export default function ManageShell({
  children,
  canManageStaffAccounts = false,
}: {
  children: React.ReactNode;
  canManageStaffAccounts?: boolean;
}) {
  const navItems = manageNavItems(canManageStaffAccounts);
  return (
    <AppChrome
      navItems={navItems}
      bottomItems={BOTTOM}
      brandSub="Caddy Admin"
      drawerTitle="관리 메뉴"
      footerTitle="관리자님"
      footerMeta="운영 콘솔"
      rightHref="/manage"
      rightAriaLabel="대시보드"
      RightIcon={IconDash}
      prefetchHrefs={ADMIN_PREFETCH}
    >
      {children}
    </AppChrome>
  );
}
