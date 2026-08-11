"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  assignCaddyToUnassigned,
  assignmentsByShift,
  confirmDraft,
  createDraftFromAutoResult,
  detectDraftWarnings,
  markDraftApplied,
  replaceAssignmentCaddy,
  reservationIdentity,
  swapAssignmentCaddies,
  unassignReservation,
  unusedCaddies,
  type AssignmentDraft,
  type DraftWarning,
} from "@/lib/assignmentDraft";
import { draftToConfirmBody } from "@/lib/assignmentConfirm";
import { buildShiftBoard } from "@/lib/assignmentBoardView";
import {
  resolveCourseCode,
  type AutoAssignCaddy,
  type AutoAssignResultV1,
  type AutoAssignmentRow,
} from "@/lib/autoAssignEngine";
import type { AvailabilityResult } from "@/lib/availabilityEngine";
import {
  COURSE_CODES,
  COURSE_LABELS,
  type CourseCode,
  type ShiftPart,
} from "@/lib/reservationParser";

type RunResponse = AutoAssignResultV1 & {
  error?: string;
  filename?: string;
  availabilityCounts?: { available: number; special: number; excluded: number };
};

const SHIFTS: ShiftPart[] = ["1부", "2부", "3부"];

/** 모바일 배치표 헤더 (가로 스크롤 없이 4코스) */
const COURSE_SHORT: Record<CourseCode, string> = {
  VERTHILL: "베",
  SKY: "스",
  OCEAN: "오",
  LAKE: "레",
};

type CourseOpenState = Record<CourseCode, boolean>;
type ResultViewMode = "board" | "list";

function defaultCourseOpen(): CourseOpenState {
  return {
    VERTHILL: true,
    SKY: true,
    OCEAN: true,
    LAKE: true,
  };
}

