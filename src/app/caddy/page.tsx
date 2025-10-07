'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

type Summary = {
  date: string
  today: { off: number; sick: number; longSick: number; duty: number; marshal: number }
  latestNotices: { id: number; title: string; createdAt: string }[]
}

export default function CaddyPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [summary, setSummary] = useState<Summary | null>(null)

  useEffect(() => {
    const run = async () => {
      try {
        const resRole = await fetch('/api/check-role', { credentials: 'include' })
        const dataRole = await resRole.json()
        if (dataRole.role !== 'caddy') {
          alert('캐디만 접근 가능합니다.')
          router.push('/login')
          return
        }
        const res = await fetch('/api/summary')
        const data: Summary = await res.json()
        setSummary(data)
      } catch {
        alert('요약 정보를 불러오지 못했습니다.')
      } finally {
        setLoading(false)
      }
    }
    run()
  }, [router])

  if (loading) return <p style={{ textAlign: 'center', marginTop: 100 }}>로딩 중...</p>

  return (
    <div style={{ maxWidth: 900, margin: '20px auto' }}>
      <h2 style={{ fontSize: 22, fontWeight: 800, marginBottom: 12 }}>캐디 대시보드</h2>
      {summary && (
        <>
          <p style={{ marginBottom: 14, color: '#64748b' }}>{summary.date} 오늘 현황</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
            <Tag label="휴무" value={summary.today.off} />
            <Tag label="병가" value={summary.today.sick} />
            <Tag label="장기병가" value={summary.today.longSick} />
            <Tag label="당번" value={summary.today.duty} />
            <Tag label="마샬" value={summary.today.marshal} />
          </div>

          <div style={{ marginTop: 28 }}>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>최근 공지</h3>
            <ul style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
              {summary.latestNotices.length === 0 && (
                <li style={{ padding: 12, color: '#64748b' }}>공지 없음</li>
              )}
              {summary.latestNotices.map(n => (
                <li key={n.id} style={{ padding: 12, borderTop: '1px solid #f1f5f9' }}>
                  <a href={`/notice/${n.id}`} style={{ textDecoration: 'none', color: '#0f172a' }}>
                    {n.title}
                  </a>
                  <span style={{ marginLeft: 8, fontSize: 12, color: '#94a3b8' }}>
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}

function Tag({ label, value }: { label: string; value: number }) {
  return (
    <div style={{
      border: '1px solid #e5e7eb', borderRadius: 12, padding: '10px 12px',
      background: '#fff', textAlign: 'center'
    }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800 }}>{value}</div>
    </div>
  )
}
