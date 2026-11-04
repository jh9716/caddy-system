'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  caddyOpsDisplayState,
  caddyOpsRowState,
  caddyOpsStatText,
  isCaddyOpsRosterPayload,
  type CaddyOpsRosterPayload,
} from '@/lib/caddyOpsRoster'
import { formatCapturedAtKst } from '@/lib/kstDate'

async function fetchRoster(refresh: boolean): Promise<CaddyOpsRosterPayload> {
  const res = await fetch(`/api/summary/ops-roster${refresh ? '?refresh=1' : ''}`, {
    credentials: 'include',
    cache: 'no-store',
    method: 'GET',
  })
  if (!res.ok) throw new Error(`status_${res.status}`)
  const json: unknown = await res.json().catch(() => null)
  if (!isCaddyOpsRosterPayload(json)) throw new Error('bad_payload')
  return json
}

/**
 * 읽기 전용. '오늘 현황'(재직/가용/휴무) + '운영 당번·마샬·조장'을
 * 하나의 /api/summary/ops-roster 응답(관리자와 같은 view)으로 그린다.
 */
export default function CaddyOpsRosterSection({
  onDate,
}: {
  onDate?: (ymd: string) => void
} = {}) {
  const [data, setData] = useState<CaddyOpsRosterPayload | null>(null)
  const [inFlight, setInFlight] = useState(true)
  const [requestFailed, setRequestFailed] = useState(false)
  const gen = useRef(0)

  const load = useCallback(async () => {
    const my = ++gen.current
    setInFlight(true)
    setRequestFailed(false)
    try {
      const fast = await fetchRoster(false)
      if (my !== gen.current) return
      setData(fast)
      if (fast.ready && fast.freshness === 'fresh') return
      // 관리자 대시보드와 같은 흐름: fast 후 Sheet 반영 refresh 1회.
      // 200이어도 freshness가 fresh가 아니면 display=refresh_failed.
      const refreshed = await fetchRoster(true)
      if (my !== gen.current) return
      setData(refreshed)
    } catch {
      if (my !== gen.current) return
      setRequestFailed(true)
    } finally {
      if (my === gen.current) setInFlight(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (data?.date) onDate?.(data.date)
  }, [data?.date, onDate])

  const display = caddyOpsDisplayState(data, { inFlight, requestFailed })
  const st = data?.stats
  const staleNote =
    display === 'refresh_failed'
      ? data?.ready && data.sourceAsOf
        ? `최신 갱신 실패 · ${formatCapturedAtKst(data.sourceAsOf)} 기준 표시`
        : '최신 데이터 갱신 실패'
      : display === 'refreshing'
        ? '최신 정보 확인 중…'
        : null
  const retry = (
    <button type="button" className="caddy-ops-roster-retry" onClick={() => void load()}>
      다시 시도
    </button>
  )
  return (
    <>
    <section
      className="caddy-home-section caddy-ops-stats"
      aria-label="오늘 현황"
      data-ops-stats-phase={display}
    >
      <h2 className="caddy-home-section-title">오늘 현황</h2>
      {staleNote ? (
        <div
          className={`caddy-ops-roster-banner${display === 'refresh_failed' ? ' is-error' : ''}`}
          role={display === 'refresh_failed' ? 'alert' : 'status'}
          data-ops-banner={display}
        >
          <span>{staleNote}</span>
          {display === 'refresh_failed' ? retry : null}
        </div>
      ) : null}
      <div
        className="caddy-home-stats caddy-ops-stats-grid"
        data-stale={display === 'refresh_failed' || undefined}
      >
        {([
          ['재직 캐디', st?.activeCount],
          ['해당일 가용', st?.finalAvailable],
          ['휴무', st?.offCount],
        ] as const).map(([label, v]) => (
          <div key={label} className="caddy-home-stat" data-stat={label}>
            <div className="caddy-home-stat-label">{label}</div>
            <div
              className={`caddy-home-stat-value${
                typeof v === 'number' && display !== 'refresh_failed' ? '' : ' is-muted'
              }`}
            >
              {caddyOpsStatText(v, display)}
            </div>
          </div>
        ))}
      </div>
      <p className="caddy-ops-stats-note">
        관리자 대시보드와 같은 운영자료 기준{data ? ` · ${data.date} (KST)` : ''} · 병가·장기병가 미제공
      </p>
    </section>
    <section
      className="caddy-home-section caddy-ops-roster"
      aria-label="운영 당번·마샬·조장"
      data-ops-roster-phase={display}
    >
      <div className="caddy-home-section-row">
        <h2 className="caddy-home-section-title">운영 당번 · 마샬 · 조장</h2>
        {display === 'refresh_failed' ? (
          <span className="caddy-ops-roster-note is-error">갱신 실패</span>
        ) : display === 'refreshing' ? (
          <span className="caddy-ops-roster-note">정보 확인 중…</span>
        ) : null}
      </div>
      {display === 'loading' ? (
        <p className="caddy-ops-roster-status" role="status">정보 확인 중…</p>
      ) : display === 'failed' || !data ? (
        <div className="caddy-ops-roster-status is-error" role="alert">
          <span>조회 실패</span>
          {retry}
        </div>
      ) : (
        <ul className="caddy-ops-roster-list" data-stale={display === 'refresh_failed' || undefined}>
          {data.groups.map((g) => {
            const state = caddyOpsRowState(g, data, display)
            return (
              <li key={g.role} className="caddy-ops-roster-row" data-role={g.role} data-state={state}>
                <span className="caddy-ops-roster-label">{g.label}</span>
                <span className="caddy-ops-roster-names">
                  {state === 'assigned'
                    ? g.names.join(' · ')
                    : state === 'pending'
                      ? '정보 확인 중'
                      : state === 'unknown'
                        ? '확인 불가'
                        : '미배정'}
                </span>
                <span className="caddy-ops-roster-count">
                  {state === 'pending' || state === 'unknown' ? '—' : `${g.count}명`}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
    </>
  )
}