export default function ManageAssignmentsOpsPage() {
  const [date, setDate] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [availability, setAvailability] = useState<AvailabilityResult | null>(
    null
  );
  const [autoResult, setAutoResult] = useState<RunResponse | null>(null);
  const [draft, setDraft] = useState<AssignmentDraft | null>(null);
  const [warnings, setWarnings] = useState<DraftWarning[]>([]);
  const [shiftTab, setShiftTab] = useState<
    ShiftPart | "UNASSIGNED" | "CLOSED"
  >("1부");
  const [courseOpen, setCourseOpen] = useState<CourseOpenState>(defaultCourseOpen);
  const [loadingAvail, setLoadingAvail] = useState(false);
  const [loadingRun, setLoadingRun] = useState(false);
  const [loadingApply, setLoadingApply] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [swapKey, setSwapKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ResultViewMode>("board");
  const [toast, setToast] = useState<string | null>(null);
  const stickyStackRef = useRef<HTMLDivElement | null>(null);

  /** 부 탭/보기 전환 시 sticky 스택 기준으로 첫 데이터 행이 보이도록 스크롤 */
  useEffect(() => {
    if (!draft) return;
    stickyStackRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [shiftTab, viewMode, draft?.id]);

  const openCourseList = useMemo(
    () => COURSE_CODES.filter((c) => courseOpen[c]),
    [courseOpen]
  );

  const pool: AutoAssignCaddy[] = useMemo(() => {
    if (availability) {
      return [
        ...availability.available.all,
        ...availability.special,
        ...availability.excluded,
      ];
    }
    return draft?.caddyPool || [];
  }, [availability, draft]);

  const freeCaddies = draft ? unusedCaddies(draft) : [];
  const liveWarnings = (draft ? detectDraftWarnings(draft) : warnings).filter(
    (w) =>
      w.code === "SAME_SHIFT_DUPLICATE" ||
      w.code === "TIME_CONFLICT" ||
      w.code === "SPECIAL_GAP_CONFLICT"
  );

  const shiftSpare =
    draft && shiftTab !== "UNASSIGNED" && shiftTab !== "CLOSED"
      ? draft.sparesByShift?.find((s) => s.shift === shiftTab) || null
      : null;

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }

  async function loadAvailability() {
    if (!date) {
      setError("날짜를 선택하세요.");
      return;
    }
    setLoadingAvail(true);
    setError(null);
    try {
      const res = await fetch(`/api/availability?date=${encodeURIComponent(date)}`, {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "가용 불러오기 실패");
        return;
      }
      setAvailability(data as AvailabilityResult);
      showToast(`가용 ${data.counts?.available ?? 0}명 로드`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "가용 요청 실패");
    } finally {
      setLoadingAvail(false);
    }
  }

  async function runAutoAssign() {
    if (!date) {
      setError("날짜를 선택하세요.");
      return;
    }
    if (!file) {
      setError("예약 Excel 파일을 선택하세요.");
      return;
    }
    if (openCourseList.length === 0) {
      setError("최소 1개 코스를 ON으로 선택하세요.");
      return;
    }
    setLoadingRun(true);
    setError(null);
    try {
      let caddyPool = pool;
      if (!availability) {
        const availRes = await fetch(
          `/api/availability?date=${encodeURIComponent(date)}`,
          { credentials: "include" }
        );
        const availData = await availRes.json();
        if (availRes.ok) {
          setAvailability(availData as AvailabilityResult);
          caddyPool = [
            ...(availData.available?.all || []),
            ...(availData.special || []),
            ...(availData.excluded || []),
          ];
        }
      }

      const form = new FormData();
      form.append("date", date);
      form.append("file", file);
      form.append("openCourses", JSON.stringify(openCourseList));
      const res = await fetch("/api/assignments/preview", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      const data = (await res.json()) as RunResponse;
      if (!res.ok) {
        setAutoResult(null);
        setDraft(null);
        setError(data.error || "자동배치 실패");
        return;
      }
      setAutoResult(data);
      const next = createDraftFromAutoResult(
        data,
        caddyPool.length ? caddyPool : undefined
      );
      setDraft(next);
      setWarnings(detectDraftWarnings(next));
      setSwapKey(null);
      setExpandedKey(null);
      setShiftTab("1부");
      const closedN = data.closedCourseReservations?.length ?? 0;
      showToast(
        closedN > 0
          ? `자동배치 완료 · DRAFT (닫힌 코스 ${closedN}건 제외)`
          : "자동배치 완료 · DRAFT"
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "자동배치 요청 실패");
    } finally {
      setLoadingRun(false);
    }
  }

  function onReplace(row: AutoAssignmentRow, caddyId: number) {
    if (!draft) return;
    const key = reservationIdentity(row.reservation);
    let result = replaceAssignmentCaddy(draft, key, caddyId);
    if (result.specialEditWarned) {
      const ok = window.confirm(
        `special 배치(${row.kind}) 캐디를 교체합니다. 계속할까요?`
      );
      if (!ok) return;
      result = replaceAssignmentCaddy(draft, key, caddyId, {
        allowSpecialEdit: true,
      });
    }
    setDraft(result.draft);
    setWarnings(result.warnings);
    showToast("캐디 교체됨");
  }

  function onSwapClick(row: AutoAssignmentRow) {
    if (!draft) return;
    const key = reservationIdentity(row.reservation);
    if (!swapKey) {
      setSwapKey(key);
      showToast("swap 대상 선택 · 다른 예약을 탭하세요");
      return;
    }
    if (swapKey === key) {
      setSwapKey(null);
      return;
    }
    let result = swapAssignmentCaddies(draft, swapKey, key);
    if (result.specialEditWarned) {
      const ok = window.confirm("special 배치가 포함된 swap입니다. 계속할까요?");
      if (!ok) {
        setSwapKey(null);
        return;
      }
      result = swapAssignmentCaddies(draft, swapKey, key, {
        allowSpecialEdit: true,
      });
    }
    setDraft(result.draft);
    setWarnings(result.warnings);
    setSwapKey(null);
    showToast("캐디 swap 완료");
  }

  function onAssignUnassigned(resKey: string, caddyId: number) {
    if (!draft) return;
    const result = assignCaddyToUnassigned(draft, resKey, caddyId);
    setDraft(result.draft);
    setWarnings(result.warnings);
    showToast("미배치에 캐디 지정");
  }

  function onUnassign(row: AutoAssignmentRow) {
    if (!draft) return;
    const key = reservationIdentity(row.reservation);
    let result = unassignReservation(draft, key);
    if (result.specialEditWarned) {
      const ok = window.confirm("special 배치를 해제합니다. 계속할까요?");
      if (!ok) return;
      result = unassignReservation(draft, key, { allowSpecialEdit: true });
    }
    setDraft(result.draft);
    setWarnings(result.warnings);
    showToast("배치 해제");
  }

  function onConfirm() {
    if (!draft) return;
    if (draft.status === "APPLIED") return;
    if (liveWarnings.some((w) => w.level === "error")) {
      const ok = window.confirm(
        "충돌/중복 경고가 있습니다. 그래도 CONFIRMED로 둘까요?\n(아직 DB에는 저장되지 않습니다)"
      );
      if (!ok) return;
    } else {
      const ok = window.confirm(
        "CONFIRMED로 표시합니다. 운영 반영 버튼으로 DB에 저장합니다."
      );
      if (!ok) return;
    }
    setDraft(confirmDraft(draft));
    showToast("CONFIRMED — 운영 반영 가능");
  }

  async function onApplyToOps(replace = false) {
    if (!draft || draft.status !== "CONFIRMED") return;
    if (!replace) {
      const ok = window.confirm(
        `${draft.date} 배치표를 Schedule/ShiftDuty에 저장할까요?`
      );
      if (!ok) return;
    }

    setLoadingApply(true);
    setError(null);
    try {
      const body = draftToConfirmBody(draft, { replace });
      const res = await fetch("/api/assignments/confirm", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 409 && data.requireReplace) {
        const approve = window.confirm(
          `${data.message || "같은 날짜 기존 배치가 있습니다."}\n\n기존 배치를 덮어쓸까요? (관리자 명시 승인)`
        );
        if (approve) {
          setLoadingApply(false);
          await onApplyToOps(true);
          return;
        }
        setError(data.error || "기존 배치 충돌");
        return;
      }

      if (!res.ok) {
        setError(data.error || data.message || "운영 반영 실패");
        return;
      }

      setDraft(
        markDraftApplied(draft, {
          auditId: typeof data.auditId === "number" ? data.auditId : null,
        })
      );
      showToast(
        data.duplicate
          ? "이미 반영된 배치 (중복 저장 생략)"
          : `APPLIED · Schedule ${data.counts?.schedules ?? 0} / Duty ${data.counts?.shiftDuties ?? 0}`
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "운영 반영 요청 실패");
    } finally {
      setLoadingApply(false);
    }
  }

  const shiftRows =
    draft && shiftTab !== "UNASSIGNED" && shiftTab !== "CLOSED"
      ? assignmentsByShift(draft, shiftTab)
      : [];

  const boardOpenCourses = useMemo<CourseCode[]>(() => {
    if (!draft || draft.openCourses == null) return [...COURSE_CODES];
    const open = new Set(
      draft.openCourses
        .map((c) => resolveCourseCode(c))
        .filter((c): c is CourseCode => !!c)
    );
    return COURSE_CODES.filter((c) => open.has(c));
  }, [draft]);

  const boardRows = useMemo(() => {
    if (shiftTab === "UNASSIGNED" || shiftTab === "CLOSED") return [];
    // 선택된 부 내부에서만 matrix — reservation.shift 기준으로 재검증
    return buildShiftBoard(shiftRows, boardOpenCourses, shiftTab);
  }, [shiftRows, boardOpenCourses, shiftTab]);

  const detailRow = useMemo(() => {
    if (!draft) return null;
    const key = expandedKey || swapKey;
    if (!key) return null;
    return (
      draft.assignments.find(
        (a) => reservationIdentity(a.reservation) === key
      ) || null
    );
  }, [draft, expandedKey, swapKey]);

  function toggleCourse(code: CourseCode) {
    setCourseOpen((prev) => ({ ...prev, [code]: !prev[code] }));
  }

  function toggleExpandKey(key: string) {
    setExpandedKey((prev) => (prev === key ? null : key));
  }

  return (
    <div className="ops-root">
      <header className="ops-header">
        <div>
          <h1>자동배치 운영</h1>
          <p>Excel → 자동배치 → 수동 수정 → CONFIRMED 후 운영 반영</p>
        </div>
        {draft && (
          <StatusBadge
            status={draft.status}
            confirmedAt={draft.confirmedAt}
            appliedAt={draft.appliedAt ?? null}
          />
        )}
      </header>

      <section className="ops-panel">
        <label className="ops-field">
          <span>날짜</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className="ops-field">
          <span>예약 Excel</span>
          <input
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </label>
        <div className="ops-courses" aria-label="코스 Open/Close">
          <div className="ops-courses-label">
            코스 운영 (기본 전부 ON · OFF 코스는 배치 제외)
          </div>
          <div className="ops-courses-toggles">
            {COURSE_CODES.map((code) => (
              <button
                key={code}
                type="button"
                className={`course-toggle ${courseOpen[code] ? "on" : "off"}`}
                onClick={() => toggleCourse(code)}
                aria-pressed={courseOpen[code]}
              >
                <span className="course-name">{COURSE_LABELS[code]}</span>
                <span className="course-state">
                  {courseOpen[code] ? "ON" : "OFF"}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="ops-actions">
          <button
            type="button"
            className="btn ghost"
            disabled={!date || loadingAvail}
            onClick={loadAvailability}
          >
            {loadingAvail ? "가용…" : "가용 캐디 불러오기"}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!date || !file || loadingRun}
            onClick={runAutoAssign}
          >
            {loadingRun ? "배치 중…" : "자동배치 실행"}
          </button>
          <button
            type="button"
            className="btn confirm"
            disabled={
              !draft ||
              draft.status === "CONFIRMED" ||
              draft.status === "APPLIED"
            }
            onClick={onConfirm}
          >
            CONFIRMED
          </button>
          <button
            type="button"
            className="btn apply"
            disabled={!draft || draft.status !== "CONFIRMED" || loadingApply}
            onClick={() => onApplyToOps(false)}
            title="CONFIRMED 상태에서만 Schedule/ShiftDuty에 저장"
          >
            {loadingApply ? "반영 중…" : "운영 반영"}
          </button>
        </div>
        {availability && (
          <div className="ops-meta">
            가용 {availability.counts.available} · special{" "}
            {availability.counts.special} · 제외 {availability.counts.excluded}
          </div>
        )}
        {autoResult && (
          <div className="ops-meta">
            자동배치 {autoResult.meta.assignedCount}건 · 미배치{" "}
            {autoResult.meta.unassignedCount}
            {(autoResult.meta.closedCourseCount ?? 0) > 0 && (
              <> · 닫힌코스 {autoResult.meta.closedCourseCount}</>
            )}{" "}
            · 파일 {autoResult.filename || "-"} · 열린코스{" "}
            {(autoResult.openCourses || openCourseList)
              .map((c) => COURSE_LABELS[c as CourseCode] || c)
              .join("/")}
          </div>
        )}
        {error && <div className="ops-error">{error}</div>}
      </section>

      {liveWarnings.length > 0 && (
        <section className="ops-warnings">
          {liveWarnings.slice(0, 8).map((w, i) => (
            <div key={`${w.code}-${i}`} className={`warn ${w.level}`}>
              {w.level === "error" ? "⚠" : "ℹ"} {w.message}
            </div>
          ))}
        </section>
      )}

      {draft && (
        <>
          {/*
            부 탭 + (배치표) 컬럼 헤더를 하나의 sticky 스택으로 묶어
            서로 다른 top/z-index sticky가 첫 데이터 행을 덮지 않게 한다.
            헤더는 문서 흐름 높이를 유지한 채 스택과 함께 고정된다.
          */}
          <div className="ops-sticky-stack" ref={stickyStackRef}>
            <nav className="ops-tabs">
              {SHIFTS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={shiftTab === s ? "on" : ""}
                  onClick={() => setShiftTab(s)}
                >
                  {s}
                  <small>
                    {assignmentsByShift(draft, s).length}
                  </small>
                </button>
              ))}
              <button
                type="button"
                className={shiftTab === "UNASSIGNED" ? "on" : ""}
                onClick={() => setShiftTab("UNASSIGNED")}
              >
                미배치
                <small>{draft.unassignedReservations.length}</small>
              </button>
              <button
                type="button"
                className={shiftTab === "CLOSED" ? "on" : ""}
                onClick={() => setShiftTab("CLOSED")}
              >
                닫힌코스
                <small>{draft.closedCourseReservations?.length ?? 0}</small>
              </button>
            </nav>

            {shiftTab !== "UNASSIGNED" && shiftTab !== "CLOSED" && (
              <div className="ops-view-toggle" role="group" aria-label="결과 보기">
                <button
                  type="button"
                  className={viewMode === "board" ? "on" : ""}
                  onClick={() => setViewMode("board")}
                >
                  배치표보기
                </button>
                <button
                  type="button"
                  className={viewMode === "list" ? "on" : ""}
                  onClick={() => setViewMode("list")}
                >
                  목록보기
                </button>
              </div>
            )}

            {shiftTab !== "UNASSIGNED" &&
              shiftTab !== "CLOSED" &&
              viewMode === "board" &&
              boardRows.length > 0 && (
                <div className="ops-board-head-bar">
                  <div
                    className="ops-board-head"
                    role="row"
                    aria-label={`${shiftTab} 배치표 헤더`}
                  >
                    <div className="bh-time" role="columnheader">
                      시간
                    </div>
                    {COURSE_CODES.map((code) => (
                      <div
                        key={code}
                        className={`bh-course ${
                          boardOpenCourses.includes(code) ? "" : "closed"
                        }`}
                        role="columnheader"
                        title={COURSE_LABELS[code]}
                      >
                        {COURSE_SHORT[code]}
                      </div>
                    ))}
                  </div>
                </div>
              )}
          </div>

          {shiftTab !== "UNASSIGNED" && shiftTab !== "CLOSED" && (
            <>
              {viewMode === "board" && (
                <div
                  className={`ops-board-wrap${
                    boardRows.length > 0 ? " has-sticky-head" : ""
                  }`}
                >
                  {boardRows.length === 0 ? (
                    <div className="ops-empty">이 부 배치 없음</div>
                  ) : (
                    <div className="ops-board" role="table" aria-label={`${shiftTab} 배치표`}>
                      {boardRows.map((tr) => {
                        const rowHasExpand = COURSE_CODES.some((code) => {
                          const cell = tr.cells[code];
                          if (cell.kind !== "assigned") return false;
                          return cell.rows.some(
                            (r) =>
                              reservationIdentity(r.reservation) ===
                                expandedKey ||
                              reservationIdentity(r.reservation) === swapKey
                          );
                        });
                        return (
                          <div key={tr.teeTime} className="ops-board-block">
                            <div className="ops-board-row" role="row">
                              <div className="bc-time" role="cell">
                                {tr.teeTime}
                              </div>
                              {COURSE_CODES.map((code) => {
                                const cell = tr.cells[code];
                                if (cell.kind === "closed") {
                                  return (
                                    <div
                                      key={code}
                                      className="bc-cell closed"
                                      role="cell"
                                      aria-label={`${COURSE_LABELS[code]} 닫힘`}
                                    >
                                      <span className="bc-closed">닫힘</span>
                                    </div>
                                  );
                                }
                                if (cell.kind === "empty") {
                                  return (
                                    <div
                                      key={code}
                                      className="bc-cell empty"
                                      role="cell"
                                    >
                                      -
                                    </div>
                                  );
                                }
                                const primary = cell.rows[0];
                                const key = reservationIdentity(
                                  primary.reservation
                                );
                                const special = primary.kind !== "regular";
                                const active =
                                  expandedKey === key ||
                                  swapKey === key ||
                                  cell.rows.some(
                                    (r) =>
                                      reservationIdentity(r.reservation) ===
                                        expandedKey ||
                                      reservationIdentity(r.reservation) ===
                                        swapKey
                                  );
                                return (
                                  <button
                                    key={code}
                                    type="button"
                                    className={`bc-cell assigned ${
                                      special ? "special" : ""
                                    } ${active ? "active" : ""}`}
                                    role="cell"
                                    onClick={() => {
                                      if (cell.rows.length === 1) {
                                        toggleExpandKey(key);
                                        return;
                                      }
                                      const idx = cell.rows.findIndex(
                                        (r) =>
                                          reservationIdentity(r.reservation) ===
                                          expandedKey
                                      );
                                      const next =
                                        cell.rows[
                                          idx >= 0
                                            ? (idx + 1) % cell.rows.length
                                            : 0
                                        ];
                                      toggleExpandKey(
                                        reservationIdentity(next.reservation)
                                      );
                                    }}
                                  >
                                    <span className="bc-name">
                                      {primary.caddy.name}
                                    </span>
                                    {cell.rows.length > 1 && (
                                      <span className="bc-more">
                                        +{cell.rows.length - 1}
                                      </span>
                                    )}
                                    {special && (
                                      <span className="bc-special">S</span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                            {rowHasExpand && detailRow && (
                              <div className="ops-board-detail">
                                <div className="ops-board-detail-meta">
                                  <strong>{detailRow.reservation.teeTime}</strong>
                                  <span>
                                    {detailRow.reservation.teamName || "-"}
                                  </span>
                                  <span>
                                    {detailRow.reservation.courseLabel ||
                                      (() => {
                                        const code = resolveCourseCode(
                                          detailRow.reservation.course
                                        );
                                        return code
                                          ? COURSE_LABELS[code]
                                          : detailRow.reservation.course;
                                      })()}
                                  </span>
                                  <span className="caddy-strong">
                                    {detailRow.caddy.name}
                                  </span>
                                  <span className="muted">
                                    {detailRow.caddy.team}·
                                    {detailRow.caddy.teamOrder}
                                    {detailRow.kind !== "regular"
                                      ? ` · ${detailRow.kind}`
                                      : ""}
                                  </span>
                                </div>
                                <div className="ops-row-actions">
                                  <label className="inline">
                                    교체
                                    <select
                                      defaultValue=""
                                      onChange={(e) => {
                                        const id = Number(e.target.value);
                                        if (id) onReplace(detailRow, id);
                                        e.target.value = "";
                                      }}
                                    >
                                      <option value="">캐디 선택</option>
                                      {freeCaddies.map((c) => (
                                        <option key={c.id} value={c.id}>
                                          {c.name} (#{c.id}/{c.team})
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                  <button
                                    type="button"
                                    className="btn tiny"
                                    onClick={() => onSwapClick(detailRow)}
                                  >
                                    {swapKey ===
                                    reservationIdentity(detailRow.reservation)
                                      ? "선택됨"
                                      : "Swap"}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn tiny ghost"
                                    onClick={() => onUnassign(detailRow)}
                                  >
                                    해제
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {viewMode === "list" && (
                <ul className="ops-list compact">
                  {shiftRows.length === 0 && (
                    <li className="ops-empty">이 부 배치 없음</li>
                  )}
                  {shiftRows.map((row) => {
                    const key = reservationIdentity(row.reservation);
                    const special = row.kind !== "regular";
                    const open = expandedKey === key || swapKey === key;
                    const course =
                      row.reservation.courseLabel ||
                      COURSE_LABELS[row.reservation.course as CourseCode] ||
                      row.reservation.course;
                    return (
                      <li
                        key={key}
                        className={`ops-row ${special ? "special" : ""} ${
                          swapKey === key ? "swap-on" : ""
                        } ${open ? "open" : ""}`}
                      >
                        <button
                          type="button"
                          className="ops-row-main"
                          onClick={() => toggleExpandKey(key)}
                        >
                          <span className="col time">
                            {row.reservation.teeTime}
                          </span>
                          <span className="col team">
                            {row.reservation.teamName || "-"}
                            {special ? (
                              <em className="tag-s">{row.kind}</em>
                            ) : null}
                          </span>
                          <span className="col course">{course}</span>
                          <span className="col caddy">{row.caddy.name}</span>
                          <span className="col meta">
                            {row.caddy.team}·{row.caddy.teamOrder}
                          </span>
                        </button>
                        {open && (
                          <div className="ops-row-actions">
                            <label className="inline">
                              교체
                              <select
                                defaultValue=""
                                onChange={(e) => {
                                  const id = Number(e.target.value);
                                  if (id) onReplace(row, id);
                                  e.target.value = "";
                                }}
                              >
                                <option value="">캐디 선택</option>
                                {freeCaddies.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.name} (#{c.id}/{c.team})
                                  </option>
                                ))}
                              </select>
                            </label>
                            <button
                              type="button"
                              className="btn tiny"
                              onClick={() => onSwapClick(row)}
                            >
                              {swapKey === key ? "선택됨" : "Swap"}
                            </button>
                            <button
                              type="button"
                              className="btn tiny ghost"
                              onClick={() => onUnassign(row)}
                            >
                              해제
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="ops-spares">
                <div className="ops-spares-title">{shiftTab} 스페어</div>
                <div className="ops-spare-line">
                  <span className="lbl">스페어1</span>
                  {shiftSpare?.spare1 ? (
                    <span>
                      {shiftSpare.spare1.name} · {shiftSpare.spare1.team} ·{" "}
                      {shiftSpare.spare1.teamOrder}번
                    </span>
                  ) : (
                    <span className="muted">-</span>
                  )}
                </div>
                <div className="ops-spare-line">
                  <span className="lbl">스페어2</span>
                  {shiftSpare?.spare2 ? (
                    <span>
                      {shiftSpare.spare2.name} · {shiftSpare.spare2.team} ·{" "}
                      {shiftSpare.spare2.teamOrder}번
                    </span>
                  ) : (
                    <span className="muted">-</span>
                  )}
                </div>
              </div>
            </>
          )}

          {shiftTab === "UNASSIGNED" && (
            <ul className="ops-list compact">
              {draft.unassignedReservations.length === 0 && (
                <li className="ops-empty">미배치 없음</li>
              )}
              {draft.unassignedReservations.map((u) => {
                const key = reservationIdentity(u.reservation);
                const open = expandedKey === key;
                const course =
                  u.reservation.courseLabel ||
                  COURSE_LABELS[u.reservation.course as CourseCode] ||
                  u.reservation.course;
                return (
                  <li key={key} className={`ops-row ${open ? "open" : ""}`}>
                    <button
                      type="button"
                      className="ops-row-main"
                      onClick={() =>
                        setExpandedKey((prev) => (prev === key ? null : key))
                      }
                    >
                      <span className="col time">{u.reservation.teeTime}</span>
                      <span className="col team">
                        {u.reservation.teamName || "-"}
                      </span>
                      <span className="col course">{course}</span>
                      <span className="col caddy muted">{u.reservation.shift}</span>
                      <span className="col meta muted">미배치</span>
                    </button>
                    {open && (
                      <div className="ops-row-actions">
                        <label className="inline">
                          지정
                          <select
                            defaultValue=""
                            onChange={(e) => {
                              const id = Number(e.target.value);
                              if (id) onAssignUnassigned(key, id);
                              e.target.value = "";
                            }}
                          >
                            <option value="">캐디 선택</option>
                            {freeCaddies.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name} (#{c.id}/{c.team})
                              </option>
                            ))}
                          </select>
                        </label>
                        <span className="muted reason">{u.reason}</span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {shiftTab === "CLOSED" && (
            <ul className="ops-list compact">
              {(draft.closedCourseReservations?.length ?? 0) === 0 && (
                <li className="ops-empty">닫힌 코스 예약 없음</li>
              )}
              {(draft.closedCourseReservations || []).map((u) => {
                const key = reservationIdentity(u.reservation);
                const course =
                  u.reservation.courseLabel ||
                  COURSE_LABELS[u.reservation.course as CourseCode] ||
                  u.reservation.course;
                return (
                  <li key={key} className="ops-row closed">
                    <div className="ops-row-main static">
                      <span className="col time">{u.reservation.teeTime}</span>
                      <span className="col team">
                        {u.reservation.teamName || "-"}
                      </span>
                      <span className="col course">{course}</span>
                      <span className="col caddy muted">{u.reservation.shift}</span>
                      <span className="col meta muted">CLOSED</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {toast && <div className="ops-toast">{toast}</div>}

      <style>{opsCss}</style>
    </div>
  );
}

function StatusBadge({
  status,
  confirmedAt,
  appliedAt,
}: {
  status: string;
  confirmedAt: string | null;
  appliedAt: string | null;
}) {
  const stamp = appliedAt || confirmedAt;
  return (
    <div className={`status ${status}`}>
      <div className="status-label">{status}</div>
      {stamp && (
        <div className="status-sub">{new Date(stamp).toLocaleString("ko-KR")}</div>
      )}
    </div>
  );
}

const opsCss = `
  .ops-root {
    max-width: 720px;
    margin: 0 auto;
    display: grid;
    gap: 12px;
    padding: 0 8px 72px;
    box-sizing: border-box;
    width: 100%;
  }
  .ops-header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
  }
  .ops-header h1 {
    margin: 0;
    font-size: 1.35rem;
  }
  .ops-header p {
    margin: 4px 0 0;
    color: #64748b;
    font-size: 0.85rem;
  }
  .status {
    min-width: 96px;
    text-align: center;
    border-radius: 12px;
    padding: 8px 10px;
    border: 1px solid #e2e8f0;
    background: #f8fafc;
  }
  .status.DRAFT { background: #f1f5f9; }
  .status.EDITED { background: #fff7ed; border-color: #fdba74; }
  .status.CONFIRMED { background: #ecfdf5; border-color: #6ee7b7; }
  .status.APPLIED { background: #eff6ff; border-color: #93c5fd; }
  .status-label { font-weight: 800; font-size: 0.85rem; }
  .status-sub { font-size: 0.65rem; color: #64748b; margin-top: 2px; }
  .ops-panel {
    display: grid;
    gap: 10px;
    padding: 12px;
    border: 1px solid #e5e7eb;
    border-radius: 14px;
    background: #fff;
  }
  .ops-courses {
    display: grid;
    gap: 6px;
  }
  .ops-courses-label {
    font-size: 0.8rem;
    color: #475569;
    font-weight: 600;
  }
  .ops-courses-toggles {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
  }
  @media (min-width: 560px) {
    .ops-courses-toggles { grid-template-columns: repeat(4, 1fr); }
  }
  .course-toggle {
    min-height: 42px;
    border-radius: 10px;
    border: 1px solid #cbd5e1;
    background: #f8fafc;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .course-toggle.on {
    background: #ecfdf5;
    border-color: #6ee7b7;
  }
  .course-toggle.off {
    background: #f8fafc;
    color: #94a3b8;
  }
  .course-state {
    font-size: 0.7rem;
    font-weight: 800;
  }
  .course-toggle.on .course-state { color: #047857; }
  .course-toggle.off .course-state { color: #94a3b8; }
  .ops-field {
    display: grid;
    gap: 4px;
    font-size: 0.85rem;
  }
  .ops-field input[type="date"],
  .ops-field input[type="file"],
  .inline select {
    width: 100%;
    min-height: 40px;
    font-size: 16px; /* iOS zoom prevent */
  }
  .ops-actions {
    display: grid;
    grid-template-columns: 1fr;
    gap: 8px;
  }
  @media (min-width: 560px) {
    .ops-actions { grid-template-columns: repeat(2, 1fr); }
  }
  @media (min-width: 720px) {
    .ops-actions { grid-template-columns: repeat(4, 1fr); }
  }
  .btn {
    min-height: 42px;
    border-radius: 10px;
    border: 1px solid #cbd5e1;
    background: #fff;
    font-size: 0.9rem;
    cursor: pointer;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn.primary { background: #0f172a; color: #fff; border-color: #0f172a; }
  .btn.confirm { background: #047857; color: #fff; border-color: #047857; }
  .btn.apply { background: #1d4ed8; color: #fff; border-color: #1d4ed8; }
  .btn.ghost { background: #f8fafc; }
  .btn.tiny { min-height: 34px; padding: 0 10px; font-size: 0.8rem; }
  .ops-meta { font-size: 0.8rem; color: #475569; }
  .ops-error { color: #b91c1c; font-size: 0.85rem; }
  .ops-warnings { display: grid; gap: 6px; }
  .warn {
    font-size: 0.8rem;
    padding: 8px 10px;
    border-radius: 10px;
  }
  .warn.error { background: #fef2f2; color: #991b1b; }
  .warn.warn { background: #fffbeb; color: #92400e; }
  /*
    단일 sticky 스택: 부 탭 + 보기 토글 + 컬럼 헤더가 같은 블록으로 고정되어
    이중 sticky(top 오프셋)로 첫 행을 덮는 문제를 제거한다.
  */
  .ops-sticky-stack {
    position: sticky;
    top: 0;
    z-index: 5;
    display: grid;
    gap: 8px;
    padding: 6px 0 0;
    background: #f8fafc;
    box-shadow: 0 1px 0 #e2e8f0;
  }
  .ops-tabs {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 6px;
    position: relative;
    z-index: auto;
    background: transparent;
    padding: 0;
  }
  .ops-tabs button {
    border: 1px solid #e2e8f0;
    background: #fff;
    border-radius: 10px;
    min-height: 44px;
    font-size: 0.85rem;
    display: grid;
    place-items: center;
    gap: 2px;
  }
  .ops-tabs button.on {
    background: #0f172a;
    color: #fff;
    border-color: #0f172a;
  }
  .ops-tabs small {
    font-size: 0.7rem;
    opacity: 0.8;
  }
  .ops-view-toggle {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .ops-view-toggle button {
    min-height: 36px;
    border-radius: 8px;
    border: 1px solid #e2e8f0;
    background: #fff;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .ops-view-toggle button.on {
    background: #0f172a;
    color: #fff;
    border-color: #0f172a;
    font-weight: 700;
  }
  .ops-board-head-bar {
    width: 100%;
    border: 1px solid #e2e8f0;
    border-bottom: 0;
    border-radius: 8px 8px 0 0;
    overflow: hidden;
    background: #0f172a;
  }
  .ops-board-wrap {
    width: 100%;
    /* overflow-x:hidden 은 sticky 스크롤 컨테인먼트를 만들어 모바일에서 깨질 수 있음 */
    overflow-x: clip;
  }
  /* ops-root gap(12px)을 상쇄해 헤더 바·본문 테두리가 이어지게 함 */
  .ops-sticky-stack:has(.ops-board-head-bar) + .ops-board-wrap.has-sticky-head {
    margin-top: -12px;
  }
  .ops-board {
    width: 100%;
    display: grid;
    gap: 0;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    overflow: hidden;
    background: #fff;
  }
  .ops-board-wrap.has-sticky-head .ops-board {
    border-top: 0;
    border-radius: 0 0 8px 8px;
  }
  .ops-board-head,
  .ops-board-row {
    display: grid;
    grid-template-columns: 40px repeat(4, minmax(0, 1fr));
    width: 100%;
  }
  .ops-board-head {
    /* 스택 안에서 일반 흐름 — 별도 sticky/top 오프셋 없음 */
    position: relative;
    background: #0f172a;
    color: #fff;
  }
  .ops-board-head > div {
    padding: 6px 2px;
    text-align: center;
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: -0.02em;
  }
  .ops-board-head .bh-time { text-align: center; }
  .ops-board-head .bh-course.closed { color: #94a3b8; text-decoration: line-through; }
  .ops-board-block + .ops-board-block {
    border-top: 1px solid #e2e8f0;
  }
  .ops-board-row > .bc-time {
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.68rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    color: #334155;
    background: #f8fafc;
    border-right: 1px solid #e2e8f0;
    padding: 4px 1px;
    min-height: 36px;
  }
  .bc-cell {
    min-width: 0;
    min-height: 36px;
    padding: 4px 2px;
    border-right: 1px solid #f1f5f9;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    font-size: 0.72rem;
    line-height: 1.15;
    background: #fff;
  }
  .ops-board-row > .bc-cell:last-child { border-right: 0; }
  .bc-cell.empty {
    color: #cbd5e1;
    font-weight: 600;
  }
  .bc-cell.closed {
    background: repeating-linear-gradient(
      -45deg,
      #f1f5f9,
      #f1f5f9 4px,
      #e2e8f0 4px,
      #e2e8f0 8px
    );
    color: #94a3b8;
  }
  .bc-closed {
    font-size: 0.62rem;
    font-weight: 800;
  }
  button.bc-cell {
    border: 0;
    cursor: pointer;
    font: inherit;
    color: inherit;
    width: 100%;
  }
  button.bc-cell.assigned {
    background: #fff;
  }
  button.bc-cell.assigned.special {
    background: #fffbeb;
  }
  button.bc-cell.assigned.active {
    outline: 2px solid #2563eb;
    outline-offset: -2px;
    z-index: 1;
  }
  .bc-name {
    font-weight: 800;
    font-size: 0.78rem;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #0f172a;
  }
  .bc-more {
    font-size: 0.6rem;
    color: #64748b;
    font-weight: 700;
  }
  .bc-special {
    font-size: 0.58rem;
    font-weight: 800;
    color: #b45309;
  }
  .ops-board-detail {
    border-top: 1px solid #e2e8f0;
    background: #f8fafc;
    padding: 8px;
    display: grid;
    gap: 8px;
  }
  .ops-board-detail-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
    font-size: 0.78rem;
    align-items: baseline;
  }
  .ops-board-detail-meta .caddy-strong {
    font-weight: 800;
    font-size: 0.9rem;
  }
  .ops-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 2px;
  }
  .ops-list.compact { gap: 1px; }
  .ops-row {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    overflow: hidden;
  }
  .ops-row.special { border-color: #f59e0b; background: #fffbeb; }
  .ops-row.swap-on { outline: 2px solid #2563eb; }
  .ops-row.closed { background: #f8fafc; color: #64748b; }
  .ops-row-main {
    width: 100%;
    display: grid;
    grid-template-columns: 46px minmax(0, 1.3fr) 52px minmax(0, 1fr) 56px;
    gap: 4px;
    align-items: center;
    padding: 5px 6px;
    min-height: 32px;
    border: 0;
    background: transparent;
    text-align: left;
    font: inherit;
    cursor: pointer;
    color: inherit;
  }
  .ops-row-main.static { cursor: default; }
  .ops-row-main .col {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.78rem;
    line-height: 1.2;
  }
  .ops-row-main .time { font-weight: 700; font-variant-numeric: tabular-nums; }
  .ops-row-main .team { font-weight: 600; }
  .ops-row-main .course { color: #475569; font-size: 0.72rem; }
  .ops-row-main .caddy { font-weight: 700; }
  .ops-row-main .meta { color: #64748b; font-size: 0.68rem; text-align: right; }
  .tag-s {
    display: inline;
    margin-left: 3px;
    font-style: normal;
    font-size: 0.62rem;
    color: #b45309;
    font-weight: 700;
  }
  .muted { color: #64748b; font-weight: 500; font-size: 0.75rem; }
  .ops-row-actions {
    display: grid;
    gap: 6px;
    grid-template-columns: 1fr auto auto;
    align-items: end;
    padding: 6px;
    border-top: 1px solid #e2e8f0;
    background: #f8fafc;
  }
  .ops-row-actions .reason { grid-column: 1 / -1; font-size: 0.72rem; }
  .inline {
    display: grid;
    gap: 2px;
    font-size: 0.75rem;
    color: #64748b;
  }
  .ops-spares {
    margin-top: 8px;
    padding: 8px 10px;
    border: 1px dashed #cbd5e1;
    border-radius: 8px;
    background: #f8fafc;
    display: grid;
    gap: 4px;
  }
  .ops-spares-title {
    font-size: 0.75rem;
    font-weight: 700;
    color: #334155;
  }
  .ops-spare-line {
    display: grid;
    grid-template-columns: 56px 1fr;
    gap: 6px;
    font-size: 0.78rem;
  }
  .ops-spare-line .lbl {
    color: #64748b;
    font-weight: 600;
  }
  .ops-empty {
    padding: 12px;
    text-align: center;
    color: #64748b;
    border: 1px dashed #cbd5e1;
    border-radius: 8px;
    font-size: 0.85rem;
  }
  .ops-toast {
    position: fixed;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    background: #0f172a;
    color: #fff;
    padding: 10px 14px;
    border-radius: 999px;
    font-size: 0.85rem;
    z-index: 20;
    max-width: 90vw;
  }
`;
