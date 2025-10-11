// src/app/admin/login/_LoginClient.tsx
'use client'

import { useSearchParams, useRouter } from 'next/navigation'
import { useState } from 'react'

export default function LoginClient() {
  const search = useSearchParams()
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(search.get('error'))

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data?.message ?? '로그인 실패')
        setLoading(false)
        return
      }
      router.replace('/manage/caddies') // 로그인 후 이동할 페이지
    } catch {
      setError('요청 실패')
      setLoading(false)
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12 }}>
      <input
        type="password"
        placeholder="관리자 비밀번호"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 8 }}
      />
      <button
        type="submit"
        disabled={loading}
        style={{
          padding: '10px 14px',
          borderRadius: 10,
          border: '1px solid #e5e7eb',
          background: '#111',
          color: '#fff',
          cursor: 'pointer',
          opacity: loading ? 0.7 : 1,
        }}
      >
        {loading ? '로그인 중…' : '로그인'}
      </button>
      {error ? <p style={{ color: 'tomato' }}>{error}</p> : null}
    </form>
  )
}
