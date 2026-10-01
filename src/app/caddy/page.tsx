'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import DevicePushSettings from '@/components/DevicePushSettings'
import PwaInstallCard from '@/components/PwaInstallCard'
import {
  CLIENT_RESOURCE,
  ensureClientAuthNamespace,
  readClientResource,
  readLastClientAuthNamespace,
  writeClientResource,
} from '@/lib/clientResourceCache'
import { resolveCaddyPageGate } from '@/lib/roleRouting'
import { formatKstDisplay } from '@/lib/kstDate'
import {
  consumeUnauthorizedMemberResponse,
  redirectMemberToLogin,
} from '@/lib/memberSessionRedirect'
import { isCurrentLoadGen } from '@/lib/pendingLoad'

type Summary = {
  date: string
  today: { off: number; sick: number; longSick: number; duty: number; marshal: number }
  latestNotices: {
    id: number
    title: string
    createdAt: string
    important?: boolean
    pinned?: boolean
  }[]
}

type MinePayload = {
  linked?: boolean
  request?: { status?: string } | null
}

function shouldRedirectUnlinked(mine: MinePayload | null): boolean {
  return Boolean(
    mine && mine.linked === false && mine.request?.status !== 'APPROVED'
  )
}

function peekSafeCaddySummary(): Summary | null {
  const ns = readLastClientAuthNamespace()
  if (!ns || (ns.role !== 'caddy' && ns.role !== 'leader')) return null
  const mineHit = readClientResource<MinePayload>(ns, CLIENT_RESOURCE.CADDY_MINE, 'self')
  if (shouldRedirectUnlinked(mineHit?.value ?? null)) return null
  return readClientResource<Summary>(ns, CLIENT_RESOURCE.CADDY_SUMMARY, 'today')?.value ?? null
}

