"use client";

import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import {
  assignCaddyToUnassigned,
  assignmentsByShift,
  autoResultFromDraft,
  applyLiveResultToDraft,
  confirmDraft,
  createDraftFromAutoResult,
  detectDraftWarnings,
  markDraftApplied,
  replaceAssignmentCaddy,
  reservationIdentity,
  unassignReservation,
  unusedCaddies,
  type AssignmentDraft,
  type DraftWarning,
} from "@/lib/assignmentDraft";
import { draftToConfirmBody } from "@/lib/assignmentConfirm";
import {
  boardAssignmentMarks,
  buildShiftBoard,
} from "@/lib/assignmentBoardView";
import {
  drivingCandidateCaddies,
  isHouseStartCandidate,
  regularCaddyPoolFromAvailabilityRows,
  resolveCourseCode,
  compareReservationOrder,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type AutoAssignResultV1,
  type AutoAssignmentRow,
} from "@/lib/autoAssignEngine";
import {
  isInactiveEmploymentAvailability,
  type AvailabilityResult,
  type AvailabilityRow,
} from "@/lib/availabilityEngine";
import type { DailyAvailabilitySummary } from "@/lib/dailyAvailabilityOverlay";
import { excludeCaddiesById } from "@/lib/dailyOpsDuty";
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

import { SpecialDutyPanel, type Shift1StartOption } from "./SpecialDutyPanel";
import { BoardQuickSheet, LiveChangePanel, LockToggle, SameDayAddSheet, TeamMoveSheet } from "./LiveChangePanel";
import { isThirdBandTeam, THIRD_BAND_TEAMS } from "@/lib/caddyManage";
import { rotateThirdQueueFromStartTeam } from "@/lib/thirdWeeklyRotation";
import {
  LIVE_CHANGE_LABELS,
  QUICK_ACTION_CONFIRM_MESSAGE,
  changeFromEmptyBoardCell,
  hasBlockingLiveChangeError,
  needsQuickActionConfirm,
  previewLiveChangeFromDraft,
  shouldReconcileLivePersist,
  swapOrderToast,
  type LiveChangeInput,
  type LiveChangePreview,
} from "@/lib/assignmentChange";
import {
  emptyBoardCellAction,
  isStableReservationMoveKey,
  reservationMoveBlockReason,
} from "@/lib/reservationMove";

type ResultViewMode = "board" | "list";

type ThirdWeeklyStartState = {
  weekStart: string;
  autoStartTeam: string;
  startTeam: string;
  overridden: boolean;
};

function AssignmentMarkBadges({
  twoWork,
  chageun,
  special,
  limousine,
  driving,
}: {
  twoWork: boolean;
  chageun: boolean;
  special?: boolean;
  limousine?: boolean;
  driving?: boolean;
}) {
  if (!twoWork && !chageun && !special && !limousine && !driving) return null;
  return (
    <span className="bc-marks">
      {limousine ? <span className="bc-badge limo">리무진</span> : null}
      {driving ? <span className="bc-badge drive">드라이빙</span> : null}
      {twoWork ? <span className="bc-badge two">투</span> : null}
      {chageun ? (
        <span className="bc-badge call">찾근</span>
      ) : special && !driving ? (
        <span className="bc-special">S</span>
      ) : null}
    </span>
  );
}

