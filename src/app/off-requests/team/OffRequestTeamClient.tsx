"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { kstYmd } from "@/lib/kstDate";
import { isYearMonth, ymdDaysInYearMonth } from "@/lib/offRequestDomain";
import {
  OFF_REQUEST_MEMBER_PATH,
  offRequestWindowStatusLabel,
  shiftYearMonth,
} from "@/lib/offRequestWindowUi";

type WindowStatus = "DRAFT" | "OPEN" | "ADJUSTING" | "FINALIZED";

type RequestRow = {
  id: number;
  caddyId: number;
  caddyName: string;
  date: string;
  status: string;
};

type DayDto = {
  date: string;
  requestedCount: number;
  approvedCount: number;
  occupied: number;
  limit: number;
  over: boolean;
  overCount: number;
  requests: RequestRow[];
};

type TeamDto = {
  month: string;
  team: string;
  window: { id: number; status: WindowStatus } | null;
  finalization: { finalizedAt: string; finalizedByUserId: number | null } | null;
  requestedCount: number;
  canAdjust: boolean;
  canFinalize: boolean;
  blockReasons: string[];
  days: DayDto[];
};

function monthFromSearch(): string | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("month") || "";
  return isYearMonth(raw) ? raw : null;
}

export default function OffRequestTeamClient() {
  const [month, setMonth] = useState(() => monthFromSearch() || kstYmd().slice(0, 7));
  const [data, setData] = useState<TeamDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [movingId, setMovingId] = useState<number | null>(null);
  const loadGen = useRef(0);

  const monthDays = useMemo(
    () => (isYearMonth(month) ? ymdDaysInYearMonth(month) : []),
    [month]
  );

  const load = useCallback(async (nextMonth: string) => {
    const gen = ++loadGen.current;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/off-requests/team?month=${nextMonth}`, {
        credentials: "include",
        cache: "no-store",
      });
      const json = await res.json().catch(() => null);
      if (gen !== loadGen.current) return;
      if (!res.ok) {
        throw new Error(json?.message || "팀 휴무 현황을 불러오지 못했습니다.");
      }
      setData(json);
    } catch (e) {
      if (gen !== loadGen.current) return;
      setError(e instanceof Error ? e.message : "팀 휴무 현황을 불러오지 못했습니다.");
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const fromUrl = monthFromSearch();
    if (fromUrl) setMonth(fromUrl);
  }, []);

  useEffect(() => {
    void load(month);
  }, [load, month]);

  async function send(url: string, body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const extra = Array.isArray(json?.details?.conflicts)
          ? json.details.conflicts
              .map((c: { caddyName?: string; date?: string; reason?: string }) =>
                [c.caddyName, c.date, c.reason].filter(Boolean).join(" ")
              )
              .join(" / ")
          : "";
        throw new Error([json?.message, extra].filter(Boolean).join(" — "));
      }
      await load(month);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리하지 못했습니다.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onMove(id: number, toDate: string) {
    const ok = await send("/api/off-requests/team/reschedule", { id, toDate });
    if (ok) setMovingId(null);
  }

  async function onFinalize() {
    const ok = await send("/api/off-requests/team/finalize", { month });
    if (ok) setConfirm(false);
  }

  const window = data?.window ?? null;
  const status = window?.status ?? null;
  const finalized = Boolean(data?.finalization);
  const canAdjust = Boolean(data?.canAdjust);
  const visibleDays = (data?.days ?? []).filter(
    (d) => d.requestedCount > 0 || d.approvedCount > 0 || d.over
  );

  return (
    <div className="off-team">
      <header className="off-cal-head">
        <h1 className="ui-page-title">팀 휴무 조정</h1>
        <p className="ui-page-sub">
          {offRequestWindowStatusLabel(status)} · {data?.team ?? "내 팀"}
        </p>
        <p>
          <a className="off-team-back" href={OFF_REQUEST_MEMBER_PATH}>
            내 신청으로
          </a>
        </p>
      </header>

      <div className="off-cal-monthbar">
        <button
          type="button"
          className="ui-btn"
          disabled={busy}
          onClick={() => setMonth((m) => shiftYearMonth(m, -1))}
        >
          이전
        </button>
        <strong>{month}</strong>
        <button
          type="button"
          className="ui-btn"
          disabled={busy}
          onClick={() => setMonth((m) => shiftYearMonth(m, 1))}
        >
          다음
        </button>
      </div>

      {error ? <p className="off-cal-error">{error}</p> : null}
      {loading ? <p className="off-cal-hint">불러오는 중…</p> : null}

      {status === "OPEN" ? <p className="off-cal-hint">아직 신청 기간입니다</p> : null}
      {status === "DRAFT" || !window ? (
        <p className="off-cal-hint">아직 휴무 신청 전입니다. 조정할 수 없습니다.</p>
      ) : null}
      {status === "FINALIZED" ? <p className="off-cal-hint">확정됨. 변경할 수 없습니다.</p> : null}
      {finalized ? (
        <p className="off-cal-hint">
          확정 완료
          {data?.finalization?.finalizedAt
            ? ` · ${data.finalization.finalizedAt.slice(0, 16).replace("T", " ")}`
            : ""}
        </p>
      ) : null}

      {visibleDays.length === 0 && !loading && !finalized ? (
        <section className="off-admin-card">
          <p className="off-cal-hint">이 달 신청 0건입니다. 검토 후 팀 최종확정할 수 있습니다.</p>
        </section>
      ) : null}

      {visibleDays.map((day) => (
        <section
          key={day.date}
          className={`off-admin-card off-team-day${day.over ? " is-over" : ""}`}
        >
          <h2 className="off-team-day-title">
            {day.date.slice(5).replace("-", "/")}
            <span>
              {day.occupied} / {day.limit}
              {day.over ? ` · ${day.overCount}명 초과` : ""}
            </span>
          </h2>
          <ul className="off-team-list">
            {day.requests.map((row) => (
              <li key={row.id}>
                <span>
                  {row.caddyName} {row.date.slice(5).replace("-", "/")}
                  {row.status === "APPROVED" ? " · 확정" : ""}
                </span>
                {canAdjust ? (
                  movingId === row.id ? (
                    <label className="off-team-move">
                      날짜 변경
                      <select
                        defaultValue={row.date}
                        disabled={busy}
                        onChange={(e) => {
                          const next = e.target.value;
                          if (next !== row.date) void onMove(row.id, next);
                        }}
                      >
                        {monthDays.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost"
                      disabled={busy}
                      onClick={() => setMovingId(row.id)}
                    >
                      날짜 변경
                    </button>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div className="off-team-foot">
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={busy || !data?.canFinalize}
          onClick={() => setConfirm(true)}
        >
          팀 최종확정
        </button>
        {!data?.canFinalize && data?.blockReasons.length ? (
          <p className="off-cal-hint">{data.blockReasons.join(" · ")}</p>
        ) : null}
      </div>

      {confirm ? (
        <div className="off-admin-modal" role="dialog" aria-modal="true">
          <div className="off-admin-modal-card">
            <p>
              {data?.team ?? "이 팀"} 휴무 {data?.requestedCount ?? 0}건을 최종 확정합니다.
              확정 후 팀장은 수정할 수 없습니다.
            </p>
            <div className="off-admin-actions">
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                disabled={busy}
                onClick={() => void onFinalize()}
              >
                확정
              </button>
              <button
                type="button"
                className="ui-btn"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                취소
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