export default function CaddyPage() {
  const router = useRouter()
  const cachedSummary = peekSafeCaddySummary()
  const [loading, setLoading] = useState(true)
  const [allowed, setAllowed] = useState(() => cachedSummary != null)
  const [summary, setSummary] = useState<Summary | null>(() => cachedSummary)
  const [refreshError, setRefreshError] = useState(false)
  const loadGen = useRef(0)

  useEffect(() => {
    const run = async () => {
      const gen = ++loadGen.current
      let redirected = false
      let showedCache = false
      try {
        // check-role stays first in the gate pair: routing/security before caddy data.
        const [r, ns] = await Promise.all([
          fetch('/api/check-role', { credentials: 'include' }),
          ensureClientAuthNamespace(),
        ])
        if (!isCurrentLoadGen(gen, loadGen.current)) return
        if (consumeUnauthorizedMemberResponse(r)) {
          redirected = true
          return
        }
        const d = await r.json()
        // 200 + role=null: expired/cleared session (check-role never 401s).
        // 503 auth_unavailable keeps the existing gate/catch path.
        if (r.status === 200 && !d.role) {
          redirected = redirectMemberToLogin()
          if (redirected) return
        }
        const gate = resolveCaddyPageGate(d.role)
        if (gate.action === 'replace') {
          router.replace(gate.href)
          return
        }
        if (gate.action === 'deny') {
          alert(gate.alertMessage)
          router.push(gate.href)
          return
        }
        if (ns) {
          const mineHit = readClientResource<MinePayload>(
            ns,
            CLIENT_RESOURCE.CADDY_MINE,
            'self'
          )
          const sumHit = readClientResource<Summary>(
            ns,
            CLIENT_RESOURCE.CADDY_SUMMARY,
            'today'
          )
          if (
            sumHit &&
            !shouldRedirectUnlinked(mineHit?.value ?? null)
          ) {
            showedCache = true
            setSummary(sumHit.value)
            setAllowed(true)
            setRefreshError(false)
            if (sumHit.fresh && (mineHit?.fresh ?? true)) {
              setLoading(false)
              return
            }
          }
        }
        const [mineRes, res] = await Promise.all([
          fetch('/api/caddy-link-requests/mine', {
            credentials: 'include',
            cache: 'no-store',
          }),
          fetch('/api/summary', { credentials: 'include', cache: 'no-store' }),
        ])
        if (!isCurrentLoadGen(gen, loadGen.current)) return
        if (
          consumeUnauthorizedMemberResponse(mineRes) ||
          consumeUnauthorizedMemberResponse(res)
        ) {
          redirected = true
          return
        }
        if (mineRes.ok) {
          const mine = (await mineRes.json().catch(() => null)) as MinePayload | null
          if (ns && mine) {
            writeClientResource(ns, CLIENT_RESOURCE.CADDY_MINE, 'self', mine)
          }
          // 미연결만 /caddy/link로. APPROVED(+미연결 레이스)는 루프 방지로 대시보드 유지
          if (shouldRedirectUnlinked(mine)) {
            router.replace('/caddy/link')
            return
          }
        }
        if (!res.ok) {
          throw new Error('summary')
        }
        const data: Summary = await res.json()
        if (!isCurrentLoadGen(gen, loadGen.current)) return
        setSummary(data)
        setAllowed(true)
        setRefreshError(false)
        if (ns) writeClientResource(ns, CLIENT_RESOURCE.CADDY_SUMMARY, 'today', data)
      } catch {
        if (redirected) return
        if (!isCurrentLoadGen(gen, loadGen.current)) return
        if (showedCache) {
          setRefreshError(true)
        } else {
          alert('정보를 불러오지 못했습니다.')
          setAllowed(true)
        }
      } finally {
        if (!redirected && isCurrentLoadGen(gen, loadGen.current)) {
          setLoading(false)
        }
      }
    }
    run()
  }, [router])

  if (!summary && (loading || !allowed)) {
    return <p style={{ textAlign:'center', marginTop:100 }}>로딩 중…</p>
  }

  return (
    <div
      style={{ maxWidth: 1100, margin: '10px auto' }}
      aria-busy={loading || undefined}
      data-resource-cache={summary ? 'ready' : 'empty'}
    >
      <h2 style={{ fontSize: 22, fontWeight: 800, marginBottom: 12 }}>캐디 대시보드 (보기 전용)</h2>
      {loading && summary ? (
        <p style={{ color: '#64748b', marginTop: 0 }}>업데이트 중…</p>
      ) : null}
      {refreshError ? (
        <p style={{ color: '#b91c1c', marginTop: 0 }}>갱신 실패</p>
      ) : null}
      <PwaInstallCard />
      <DevicePushSettings />

      {summary && (
        <>
          <p style={{ marginBottom: 14, color: '#64748b' }}>{summary.date} 오늘 현황</p>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(5, 1fr)', gap:10 }}>
            <Tag label="휴무" value={summary.today.off} />
            <Tag label="병가" value={summary.today.sick} />
            <Tag label="장기병가" value={summary.today.longSick} />
            <Tag label="당번" value={summary.today.duty} />
            <Tag label="마샬" value={summary.today.marshal} />
          </div>

          <div style={{ marginTop: 28 }}>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>배치표</h3>
            <a
              href="/board"
              style={{
                display: "inline-block",
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #e5e7eb",
                background: "#0f172a",
                color: "#fff",
                textDecoration: "none",
                fontWeight: 700,
              }}
            >
              공용 배치표 보기
            </a>
          </div>

          <div style={{ marginTop: 28 }}>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>휴무 신청</h3>
            <a
              href="/off-requests"
              style={{
                display: "inline-block",
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #e5e7eb",
                background: "#21453a",
                color: "#fff",
                textDecoration: "none",
                fontWeight: 700,
              }}
            >
              월간 휴무 신청
            </a>
          </div>

          <div style={{ marginTop: 28 }}>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>코스 제보</h3>
            <a
              href="/course-reports"
              style={{
                display: "inline-block",
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #e5e7eb",
                background: "#163028",
                color: "#fff",
                textDecoration: "none",
                fontWeight: 700,
              }}
            >
              코스 제보 보기
            </a>
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
                    {n.important ? '[중요] ' : ''}
                    {n.pinned ? '[고정] ' : ''}
                    {n.title}
                  </a>
                  <span style={{ marginLeft: 8, fontSize: 12, color: '#94a3b8' }}>
                    {formatKstDisplay(n.createdAt, "ymd-hm")}
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
      border:'1px solid #e5e7eb', borderRadius:12, padding:'10px 12px',
      background:'#fff', textAlign:'center'
    }}>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800 }}>{value}</div>
    </div>
  )
}
