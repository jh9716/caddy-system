'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const tabs = [
  { href: '/', label: '대시보드' },
  { href: '/schedule', label: '가용표' },
  { href: '/leave', label: '휴무 신청' },
  { href: '/notice', label: '공지사항' },
  { href: '/manage/caddies', label: '캐디 관리' },
];

export default function NavBar() {
  const pathname = usePathname();

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  }

  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 40,
      backdropFilter: 'saturate(180%) blur(8px)',
      background: 'rgba(255,255,255,0.7)', borderBottom: '1px solid #eee'
    }}>
      <div style={{maxWidth: 1120, margin: '0 auto', padding: '14px 20px', display:'flex', alignItems:'center', justifyContent:'space-between'}}>
        <Link href="/" style={{fontWeight: 800, letterSpacing: 0.5, fontSize: 18}}>VERTHILL • Caddy</Link>
        <nav style={{display:'flex', gap: 10, alignItems:'center'}}>
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
          <button onClick={logout} style={{padding:'8px 12px', border:'1px solid #e5e7eb', background:'#fff', borderRadius:10}}>
            로그아웃
          </button>
        </nav>
      </div>
    </header>
  );
}
