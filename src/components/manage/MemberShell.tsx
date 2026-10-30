"use client";

import AppChrome, {
  IconBoard,
  IconChat,
  IconDash,
  IconHome,
  IconNotice,
} from "@/components/manage/AppChrome";
import { memberNavItems } from "@/lib/boardNav";

const BOTTOM = [
  { href: "/", label: "홈", Icon: IconHome },
  { href: "/notice", label: "공지", Icon: IconNotice },
  { href: "/board", label: "배치표", Icon: IconBoard },
  { href: "/chat", label: "채팅", Icon: IconChat },
  { href: "/caddy", label: "내 대시보드", Icon: IconDash },
] as const;

const PREFETCH = ["/", "/notice", "/board", "/chat", "/caddy", "/course-reports"] as const;

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
