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

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const
const NOTICE_PREVIEW = 4

function formatCaddyHomeDate(ymd: string): { label: string; weekday: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return { label: ymd, weekday: '' }
  const dt = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+09:00`)
  const weekday = Number.isNaN(dt.getTime()) ? '' : WEEKDAYS[dt.getDay()]
  return {
    label: `${Number(m[2])}월 ${Number(m[3])}일`,
    weekday,
  }
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

  const todayDate = summary ? formatCaddyHomeDate(summary.date) : null
  const notices = summary?.latestNotices.slice(0, NOTICE_PREVIEW) ?? []

  return (
    <div
      className="caddy-home"
      aria-busy={loading || undefined}
      data-resource-cache={summary ? 'ready' : 'empty'}
    >
      <header className="caddy-home-head">
        <h1 className="caddy-home-title">내 대시보드</h1>
        {loading && summary ? (
          <p className="caddy-home-note">업데이트 중…</p>
        ) : null}
        {refreshError ? (
          <p className="caddy-home-note is-error">갱신 실패</p>
        ) : null}
      </header>

      {summary && todayDate && (
        <>
          <section className="caddy-home-today" aria-label="오늘">
            <p className="caddy-home-today-kicker">오늘</p>
            <h2 className="caddy-home-today-date">
              {todayDate.label}
              {todayDate.weekday ? (
                <span className="caddy-home-today-weekday"> ({todayDate.weekday})</span>
              ) : null}
            </h2>
            <p className="caddy-home-today-status">개인 상태 정보 없음</p>
          </section>

          <section className="caddy-home-section" aria-label="오늘 현황">
            <h2 className="caddy-home-section-title">오늘 현황</h2>
            <div className="caddy-home-stats">
              <Stat label="휴무" value={summary.today.off} />
              <Stat label="병가" value={summary.today.sick} />
              <Stat label="장기병가" value={summary.today.longSick} />
              <Stat label="당번" value={summary.today.duty} />
              <Stat label="마샬" value={summary.today.marshal} />
            </div>
          </section>

          <section className="caddy-home-section" aria-label="최근 공지">
            <div className="caddy-home-section-row">
              <h2 className="caddy-home-section-title">최근 공지</h2>
              <a href="/notice" className="caddy-home-more">전체보기 {'>'}</a>
            </div>
            <ul className="caddy-home-notices">
              {notices.length === 0 && (
                <li className="caddy-home-notice is-empty">공지 없음</li>
              )}
              {notices.map((n) => (
                <li key={n.id} className="caddy-home-notice">
                  <a href={`/notice/${n.id}`} className="caddy-home-notice-link">
                    <span className="caddy-home-notice-main">
                      {n.important ? (
                        <span className="caddy-home-badge is-important">중요</span>
                      ) : null}
                      {n.pinned ? (
                        <span className="caddy-home-badge is-pinned">고정</span>
                      ) : null}
                      <span className="caddy-home-notice-title">{n.title}</span>
                    </span>
                    <span className="caddy-home-notice-date">
                      {formatKstDisplay(n.createdAt, "ymd")}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>

          <section className="caddy-home-section" aria-label="내 일정">
            <h2 className="caddy-home-section-title">내 일정</h2>
            <p className="caddy-home-schedule-note">
              휴무 신청 현황은 월간 휴무 신청에서 확인할 수 있습니다.
            </p>
            <a href="/off-requests" className="caddy-home-cta">월간 휴무 신청</a>
            <a href="/board" className="caddy-home-shortcut">배치표</a>
          </section>
        </>
      )}

      <PwaInstallCard />
      <div className="caddy-home-push">
        <DevicePushSettings />
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="caddy-home-stat">
      <div className="caddy-home-stat-label">{label}</div>
      <div className="caddy-home-stat-value">{value}</div>
    </div>
  )
}
