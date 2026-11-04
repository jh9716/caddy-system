'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  caddyOpsRosterRowState,
  isCaddyOpsRosterPayload,
  type CaddyOpsRosterPayload,
} from '@/lib/caddyOpsRoster'

type Phase = 'loading' | 'ready' | 'error'

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

/** 읽기 전용. 배정 변경 UI/요청 없음. */
export default function CaddyOpsRosterSection() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [data, setData] = useState<CaddyOpsRosterPayload | null>(null)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const gen = useRef(0)
  const dataRef = useRef<CaddyOpsRosterPayload | null>(null)

  const load = useCallback(async () => {
    const my = ++gen.current
    setPhase('loading')
    setRefreshFailed(false)
    try {
      const fast = await fetchRoster(false)
      if (my !== gen.current) return
      dataRef.current = fast
      setData(fast)
      setPhase('ready')
      if (fast.ready && fast.freshness === 'fresh') return
      // 관리자 대시보드와 같은 흐름: fast 후 Sheet 반영 refresh 1회
      const refreshed = await fetchRoster(true)
      if (my !== gen.current) return
      dataRef.current = refreshed
      setData(refreshed)
    } catch {
      if (my !== gen.current) return
      if (dataRef.current) {
        setPhase('ready')
        setRefreshFailed(true)
      } else {
        setPhase('error')
      }
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section
      className="caddy-home-section caddy-ops-roster"
      aria-label="운영 당번·마샬·조장"
      data-ops-roster-phase={phase}
    >
      <div className="caddy-home-section-row">
        <h2 className="caddy-home-section-title">운영 당번 · 마샬 · 조장</h2>
        {phase === 'ready' && data && refreshFailed ? (
          <button type="button" className="caddy-ops-roster-retry" onClick={() => void load()}>
            최신 확인 실패 · 다시 시도
          </button>
        ) : phase === 'ready' && data && !data.ready ? (
          <span className="caddy-ops-roster-note">정보 확인 중…</span>
        ) : null}
      </div>
      {phase === 'loading' && !data ? (
        <p className="caddy-ops-roster-status" role="status">정보 확인 중…</p>
      ) : phase === 'error' && !data ? (
        <div className="caddy-ops-roster-status is-error" role="alert">
          <span>조회 실패</span>
          <button type="button" className="caddy-ops-roster-retry" onClick={() => void load()}>
            다시 시도
          </button>
        </div>
      ) : data ? (
        <ul className="caddy-ops-roster-list">
          {data.groups.map((g) => {
            const state = caddyOpsRosterRowState(g, data.ready)
            return (
              <li key={g.role} className="caddy-ops-roster-row" data-role={g.role} data-state={state}>
                <span className="caddy-ops-roster-label">{g.label}</span>
                <span className="caddy-ops-roster-names">
                  {state === 'assigned'
                    ? g.names.join(' · ')
                    : state === 'pending'
                      ? '정보 확인 중'
                      : '미배정'}
                </span>
                <span className="caddy-ops-roster-count">
                  {state === 'pending' ? '—' : `${g.count}명`}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