const BoardAssignedSlots = memo(function BoardAssignedSlots({
  rows,
  allAssignments,
  expandedKey,
  swapKey,
  moveKey,
  onTeamTap,
  onCaddyTap,
  onToggleLock,
}: {
  rows: AutoAssignmentRow[];
  allAssignments: AutoAssignmentRow[];
  expandedKey: string | null;
  swapKey: string | null;
  moveKey: string | null;
  onTeamTap: (row: AutoAssignmentRow) => void;
  onCaddyTap: (row: AutoAssignmentRow) => void;
  onToggleLock: (row: AutoAssignmentRow, locked: boolean) => void;
}) {
  return (
    <>
      {rows.map((row) => {
        const key = reservationIdentity(row.reservation);
        const special = row.kind !== "regular";
        const marks = boardAssignmentMarks(row, allAssignments);
        const active = expandedKey === key || swapKey === key || moveKey === key;
        return (
          <div
            key={key}
            className={`bc-slot${active ? " active" : ""}${
              swapKey === key ? " swap-on" : ""
            }${moveKey === key ? " move-on" : ""}`}
          >
            <button
              type="button"
              className="bc-team"
              onClick={() => onTeamTap(row)}
            >
              <span className="bc-team-name">
                {row.reservation.teamName || "팀"}
              </span>
              {marks.limousine ? (
                <span className="bc-badge limo">리무진</span>
              ) : null}
            </button>
            <button
              type="button"
              className="bc-caddy"
              onClick={() => onCaddyTap(row)}
            >
              <span className="bc-name">{row.caddy.name}</span>
              <AssignmentMarkBadges
                twoWork={marks.twoWork}
                chageun={marks.chageun}
                special={special}
                driving={marks.driving}
              />
            </button>
            <LockToggle
              row={row}
              onToggle={(locked) => onToggleLock(row, locked)}
            />
          </div>
        );
      })}
    </>
  );
});

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
  const [dutyFile, setDutyFile] = useState<File | null>(null);
  const [opsDutyStored, setOpsDutyStored] = useState<{
    count: number;
    byRole?: Record<string, number>;
    caddyIds: number[];
  } | null>(null);
  const [opsDutyPreview, setOpsDutyPreview] = useState<{
    matchedCount: number;
    reviewCount: number;
    existingCount: number;
    replaceRequired: boolean;
    reviews: Array<{ rawName: string; reason: string; role?: string }>;
    matched: Array<{ name: string; rawName: string; role: string; roleKey: string }>;
  } | null>(null);
  const [loadingDutyPreview, setLoadingDutyPreview] = useState(false);
  const [loadingDutyApply, setLoadingDutyApply] = useState(false);
  const [shift1Options, setShift1Options] = useState<Shift1StartOption[]>([]);
  const [availability, setAvailability] = useState<
    (AvailabilityResult & { dailySummary?: DailyAvailabilitySummary }) | null
  >(null);
  const [autoResult, setAutoResult] = useState<RunResponse | null>(null);
  const [draft, setDraft] = useState<AssignmentDraft | null>(null);
  const [warnings, setWarnings] = useState<DraftWarning[]>([]);
  const [shiftTab, setShiftTab] = useState<
    ShiftPart | "UNASSIGNED" | "CLOSED"
  >("1부");
  const [courseOpen, setCourseOpen] = useState<CourseOpenState>(defaultCourseOpen);
  const [houseStartCaddyId, setHouseStartCaddyId] = useState<number | "">("");
  const [thirdStartCaddyId, setThirdStartCaddyId] = useState<number | "">("");
  const [thirdWeekly, setThirdWeekly] = useState<ThirdWeeklyStartState | null>(
    null
  );
  const [savingThirdWeekly, setSavingThirdWeekly] = useState(false);
  const [loadingAvail, setLoadingAvail] = useState(false);
  const [loadingRun, setLoadingRun] = useState(false);
  const [loadingApply, setLoadingApply] = useState(false);
  const [loadingLiveApply, setLoadingLiveApply] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [swapKey, setSwapKey] = useState<string | null>(null);
  const [moveKey, setMoveKey] = useState<string | null>(null);
  const [moveSheetOpen, setMoveSheetOpen] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [quickSheet, setQuickSheet] = useState<{
    mode: "team" | "caddy";
    key: string;
  } | null>(null);
  const [liveChangePreset, setLiveChangePreset] =
    useState<LiveChangeInput | null>(null);
  const [addTeamOpen, setAddTeamOpen] = useState(false);
  const [unavailableCaddyIds, setUnavailableCaddyIds] = useState<number[]>([]);
  const [viewMode, setViewMode] = useState<ResultViewMode>("board");
  const [toast, setToast] = useState<string | null>(null);
  const stickyStackRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<AssignmentDraft | null>(null);
  const autoResultRef = useRef<RunResponse | null>(null);
  const persistQueueRef = useRef(Promise.resolve());
  const persistGenRef = useRef(0);
  draftRef.current = draft;
  autoResultRef.current = autoResult;

  useEffect(() => {
    if (!file || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setShift1Options([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const form = new FormData();
        form.append("file", file);
        form.append("defaultDate", date);
        const res = await fetch("/api/reservations/preview", {
          method: "POST",
          body: form,
          credentials: "include",
        });
        const data = await res.json();
        if (!res.ok || cancelled) return;
        const rows = ((data.reservations || []) as AutoAssignReservation[])
          .filter(
            (row) =>
              row.shift === "1부" && (!row.date || row.date === date)
          )
          .slice()
          .sort(compareReservationOrder);
        if (cancelled) return;
        setShift1Options(
          rows.map((row) => {
            const code = resolveCourseCode(row.course);
            const courseLabel = code ? COURSE_LABELS[code] : row.course;
            return {
              course: row.course,
              teeTime: row.teeTime,
              teamName: row.teamName ?? null,
              label: `${courseLabel} ${row.teeTime}${
                row.teamName ? ` · ${row.teamName}` : ""
              }`,
            };
          })
        );
      } catch {
        if (!cancelled) setShift1Options([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, date]);

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setOpsDutyStored(null);
      setOpsDutyPreview(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/daily-ops-duties?date=${encodeURIComponent(date)}`,
          { credentials: "include" }
        );
        const data = await res.json();
        if (!res.ok || cancelled) return;
        setOpsDutyStored({
          count: Number(data.count) || 0,
          byRole: data.byRole,
          caddyIds: Array.isArray(data.caddyIds)
            ? data.caddyIds
            : Array.isArray(data.rows)
              ? data.rows.map((r: { caddyId: number }) => r.caddyId)
              : [],
        });
      } catch {
        if (!cancelled) setOpsDutyStored(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [date]);

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setThirdWeekly(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/third-weekly-start?date=${encodeURIComponent(date)}`,
          { credentials: "include" }
        );
        const data = await res.json();
        if (!res.ok || cancelled) return;
        setThirdWeekly({
          weekStart: String(data.weekStart || ""),
          autoStartTeam: String(data.autoStartTeam || ""),
          startTeam: String(data.startTeam || ""),
          overridden: Boolean(data.overridden),
        });
      } catch {
        if (!cancelled) setThirdWeekly(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [date]);

  /** 부 탭/보기 전환 시 sticky 스택 기준으로 첫 데이터 행이 보이도록 스크롤 */
  useEffect(() => {
    if (!draft) return;
    stickyStackRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [shiftTab, viewMode, draft?.id]);

  const openCourseList = useMemo(
    () => COURSE_CODES.filter((c) => courseOpen[c]),
    [courseOpen]
  );

  /** 오늘 1부 첫 캐디 후보: 당일 일반 가용 1~8조 HOUSE만 (9~12조·special/제외 제외) */
  const houseStartCandidates = useMemo(() => {
    const rows = availability?.available?.all || [];
    return rows
      .filter((r) => isHouseStartCandidate(r))
      .slice()
      .sort(
        (a, b) =>
          String(a.team).localeCompare(String(b.team), "ko") ||
          (Number(a.teamOrder) || 0) - (Number(b.teamOrder) || 0) ||
          a.id - b.id
      );
  }, [availability]);

  /** 오늘 3부 첫 캐디 후보: 9~12조 (가용+특수+당일 제외 ACTIVE). RETIRED/LEAVE 제외. 주간 시작조 회전순 */
  const thirdStartCandidates = useMemo(() => {
    if (!availability) return [];
    const rows: AvailabilityRow[] = [
      ...availability.available.all,
      ...availability.special,
      ...availability.excluded,
    ];
    const byId = new Map<number, AvailabilityRow>();
    for (const row of rows) {
      if (!isThirdBandTeam(row.team)) continue;
      if (String(row.caddyType || "").toUpperCase() === "DRIVING") continue;
      if (isInactiveEmploymentAvailability(row)) continue;
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
    const startTeam = THIRD_BAND_TEAMS.includes(
      (thirdWeekly?.startTeam || "") as (typeof THIRD_BAND_TEAMS)[number]
    )
      ? (thirdWeekly!.startTeam as (typeof THIRD_BAND_TEAMS)[number])
      : "12조";
    return rotateThirdQueueFromStartTeam([...byId.values()], startTeam);
  }, [availability, thirdWeekly]);

  function thirdStartCandidateStatus(row: AvailabilityRow): string {
    if (row.excludedReasons && row.excludedReasons.length > 0) {
      return row.excludedReasons[0];
    }
    if (row.assignmentLabels && row.assignmentLabels.length > 0) {
      return row.assignmentLabels[0];
    }
    if (row.bucket === "special" || (row.specialTags && row.specialTags.length > 0)) {
      return row.specialTags[0] || "특수";
    }
    return "근무";
  }

  const opsDutyCaddyIds = opsDutyStored?.caddyIds || [];
  const pool: AutoAssignCaddy[] = useMemo(() => {
    const raw = availability
      ? regularCaddyPoolFromAvailabilityRows(availability.available.all)
      : draft?.caddyPool || [];
    return excludeCaddiesById(raw, opsDutyCaddyIds);
  }, [availability, draft, opsDutyCaddyIds]);

  const freeCaddies = draft ? unusedCaddies(draft) : [];
  const drivingCandidates = draft
    ? drivingCandidateCaddies({
        pool: excludeCaddiesById(draft.caddyPool, opsDutyCaddyIds),
        assignedCaddyIds: draft.assignments.map((a) => a.caddy.id),
        unavailableCaddyIds,
      })
    : [];
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

  async function persistThirdWeeklyStart(startTeam: string | null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    setSavingThirdWeekly(true);
    setError(null);
    try {
      const res = await fetch("/api/third-weekly-start", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, startTeam }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "3부반 시작조 저장 실패");
        return;
      }
      setThirdWeekly({
        weekStart: String(data.weekStart || ""),
        autoStartTeam: String(data.autoStartTeam || ""),
        startTeam: String(data.startTeam || ""),
        overridden: Boolean(data.overridden),
      });
      showToast(
        startTeam
          ? `이번 주 3부반 시작조 ${data.startTeam} (수동)`
          : `이번 주 3부반 시작조 ${data.startTeam} (자동)`
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "3부반 시작조 저장 실패");
    } finally {
      setSavingThirdWeekly(false);
    }
  }

  async function loadAvailability() {
    if (!date) {
      setError("날짜를 선택하세요.");
      return;
    }
    setLoadingAvail(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("date", date);
      if (dutyFile) form.append("dutyFile", dutyFile);
      const res = await fetch("/api/availability", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "가용 불러오기 실패");
        return;
      }
      setAvailability(data as AvailabilityResult & { dailySummary?: DailyAvailabilitySummary });
      const dutyIds = Array.isArray((data as { opsDutyCaddyIds?: number[] }).opsDutyCaddyIds)
        ? ((data as { opsDutyCaddyIds?: number[] }).opsDutyCaddyIds as number[])
        : [];
      if (dutyIds.length) {
        setOpsDutyStored((prev) => ({
          count: prev?.count ?? dutyIds.length,
          byRole: prev?.byRole,
          caddyIds: dutyIds,
        }));
        if (draftRef.current) {
          const current = draftRef.current;
          setDraft({
            ...current,
            caddyPool: excludeCaddiesById(current.caddyPool, dutyIds),
          });
        }
      }
      setHouseStartCaddyId("");
      showToast(`최종 가용 ${data.counts?.available ?? 0}명 로드`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "가용 요청 실패");
    } finally {
      setLoadingAvail(false);
    }
  }

  async function previewOpsDutyFile() {
    if (!date) {
      setError("날짜를 선택하세요.");
      return;
    }
    if (!dutyFile) {
      setError("당번·마샬·조장 파일을 선택하세요.");
      return;
    }
    setLoadingDutyPreview(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("date", date);
      form.append("file", dutyFile);
      const res = await fetch("/api/daily-ops-duties/preview", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "당번 일정 미리보기 실패");
        return;
      }
      setOpsDutyPreview({
        matchedCount: Number(data.matchedCount) || 0,
        reviewCount: Number(data.reviewCount) || 0,
        existingCount: Number(data.existingCount) || 0,
        replaceRequired: Boolean(data.replaceRequired),
        reviews: Array.isArray(data.reviews) ? data.reviews : [],
        matched: Array.isArray(data.matched) ? data.matched : [],
      });
      showToast(
        `당번 일정 미리보기 ${data.matchedCount}명` +
          (data.existingCount ? ` · 기존 ${data.existingCount}건 교체 필요` : "")
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "당번 일정 미리보기 실패");
    } finally {
      setLoadingDutyPreview(false);
    }
  }

  async function applyOpsDutyFile() {
    if (!date) {
      setError("날짜를 선택하세요.");
      return;
    }
    if (!dutyFile) {
      setError("당번·마샬·조장 파일을 선택하세요.");
      return;
    }
    if (opsDutyPreview?.replaceRequired) {
      const ok = window.confirm(
        `이 날짜에 이미 당번·마샬·조장 일정 ${opsDutyPreview.existingCount}건이 있습니다. 이번 파일로 교체할까요?`
      );
      if (!ok) return;
    }
    if (opsDutyPreview && opsDutyPreview.reviewCount > 0) {
      const ok = window.confirm(
        `확인 필요 ${opsDutyPreview.reviewCount}건은 저장하지 않습니다. 매칭된 ${opsDutyPreview.matchedCount}명만 이 날짜 일정으로 저장할까요?`
      );
      if (!ok) return;
    }
    setLoadingDutyApply(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("date", date);
      form.append("file", dutyFile);
      form.append("confirmReplace", "1");
      const res = await fetch("/api/daily-ops-duties/apply", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "당번 일정 저장 실패");
        return;
      }
      setOpsDutyStored({
        count: Number(data.savedCount) || 0,
        byRole: data.byRole,
        caddyIds: Array.isArray(data.saved)
          ? data.saved.map((r: { caddyId: number }) => r.caddyId)
          : [],
      });
      setOpsDutyPreview(null);
      showToast(`당번·마샬·조장 일정 ${data.savedCount}명 저장`);
      const availForm = new FormData();
      availForm.append("date", date);
      const availRes = await fetch("/api/availability", {
        method: "POST",
        body: availForm,
        credentials: "include",
      });
      const availData = await availRes.json();
      if (availRes.ok) {
        setAvailability(
          availData as AvailabilityResult & { dailySummary?: DailyAvailabilitySummary }
        );
        const dutyIds = Array.isArray(availData.opsDutyCaddyIds)
          ? (availData.opsDutyCaddyIds as number[])
          : [];
        if (dutyIds.length && draftRef.current) {
          const current = draftRef.current;
          setDraft({
            ...current,
            caddyPool: excludeCaddiesById(current.caddyPool, dutyIds),
          });
        }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "당번 일정 저장 실패");
    } finally {
      setLoadingDutyApply(false);
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
    if (houseStartCaddyId === "" || !Number(houseStartCaddyId)) {
      setError("오늘 1부 첫 캐디를 선택하세요.");
      return;
    }
    setLoadingRun(true);
    setError(null);
    try {
      let caddyPool = pool;
      if (!availability) {
        const availForm = new FormData();
        availForm.append("date", date);
        if (dutyFile) availForm.append("dutyFile", dutyFile);
        const availRes = await fetch("/api/availability", {
          method: "POST",
          body: availForm,
          credentials: "include",
        });
        const availData = await availRes.json();
        if (!availRes.ok) {
          setError(availData.error || "가용 불러오기 실패");
          return;
        }
        setAvailability(availData as AvailabilityResult & { dailySummary?: DailyAvailabilitySummary });
        caddyPool = regularCaddyPoolFromAvailabilityRows(
          availData.available?.all || []
        );
      }

      const form = new FormData();
      form.append("date", date);
      form.append("file", file);
      if (dutyFile) form.append("dutyFile", dutyFile);
      form.append("openCourses", JSON.stringify(openCourseList));
      form.append("houseStartCaddyId", String(houseStartCaddyId));
      if (thirdWeekly?.startTeam) {
        form.append("thirdStartTeam", thirdWeekly.startTeam);
      }
      if (thirdStartCaddyId !== "" && Number(thirdStartCaddyId)) {
        form.append("thirdStartCaddyId", String(thirdStartCaddyId));
      }
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
      setQuickSheet(null);
      setUnavailableCaddyIds([]);
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
      setMoveKey(null);
      setMoveSheetOpen(false);
      setSwapKey(key);
      showToast("순번 바꿈 · 다른 캐디를 탭하세요");
      return;
    }
    if (swapKey === key) {
      setSwapKey(null);
      return;
    }
    const change: LiveChangeInput = {
      type: "SWAP_CADDY",
      reservationKeyA: swapKey,
      reservationKeyB: key,
    };
    setSwapKey(null);
    void applyQuickChange(change);
  }

  function handlePlacementTap(
    row: AutoAssignmentRow,
    mode: "team" | "caddy"
  ) {
    if (moveKey) {
      const key = reservationIdentity(row.reservation);
      if (key === moveKey) {
        setMoveSheetOpen(true);
        setQuickSheet(null);
        return;
      }
      showToast("빈 칸을 탭하거나 직접 입력하세요. 이동 중에는 당추/순번바꿈이 동작하지 않습니다.");
      setQuickSheet(null);
      return;
    }
    if (swapKey) {
      onSwapClick(row);
      setQuickSheet(null);
      return;
    }
    const key = reservationIdentity(row.reservation);
    setExpandedKey(key);
    setQuickSheet({ mode, key });
  }

  const onTeamTap = useCallback(
    (row: AutoAssignmentRow) => {
      handlePlacementTap(row, "team");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [swapKey, moveKey]
  );
  const onCaddyTap = useCallback(
    (row: AutoAssignmentRow) => {
      handlePlacementTap(row, "caddy");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [swapKey, moveKey]
  );

  function onStartTeamMove(row: AutoAssignmentRow) {
    const block = reservationMoveBlockReason(row);
    if (block) {
      setError(block.message);
      showToast(block.message);
      setQuickSheet(null);
      return;
    }
    const key = reservationIdentity(row.reservation);
    if (!isStableReservationMoveKey(key)) {
      const msg =
        "위치가 포함된 예약 키는 이동할 수 없습니다. id가 있는 예약만 이동합니다.";
      setError(msg);
      showToast(msg);
      setQuickSheet(null);
      return;
    }
    setSwapKey(null);
    setMoveKey(key);
    setMoveSheetOpen(true);
    setQuickSheet(null);
    showToast("팀 이동 모드 · 빈 칸을 탭하거나 목적 티타임을 입력하세요");
  }

  function cancelTeamMove() {
    setMoveKey(null);
    setMoveSheetOpen(false);
    showToast("팀 이동을 취소했습니다");
  }

  function onRequestLiveChange(change: LiveChangeInput) {
    if (change.type === "ADD_RESERVATION" || change.type === "MOVE_RESERVATION") {
      setLiveChangePreset(change);
      if (change.type === "MOVE_RESERVATION") setMoveSheetOpen(false);
      return;
    }
    void applyQuickChange(change);
  }

  function onEmptyBoardCellClick(course: CourseCode, teeTime: string) {
    if (!draft || shiftTab === "UNASSIGNED" || shiftTab === "CLOSED") return;
    const change = changeFromEmptyBoardCell({
      date: draft.date,
      course,
      shift: shiftTab,
      teeTime,
      teamName: "당추",
      moveReservationKey: moveKey,
    });
    if (change.type === "MOVE_RESERVATION") {
      setMoveSheetOpen(false);
      setLiveChangePreset(change);
      return;
    }
    const courseLabel = COURSE_LABELS[course];
    const ok = window.confirm(
      `${shiftTab} ${teeTime} ${courseLabel}에 당추를 추가할까요?`
    );
    if (!ok) return;
    setLiveChangePreset(change);
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

  async function persistLivePreview(input: {
    preview: LiveChangePreview;
    previous: AutoAssignResultV1;
    pool: AutoAssignCaddy[];
    successToast?: string;
    applyServerDraft?: boolean;
    rollbackDraft?: AssignmentDraft | null;
  }): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch("/api/assignments/reflow/apply", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previous: input.previous,
          regularCaddyPool: input.pool,
          events: input.preview.events,
          changeType: input.preview.changeType,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (input.rollbackDraft) {
          setDraft(input.rollbackDraft);
          setWarnings(detectDraftWarnings(input.rollbackDraft));
        }
        setError(
          data.error ||
            data.message ||
            "배치 저장 중 오류가 발생했습니다. 다시 시도해주세요."
        );
        showToast("저장 실패 · 이전 상태로 되돌렸습니다");
        return false;
      }
      if (input.applyServerDraft !== false) {
        const current = draftRef.current;
        if (current) {
          const after = (data.preview?.after ||
            input.preview.after) as typeof input.preview.after;
          const next = applyLiveResultToDraft(current, after);
          setDraft(next);
          setWarnings(detectDraftWarnings(next));
          if (autoResultRef.current) {
            setAutoResult({ ...autoResultRef.current, ...after });
          }
        }
      }
      setUnavailableCaddyIds(
        Array.isArray(data.preview?.unavailableCaddyIds)
          ? data.preview.unavailableCaddyIds
          : input.preview.unavailableCaddyIds || []
      );
      if (input.successToast) showToast(input.successToast);
      return true;
    } catch (e: unknown) {
      if (input.rollbackDraft) {
        setDraft(input.rollbackDraft);
        setWarnings(detectDraftWarnings(input.rollbackDraft));
      }
      setError(e instanceof Error ? e.message : "현장 변경 적용 실패");
      showToast("저장 실패 · 이전 상태로 되돌렸습니다");
      return false;
    }
  }

  function quickActionToast(
    change: LiveChangeInput,
    source: AssignmentDraft | null
  ): string {
    if (change.type === "SWAP_CADDY") {
      const a = source?.assignments.find(
        (row) => reservationIdentity(row.reservation) === change.reservationKeyA
      );
      const b = source?.assignments.find(
        (row) => reservationIdentity(row.reservation) === change.reservationKeyB
      );
      return swapOrderToast(a?.caddy.name || "A", b?.caddy.name || "B");
    }
    if (change.type === "SET_LIMOUSINE") {
      return change.limousineCart ? "리무진 ON" : "리무진 OFF";
    }
    if (change.type === "SET_LOCK") {
      return change.locked ? "LOCK ON" : "LOCK OFF";
    }
    return `${LIVE_CHANGE_LABELS[change.type]} 적용`;
  }

  function applyQuickChange(change: LiveChangeInput) {
    const current = draftRef.current;
    if (!current) return;
    if (needsQuickActionConfirm(change.type)) {
      if (!window.confirm(QUICK_ACTION_CONFIRM_MESSAGE)) return;
    }
    const previous = autoResultFromDraft(current, autoResultRef.current);
    const livePool = excludeCaddiesById(current.caddyPool, opsDutyCaddyIds);
    const preview = previewLiveChangeFromDraft({
      draft: { ...current, caddyPool: livePool },
      base: autoResultRef.current,
      change,
    });
    const blocking = preview.warnings.find((w) => w.level === "error");
    if (blocking) {
      setError(blocking.message);
      showToast(blocking.message);
      return;
    }
    const next = applyLiveResultToDraft(current, preview.after);
    setDraft(next);
    setWarnings(detectDraftWarnings(next));
    setUnavailableCaddyIds(preview.unavailableCaddyIds || []);
    if (autoResultRef.current) {
      setAutoResult({ ...autoResultRef.current, ...preview.after });
    }
    showToast(quickActionToast(change, current));
    const gen = persistGenRef.current;
    persistQueueRef.current = persistQueueRef.current.then(async () => {
      if (gen !== persistGenRef.current) return;
      const ok = await persistLivePreview({
        preview,
        previous,
        pool: livePool,
        applyServerDraft: shouldReconcileLivePersist(change.type),
        rollbackDraft: current,
      });
      if (!ok) persistGenRef.current += 1;
    });
  }

  async function onLiveApply(preview: LiveChangePreview) {
    const current = draftRef.current;
    if (!current) return;
    if (hasBlockingLiveChangeError(preview.warnings)) {
      const msg =
        preview.warnings.find((w) => w.level === "error")?.message ||
        "적용할 수 없는 변경입니다.";
      setError(msg);
      showToast(msg);
      return;
    }
    setLoadingLiveApply(true);
    try {
      const ok = await persistLivePreview({
        preview,
        previous: autoResultFromDraft(current, autoResultRef.current),
        pool: excludeCaddiesById(current.caddyPool, opsDutyCaddyIds),
        successToast: "현장 변경 적용 · Reservation/Placement 저장",
        applyServerDraft: true,
      });
      if (ok && preview.changeType === "MOVE_RESERVATION") {
        setMoveKey(null);
        setMoveSheetOpen(false);
      }
    } finally {
      setLoadingLiveApply(false);
    }
  }

  const onToggleLock = useCallback((row: AutoAssignmentRow, locked: boolean) => {
    applyQuickChange({
      type: "SET_LOCK",
      reservationKey: reservationIdentity(row.reservation),
      locked,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const quickSheetRow = useMemo(() => {
    if (!draft || !quickSheet) return null;
    return (
      draft.assignments.find(
        (a) => reservationIdentity(a.reservation) === quickSheet.key
      ) || null
    );
  }, [draft, quickSheet]);

  const moveSourceRow = useMemo(() => {
    if (!draft || !moveKey) return null;
    return (
      draft.assignments.find(
        (a) => reservationIdentity(a.reservation) === moveKey
      ) || null
    );
  }, [draft, moveKey]);

  function toggleCourse(code: CourseCode) {
    setCourseOpen((prev) => ({ ...prev, [code]: !prev[code] }));
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
            onChange={(e) => {
              setDate(e.target.value);
              setHouseStartCaddyId("");
              setThirdStartCaddyId("");
              setAvailability(null);
            }}
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
        <label className="ops-field">
          <span>당번·마샬·조장 Excel (xlsx/xlsm)</span>
          <input
            type="file"
            accept=".xlsx,.xlsm"
            onChange={(e) => {
              setDutyFile(e.target.files?.[0] || null);
              setOpsDutyPreview(null);
            }}
          />
          <div className="ops-duty-actions">
            <button
              type="button"
              className="ghost"
              onClick={previewOpsDutyFile}
              disabled={loadingDutyPreview || !dutyFile}
            >
              {loadingDutyPreview ? "미리보기…" : "일정 미리보기"}
            </button>
            <button
              type="button"
              onClick={applyOpsDutyFile}
              disabled={loadingDutyApply || !dutyFile}
            >
              {loadingDutyApply
                ? "저장…"
                : opsDutyPreview?.replaceRequired
                  ? "이 날짜 일정 교체 저장"
                  : "이 날짜 일정 저장"}
            </button>
          </div>
          {opsDutyStored && (
            <div className="ops-meta">
              서버 저장 {opsDutyStored.count}명
              {opsDutyStored.count > 0
                ? " · 파일 없이 가용/자동배치/reflow에 반영"
                : " · 아직 없음"}
              {opsDutyStored.byRole && opsDutyStored.count > 0 ? (
                <div>
                  조출당번 {opsDutyStored.byRole.DUTY_AM ?? 0} / 후출당번{" "}
                  {opsDutyStored.byRole.DUTY_PM ?? 0} / 조출마샬{" "}
                  {opsDutyStored.byRole.MARSHAL_AM ?? 0} / 후출마샬{" "}
                  {opsDutyStored.byRole.MARSHAL_PM ?? 0} / 조장{" "}
                  {opsDutyStored.byRole.LEADER ?? 0}
                </div>
              ) : null}
            </div>
          )}
          {opsDutyPreview && (
            <div className="ops-daily">
              <div className="ops-daily-title">당번 일정 미리보기</div>
              <ul className="ops-daily-list">
                <li>매칭 {opsDutyPreview.matchedCount}명</li>
                <li>확인 필요 {opsDutyPreview.reviewCount}</li>
                <li>기존 저장 {opsDutyPreview.existingCount}건</li>
              </ul>
              {opsDutyPreview.reviews.length > 0 && (
                <div className="ops-daily-reviews">
                  <ul>
                    {opsDutyPreview.reviews.map((r, i) => (
                      <li key={`${r.rawName}-${i}`}>
                        <strong>{r.rawName}</strong> — {r.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
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
        <label className="ops-field ops-first-caddy">
          <span>오늘 1부 첫 캐디 (필수)</span>
          <select
            value={houseStartCaddyId === "" ? "" : String(houseStartCaddyId)}
            onChange={(e) => {
              const v = e.target.value;
              setHouseStartCaddyId(v ? Number(v) : "");
            }}
            disabled={!availability || houseStartCandidates.length === 0}
          >
            <option value="">
              {!availability
                ? "먼저 가용 캐디를 불러오세요"
                : houseStartCandidates.length === 0
                  ? "선택 가능한 HOUSE 가용 캐디 없음"
                  : "HOUSE 가용 캐디 선택…"}
            </option>
            {houseStartCandidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.team} · {c.teamOrder}번 (id {c.id})
              </option>
            ))}
          </select>
        </label>
        <div className="ops-field ops-third-week">
          <span>
            이번 주 3부반 시작조
            {thirdWeekly?.overridden ? (
              <span className="ops-manual-badge">수동 지정</span>
            ) : null}
          </span>
          <div className="ops-third-week-row">
            <select
              value={thirdWeekly?.startTeam || ""}
              disabled={!date || savingThirdWeekly}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                void persistThirdWeeklyStart(v);
              }}
            >
              <option value="">
                {!date ? "날짜를 선택하세요" : "불러오는 중…"}
              </option>
              {THIRD_BAND_TEAMS.map((team) => (
                <option key={team} value={team}>
                  {team}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn ghost"
              disabled={!thirdWeekly?.overridden || savingThirdWeekly}
              onClick={() => void persistThirdWeeklyStart(null)}
            >
              자동값으로 복원
            </button>
          </div>
          <span className="ops-third-week-hint">
            자동 계산값 {thirdWeekly?.autoStartTeam || "—"} · {thirdWeekly?.weekStart || "—"} 주만 적용
          </span>
        </div>
        <label className="ops-field ops-first-caddy">
          <span>3부 첫 캐디 (선택)</span>
          <select
            value={thirdStartCaddyId === "" ? "" : String(thirdStartCaddyId)}
            onChange={(e) => {
              const v = e.target.value;
              setThirdStartCaddyId(v ? Number(v) : "");
            }}
            disabled={!availability}
          >
            <option value="">
              {!availability
                ? "먼저 가용 캐디를 불러오세요"
                : "선택 안 함 (주간 시작조 첫 가용)"}
            </option>
            {thirdStartCandidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.team} {c.teamOrder}번 · {thirdStartCandidateStatus(c)}
              </option>
            ))}
          </select>
        </label>
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
            disabled={
              !date ||
              !file ||
              loadingRun ||
              houseStartCaddyId === "" ||
              !Number(houseStartCaddyId)
            }
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
        {availability?.dailySummary && (
          <div className="ops-daily" aria-label="당일 가용 요약">
            <div className="ops-daily-title">당일 가용 요약</div>
            <ul className="ops-daily-list">
              <li>재직/기본 가용 {availability.dailySummary.baseAvailable}</li>
              <li>휴무 {availability.dailySummary.off}</li>
              <li>
                조출당번 {availability.dailySummary.dutyAm} / 후출당번{" "}
                {availability.dailySummary.dutyPm}
              </li>
              <li>
                조출마샬 {availability.dailySummary.marshalAm} / 후출마샬{" "}
                {availability.dailySummary.marshalPm}
              </li>
              <li>조장 {availability.dailySummary.leader}</li>
              <li>
                휴무/기타 중복 {availability.dailySummary.duplicateExcluded}명
              </li>
              <li>
                실제 추가 제외{" "}
                {availability.dailySummary.dutyAdditionalExcluded ?? 0}명
              </li>
              <li>확인 필요 {availability.dailySummary.reviewCount}</li>
              <li className="final">
                최종 가용 {availability.dailySummary.finalAvailable}
              </li>
            </ul>
            {(availability.dailySummary.duplicates || []).length > 0 && (
              <div className="ops-daily-reviews">
                <div className="ops-daily-title">중복 상세</div>
                <ul>
                  {availability.dailySummary.duplicates.map((d, i) => (
                    <li key={`${d.name}-${d.role}-${i}`}>
                      <strong>{d.name}</strong> — {d.role} / {d.overlappedWith}{" "}
                      중복
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {availability.dailySummary.reviews.length > 0 && (
              <div className="ops-daily-reviews">
                <div className="ops-daily-title">확인 필요</div>
                <ul>
                  {availability.dailySummary.reviews.map((r, i) => (
                    <li key={`${r.name}-${i}`}>
                      <strong>{r.name}</strong> — {r.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
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
        {autoResult?.specialPlacement?.block && (
          <div className="ops-error">
            {autoResult.specialPlacement.block.message}
            {autoResult.specialPlacement.block.neededCount != null && (
              <>
                {" "}
                (필요 {autoResult.specialPlacement.block.neededCount} / 확보{" "}
                {autoResult.specialPlacement.block.availableCount})
              </>
            )}
            {autoResult.specialPlacement.block.collisions?.length ? (
              <div>
                {autoResult.specialPlacement.block.collisions.map((c, i) => (
                  <div key={`${c.index}-${c.teeTime}-${i}`}>
                    {c.index}번째 {c.course} {c.teeTime}
                    {c.teamName ? ` · ${c.teamName}` : ""}
                    {c.kind ? ` · ${c.kind}` : ""}
                    {c.reason ? ` · ${c.reason}` : ""}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
        <SpecialDutyPanel
          key={date || "no-date"}
          date={date}
          excludedRows={availability?.excluded}
          shift1Options={shift1Options}
        />
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

            {draft.sparesByShift?.length > 0 && (
              <div className="ops-spares-all" aria-label="부별 스페어 현황">
                {SHIFTS.map((s) => {
                  const sp = draft.sparesByShift.find((x) => x.shift === s);
                  return (
                    <div key={s} className="ops-spares-all-col">
                      <div className="ops-spares-all-title">{s} 스페어</div>
                      <div>
                        스페어 1:{" "}
                        {sp?.spare1
                          ? `${sp.spare1.name} / ${sp.spare1.team} / ${sp.spare1.teamOrder}번`
                          : "-"}
                      </div>
                      <div>
                        스페어 2:{" "}
                        {sp?.spare2
                          ? `${sp.spare2.name} / ${sp.spare2.team} / ${sp.spare2.teamOrder}번`
                          : "-"}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {shiftTab !== "UNASSIGNED" && shiftTab !== "CLOSED" && (
              <div className="ops-board-tools">
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
                <button
                  type="button"
                  className="ops-add-team"
                  onClick={() => {
                    if (moveKey) return;
                    setAddTeamOpen(true);
                  }}
                  disabled={!!moveKey}
                >
                  {moveKey ? "이동 중" : "당추 추가"}
                </button>
              </div>
            )}

            {moveKey && moveSourceRow ? (
              <div className="move-mode-banner" role="status">
                <div>
                  <strong>팀 이동 모드</strong>
                  <span>
                    {moveSourceRow.reservation.teamName || "팀"} · 다른 부 탭으로
                    옮겨도 유지됩니다. 빈 칸을 탭하세요.
                  </span>
                </div>
                <button type="button" className="btn tiny ghost" onClick={cancelTeamMove}>
                  이동 취소
                </button>
              </div>
            ) : null}

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
                      {boardRows.map((tr) => (
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
                                  const cellAction = emptyBoardCellAction(moveKey);
                                  const moveDest = cellAction === "move";
                                  return (
                                    <button
                                      key={code}
                                      type="button"
                                      className={`bc-cell empty ${
                                        moveDest ? "move-dest" : "addable"
                                      }`}
                                      role="cell"
                                      aria-label={
                                        moveDest
                                          ? `${shiftTab} ${tr.teeTime} ${COURSE_LABELS[code]} 이동 목적지 선택`
                                          : `${shiftTab} ${tr.teeTime} ${COURSE_LABELS[code]} 당추 추가`
                                      }
                                      onClick={() =>
                                        onEmptyBoardCellClick(code, tr.teeTime)
                                      }
                                    >
                                      {moveDest ? "이동" : "-"}
                                    </button>
                                  );
                                }
                                const primary = cell.rows[0];
                                const marks = boardAssignmentMarks(
                                  primary,
                                  draft.assignments
                                );
                                const special = cell.rows.some(
                                  (r) => r.kind !== "regular"
                                );
                                const active = cell.rows.some(
                                  (r) =>
                                    reservationIdentity(r.reservation) ===
                                      expandedKey ||
                                    reservationIdentity(r.reservation) ===
                                      swapKey ||
                                    reservationIdentity(r.reservation) ===
                                      moveKey
                                );
                                return (
                                  <div
                                    key={code}
                                    className={`bc-cell assigned ${
                                      special ? "special" : ""
                                    }${marks.twoWork ? " two-work" : ""}${
                                      marks.chageun ? " chageun" : ""
                                    }${marks.limousine ? " limo" : ""}${
                                      marks.driving ? " drive" : ""
                                    } ${active ? "active" : ""}`}
                                    role="cell"
                                  >
                                    <BoardAssignedSlots
                                      rows={cell.rows}
                                      allAssignments={draft.assignments}
                                      expandedKey={expandedKey}
                                      swapKey={swapKey}
                                      moveKey={moveKey}
                                      onTeamTap={onTeamTap}
                                      onCaddyTap={onCaddyTap}
                                      onToggleLock={onToggleLock}
                                    />
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}
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
                    const marks = boardAssignmentMarks(
                      row,
                      draft.assignments
                    );
                    const open = expandedKey === key || swapKey === key || moveKey === key;
                    const course =
                      row.reservation.courseLabel ||
                      COURSE_LABELS[row.reservation.course as CourseCode] ||
                      row.reservation.course;
                    return (
                      <li
                        key={key}
                        className={`ops-row ${special ? "special" : ""}${
                          marks.twoWork ? " two-work" : ""
                        }${marks.chageun ? " chageun" : ""}${
                          marks.limousine ? " limo" : ""
                        }${marks.driving ? " drive" : ""} ${
                          swapKey === key ? "swap-on" : ""
                        } ${moveKey === key ? "move-on" : ""} ${open ? "open" : ""}`}
                      >
                        <div className="ops-row-main">
                          <span className="col time">
                            {row.reservation.teeTime}
                          </span>
                          <button
                            type="button"
                            className="col team ops-row-hit"
                            onClick={() => handlePlacementTap(row, "team")}
                          >
                            {row.reservation.teamName || "팀"}
                            {marks.limousine ? (
                              <span className="bc-badge limo">리무진</span>
                            ) : null}
                            {special && !marks.chageun && !marks.driving ? (
                              <em className="tag-s">{row.kind}</em>
                            ) : null}
                          </button>
                          <span className="col course">{course}</span>
                          <button
                            type="button"
                            className="col caddy ops-row-hit"
                            onClick={() => handlePlacementTap(row, "caddy")}
                          >
                            {row.caddy.name}
                            <AssignmentMarkBadges
                              twoWork={marks.twoWork}
                              chageun={marks.chageun}
                              special={special}
                              driving={marks.driving}
                            />
                          </button>
                          <span className="col meta">
                            {row.caddy.team}·{row.caddy.teamOrder}
                          </span>
                          <LockToggle
                            row={row}
                            onToggle={(locked) => onToggleLock(row, locked)}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="ops-spares">
                <div className="ops-spares-title">{shiftTab} 스페어 (현재 계산)</div>
                <div className="ops-spare-line">
                  <span className="lbl">스페어 1</span>
                  {shiftSpare?.spare1 ? (
                    <span>
                      {shiftSpare.spare1.name} / {shiftSpare.spare1.team} /{" "}
                      {shiftSpare.spare1.teamOrder}번
                    </span>
                  ) : (
                    <span className="muted">-</span>
                  )}
                </div>
                <div className="ops-spare-line">
                  <span className="lbl">스페어 2</span>
                  {shiftSpare?.spare2 ? (
                    <span>
                      {shiftSpare.spare2.name} / {shiftSpare.spare2.team} /{" "}
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

      {draft && (
        <LiveChangePanel
          draft={draft}
          previous={autoResultFromDraft(draft, autoResult)}
          applying={loadingLiveApply}
          onApplyPreview={onLiveApply}
          unavailableCaddyIds={unavailableCaddyIds}
          preset={liveChangePreset}
          onPresetConsumed={() => setLiveChangePreset(null)}
          defaultShift={
            shiftTab === "UNASSIGNED" || shiftTab === "CLOSED"
              ? "1부"
              : shiftTab
          }
        />
      )}

      {toast && <div className="ops-toast vh-manage-toast">{toast}</div>}
      {addTeamOpen &&
        draft &&
        shiftTab !== "UNASSIGNED" &&
        shiftTab !== "CLOSED" && (
          <SameDayAddSheet
            key={shiftTab}
            date={draft.date}
            defaultShift={shiftTab}
            onClose={() => setAddTeamOpen(false)}
            onSubmit={(change) => setLiveChangePreset(change)}
          />
        )}
      {quickSheet && quickSheetRow && (
        <BoardQuickSheet
          mode={quickSheet.mode}
          row={quickSheetRow}
          drivingCandidates={drivingCandidates}
          swapSelected={
            swapKey === reservationIdentity(quickSheetRow.reservation)
          }
          onClose={() => setQuickSheet(null)}
          onRequestChange={onRequestLiveChange}
          onSwapClick={() => onSwapClick(quickSheetRow)}
          onStartTeamMove={onStartTeamMove}
        />
      )}
      {moveSheetOpen && moveSourceRow && (
        <TeamMoveSheet
          row={moveSourceRow}
          onClose={() => setMoveSheetOpen(false)}
          onCancelMove={cancelTeamMove}
          onSubmit={(change) => {
            setMoveSheetOpen(false);
            setLiveChangePreset(change);
          }}
        />
      )}

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
  .ops-field select,
  .inline select {
    width: 100%;
    min-height: 40px;
    font-size: 16px; /* iOS zoom prevent */
  }
  .ops-first-caddy {
    margin-top: 4px;
  }
  .ops-third-week {
    margin-top: 4px;
  }
  .ops-third-week-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
  }
  .ops-third-week-hint {
    color: #57534e;
    font-size: 0.78rem;
  }
  .ops-manual-badge {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 7px;
    border-radius: 999px;
    background: #fef3c7;
    color: #92400e;
    font-size: 0.72rem;
    font-weight: 700;
    vertical-align: middle;
  }
  .ops-spares-all {
    display: grid;
    grid-template-columns: 1fr;
    gap: 8px;
    padding: 10px 12px;
    background: #f8faf9;
    border-bottom: 1px solid #e7e5e4;
    font-size: 0.78rem;
    color: #1c1917;
  }
  @media (min-width: 720px) {
    .ops-spares-all {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
  .ops-spares-all-title {
    font-weight: 700;
    margin-bottom: 4px;
    color: #14532d;
  }
  .ops-spares-all-col {
    min-width: 0;
    line-height: 1.45;
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
  .ops-duty-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
  }
  .ops-daily {
    border: 1px solid #e7e5e4;
    background: #fafaf9;
    border-radius: 10px;
    padding: 10px 12px;
    display: grid;
    gap: 8px;
  }
  .ops-daily-title { font-size: 0.78rem; font-weight: 800; color: #1c1917; }
  .ops-daily-list {
    margin: 0; padding: 0; list-style: none;
    display: grid; gap: 3px; font-size: 0.8rem; color: #334155;
  }
  .ops-daily-list .final { font-weight: 800; color: #14532d; }
  .ops-daily-reviews ul {
    margin: 0; padding-left: 18px; font-size: 0.78rem; color: #9a3412;
  }
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
    flex: 1;
  }
  .ops-board-tools {
    display: flex;
    gap: 6px;
    align-items: stretch;
  }
  .ops-add-team {
    min-height: 36px;
    padding: 0 12px;
    border-radius: 8px;
    border: 1px solid #0f172a;
    background: #0f172a;
    color: #fff;
    font-size: 0.8rem;
    font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
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
  button.bc-cell.empty.addable {
    cursor: pointer;
    color: #94a3b8;
  }
  button.bc-cell.empty.addable:hover,
  button.bc-cell.empty.addable:focus-visible {
    background: #f8fafc;
    color: #0f172a;
    outline: 2px solid #0f172a;
    outline-offset: -2px;
  }
  button.bc-cell.empty.move-dest {
    cursor: pointer;
    color: #9a3412;
    font-size: 0.62rem;
    font-weight: 700;
  }
  button.bc-cell.empty.move-dest:hover,
  button.bc-cell.empty.move-dest:focus-visible {
    background: #fff7ed;
    color: #9a3412;
    outline: 2px solid #ea580c;
    outline-offset: -2px;
  }
  .move-mode-banner {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: center;
    padding: 8px 10px;
    border-radius: 10px;
    background: #fff7ed;
    border: 1px solid #fdba74;
    color: #9a3412;
    font-size: 0.82rem;
  }
  .move-mode-banner div {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .move-mode-banner span {
    color: #c2410c;
  }
  .move-preview {
    display: grid;
    gap: 6px;
    padding: 10px;
    border-radius: 10px;
    background: #fff7ed;
    border: 1px solid #fdba74;
  }
  .move-preview-title {
    font-weight: 700;
    color: #9a3412;
  }
  .move-preview-note {
    margin: 0;
    font-size: 0.82rem;
    color: #9a3412;
  }
  .move-preview-warn {
    margin: 0;
    padding: 6px 8px;
    border-radius: 8px;
    background: #7f1d1d;
    color: #fecaca;
    font-weight: 700;
    font-size: 0.82rem;
  }
  .move-preview-list {
    margin: 0;
    padding-left: 18px;
    font-size: 0.82rem;
    color: #0f172a;
  }
  .move-sheet-copy,
  .move-sheet-from {
    margin: 0;
    font-size: 0.8rem;
    color: #64748b;
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
  .bc-cell.assigned {
    background: #fff;
    gap: 4px;
    padding: 3px 1px;
  }
  .bc-cell.assigned.special {
    background: #fffbeb;
  }
  .bc-cell.assigned.two-work {
    background: #f8fafc;
    box-shadow: inset 2px 0 0 #94a3b8;
  }
  .bc-cell.assigned.chageun {
    background: #fffdf6;
    box-shadow: inset 2px 0 0 #d6b37a;
  }
  .bc-cell.assigned.two-work.chageun {
    background: #f8fafc;
    box-shadow: inset 2px 0 0 #94a3b8, inset 0 -2px 0 #d6b37a;
  }
  .bc-cell.assigned.active {
    outline: 2px solid #2563eb;
    outline-offset: -2px;
    z-index: 1;
  }
  .bc-slot {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    width: 100%;
    min-width: 0;
  }
  .bc-slot.swap-on,
  .bc-slot.move-on,
  .bc-slot.active {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
    border-radius: 4px;
  }
  .bc-team,
  .bc-caddy {
    border: 0;
    background: transparent;
    font: inherit;
    color: inherit;
    cursor: pointer;
    width: 100%;
    padding: 1px 2px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    min-height: 22px;
  }
  .bc-team-name {
    font-size: 0.58rem;
    font-weight: 700;
    color: #475569;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bc-caddy .bc-name {
    pointer-events: none;
  }
  .lock-chip {
    font-size: 0.58rem !important;
    padding: 1px 5px !important;
    min-height: 18px !important;
    line-height: 1.1;
    border-radius: 999px;
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
  .bc-marks {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    max-width: 100%;
  }
  .bc-badge {
    display: inline-block;
    font-size: 0.55rem;
    font-weight: 800;
    line-height: 1.15;
    padding: 1px 4px;
    border-radius: 4px;
    letter-spacing: 0;
    white-space: nowrap;
  }
  .bc-badge.two {
    color: #334155;
    background: #e2e8f0;
  }
  .bc-badge.call {
    color: #7c5a1e;
    background: #f4ead6;
  }
  .bc-badge.limo {
    color: #9a3412;
    background: #fb923c;
    box-shadow: 0 0 0 1px #c2410c;
    font-size: 0.6rem;
  }
  .bc-badge.drive {
    color: #fff;
    background: #7c3aed;
  }
  .bc-cell.assigned.limo {
    box-shadow: inset 0 -3px 0 #f59e0b;
  }
  .bc-cell.assigned.drive {
    box-shadow: inset 3px 0 0 #7c3aed;
  }
  .bc-cell.assigned.limo.drive {
    box-shadow: inset 3px 0 0 #7c3aed, inset 0 -3px 0 #f59e0b;
  }
  .ops-row.limo { background: #fff7ed; }
  .ops-row.drive { box-shadow: inset 3px 0 0 #7c3aed; }
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
  .ops-row.special { border-color: #e7d3a8; background: #fffdf8; }
  .ops-row.two-work { box-shadow: inset 3px 0 0 #94a3b8; }
  .ops-row.chageun { box-shadow: inset 3px 0 0 #d6b37a; }
  .ops-row.two-work.chageun {
    box-shadow: inset 3px 0 0 #94a3b8, inset 0 -2px 0 #d6b37a;
  }
  .ops-row.swap-on,
  .ops-row.move-on { outline: 2px solid #2563eb; }
  .ops-row.closed { background: #f8fafc; color: #64748b; }
  .ops-row-main {
    width: 100%;
    display: grid;
    grid-template-columns: 46px minmax(0, 1.3fr) 52px minmax(0, 1fr) 40px auto;
    gap: 4px;
    align-items: center;
    padding: 5px 6px;
    min-height: 32px;
    border: 0;
    background: transparent;
    text-align: left;
    font: inherit;
    color: inherit;
  }
  .ops-row-main.static { cursor: default; }
  .ops-row-hit {
    border: 0;
    background: transparent;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
    padding: 0;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
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
  .ops-row-main .caddy { font-weight: 700; display: inline-flex; align-items: center; gap: 4px; }
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
    background: #0f172a;
    color: #fff;
    padding: 10px 14px;
    border-radius: 999px;
    font-size: 0.85rem;
    text-align: center;
  }
  .live-preview-dock {
    position: fixed;
    left: max(12px, env(safe-area-inset-left, 0px));
    right: max(12px, env(safe-area-inset-right, 0px));
    width: auto;
    max-width: min(560px, calc(100vw - 24px));
    margin: 0 auto;
    bottom: calc(58px + env(safe-area-inset-bottom, 0px) + 58px);
    z-index: 55;
    background: #0f172a;
    color: #fff;
    border-radius: 12px;
    padding: 10px 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.28);
  }
  .live-preview-dock-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .live-preview-dock-copy span {
    color: #cbd5e1;
    font-size: 0.75rem;
  }
  .live-preview-dock-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
  @media (min-width: 960px) {
    .live-preview-dock {
      bottom: 24px;
    }
  }
  .live-change {
    border: 1px solid #cbd5e1;
    border-radius: 12px;
    padding: 10px 12px;
    background: #fff;
    display: grid;
    gap: 10px;
  }
  .live-change.is-collapsed {
    padding: 8px 12px;
    gap: 0;
  }
  .live-advanced-toggle {
    width: 100%;
    min-height: 44px;
    border: 1px solid #cbd5e1;
    border-radius: 10px;
    background: #f8fafc;
    color: #0f172a;
    font-size: 0.9rem;
    font-weight: 700;
  }
  .live-change-head {
    display: grid;
    gap: 2px;
  }
  .live-change-head span {
    color: #64748b;
    font-size: 0.8rem;
  }
  .live-change-grid {
    display: grid;
    gap: 8px;
  }
  .live-change-grid label {
    display: grid;
    gap: 4px;
    font-size: 0.8rem;
    color: #334155;
  }
  .live-change-grid select,
  .live-change-grid input {
    min-height: 40px;
    font-size: 16px;
  }
  .live-swap-hint {
    margin: 0;
    color: #64748b;
    font-size: 0.78rem;
    line-height: 1.4;
  }
  .live-change-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .live-preview {
    border: 1px dashed #94a3b8;
    border-radius: 8px;
    padding: 10px;
    background: #f8fafc;
    display: grid;
    gap: 6px;
    font-size: 0.8rem;
  }
  .live-preview-title {
    font-weight: 700;
  }
  .live-preview-warn {
    margin: 0;
    padding-left: 18px;
    color: #b45309;
  }
  .live-preview-warn .error {
    color: #b91c1c;
    font-weight: 700;
  }
  .same-day-add-form label {
    display: grid;
    gap: 4px;
    font-size: 0.8rem;
    color: #334155;
  }
  .same-day-add-form input,
  .same-day-add-form select {
    min-height: 40px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    padding: 6px 8px;
    font: inherit;
  }
  .same-day-add-form input[readonly] {
    background: #f8fafc;
    color: #64748b;
  }
  .live-preview-diff {
    margin: 0;
    padding-left: 18px;
    max-height: 220px;
    overflow: auto;
  }
  .live-preview-lock,
  .live-preview-unassigned {
    color: #334155;
  }
  .live-row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .qa-overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.45);
    z-index: 80;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }
  .qa-sheet {
    width: 100%;
    max-width: 480px;
    background: #fff;
    border-radius: 16px 16px 0 0;
    padding: 12px 14px 24px;
    max-height: 80vh;
    overflow: auto;
    box-shadow: 0 -8px 24px rgba(15, 23, 42, 0.18);
  }
  .qa-sheet-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  .qa-actions {
    display: grid;
    gap: 8px;
  }
  .qa-actions .btn {
    min-height: 44px;
  }
  .qa-empty {
    padding: 10px 8px;
    color: #64748b;
    font-size: 0.85rem;
    background: #f8fafc;
    border-radius: 8px;
  }
`;
