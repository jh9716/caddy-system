"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PRIMARY_TEAMS } from "@/lib/caddyManage";
import { isYearMonth } from "@/lib/offRequestDomain";
import { formatKstDateTimeLocal, formatKstDisplay, kstYmd } from "@/lib/kstDate";
import {
  offRequestWindowStatusLabel,
  shiftYearMonth,
  weekdayIndexUtc,
} from "@/lib/offRequestWindowUi";

function monthFromSearch(): string | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("month") || "";
  return isYearMonth(raw) ? raw : null;
}

type WindowStatus = "DRAFT" | "OPEN" | "ADJUSTING" | "FINALIZED";

type WindowDto = {
  id: number;
  yearMonth: string;
  status: WindowStatus;
  openAt: string;
  closeAt: string;
  defaultQuota: number;
};

type TeamCell = {
  team: string;
  requestedCount: number;
  approvedCount: number;
  occupied: number;
  limit: number;
  over: boolean;
  override: boolean;
};

type DayDto = {
  date: string;
  requestedCount: number;
  approvedCount: number;
  occupied: number;
  overTeamCount: number;
  teams: TeamCell[];
};

type ProgressTeam = {
  team: string;
  finalized: boolean;
  finalizedAt: string | null;
};

type ProgressDto = {
  teamCount: number;
  finalizedCount: number;
  teams: ProgressTeam[];
};

type AdminMonthDto = {
  month: string;
  window: WindowDto | null;
  teams: string[];
  quotas: Array<{ team: string; date: string; limit: number }>;
  days: DayDto[];
  progress?: ProgressDto;
};

type ConfirmKind = "open" | "close" | "finalize" | null;

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function defaultCreateInputs(month: string) {
  const [y, m] = month.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1));
  const py = prev.getUTCFullYear();
  const pm = String(prev.getUTCMonth() + 1).padStart(2, "0");
  return {
    openAt: `${py}-${pm}-01T09:00`,
    closeAt: `${month}-20T18:00`,
    defaultQuota: "5",
  };
}

function teamCell(day: DayDto | undefined, team: string): TeamCell | null {
  return day?.teams.find((t) => t.team === team) ?? null;
}

