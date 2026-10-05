/**
 * 관리자 좌측/드로어 메뉴. 화면 이동만 정의한다.
 * route 삭제·redirect·권한 변경 없음.
 */

export type AdminNavItem = {
  href: string;
  label: string;
  match: (pathname: string) => boolean;
};

export type AdminToolGroup = "ops" | "notify" | "account";

export type AdminToolItem = {
  href: string;
  label: string;
  description: string;
  group: AdminToolGroup;
  accountManagerOnly?: boolean;
};

export const ADMIN_TOOL_GROUP_LABELS: Record<AdminToolGroup, string> = {
  ops: "운영 보조",
  notify: "알림 / 진단",
  account: "계정 / 시스템",
};

export const ADMIN_TOOL_GROUP_ORDER: AdminToolGroup[] = [
  "ops",
  "notify",
  "account",
];

export const ADMIN_TOOL_ITEMS: readonly AdminToolItem[] = [
  {
    href: "/manage/caddy-search",
    label: "캐디 검색",
    description: "이름·연락처로 캐디를 찾습니다",
    group: "ops",
  },
  {
    href: "/manage/assignments/preview",
    label: "배치 미리보기",
    description: "자동배치 결과를 미리 확인합니다",
    group: "ops",
  },
  {
    href: "/manage/reservations",
    label: "예약표 파싱",
    description: "예약 XLS/XLSX 파싱 미리보기 · DB 저장 없음",
    group: "ops",
  },
  {
    href: "/manage/alimtalk",
    label: "알림톡",
    description: "근무 알림톡 미리보기 · 실제 발송 없음",
    group: "notify",
  },
  {
    href: "/manage/notifications",
    label: "알림 설정",
    description: "이 기기 푸시 알림을 켜거나 끕니다",
    group: "notify",
  },
  {
    href: "/manage/push-test",
    label: "푸시 알림 테스트",
    description: "Native/PWA Push 동작 확인용 진단 도구",
    group: "notify",
  },
  {
    href: "/manage/users",
    label: "계정 연결",
    description: "캐디 ↔ Kakao 계정 연결 및 승인 관리",
    group: "account",
  },
  {
    href: "/manage/privacy-requests",
    label: "개인정보 요청",
    description: "공개 문의·삭제 요청 수신함",
    group: "account",
  },
  {
    href: "/manage/staff-accounts",
    label: "직원 계정",
    description: "관리자 ID/PW 계정 발급·관리",
    group: "account",
    accountManagerOnly: true,
  },
];

export function pathStartsWith(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isAdminToolPath(pathname: string): boolean {
  return ADMIN_TOOL_ITEMS.some((item) => pathStartsWith(pathname, item.href));
}

export const ADMIN_MAIN_NAV: readonly AdminNavItem[] = [
  { href: "/manage", label: "대시보드", match: (p) => p === "/manage" },
  {
    href: "/manage/caddies",
    label: "캐디 관리",
    match: (p) => pathStartsWith(p, "/manage/caddies"),
  },
  {
    href: "/manage/availability",
    label: "가용표",
    match: (p) => pathStartsWith(p, "/manage/availability"),
  },
  {
    href: "/manage/off-requests",
    label: "휴무 신청",
    match: (p) => pathStartsWith(p, "/manage/off-requests"),
  },
  {
    href: "/manage/assignments",
    label: "자동배치",
    match: (p) =>
      pathStartsWith(p, "/manage/assignments") && !p.includes("/preview"),
  },
  {
    href: "/board",
    label: "배치표",
    match: (p) => pathStartsWith(p, "/board"),
  },
  { href: "/notice", label: "공지", match: (p) => pathStartsWith(p, "/notice") },
  { href: "/chat", label: "채팅", match: (p) => pathStartsWith(p, "/chat") },
  {
    href: "/course-reports",
    label: "코스 제보",
    match: (p) => pathStartsWith(p, "/course-reports"),
  },
  {
    href: "/schedule",
    label: "스케줄",
    match: (p) => pathStartsWith(p, "/schedule"),
  },
  {
    href: "/manage/tools",
    label: "관리도구",
    match: (p) => pathStartsWith(p, "/manage/tools") || isAdminToolPath(p),
  },
];

export const ADMIN_MAIN_NAV_HREFS = ADMIN_MAIN_NAV.map((item) => item.href);

export const ADMIN_HIDDEN_FROM_MAIN_HREFS = ADMIN_TOOL_ITEMS.map(
  (item) => item.href
);

export function manageNavItems(
  _canManageStaffAccounts?: boolean
): AdminNavItem[] {
  return ADMIN_MAIN_NAV.slice();
}

export function manageToolItems(canManageStaffAccounts: boolean): AdminToolItem[] {
  return ADMIN_TOOL_ITEMS.filter(
    (item) => !item.accountManagerOnly || canManageStaffAccounts
  );
}

export function groupAdminToolItems(
  items: readonly AdminToolItem[]
): Array<{ group: AdminToolGroup; label: string; items: AdminToolItem[] }> {
  return ADMIN_TOOL_GROUP_ORDER.map((group) => ({
    group,
    label: ADMIN_TOOL_GROUP_LABELS[group],
    items: items.filter((item) => item.group === group),
  })).filter((section) => section.items.length > 0);
}

export function activeAdminMainHref(pathname: string): string | null {
  const hit = ADMIN_MAIN_NAV.find((item) => item.match(pathname));
  return hit?.href ?? null;
}
