'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'

export default function NavBar() {
  const [role, setRole] = useState<string | null>(null)

  useEffect(() => {
    // 쿠키는 서버에서 읽는게 정석이지만, 간단 체크용 API 호출로 가져옵니다.
    fetch('/api/check-role', { credentials: 'include' })
      .then(r => r.json())
      .then(d => setRole(d.role ?? null))
      .catch(() => setRole(null))
  }, [])

  async function onLogout() {
    await fetch('/api/logout', { method: 'POST' })
    window.location.href = '/login'
  }

  const common = [
    { href: '/', label: '홈' },
    { href: '/notice', label: '공지' },
  ]
  const adminOnly = [
    { href: '/manage', label: '관리대시보드' },
    { href: '/manage/caddies', label: '캐디등록/관리' },
    { href: '/schedule', label: '가용표' },
  ]
  const caddyOnly = [
    { href: '/caddy', label: '캐디대시보드' },
    { href: '/schedule', label: '가용표' },
  ]

  const tabs = role === 'admin'
    ? [...common, ...adminOnly]
    : role === 'caddy'
      ? [...common, ...caddyOnly]
      : [...common, { href:'/login', label:'로그인' }]

  return (
    <header style={{
      position:'sticky', top:0, zIndex:40, backdropFilter:'saturate(180%) blur(8px)',
      background:'rgba(255,255,255,0.75)', borderBottom:'1px solid #eee'
    }}>
      <div style={{
        maxWidth:1120, margin:'0 auto', padding:'12px 16px',
        display:'flex', alignItems:'center', justifyContent:'space-between'
      }}>
        <Link href="/" style={{fontWeight:900, letterSpacing:0.5}}>VERTHILL • Caddy</Link>
        <nav style={{display:'flex', gap:10, alignItems:'center'}}>
          {tabs.map(t => (
            <Link
              key={t.href}
              href={t.href}
              style={{
                padding:'8px 12px', borderRadius:10, border:'1px solid #e5e7eb',
                textDecoration:'none', color:'#111', background:'#f8fafc'
              }}
            >
              {t.label}
            </Link>
          ))}
          {role ? (
            <button onClick={onLogout} style={{
              padding:'8px 12px', borderRadius:10, border:'1px solid #e5e7eb',
              background:'#fff', cursor:'pointer'
            }}>
              로그아웃
            </button>
          ) : null}
        </nav>
      </div>
    </header>
  )
}
