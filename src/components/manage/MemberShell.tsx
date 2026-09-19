"use client";

import AppChrome, {
  IconBoard,
  IconDash,
  IconHome,
  IconNotice,
  IconReport,
} from "@/components/manage/AppChrome";
import { memberNavItems } from "@/lib/boardNav";

const BOTTOM = [
  { href: "/", label: "홈", Icon: IconHome },
  { href: "/notice", label: "공지", Icon: IconNotice },
  { href: "/course-reports", label: "제보", Icon: IconReport },
  { href: "/board", label: "배치표", Icon: IconBoard },
  { href: "/caddy", label: "내 대시보드", Icon: IconDash },
] as const;

const PREFETCH = ["/", "/notice", "/course-reports", "/board", "/caddy"] as const;

export default function MemberShell({ children }: { children: React.ReactNode }) {
  return (
    <AppChrome
      navItems={memberNavItems()}
      bottomItems={BOTTOM}
      brandSub="Caddy"
      drawerTitle="메뉴"
      footerTitle="캐디"
      footerMeta="내 메뉴"
      rightHref="/caddy"
      rightAriaLabel="내 대시보드"
      RightIcon={IconDash}
      prefetchHrefs={PREFETCH}
      bottomTabsClassName="vh-bottom-tabs-5"
    >
      {children}
    </AppChrome>
  );
}
