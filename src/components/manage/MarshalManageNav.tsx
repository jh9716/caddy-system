"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/manage/marshals", label: "명단" },
  { href: "/manage/marshals/schedule", label: "월표" },
] as const;

export default function MarshalManageNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="마샬 관리 섹션"
      style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        margin: "0 0 16px",
      }}
    >
      {ITEMS.map((item) => {
        const active =
          item.href === "/manage/marshals"
            ? pathname === "/manage/marshals"
            : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className="ui-btn"
            style={{
              textDecoration: "none",
              background: active ? "var(--vh-ink)" : "transparent",
              color: active ? "var(--vh-paper, #fff)" : "inherit",
            }}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
