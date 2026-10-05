"use client";

import AppChrome, {
  IconCaddy,
  IconDash,
  IconHome,
  IconMenu,
} from "@/components/manage/AppChrome";
import { manageNavItems } from "@/lib/adminManageNav";

export { manageNavItems, manageToolItems } from "@/lib/adminManageNav";

const BOTTOM = [
  { href: "/", label: "홈", Icon: IconHome },
  { href: "/manage", label: "대시보드", Icon: IconDash },
  { href: "/manage/caddies", label: "캐디", Icon: IconCaddy },
  { href: "#menu", label: "메뉴", Icon: IconMenu },
] as const;

const ADMIN_PREFETCH = [
  "/manage",
  "/manage/caddies",
  "/manage/availability",
  "/manage/off-requests",
  "/manage/assignments",
  "/manage/tools",
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
