'use client'
import { useEffect, useState } from 'react'

type TableColumn = {
  team: string
  rows: { id: number; name: string; badges: string[] }[]
}
type TableData = {
  date: string
  columns: TableColumn[]
  maxRows: number
}

function todayYMD() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const TAG_COLOR: Record<string, string> = {
  '휴무': '#bbf7d0',
  '병가': '#fde68a',
  '장기병가': '#a7f3d0',
  '당번': '#e0e7ff',
  '마샬': '#f5d0fe',
  '타구사고': '#fee2e2',
  '경조사': '#fef3c7',
}

function Chip({ text }: { text: string }) {
  const base = text.includes('당번')
    ? '당번'
    : text.includes('마샬')
    ? '마샬'
    : text
  const bg = TAG_COLOR[base] ?? '#e2e8f0'
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 6px',
        marginRight: 6,
        borderRadius: 8,
        fontSize: 12,
        background: bg,
        color: '#111827',
      }}
    >
      {text}
    </span>
  )
}

export default function SchedulePage() {
  const [date, setDate] = useState<string>(todayYMD())
  const [data, setData] = useState<TableData | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function load(d: string) {
    try {
      setLoading(true)
      setErr(null)
      const res = await fetch(`/api/schedule/table?date=${encodeURIComponent(d)}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) {
        setErr(json?.error || '가용표 조회 실패')
        setData(null)
      } else {
        setData(json as TableData)
      }
    } catch {
      setErr('네트워크 오류')
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load(date)
  }, [date])

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <h2 style={{ fontSize: 22, fontWeight: 800, marginBottom: 12 }}>📅 가용표</h2>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          style={{ padding: 8, border: '1px solid #e5e7eb', borderRadius: 8 }}
        />
        <button
          onClick={() => load(date)}
          style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}
          disabled={loading}
        >
          새로고침
        </button>
      </div>

      {/* 범례 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {['휴무','병가','장기병가','당번','마샬','타구사고','경조사','1부','2부','3부','1·3','1·2','54'].map(t => (
          <Chip key={t} text={t} />
        ))}
      </div>

      {err && (
        <div
          style={{
            padding: 12,
            border: '1px solid #fecaca',
            background: '#fef2f2',
            color: '#b91c1c',
            borderRadius: 8,
            marginBottom: 12,
          }}
        >
          {err}
        </div>
      )}

      {loading || !data ? (
        <p style={{ textAlign: 'center', marginTop: 60 }}>불러오는 중…</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
            <thead>
              <tr>
                {data.columns.map((c, i) => (
                  <th
                    key={i}
                    style={{
                      padding: 10,
                      borderBottom: '1px solid #e5e7eb',
                      background: '#f8fafc',
                      fontSize: 13,
                      color: '#334155',
                    }}
                  >
                    {c.team}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: data.maxRows }).map((_, rIdx) => (
                <tr key={rIdx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  {data.columns.map((col, cIdx) => {
                    const row = col.rows[rIdx]
                    return (
                      <td key={`${cIdx}-${rIdx}`} style={{ verticalAlign: 'top', padding: 8, fontSize: 14 }}>
                        {row ? (
                          <div>
                            <div style={{ marginBottom: 4 }}>{row.name}</div>
                            <div>
                              {(row.badges ?? []).map((b, i) => (
                                <Chip key={`${row.id}-${i}`} text={b} />
                              ))}
                            </div>
                          </div>
                        ) : (
                          <span style={{ color: '#cbd5e1' }}>—</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