export default function OffRequestAdminClient() {
  const [month, setMonth] = useState(() => kstYmd().slice(0, 7));
  const [team, setTeam] = useState<string>(PRIMARY_TEAMS[6] ?? "7조");
  const [data, setData] = useState<AdminMonthDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmKind>(null);
  const [proxyTeam, setProxyTeam] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(() => defaultCreateInputs(kstYmd().slice(0, 7)));
  const [editForm, setEditForm] = useState({
    openAt: "",
    closeAt: "",
    defaultQuota: "5",
  });
  const [quotaLimit, setQuotaLimit] = useState("5");
  const loadGen = useRef(0);

  const load = useCallback(async (nextMonth: string) => {
    const gen = ++loadGen.current;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/off-requests/admin-month?month=${nextMonth}`, {
        credentials: "include",
        cache: "no-store",
      });
      const json = await res.json().catch(() => null);
      if (gen !== loadGen.current) return;
      if (!res.ok) {
        throw new Error(json?.message || "월간 현황을 불러오지 못했습니다.");
      }
      setData(json);
      if (json.window) {
        setEditForm({
          openAt: formatKstDateTimeLocal(json.window.openAt),
          closeAt: formatKstDateTimeLocal(json.window.closeAt),
          defaultQuota: String(json.window.defaultQuota),
        });
      } else {
        setCreateForm(defaultCreateInputs(nextMonth));
      }
    } catch (e) {
      if (gen !== loadGen.current) return;
      setError(e instanceof Error ? e.message : "월간 현황을 불러오지 못했습니다.");
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

  const window = data?.window ?? null;
  const draft = window?.status === "DRAFT";
  const open = window?.status === "OPEN";
  const adjusting = window?.status === "ADJUSTING";
  const finalized = window?.status === "FINALIZED";
  const canEditQuota = draft;
  const selected = data?.days.find((d) => d.date === selectedDate) ?? null;
  const selectedTeam = teamCell(selected ?? undefined, team);

  const cells = useMemo(() => {
    const days = data?.days ?? [];
    if (days.length === 0) return [];
    const pad = weekdayIndexUtc(days[0].date);
    return [...Array.from({ length: pad }, () => null), ...days];
  }, [data]);

  async function send(
    url: string,
    method: string,
    body?: Record<string, unknown>
  ): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(url, {
        method,
        credentials: "include",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(json?.message || "처리하지 못했습니다.");
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

  async function onCreate() {
    const ok = await send("/api/off-requests/window", "POST", {
      yearMonth: month,
      openAt: createForm.openAt ? new Date(`${createForm.openAt}:00+09:00`).toISOString() : "",
      closeAt: createForm.closeAt ? new Date(`${createForm.closeAt}:00+09:00`).toISOString() : "",
      defaultQuota: Number(createForm.defaultQuota),
    });
    if (ok) setCreateOpen(false);
  }

  async function onPatch() {
    if (!window) return;
    await send(`/api/off-requests/window/${window.id}`, "PATCH", {
      openAt: editForm.openAt ? new Date(`${editForm.openAt}:00+09:00`).toISOString() : undefined,
      closeAt: editForm.closeAt ? new Date(`${editForm.closeAt}:00+09:00`).toISOString() : undefined,
      defaultQuota: Number(editForm.defaultQuota),
    });
  }

  async function onConfirm() {
    if (!window || !confirm) return;
    const path =
      confirm === "open" ? "open" : confirm === "close" ? "close" : "finalize";
    const ok = await send(`/api/off-requests/window/${window.id}/${path}`, "POST");
    if (ok) setConfirm(null);
  }

  async function onProxyFinalize() {
    if (!proxyTeam) return;
    const ok = await send("/api/off-requests/admin/finalize-team", "POST", {
      month,
      team: proxyTeam,
    });
    if (ok) setProxyTeam(null);
  }

  async function onSaveQuota() {
    if (!selectedDate) return;
    const ok = await send("/api/off-requests/quota", "PUT", {
      month,
      team,
      date: selectedDate,
      limit: Number(quotaLimit),
    });
    if (ok) setQuotaLimit(quotaLimit);
  }

  async function onDeleteQuota() {
    if (!selectedDate) return;
    await send("/api/off-requests/quota", "DELETE", {
      month,
      team,
      date: selectedDate,
    });
  }

  function pickDate(date: string) {
    setSelectedDate(date);
    const day = data?.days.find((d) => d.date === date);
    const cell = teamCell(day, team);
    setQuotaLimit(String(cell?.limit ?? window?.defaultQuota ?? 5));
  }

  function changeTeam(next: string) {
    setTeam(next);
    if (selectedDate) {
      const day = data?.days.find((d) => d.date === selectedDate);
      const cell = teamCell(day, next);
      setQuotaLimit(String(cell?.limit ?? window?.defaultQuota ?? 5));
    }
  }

  const overrides = (data?.quotas ?? []).filter((q) => q.team === team);

  return (
    <div className="off-admin">
      <header className="off-admin-head">
        <h1 className="ui-page-title">휴무 신청 관리</h1>
        <p className="ui-page-sub">월별 신청 기간을 만들고 열고 마감합니다.</p>
      </header>

      <div className="off-cal-monthbar">
        <button
          type="button"
          className="ui-btn"
          disabled={busy}
          onClick={() => {
            setSelectedDate(null);
            setCreateOpen(false);
            setMonth((m) => shiftYearMonth(m, -1));
          }}
        >
          이전
        </button>
        <strong>{month}</strong>
        <button
          type="button"
          className="ui-btn"
          disabled={busy}
          onClick={() => {
            setSelectedDate(null);
            setCreateOpen(false);
            setMonth((m) => shiftYearMonth(m, 1));
          }}
        >
          다음
        </button>
      </div>

      {error ? <p className="off-cal-error">{error}</p> : null}
      {loading ? <p className="off-cal-hint">불러오는 중…</p> : null}

      {!loading && !window ? (
        <section className="off-admin-card">
          <p className="off-admin-status">신청 기간 없음</p>
          {!createOpen ? (
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={busy}
              onClick={() => {
                setCreateForm(defaultCreateInputs(month));
                setCreateOpen(true);
              }}
            >
              휴무 신청 만들기
            </button>
          ) : (
            <form
              className="off-admin-form"
              onSubmit={(e) => {
                e.preventDefault();
                void onCreate();
              }}
            >
              <label>
                대상 월
                <input value={month} readOnly />
              </label>
              <label>
                신청 시작 예정
                <input
                  type="datetime-local"
                  value={createForm.openAt}
                  onChange={(e) => setCreateForm((f) => ({ ...f, openAt: e.target.value }))}
                />
              </label>
              <label>
                신청 마감 예정
                <input
                  type="datetime-local"
                  value={createForm.closeAt}
                  onChange={(e) => setCreateForm((f) => ({ ...f, closeAt: e.target.value }))}
                />
              </label>
              <label>
                기본 허용 인원
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={createForm.defaultQuota}
                  onChange={(e) => setCreateForm((f) => ({ ...f, defaultQuota: e.target.value }))}
                />
              </label>
              <div className="off-admin-actions">
                <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>
                  DRAFT로 만들기
                </button>
                <button
                  type="button"
                  className="ui-btn"
                  disabled={busy}
                  onClick={() => setCreateOpen(false)}
                >
                  취소
                </button>
              </div>
            </form>
          )}
        </section>
      ) : null}

      {window ? (
        <section className="off-admin-card">
          <p className="off-admin-status">
            {offRequestWindowStatusLabel(window.status)} · {window.status}
          </p>
          <dl className="off-admin-meta">
            <div>
              <dt>대상 월</dt>
              <dd>{window.yearMonth}</dd>
            </div>
            <div>
              <dt>신청 시작 예정</dt>
              <dd>{formatKstDisplay(window.openAt, "ymd-hm")}</dd>
            </div>
            <div>
              <dt>신청 마감 예정</dt>
              <dd>{formatKstDisplay(window.closeAt, "ymd-hm")}</dd>
            </div>
            <div>
              <dt>기본 허용 인원</dt>
              <dd>{window.defaultQuota}명</dd>
            </div>
          </dl>
          {open ? <p className="off-cal-hint">현재 신청 진행 중. 현황은 읽기 전용입니다.</p> : null}
          {adjusting ? (
            <p className="off-cal-hint">
              조정 중. 모든 팀이 확정되면 월 전체를 잠글 수 있습니다.
            </p>
          ) : null}
          {finalized ? <p className="off-cal-hint">확정됨. 변경할 수 없습니다.</p> : null}

          {draft ? (
            <form
              className="off-admin-form"
              onSubmit={(e) => {
                e.preventDefault();
                void onPatch();
              }}
            >
              <label>
                신청 시작 예정
                <input
                  type="datetime-local"
                  value={editForm.openAt}
                  onChange={(e) => setEditForm((f) => ({ ...f, openAt: e.target.value }))}
                />
              </label>
              <label>
                신청 마감 예정
                <input
                  type="datetime-local"
                  value={editForm.closeAt}
                  onChange={(e) => setEditForm((f) => ({ ...f, closeAt: e.target.value }))}
                />
              </label>
              <label>
                기본 허용 인원
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={editForm.defaultQuota}
                  onChange={(e) => setEditForm((f) => ({ ...f, defaultQuota: e.target.value }))}
                />
              </label>
              <button type="submit" className="ui-btn" disabled={busy}>
                일정/정원 저장
              </button>
            </form>
          ) : null}

          <div className="off-admin-actions">
            {draft ? (
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                disabled={busy}
                onClick={() => setConfirm("open")}
              >
                신청 시작
              </button>
            ) : null}
            {open ? (
              <button
                type="button"
                className="ui-btn ui-btn-danger"
                disabled={busy}
                onClick={() => setConfirm("close")}
              >
                신청 마감
              </button>
            ) : null}
            {adjusting ? (
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                disabled={
                  busy ||
                  (data?.progress?.finalizedCount ?? 0) < (data?.progress?.teamCount ?? 12)
                }
                onClick={() => setConfirm("finalize")}
              >
                월 전체 확정
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {window && data?.progress ? (
        <section className="off-admin-card">
          <h2 className="off-admin-subtitle">
            {data.progress.finalizedCount} / {data.progress.teamCount}팀 확정
          </h2>
          <ul className="off-admin-progress">
            {data.progress.teams.map((row) => (
              <li key={row.team} className={row.finalized ? "is-done" : "is-wait"}>
                <span>{row.team}</span>
                {row.finalized ? (
                  <strong>확정</strong>
                ) : (
                  <span className="off-admin-progress-wait">
                    <strong>미확정</strong>
                    {adjusting ? (
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost"
                        disabled={busy}
                        onClick={() => setProxyTeam(row.team)}
                      >
                        대행 확정
                      </button>
                    ) : null}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="off-admin-card">
        <div className="off-admin-teambar">
          <label>
            조
            <select value={team} onChange={(e) => changeTeam(e.target.value)}>
              {PRIMARY_TEAMS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <p className="off-cal-hint">
            날짜별 숫자는 신청 + 확정 OFF / 정원입니다. 다른 캐디 이름은 보이지 않습니다.
          </p>
        </div>

        <div className="off-cal-grid" role="grid" aria-label="휴무 신청 관리 달력">
          {WEEKDAYS.map((w) => (
            <div key={w} className="off-cal-dow">
              {w}
            </div>
          ))}
          {cells.map((day, idx) => {
            if (!day) return <div key={`pad-${idx}`} className="off-cal-cell is-empty" />;
            const cell = teamCell(day, team);
            const classes = [
              "off-cal-cell",
              "is-open",
              selectedDate === day.date ? "is-moving" : "",
              cell?.over ? "is-over" : "",
              cell?.override ? "is-mine" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={day.date}
                type="button"
                className={classes}
                disabled={busy}
                onClick={() => pickDate(day.date)}
              >
                <span className="off-cal-num">{Number(day.date.slice(-2))}</span>
                <span className="off-cal-count">
                  {cell ? `${cell.occupied}/${cell.limit}` : `${day.occupied}`}
                </span>
                {cell?.override ? <span className="off-cal-mine">지정</span> : null}
              </button>
            );
          })}
        </div>

        {overrides.length > 0 ? (
          <ul className="off-admin-overrides">
            {overrides.map((q) => (
              <li key={`${q.team}-${q.date}`}>
                {q.date} {q.team} → {q.limit}명
              </li>
            ))}
          </ul>
        ) : (
          <p className="off-cal-hint">이 조 override 없음. 기본 {window?.defaultQuota ?? 5}명.</p>
        )}
      </section>

      {selected ? (
        <section className="off-admin-card">
          <h2 className="off-admin-subtitle">{selected.date} 신청 현황</h2>
          {canEditQuota ? (
            <form
              className="off-admin-form is-inline"
              onSubmit={(e) => {
                e.preventDefault();
                void onSaveQuota();
              }}
            >
              <label>
                조
                <select value={team} onChange={(e) => changeTeam(e.target.value)}>
                  {PRIMARY_TEAMS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                허용 인원
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={quotaLimit}
                  onChange={(e) => setQuotaLimit(e.target.value)}
                />
              </label>
              <button type="submit" className="ui-btn ui-btn-primary" disabled={busy}>
                override 저장
              </button>
              {selectedTeam?.override ? (
                <button
                  type="button"
                  className="ui-btn"
                  disabled={busy}
                  onClick={() => void onDeleteQuota()}
                >
                  기본값으로 복귀
                </button>
              ) : null}
            </form>
          ) : (
            <p className="off-cal-hint">
              {selectedTeam?.override
                ? `${team} override ${selectedTeam.limit}명`
                : `${team}는 기본 ${window?.defaultQuota ?? 5}명`}
            </p>
          )}

          <table className="off-admin-table">
            <thead>
              <tr>
                <th>조</th>
                <th>신청</th>
                <th>확정 OFF</th>
                <th>예상 총원</th>
                <th>정원</th>
                <th>초과</th>
              </tr>
            </thead>
            <tbody>
              {selected.teams.map((row) => (
                <tr key={row.team} className={row.team === team ? "is-current" : ""}>
                  <td>{row.team}</td>
                  <td>{row.requestedCount}</td>
                  <td>{row.approvedCount}</td>
                  <td>{row.occupied}</td>
                  <td>
                    {row.limit}
                    {row.override ? " *" : ""}
                  </td>
                  <td>{row.over ? "초과" : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {proxyTeam ? (
        <div className="off-admin-modal" role="dialog" aria-modal="true">
          <div className="off-admin-modal-card">
            <p>
              {proxyTeam} 휴무를 관리자가 대행 확정합니다. 정원/충돌 검증은 팀장 확정과
              같습니다. 확정 후 해당 팀은 수정할 수 없습니다.
            </p>
            <div className="off-admin-actions">
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                disabled={busy}
                onClick={() => void onProxyFinalize()}
              >
                대행 확정
              </button>
              <button
                type="button"
                className="ui-btn"
                disabled={busy}
                onClick={() => setProxyTeam(null)}
              >
                취소
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirm ? (
        <div className="off-admin-modal" role="dialog" aria-modal="true">
          <div className="off-admin-modal-card">
            <p>
              {confirm === "open"
                ? "이 달 휴무 신청을 시작할까요? 캐디가 신청할 수 있게 됩니다."
                : confirm === "close"
                  ? "신청을 마감하고 조정 중으로 바꿀까요? 캐디는 더 이상 신청·변경할 수 없습니다."
                  : "모든 팀 확정을 확인하고 이 달을 최종 잠글까요? 이후 수정할 수 없습니다."}
            </p>
            <div className="off-admin-actions">
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                disabled={busy}
                onClick={() => void onConfirm()}
              >
                {confirm === "open"
                  ? "신청 시작"
                  : confirm === "close"
                    ? "신청 마감"
                    : "월 전체 확정"}
              </button>
              <button type="button" className="ui-btn" disabled={busy} onClick={() => setConfirm(null)}>
                취소
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
