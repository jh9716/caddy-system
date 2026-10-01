"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { kstYmd } from "@/lib/kstDate";
import {
  consumeUnauthorizedMemberResponse,
  redirectMemberToLogin,
} from "@/lib/memberSessionRedirect";
import { isYearMonth } from "@/lib/offRequestDomain";
import {
  CLIENT_RESOURCE,
  ensureClientAuthNamespace,
  invalidateClientResource,
  peekLastNamespaceResource,
  readLastClientAuthNamespace,
  shouldApplyScopedResponse,
  writeClientResource,
} from "@/lib/clientResourceCache";
import {
  calendarPlaceholderDates,
  isCurrentLoadGen,
  isStaleCalendarMonth,
} from "@/lib/pendingLoad";
import {
  offRequestWindowHint,
  offRequestWindowStatusLabel,
  shiftYearMonth,
  weekdayIndexUtc,
} from "@/lib/offRequestWindowUi";

type WindowDto = {
  id: number;
  yearMonth: string;
  status: "DRAFT" | "OPEN" | "ADJUSTING" | "FINALIZED";
  openAt: string;
  closeAt: string;
  defaultQuota: number;
};

type MineDto = {
  id: number;
  date: string;
  status: string;
};

type DayDto = {
  date: string;
  limit: number;
  requestedCount: number;
  approvedCount: number;
  mine: MineDto | null;
  over: boolean;
};

type CalendarDto = {
  month: string;
  today: string;
  window: WindowDto | null;
  days: DayDto[];
};

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function formatPeriod(window: WindowDto | null): string {
  if (!window) return "일정 없음";
  const open = window.openAt.slice(0, 10);
  const close = window.closeAt.slice(0, 10);
  return `${open} ~ ${close}`;
}

