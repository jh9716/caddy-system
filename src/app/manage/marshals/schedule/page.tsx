"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MarshalManageNav from "@/components/manage/MarshalManageNav";
import MarshalPenaltyOccurrencePanel from "@/components/manage/MarshalPenaltyOccurrencePanel";
import {
  DUTY_PANEL_TITLE,
  occurrenceCalendarBadgeText,
  regenerationBannerText,
  type OccurrenceListItem,
} from "@/lib/marshalPenaltyOccurrenceUi";
import {
  MARSHAL_WEEKDAY_LABELS,
  buildMarshalDayBoard,
  buildMonthCalendar,
  formatCompactShifts,
  listMonthDayBoards,
  marshalScheduleIntroText,
  marshalShiftText,
  marshalSlotSourceText,
  classifyScheduleFetchResult,
  matchesRequestedYearMonth,
  nextFetchStateAfterLoad,
  nextScheduleRequestId,
  planStatusLabel,
  scheduleEmptyAllowed,
  scheduleFetchErrorMessage,
  scheduleFetchFailureKind,
  scheduleMutationBlocked,
  schedulePlanDisplayAllowed,
  scheduleWorkspaceVisible,
  shiftYearMonth,
  shouldScrollPcDayDetail,
  summarizeMarshalNames,
  type MarshalDayBoard,
  type MarshalScheduleFetchState,
  type MarshalScheduleSlotView,
} from "@/lib/marshalScheduleUi";

type Member = {
  profileId: number;
  caddyId: number;
  rotationOrder: number;
  name: string;
};

type Penalty = {
  id: number;
  date: string;
  shift: string;
  caddyId: number;
  reason: string;
  note: string | null;
  caddy: { id: number; name: string };
};

type CreditRemain = {
  profileId: number;
  caddyId: number;
  name: string;
  remaining: number;
};

type OpenCredit = {
  id: number;
  marshalProfileId: number;
  reason: string | null;
  caddy: { name: string };
};

type PlanPayload = {
  year: number;
  month: number;
  suggestedStartRotationOrder: number | null;
  suggestedStartPendingProfileIds?: number[];
  suggestedStartPendingNames?: string[];
  members: Member[];
  credits: OpenCredit[];
  creditRemaining: CreditRemain[];
  penaltyOccurrences?: OccurrenceListItem[];
  plan: {
    id: number;
    amSlotsPerDay: number;
    pmSlotsPerDay: number;
    status: string;
    needsRegeneration?: boolean;
    startRotationOrder: number;
    nextRotationOrder: number;
    startPendingProfileIds?: number[];
    nextPendingProfileIds?: number[];
    startPendingNames?: string[];
    nextPendingNames?: string[];
    generatedAt: string | null;
    slots: MarshalScheduleSlotView[];
    penalties: Penalty[];
  } | null;
};

function currentYearMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function PanelToggle({
  open,
  onToggle,
  label,
  count,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      className="ms-panel-toggle"
      aria-expanded={open}
      onClick={onToggle}
    >
      <span>
        {label}
        {count != null ? ` ${count}` : ""}
      </span>
      <span aria-hidden>{open ? "▾" : "›"}</span>
    </button>
  );
}

function DayFlags({ day }: { day: MarshalDayBoard }) {
  const occ = day.occurrenceBadges || [];
  return (
    <span className="ms-flags">
      {day.hasWarning ? <span className="ms-flag is-warn">경고</span> : null}
      {day.hasSubstitute ? <span className="ms-flag is-sub">대타</span> : null}
      {occ.length === 0 && day.hasPenalty ? (
        <span className="ms-flag is-penalty">벌당</span>
      ) : null}
      {occ.slice(0, 2).map((badge) => (
        <span
          key={`${badge.caddyId}-${badge.source}`}
          className={`ms-flag is-occ is-${badge.source.toLowerCase()}`}
        >
          {occurrenceCalendarBadgeText(badge)}
        </span>
      ))}
      {occ.length > 2 ? (
        <span className="ms-flag is-occ">전일 +{occ.length - 2}</span>
      ) : null}
    </span>
  );
}

