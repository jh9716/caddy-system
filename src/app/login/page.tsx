'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const [id, setId] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const onSubmit = async () => {
    try {
      setLoading(true)
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id.trim(), password: password.trim() })
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        alert(`로그인 실패: ${data?.error ?? res.status}`)
        return
      }
      const data = await res.json()
      if (data.role === 'admin') router.push('/manage')
      else router.push('/caddy') // 캐디 대시보드
    } catch (e:any) {
      alert('네트워크 오류 또는 서버 오류')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: '100px auto' }}>
      <h2>로그인</h2>
      <input
        placeholder="아이디"
        value={id}
        onChange={(e) => setId(e.target.value)}
        style={{ width: '100%', padding: 10, marginBottom: 8 }}
      />
      <input
        type="password"
        placeholder="비밀번호"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        style={{ width: '100%', padding: 10, marginBottom: 12 }}
      />
      <button
        onClick={onSubmit}
        disabled={loading}
        style={{ width: '100%', padding: 12, background: '#0f172a', color: '#fff' }}
      >
        {loading ? '로그인 중…' : '로그인'}
      </button>
    </div>
  )
}
