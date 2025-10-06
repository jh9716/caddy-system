// src/app/admin/login/page.tsx
import { Suspense } from 'react'
import LoginClient from './_LoginClient'

export const dynamic = 'force-dynamic' // (옵션) 프리렌더링을 강제로 끄고 동적 처리

export default function AdminLoginPage() {
  return (
    <div style={{ maxWidth: 420, margin: '60px auto', padding: 20 }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 16 }}>관리자 로그인</h1>
      <Suspense fallback={<p>로딩 중…</p>}>
        <LoginClient />
      </Suspense>
    </div>
  )
}