export default function ManageMarshalSchedulePage() {
  const initial = currentYearMonth();
  const [year, setYear] = useState(String(initial.year));
  const [month, setMonth] = useState(String(initial.month));
  const [data, setData] = useState<PlanPayload | null>(null);
  const [amSlots, setAmSlots] = useState("2");
  const [pmSlots, setPmSlots] = useState("1");
  const [startOrder, setStartOrder] = useState("");
  const [fetchState, setFetchState] =
    useState<MarshalScheduleFetchState>("LOADING");
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestSeq = useRef(0);
  const dayDetailRef = useRef<HTMLDivElement>(null);
  const settingsPanelRef = useRef<HTMLElement>(null);
  const [penaltyDate, setPenaltyDate] = useState("");
  const [penaltyCaddyId, setPenaltyCaddyId] = useState("");
  const [penaltyShift, setPenaltyShift] = useState("AM");
  const [penaltyReason, setPenaltyReason] = useState("");
  const [subSlotId, setSubSlotId] = useState<number | null>(null);
  const [subCaddyId, setSubCaddyId] = useState("");
  const [subNote, setSubNote] = useState("");
  const [applyCredit, setApplyCredit] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [penaltyOpen, setPenaltyOpen] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  const [creditQuery, setCreditQuery] = useState("");

  const applyFetchedPlan = (json: PlanPayload) => {
    setData(json);
    if (json.plan) {
      setAmSlots(String(json.plan.amSlotsPerDay));
      setPmSlots(String(json.plan.pmSlotsPerDay));
      setStartOrder(String(json.plan.startRotationOrder));
    } else {
      setAmSlots("2");
      setPmSlots("1");
      if (json.suggestedStartRotationOrder != null) {
        setStartOrder(String(json.suggestedStartRotationOrder));
      }
    }
  };

  const clearDisplayedPlan = () => {
    setData(null);
    setSelectedDate(null);
    setSubSlotId(null);
    setAmSlots("2");
    setPmSlots("1");
    setStartOrder("");
  };

  const load = useCallback(async (
    mode: "month-change" | "refresh" | "retry" = "refresh"
  ) => {
    const requestedYear = Number(year);
    const requestedMonth = Number(month);
    const requestId = nextScheduleRequestId(requestSeq.current);
    requestSeq.current = requestId;
    setFetchState("LOADING");
    setFetchError(null);
    if (mode === "month-change" || mode === "retry") {
      clearDisplayedPlan();
    }
    try {
      const res = await fetch(
        `/api/marshals/plans?year=${requestedYear}&month=${requestedMonth}`,
        { credentials: "include" }
      );
      const json = await res.json().catch(() => ({}));
      if (requestId !== requestSeq.current) return;
      const result = classifyScheduleFetchResult({
        requestId,
        latestRequestId: requestSeq.current,
        ok: res.ok,
        payload: json,
        year: requestedYear,
        month: requestedMonth,
      });
      const nextState = nextFetchStateAfterLoad({
        previous: "LOADING",
        result,
        hasPlan: Boolean((json as PlanPayload)?.plan),
      });
      if (result === "stale") return;
      if (result === "error") {
        clearDisplayedPlan();
        const kind = scheduleFetchFailureKind({
          ok: res.ok,
          payloadMatches: matchesRequestedYearMonth(
            json,
            requestedYear,
            requestedMonth
          ),
        });
        setFetchError(
          (res.ok ? null : json?.error) || scheduleFetchErrorMessage(kind)
        );
        setFetchState("ERROR");
        return;
      }
      applyFetchedPlan(json as PlanPayload);
      setFetchState(nextState);
    } catch {
      if (requestId !== requestSeq.current) return;
      clearDisplayedPlan();
      setFetchError(scheduleFetchErrorMessage("network"));
      setFetchState(
        nextFetchStateAfterLoad({
          previous: "LOADING",
          result: "error",
          hasPlan: false,
        })
      );
    }
  }, [year, month]);

  useEffect(() => {
    void load("month-change");
  }, [load]);

  const yearNum = Number(year);
  const monthNum = Number(month);
  const monthValid =
    Number.isInteger(yearNum) &&
    Number.isInteger(monthNum) &&
    monthNum >= 1 &&
    monthNum <= 12;
  const dataForMonth =
    data && monthValid && matchesRequestedYearMonth(data, yearNum, monthNum)
      ? data
      : null;
  const slots = useMemo(() => dataForMonth?.plan?.slots || [], [dataForMonth]);
  const penalties = useMemo(
    () => dataForMonth?.plan?.penalties || [],
    [dataForMonth]
  );
  const occurrences = useMemo(
    () => dataForMonth?.penaltyOccurrences || [],
    [dataForMonth]
  );
  const calendar = useMemo(
    () => (monthValid ? buildMonthCalendar(yearNum, monthNum) : []),
    [monthValid, yearNum, monthNum]
  );
  const days = useMemo(
    () =>
      monthValid
        ? listMonthDayBoards({
            year: yearNum,
            month: monthNum,
            slots,
            penalties,
            occurrences,
          })
        : [],
    [monthValid, yearNum, monthNum, slots, penalties, occurrences]
  );
  const selected = selectedDate
    ? buildMarshalDayBoard({
        ymd: selectedDate,
        slots,
        penalties,
        occurrences,
      })
    : null;

  const run = async (fn: () => Promise<void>) => {
    if (scheduleMutationBlocked({ loading: fetchState === "LOADING", busy, fetchState })) {
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await load("refresh");
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "처리 실패");
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = () =>
    run(async () => {
      const res = await fetch("/api/marshals/plans", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year: Number(year),
          month: Number(month),
          amSlotsPerDay: Number(amSlots),
          pmSlotsPerDay: Number(pmSlots),
          startRotationOrder: startOrder ? Number(startOrder) : undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "설정 저장 실패");
    });

  const generate = (replace: boolean) =>
    run(async () => {
      if (
        replace &&
        !window.confirm("기존 DRAFT 월표를 덮어씁니다. 벌당/대타/수동 슬롯도 사라집니다.")
      ) {
        return;
      }
      if (
        !replace &&
        !window.confirm("이 설정으로 월표를 생성할까요? 생성된 배정은 서버에 저장됩니다.")
      ) {
        return;
      }
      const res = await fetch("/api/marshals/plans/generate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year: Number(year),
          month: Number(month),
          amSlotsPerDay: Number(amSlots),
          pmSlotsPerDay: Number(pmSlots),
          startRotationOrder: startOrder ? Number(startOrder) : undefined,
          replace,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "생성 실패");
    });

  const finalize = () =>
    run(async () => {
      const planId = dataForMonth?.plan?.id;
      if (!planId) return;
      if (
        !window.confirm(
          "이 월표를 FINALIZED(마감) 할까요? 마감 후에는 일반 재생성·설정 변경을 할 수 없습니다."
        )
      ) {
        return;
      }
      const res = await fetch(`/api/marshals/plans/${planId}/finalize`, {
        method: "POST",
        credentials: "include",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "마감 실패");
    });

  const addPenalty = () =>
    run(async () => {
      const res = await fetch("/api/marshals/penalties", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year: Number(year),
          month: Number(month),
          date: penaltyDate,
          caddyId: Number(penaltyCaddyId),
          shift: penaltyShift,
          reason: penaltyReason,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "벌당 추가 실패");
      setPenaltyReason("");
    });

  const replaceSlot = () =>
    run(async () => {
      const planId = dataForMonth?.plan?.id;
      if (!planId || !subSlotId) return;
      const res = await fetch(
        `/api/marshals/plans/${planId}/slots/${subSlotId}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            caddyId: Number(subCaddyId),
            note: subNote,
            asSubstitute: true,
            applyCredit,
          }),
        }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "교체 실패");
      setSubSlotId(null);
      setSubCaddyId("");
      setSubNote("");
      setApplyCredit(false);
    });

  const addCredit = (profileId: number) =>
    run(async () => {
      const res = await fetch("/api/marshals/credits", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marshalProfileId: profileId,
          delta: 1,
          reason: "대타 보정",
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "보정 추가 실패");
    });

  const cancelCredit = (creditId: number) =>
    run(async () => {
      const res = await fetch("/api/marshals/credits", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creditId, delta: -1 }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "보정 취소 실패");
    });

  const moveMonth = (delta: number) => {
    if (busy) return;
    const next = shiftYearMonth(yearNum, monthNum, delta);
    setYear(String(next.year));
    setMonth(String(next.month));
    clearDisplayedPlan();
  };

  const toggleDay = (ymd: string) => {
    setSelectedDate((current) => (current === ymd ? null : ymd));
    setSubSlotId(null);
  };

  const openSettings = () => {
    setSettingsOpen(true);
    requestAnimationFrame(() => {
      settingsPanelRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  };

  useEffect(() => {
    if (!selectedDate) return;
    const el = dayDetailRef.current;
    if (!el) return;
    const calendar = el.closest("[data-marshal-schedule='calendar']");
    const calendarDisplay = calendar
      ? window.getComputedStyle(calendar).display
      : "none";
    if (!shouldScrollPcDayDetail({ selectedDate, calendarDisplay })) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedDate]);

  const loading = fetchState === "LOADING";
  const fetchFailed = fetchState === "ERROR";
  const finalized = dataForMonth?.plan?.status === "FINALIZED";
  const hasPlan =
    schedulePlanDisplayAllowed(fetchState) && Boolean(dataForMonth?.plan);
  const showEmpty = scheduleEmptyAllowed(fetchState);
  const showWorkspace = scheduleWorkspaceVisible(fetchState);
  const locked = scheduleMutationBlocked({ loading, busy, fetchState });
  const creditRows = (dataForMonth?.creditRemaining || []).filter((row) =>
    row.name.includes(creditQuery.trim())
  );
  const pendingNames =
    dataForMonth?.plan?.nextPendingNames ??
    dataForMonth?.suggestedStartPendingNames ??
    [];
  const pendingCount =
    dataForMonth?.plan?.nextPendingProfileIds?.length ??
    dataForMonth?.suggestedStartPendingProfileIds?.length ??
    0;

  const renderDayDetail = (day: MarshalDayBoard, panelId: string) => (
    <div
      className="ms-day-panel"
      id={panelId}
      data-marshal-day-panel={day.ymd}
    >
      <p className="ms-day-panel-head">
        {day.ymd} {day.weekdayLabel}요일
        <DayFlags day={day} />
      </p>
      {day.occurrenceBadges.length > 0 ? (
        <p className="ms-muted">
          전일 벌당(조출+후출){" "}
          {day.occurrenceBadges
            .map((badge) => occurrenceCalendarBadgeText(badge))
            .join(" · ")}
        </p>
      ) : null}
      {(["AM", "PM"] as const).map((shift) => {
        const lane = shift === "AM" ? day.am : day.pm;
        return (
          <div key={shift} className="ms-day-lane">
            <strong>{marshalShiftText(shift)}</strong>
            {lane.length === 0 ? (
              <p className="ms-muted">배정 없음</p>
            ) : (
              <ul>
                {lane.map((slot) => (
                  <li key={slot.id}>
                    <span className="ms-slot-name">{slot.caddy.name}</span>
                    <span className="ms-slot-meta">
                      {marshalSlotSourceText(slot.source)}
                      {slot.warning ? ` · ${slot.warning}` : ""}
                      {slot.originalCaddy
                        ? ` · 원래 ${slot.originalCaddy.name}`
                        : ""}
                    </span>
                    <button
                      type="button"
                      className="ui-btn ms-mini-btn"
                      disabled={locked}
                      onClick={() => {
                        setSubSlotId(slot.id);
                        setSubCaddyId("");
                      }}
                    >
                      교체
                    </button>
                    {subSlotId === slot.id ? (
                      <div className="ms-sub-form">
                        <select
                          aria-label="대타 마샬"
                          value={subCaddyId}
                          onChange={(e) => setSubCaddyId(e.target.value)}
                        >
                          <option value="">마샬 선택</option>
                          {(dataForMonth?.members || []).map((member) => (
                            <option key={member.profileId} value={member.caddyId}>
                              {member.rotationOrder} {member.name}
                            </option>
                          ))}
                        </select>
                        <input
                          aria-label="대타 메모"
                          placeholder="사유"
                          value={subNote}
                          onChange={(e) => setSubNote(e.target.value)}
                        />
                        <label>
                          <input
                            type="checkbox"
                            checked={applyCredit}
                            onChange={(e) => setApplyCredit(e.target.checked)}
                          />{" "}
                          대타 보정 적용
                        </label>
                        <button
                          type="button"
                          className="ui-btn ui-btn-primary"
                          disabled={locked || !subCaddyId}
                          onClick={() => void replaceSlot()}
                        >
                          저장
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="vh-page" data-marshal-fetch-state={fetchState}>
      <div className="vh-page-head">
        <h1>마샬 월표</h1>
        <p>{marshalScheduleIntroText()}</p>
      </div>
      <MarshalManageNav />

      <div className="ms-toolbar" data-marshal-schedule="toolbar">
        <div className="ms-month-nav">
          <button
            type="button"
            className="ui-btn"
            onClick={() => moveMonth(-1)}
            aria-label="이전 달"
            disabled={busy}
          >
            이전 달
          </button>
          <label className="ms-field">
            <span>연도</span>
            <input
              aria-label="연"
              type="number"
              value={year}
              disabled={busy}
              onChange={(e) => {
                setYear(e.target.value);
                clearDisplayedPlan();
              }}
            />
          </label>
          <label className="ms-field">
            <span>월</span>
            <input
              aria-label="월"
              type="number"
              min={1}
              max={12}
              value={month}
              disabled={busy}
              onChange={(e) => {
                setMonth(e.target.value);
                clearDisplayedPlan();
              }}
            />
          </label>
          <button
            type="button"
            className="ui-btn"
            onClick={() => moveMonth(1)}
            aria-label="다음 달"
            disabled={busy}
          >
            다음 달
          </button>
          {showEmpty ? (
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              data-marshal-open-settings="toolbar"
              onClick={openSettings}
            >
              월표 설정 열기
            </button>
          ) : null}
        </div>
        <p className="ms-status-line">
          <span
            className={`ms-status is-${
              fetchFailed
                ? "error"
                : (dataForMonth?.plan?.status || "none").toLowerCase()
            }`}
            data-marshal-plan-status={
              fetchFailed ? "error" : dataForMonth?.plan?.status || "none"
            }
            data-marshal-fetch-state={fetchState}
          >
            {loading
              ? "조회 중"
              : fetchFailed
                ? "조회 실패"
                : planStatusLabel(dataForMonth?.plan?.status)}
          </span>
          {loading ? (
            <span data-marshal-loading-status="1">월표를 불러오는 중…</span>
          ) : hasPlan ? (
            <>
              <span>
                조출 {dataForMonth?.plan?.amSlotsPerDay ?? amSlots}명 · 후출{" "}
                {dataForMonth?.plan?.pmSlotsPerDay ?? pmSlots}명
              </span>
              <span>
                다음 순번{" "}
                {dataForMonth?.plan?.nextRotationOrder ??
                  dataForMonth?.suggestedStartRotationOrder ??
                  "—"}
              </span>
              <span>
                {pendingCount < 1
                  ? "이월 대기 0명"
                  : `이월 대기 ${pendingCount}명${
                      pendingNames.length ? ` (${pendingNames.join(", ")})` : ""
                    }`}
              </span>
            </>
          ) : showEmpty ? (
            <span data-marshal-empty-status="1">이 달에는 월표가 없습니다.</span>
          ) : fetchFailed ? (
            <span data-marshal-fetch-error-status="1">다시 조회한 뒤에 관리할 수 있습니다.</span>
          ) : null}
        </p>
      </div>

      {loading ? (
        <p className="ms-loading" aria-live="polite" data-marshal-loading="1">
          월표를 불러오는 중…
        </p>
      ) : null}

      {fetchFailed ? (
        <div
          className="ms-fetch-error"
          role="alert"
          data-marshal-fetch-error="1"
        >
          <p>{fetchError || scheduleFetchErrorMessage("http")}</p>
          <button
            type="button"
            className="ui-btn"
            data-marshal-retry-fetch="1"
            disabled={busy}
            onClick={() => void load("retry")}
          >
            다시 조회
          </button>
        </div>
      ) : null}

      {actionError && !fetchFailed ? (
        <p className="vh-auth-error" role="alert" style={{ marginBottom: 12 }}>
          {actionError}
        </p>
      ) : null}

      {showWorkspace &&
      regenerationBannerText({
        needsRegeneration: dataForMonth?.plan?.needsRegeneration,
        planStatus: dataForMonth?.plan?.status,
      }) ? (
        <p
          className="ms-regen"
          role="status"
          data-marshal-regen-banner="1"
        >
          {regenerationBannerText({
            needsRegeneration: dataForMonth?.plan?.needsRegeneration,
            planStatus: dataForMonth?.plan?.status,
          })}
        </p>
      ) : null}

      {showWorkspace && showEmpty ? (
        <div className="ms-empty" data-marshal-empty-plan="1">
          <p>아직 생성된 마샬 월표가 없습니다.</p>
          <p>
            설정을 확인한 후 월표를 생성하세요. 이 화면을 열어도 월표는 자동
            생성되지 않습니다.
          </p>
          <div className="ms-empty-actions">
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              data-marshal-open-settings="1"
              onClick={openSettings}
            >
              월표 설정 열기
            </button>
          </div>
        </div>
      ) : null}

      {showWorkspace ? (
        <MarshalPenaltyOccurrencePanel
          members={dataForMonth?.members || []}
          occurrences={occurrences}
          planStatus={dataForMonth?.plan?.status}
          needsRegeneration={Boolean(dataForMonth?.plan?.needsRegeneration)}
          planGenerated={Boolean(dataForMonth?.plan?.generatedAt)}
          locked={locked}
          onMutate={run}
        />
      ) : null}

      {showWorkspace ? (
      <section
        className="ms-board"
        data-marshal-schedule="board"
        aria-busy={loading || undefined}
      >
        <div className="ms-calendar" data-marshal-schedule="calendar">
          {selected ? (
            <div
              ref={dayDetailRef}
              className="ms-cal-detail"
              data-marshal-day-detail="pc"
            >
              {renderDayDetail(selected, `marshal-cal-panel-${selected.ymd}`)}
            </div>
          ) : null}
          <div className="ms-cal-head">
            {MARSHAL_WEEKDAY_LABELS.map((label) => (
              <div key={label}>{label}</div>
            ))}
          </div>
          <div className="ms-cal-grid">
            {calendar.map((cell, index) => {
              if (!cell.inMonth || !cell.ymd) {
                return (
                  <div
                    key={`pad-${index}`}
                    className={`ms-cal-cell is-pad is-w${cell.weekday}`}
                  />
                );
              }
              const day = days.find((row) => row.ymd === cell.ymd);
              if (!day) {
                return (
                  <div
                    key={`missing-${cell.ymd}`}
                    className={`ms-cal-cell is-pad is-w${cell.weekday}`}
                  />
                );
              }
              const open = selectedDate === day.ymd;
              return (
                <button
                  key={day.ymd}
                  type="button"
                  className={`ms-cal-cell is-w${day.weekday}${open ? " is-open" : ""}${
                    day.hasWarning ? " has-warn" : ""
                  }`}
                  data-marshal-day={day.ymd}
                  aria-expanded={open}
                  aria-controls={`marshal-cal-panel-${day.ymd}`}
                  onClick={() => toggleDay(day.ymd)}
                >
                  <span className="ms-cal-day">{day.day}</span>
                  <DayFlags day={day} />
                  <span className="ms-cal-shift is-am">
                    조출 {summarizeMarshalNames(day.amNames, 3).text}
                  </span>
                  <span className="ms-cal-shift is-pm">
                    후출 {summarizeMarshalNames(day.pmNames, 3).text}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <ul className="ms-dense" data-marshal-schedule="dense">
          {days.map((day) => {
            const open = selectedDate === day.ymd;
            return (
              <li
                key={day.ymd}
                className={`ms-dense-row${open ? " is-open" : ""}${
                  day.weekday === 0 || day.weekday === 6 ? " is-weekend" : ""
                }`}
              >
                <button
                  type="button"
                  className="ms-dense-main"
                  aria-expanded={open}
                  aria-controls={`marshal-dense-panel-${day.ymd}`}
                  data-marshal-day={day.ymd}
                  onClick={() => toggleDay(day.ymd)}
                >
                  <span className="ms-dense-date">
                    {day.day} {day.weekdayLabel}
                  </span>
                  <span className="ms-dense-line">{formatCompactShifts(day)}</span>
                  <DayFlags day={day} />
                  <span className="ms-dense-more" aria-hidden>
                    {open ? "▾" : "›"}
                  </span>
                </button>
                {open ? renderDayDetail(day, `marshal-dense-panel-${day.ymd}`) : null}
              </li>
            );
          })}
        </ul>
      </section>
      ) : null}

      {showWorkspace ? (
      <>
      <section
        ref={settingsPanelRef}
        className="ms-panel ui-card"
        data-marshal-settings-panel="1"
      >
        <PanelToggle
          open={settingsOpen}
          onToggle={() => setSettingsOpen((value) => !value)}
          label="월표 설정"
        />
        {settingsOpen ? (
          <form
            className="ms-panel-body"
            data-marshal-settings="1"
            onSubmit={(e) => {
              e.preventDefault();
              void saveSettings();
            }}
          >
            <p className="ms-muted">
              조회만으로는 저장되지 않습니다. 조출/후출 인원은 이 월의 슬롯 수이며
              순환 엔진 규칙을 바꾸지 않습니다.
            </p>
            <div className="ms-settings-grid">
              <label className="ms-field">
                <span>시작 순번</span>
                <input
                  aria-label="시작 순번"
                  type="number"
                  min={1}
                  placeholder="시작 순번"
                  value={startOrder}
                  onChange={(e) => setStartOrder(e.target.value)}
                  disabled={locked || finalized}
                />
              </label>
              <label className="ms-field">
                <span>조출 인원</span>
                <input
                  aria-label="조출 인원"
                  type="number"
                  min={0}
                  value={amSlots}
                  onChange={(e) => setAmSlots(e.target.value)}
                  disabled={locked || finalized}
                />
              </label>
              <label className="ms-field">
                <span>후출 인원</span>
                <input
                  aria-label="후출 인원"
                  type="number"
                  min={0}
                  value={pmSlots}
                  onChange={(e) => setPmSlots(e.target.value)}
                  disabled={locked || finalized}
                />
              </label>
            </div>
            <div className="ms-actions">
              <button type="submit" className="ui-btn" disabled={locked || finalized}>
                설정 저장
              </button>
              <button
                type="button"
                className="ui-btn"
                disabled={locked || finalized}
                onClick={() => void generate(Boolean(dataForMonth?.plan?.slots.length))}
              >
                {dataForMonth?.plan?.slots.length ? "DRAFT 다시 생성" : "월표 생성"}
              </button>
              <button
                type="button"
                className="ui-btn"
                disabled={
                  locked ||
                  !dataForMonth?.plan?.id ||
                  finalized ||
                  Boolean(dataForMonth?.plan?.needsRegeneration)
                }
                onClick={() => void finalize()}
              >
                마감 (FINALIZE)
              </button>
            </div>
          </form>
        ) : null}
      </section>

      <section className="ms-panel ui-card">
        <PanelToggle
          open={penaltyOpen}
          onToggle={() => setPenaltyOpen((value) => !value)}
          label={DUTY_PANEL_TITLE}
          count={penalties.length}
        />
        {penaltyOpen ? (
          <div className="ms-panel-body">
            <p className="ms-muted">
              이번 달 월표에 조출 또는 후출 한 칸을 직접 넣는 기능입니다. 다음 달
              전일 벌당 발생과는 다릅니다.
            </p>
            <div className="ms-actions">
              <input
                aria-label="벌당 날짜"
                type="date"
                value={penaltyDate}
                onChange={(e) => setPenaltyDate(e.target.value)}
              />
              <select
                aria-label="벌당 마샬"
                value={penaltyCaddyId}
                onChange={(e) => setPenaltyCaddyId(e.target.value)}
              >
                <option value="">마샬 선택</option>
                {(dataForMonth?.members || []).map((member) => (
                  <option key={member.profileId} value={member.caddyId}>
                    {member.rotationOrder} {member.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="벌당 시프트"
                value={penaltyShift}
                onChange={(e) => setPenaltyShift(e.target.value)}
              >
                <option value="AM">조출</option>
                <option value="PM">후출</option>
              </select>
              <input
                aria-label="벌당 사유"
                placeholder="사유"
                value={penaltyReason}
                onChange={(e) => setPenaltyReason(e.target.value)}
              />
              <button
                type="button"
                className="ui-btn"
                disabled={
                  locked || finalized || !penaltyDate || !penaltyCaddyId || !penaltyReason
                }
                onClick={() => void addPenalty()}
              >
                벌당 추가
              </button>
            </div>
            <ul className="ms-list">
              {penalties.map((row) => (
                <li key={row.id}>
                  {row.date} {marshalShiftText(row.shift)} {row.caddy.name} · {row.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="ms-panel ui-card">
        <PanelToggle
          open={creditOpen}
          onToggle={() => setCreditOpen((value) => !value)}
          label="대타 보정 관리"
          count={dataForMonth?.creditRemaining?.length || 0}
        />
        {creditOpen ? (
          <div className="ms-panel-body">
            <label className="ms-field">
              <span>마샬 검색</span>
              <input
                aria-label="대타 보정 검색"
                value={creditQuery}
                onChange={(e) => setCreditQuery(e.target.value)}
                placeholder="이름"
              />
            </label>
            <ul className="ms-list">
              {creditRows.map((row) => (
                <li key={row.profileId}>
                  {row.name} 잔여 {row.remaining}{" "}
                  <button
                    type="button"
                    className="ui-btn ms-mini-btn"
                    disabled={locked}
                    onClick={() => void addCredit(row.profileId)}
                  >
                    +1
                  </button>
                </li>
              ))}
            </ul>
            {(dataForMonth?.credits || []).length > 0 ? (
              <ul className="ms-list">
                {dataForMonth!.credits.map((row) => (
                  <li key={row.id}>
                    {row.caddy.name} {row.reason || "보정"}{" "}
                    <button
                      type="button"
                      className="ui-btn ms-mini-btn"
                      disabled={locked}
                      onClick={() => void cancelCredit(row.id)}
                    >
                      -1
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>
      </>
      ) : null}
    </div>
  );
}
