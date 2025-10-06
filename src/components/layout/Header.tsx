'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const tabs = [
  { href: '/', label: '대시보드' },
  { href: '/schedule', label: '가용표' },
  { href: '/admin/assignments', label: '휴무 신청' }, // 임시 라벨
  { href: '/notice', label: '공지' },
  { href: '/admin', label: '관리' },
];

export default function Header() {
  const pathname = usePathname();
  return (
    <header className="w-full border-b">
      <div className="mx-auto max-w-5xl h-12 flex items-center justify-between px-4">
        <Link href="/" className="font-semibold">VERTHILL • Caddy</Link>
        <nav className="flex gap-4 text-sm">
          {tabs.map(t => (
            <Link
              key={t.href}
              href={t.href}
              className={pathname.startsWith(t.href) ? 'font-semibold' : ''}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
