'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const tabs = [
  { href: '/', label: '대시보드' },
  { href: '/schedule', label: '가용표' },
  { href: '/leave', label: '휴무 신청' },
  { href: '/notice', label: '공지' },
  { href: '/admin', label: '관리' },
];

export default function NavBar() {
  const pathname = usePathname();
  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 40,
      backdropFilter: 'saturate(180%) blur(8px)',
      background: 'rgba(255,255,255,0.7)', borderBottom: '1px solid #eee'
    }}>
      <div style={{maxWidth: 1120, margin: '0 auto', padding: '14px 20px', display:'flex', alignItems:'center', justifyContent:'space-between'}}>
        <Link href="/" style={{fontWeight: 800, letterSpacing: 0.5, fontSize: 18}}>VERTHILL • Caddy</Link>
        <nav style={{display:'flex', gap: 10}}>
          {tabs.map(t => (
            <Link
              key={t.href}
              href={t.href}
              style={{
                padding: '8px 12px',
                borderRadius: 10,
                textDecoration: 'none',
                color: pathname === t.href ? '#111' : '#444',
                background: pathname === t.href ? '#f1f5f9' : 'transparent',
                border: pathname === t.href ? '1px solid #e5e7eb' : '1px solid transparent'
              }}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