export default function OffRequestCalendarClient() {
  const [month, setMonth] = useState(() => kstYmd().slice(0, 7));
  const [data, setData] = useState<CalendarDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [moveId, setMoveId] = useState<number | null>(null);
  const loadGen = useRef(0);

  const load = useCallback(async (nextMonth: string) => {
    const gen = ++loadGen.current;
    const cached = peekLastNamespaceResource<CalendarDto>(
      CLIENT_RESOURCE.OFF_CALENDAR,
      nextMonth,
      (value) => value.month === nextMonth
    );
    if (cached) {
      setData(cached.value);
      setError("");
    }
    setLoading(true);
    setMoveId(null);
    const nsPromise = ensureClientAuthNamespace();
    try {
      const res = await fetch(`/api/off-requests/calendar?month=${nextMonth}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!isCurrentLoadGen(gen, loadGen.current)) return;
      if (consumeUnauthorizedMemberResponse(res)) return;
      if (res.status === 401) {
        redirectMemberToLogin();
        return;
      }
      const json = await res.json().catch(() => null);
      const responseMonth =
        json && typeof json.month === "string" ? json.month : nextMonth;
      if (
        !shouldApplyScopedResponse({
          requestGen: gen,
          latestGen: loadGen.current,
          selectedKey: nextMonth,
          responseKey: responseMonth,
        })
      ) {
        return;
      }
      if (!res.ok) {
        throw new Error(json?.message || "달력을 불러오지 못했습니다.");
      }
      setData(json);
      setError("");
      const ns = await nsPromise;
      if (!isCurrentLoadGen(gen, loadGen.current)) return;
      if (!ns) return;
      writeClientResource(ns, CLIENT_RESOURCE.OFF_CALENDAR, nextMonth, json);
    } catch (e) {
      if (!isCurrentLoadGen(gen, loadGen.current)) return;
      setError(e instanceof Error ? e.message : "달력을 불러오지 못했습니다.");
    } finally {
      if (isCurrentLoadGen(gen, loadGen.current)) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(month);
  }, [load, month]);

  const staleMonth = isStaleCalendarMonth(data?.month, month);
  const window = staleMonth ? null : data?.window ?? null;
  const open = window?.status === "OPEN";
  const cells = useMemo(() => {
    const days = staleMonth
      ? calendarPlaceholderDates(month).map((date) => ({ date, pending: true as const }))
      : (data?.days ?? []).map((day) => ({ ...day, pending: false as const }));
    if (days.length === 0) return [];
    const pad = weekdayIndexUtc(days[0].date);
    return [...Array.from({ length: pad }, () => null), ...days];
  }, [data, month, staleMonth]);

  async function postJson(url: string, body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (consumeUnauthorizedMemberResponse(res)) return false;
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(json?.message || "처리하지 못했습니다.");
      }
      const ns = readLastClientAuthNamespace();
      if (ns) invalidateClientResource(ns, CLIENT_RESOURCE.OFF_CALENDAR, month);
      await load(month);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리하지 못했습니다.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onDayClick(day: DayDto) {
    if (!open || busy) return;
    if (day.mine) {
      if (moveId === day.mine.id) {
        setMoveId(null);
        return;
      }
      setMoveId(day.mine.id);
      return;
    }
    if (moveId != null) {
      const ok = await postJson(`/api/off-requests/${moveId}/reschedule`, {
        toDate: day.date,
      });
      if (ok) setMoveId(null);
      return;
    }
    await postJson("/api/off-requests", { date: day.date });
  }

  async function onCancel(day: DayDto) {
    if (!day.mine || !open || busy) return;
    const ok = await postJson(`/api/off-requests/${day.mine.id}/cancel`, {});
    if (ok) setMoveId(null);
  }

  return (
    <div
      className="off-cal"
      aria-busy={loading || staleMonth || undefined}
      data-resource-cache={data?.month === month ? "ready" : "empty"}
    >
      <header className="off-cal-head">
        <h1 className="ui-page-title">휴무 신청</h1>
        <p className="ui-page-sub">
          {staleMonth
            ? "이 달 현황 불러오는 중"
            : `${offRequestWindowStatusLabel(window?.status)} · ${formatPeriod(window)}`}
        </p>
      </header>

      <div className="off-cal-monthbar">
        <button
          type="button"
          className="ui-btn"
          onClick={() => setMonth((m) => shiftYearMonth(m, -1))}
          disabled={busy}
        >
          이전
        </button>
        <strong>{isYearMonth(month) ? month : ""}</strong>
        <button
          type="button"
          className="ui-btn"
          onClick={() => setMonth((m) => shiftYearMonth(m, 1))}
          disabled={busy}
        >
          다음
        </button>
      </div>

      {staleMonth ? (
        <p className="off-cal-updating">날짜별 신청 현황을 불러오는 중</p>
      ) : (
        <p className="off-cal-hint">{offRequestWindowHint(window?.status ?? null)}</p>
      )}
      {!staleMonth && loading && data ? (
        <p className="off-cal-updating">업데이트 중…</p>
      ) : null}
      {moveId != null && open ? (
        <p className="off-cal-hint is-move">다른 날짜를 누르면 신청일이 이동합니다.</p>
      ) : null}
      {error ? <p className="off-cal-error">{error}</p> : null}

      <div className="off-cal-grid" role="grid" aria-label="휴무 신청 달력">
        {WEEKDAYS.map((w) => (
          <div key={w} className="off-cal-dow">
            {w}
          </div>
        ))}
        {cells.map((day, idx) => {
          if (!day) {
            return <div key={`pad-${idx}`} className="off-cal-cell is-empty" />;
          }
          if (day.pending) {
            return (
              <div key={day.date} className="off-cal-cell is-pending">
                <span className="off-cal-num">{Number(day.date.slice(-2))}</span>
                <span className="vh-skel vh-skel-line" />
              </div>
            );
          }
          const mine = Boolean(day.mine);
          const classes = [
            "off-cal-cell",
            mine ? "is-mine" : "",
            day.over ? "is-over" : "",
            open ? "is-open" : "is-locked",
            moveId != null && mine && moveId === day.mine?.id ? "is-moving" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={day.date}
              type="button"
              className={classes}
              disabled={!open || busy}
              onClick={() => void onDayClick(day)}
            >
              <span className="off-cal-num">{Number(day.date.slice(-2))}</span>
              <span className="off-cal-count">
                {day.approvedCount + day.requestedCount}/{day.limit}
              </span>
              {mine ? <span className="off-cal-mine">내 신청</span> : null}
            </button>
          );
        })}
      </div>

      {open && data?.days.some((d) => d.mine) ? (
        <ul className="off-cal-mine-list">
          {data.days
            .filter((d) => d.mine)
            .map((d) => (
              <li key={d.date}>
                <span>{d.date}</span>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost"
                  disabled={busy}
                  onClick={() => void onCancel(d)}
                >
                  취소
                </button>
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}
