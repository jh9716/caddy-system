'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [id, setId] = useState('')
  const [pw, setPw] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id.trim(), password: pw.trim() })
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error ?? '로그인 실패')
        return
      }
      if (data.role === 'admin') router.replace('/manage')
      else router.replace('/caddy')
    } catch {
      setError('네트워크 오류 또는 서버 오류')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{minHeight:'70vh', display:'grid', placeItems:'center', padding:20}}>
      <div style={{
        width: 380, background:'#fff', border:'1px solid #e5e7eb', borderRadius:16, padding:24,
        boxShadow:'0 6px 20px rgba(0,0,0,0.04)'
      }}>
        <h1 style={{fontSize:22, fontWeight:800, marginBottom:8}}>Verthill Caddy System</h1>
        <p style={{color:'#64748b', marginBottom:18}}>역할에 맞는 계정으로 로그인해주세요.</p>

        <form onSubmit={onSubmit} style={{display:'grid', gap:12}}>
          <input
            placeholder="아이디 (예: caddy / admin1)"
            value={id}
            onChange={(e)=>setId(e.target.value)}
            style={{padding:12, border:'1px solid #e5e7eb', borderRadius:10}}
          />
          <input
            type="password"
            placeholder="비밀번호 (예: caddy1234 / 011697)"
            value={pw}
            onChange={(e)=>setPw(e.target.value)}
            style={{padding:12, border:'1px solid #e5e7eb', borderRadius:10}}
          />
          <button
            type="submit"
            disabled={loading}
            style={{
              padding:12, borderRadius:10, border:'1px solid #0f172a',
              background:'#0f172a', color:'#fff', fontWeight:700, cursor:'pointer',
              opacity: loading ? 0.7 : 1
            }}
          >
            {loading ? '로그인 중…' : '로그인'}
          </button>
          {error ? <div style={{color:'tomato', fontSize:13}}>{error}</div> : null}

          <div style={{marginTop:10, fontSize:12, color:'#94a3b8', lineHeight:1.6}}>
            <div>캐디(공용): <b>아이디 caddy / 비번 .env의 CADDY_PASSWORD</b></div>
            <div>관리자: <b>아이디 admin / 비번 .env의 ADMIN_PASSWORD</b></div>
          </div>
        </form>
      </div>
    </div>
  )
}
