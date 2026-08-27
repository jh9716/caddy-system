"use client";

import { useEffect, useMemo, useState } from "react";
import {
  COURSE_CODES,
  COURSE_LABELS,
  SHIFT_PARTS,
  type CourseCode,
  type ShiftPart,
} from "@/lib/reservationParser";
import {
  hasBlockingLiveChangeError,
  isLiveChangeReady,
  LIVE_CHANGE_LABELS,
  makeAddReservation,
  makeAddReservationChange,
  makeMoveReservationChange,
  previewLiveChangeFromDraft,
  type LiveChangeInput,
  type LiveChangePreview,
  type LiveChangeType,
} from "@/lib/assignmentChange";
import {
  isPlacementLocked,
  reservationIdentity,
  type AssignmentDraft,
} from "@/lib/assignmentDraft";
import {
  isDrivingPlacement,
  drivingCandidateCaddies,
  type AutoAssignCaddy,
  type AutoAssignResultV1,
  type AutoAssignmentRow,
} from "@/lib/autoAssignEngine";
import {
  courseLabelKo,
  parseMoveDestination,
  reservationMoveBlockReason,
  summarizeReservationMove,
} from "@/lib/reservationMove";
import { formatCaddyLabel } from "@/lib/caddyDisplay";

type Props = {
  draft: AssignmentDraft;
  previous: AutoAssignResultV1;
  onApplyPreview: (preview: LiveChangePreview) => Promise<void> | void;
  applying?: boolean;
  preset?: LiveChangeInput | null;
  onPresetConsumed?: () => void;
  unavailableCaddyIds?: number[];
  /** 추가팀 폼의 부 기본값. 현재 보드 탭을 넘기면 무조건 1부가 되지 않는다. */
  defaultShift?: ShiftPart;
  onResetDraft?: () => void;
  /** 관리 도구 · 현재 조건으로 순번 재계산 (기존 자동배치 실행). */
  onRecalcOrder?: () => void;
  specialSupportByShift?: Record<ShiftPart, AutoAssignCaddy[]>;
};

export function LiveChangePanel({
  draft,
  previous,
  onApplyPreview,
  applying,
  preset,
  onPresetConsumed,
  unavailableCaddyIds,
  defaultShift = "1부",
  onResetDraft,
  onRecalcOrder,
  specialSupportByShift,
}: Props) {
  const [changeType, setChangeType] = useState<LiveChangeType>("CANCEL_RESERVATION");
  const [reservationKeyValue, setReservationKeyValue] = useState("");
  const [caddyId, setCaddyId] = useState<number | "">("");
  const [swapA, setSwapA] = useState("");
  const [swapB, setSwapB] = useState("");
  const [limousineOn, setLimousineOn] = useState(true);
  const [lockOn, setLockOn] = useState(true);
  const [addCourse, setAddCourse] = useState<CourseCode>("VERTHILL");
  const [addShift, setAddShift] = useState<ShiftPart>(defaultShift);
  const [addTeeTime, setAddTeeTime] = useState("07:00");
  const [addTeamName, setAddTeamName] = useState("추가팀");
  const [sickShift, setSickShift] = useState<ShiftPart>(defaultShift);
  const [moveCourse, setMoveCourse] = useState<CourseCode>("VERTHILL");
  const [moveShift, setMoveShift] = useState<ShiftPart>(defaultShift);
  const [moveTeeTime, setMoveTeeTime] = useState("");
  const [preview, setPreview] = useState<LiveChangePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adminToolsOpen, setAdminToolsOpen] = useState(false);

  const assignedOptions = useMemo(
    () =>
      [...draft.assignments].map((row) => ({
        key: reservationIdentity(row.reservation),
        label: `${row.reservation.shift} ${row.reservation.teeTime} ${COURSE_LABELS[row.reservation.course as CourseCode] || row.reservation.course} · ${formatCaddyLabel(row.caddy)}`,
        row,
      })),
    [draft.assignments]
  );

  const assignedCaddies = useMemo(() => {
    const map = new Map<number, AutoAssignCaddy>();
    for (const row of draft.assignments) {
      if (!map.has(row.caddy.id)) map.set(row.caddy.id, row.caddy);
    }
    return [...map.values()];
  }, [draft.assignments]);

  const shift3Options = useMemo(
    () => assignedOptions.filter((o) => String(o.row.reservation.shift) === "3부"),
    [assignedOptions]
  );
  const drivingCandidates = useMemo(
    () =>
      drivingCandidateCaddies({
        pool: draft.caddyPool,
        assignedCaddyIds: draft.assignments.map((a) => a.caddy.id),
        unavailableCaddyIds,
      }),
    [draft, unavailableCaddyIds]
  );

  useEffect(() => {
    setAddShift(defaultShift);
  }, [defaultShift]);

  useEffect(() => {
    if (!preset) return;
    setChangeType(preset.type);
    setReservationKeyValue(preset.reservationKey || "");
    setCaddyId(preset.caddyId || "");
    if (preset.shift) setSickShift(preset.shift);
    setSwapA(preset.reservationKeyA || "");
    setSwapB(preset.reservationKeyB || "");
    setLimousineOn(preset.limousineCart !== false);
    setLockOn(preset.locked !== false);
    if (preset.type === "ADD_RESERVATION" && preset.addReservation) {
      const add = preset.addReservation;
      const course = String(add.course || "").toUpperCase() as CourseCode;
      if ((COURSE_CODES as readonly string[]).includes(course)) {
        setAddCourse(course);
      }
      const shift = String(add.shift || "") as ShiftPart;
      if ((SHIFT_PARTS as readonly string[]).includes(shift)) {
        setAddShift(shift);
      }
      if (add.teeTime) setAddTeeTime(add.teeTime);
      setAddTeamName(add.teamName || "추가팀");
    }
    if (preset.type === "MOVE_RESERVATION" && preset.to) {
      const dest = parseMoveDestination(preset.to);
      if (dest) {
        setMoveCourse(dest.course);
        setMoveShift(dest.shift);
        setMoveTeeTime(dest.teeTime);
      }
    }
    setError(null);
    if (isLiveChangeReady(preset)) {
      const next = previewLiveChangeFromDraft({
        draft,
        base: previous,
        change: preset,
        specialSupportByShift,
      });
      setPreview(next);
    } else {
      setPreview(null);
    }
    onPresetConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  function buildChange(): LiveChangeInput | null {
    if (changeType === "CANCEL_RESERVATION" || changeType === "TEAM_NOSHOW") {
      if (!reservationKeyValue) return null;
      return { type: changeType, reservationKey: reservationKeyValue };
    }
    if (changeType === "CADDY_SICK" || changeType === "CADDY_ATTENDANCE_NOSHOW") {
      if (!caddyId) return null;
      return {
        type: changeType,
        caddyId: Number(caddyId),
        ...(changeType === "CADDY_SICK" ? { shift: sickShift } : {}),
      };
    }
    if (changeType === "ADD_RESERVATION") {
      if (!/^\d{2}:\d{2}$/.test(addTeeTime)) return null;
      return {
        type: "ADD_RESERVATION",
        addReservation: makeAddReservation({
          date: draft.date,
          course: addCourse,
          shift: addShift,
          teeTime: addTeeTime,
          teamName: addTeamName || "추가팀",
        }),
      };
    }
    if (changeType === "SWAP_CADDY") {
      if (!swapA || !swapB || swapA === swapB) return null;
      return {
        type: "SWAP_CADDY",
        reservationKeyA: swapA,
        reservationKeyB: swapB,
      };
    }
    if (changeType === "SET_LIMOUSINE") {
      if (!reservationKeyValue) return null;
      return {
        type: "SET_LIMOUSINE",
        reservationKey: reservationKeyValue,
        limousineCart: limousineOn,
      };
    }
    if (changeType === "ASSIGN_DRIVING") {
      if (!reservationKeyValue || !caddyId) return null;
      return {
        type: "ASSIGN_DRIVING",
        reservationKey: reservationKeyValue,
        caddyId: Number(caddyId),
      };
    }
    if (changeType === "CLEAR_DRIVING") {
      if (!reservationKeyValue) return null;
      return { type: "CLEAR_DRIVING", reservationKey: reservationKeyValue };
    }
    if (changeType === "SET_LOCK") {
      if (!reservationKeyValue) return null;
      return {
        type: "SET_LOCK",
        reservationKey: reservationKeyValue,
        locked: lockOn,
      };
    }
    if (changeType === "MOVE_RESERVATION") {
      if (!reservationKeyValue || !/^\d{2}:\d{2}$/.test(moveTeeTime)) return null;
      return makeMoveReservationChange({
        reservationKey: reservationKeyValue,
        to: { course: moveCourse, shift: moveShift, teeTime: moveTeeTime },
      });
    }
    return null;
  }

  function previewSwap(reservationKeyA: string, reservationKeyB: string) {
    setError(null);
    if (!reservationKeyA || !reservationKeyB || reservationKeyA === reservationKeyB) {
      setPreview(null);
      return;
    }
    setPreview(
      previewLiveChangeFromDraft({
        draft,
        base: previous,
        change: {
          type: "SWAP_CADDY",
          reservationKeyA,
          reservationKeyB,
        },
        specialSupportByShift,
      })
    );
  }

  function onReflow() {
    if (onRecalcOrder) {
      onRecalcOrder();
      return;
    }
    setError(null);
    const change = buildChange();
    if (!change) {
      setError("변경 대상을 선택하세요.");
      return;
    }
    const next = previewLiveChangeFromDraft({
      draft,
      base: previous,
      change,
      specialSupportByShift,
    });
    setPreview(next);
  }

  function onCancelPreview() {
    setPreview(null);
    setError(null);
  }

  const blockingError = hasBlockingLiveChangeError(preview?.warnings);
  const canApply = !!preview && !applying && !blockingError;

  async function onApply() {
    if (!preview || blockingError) return;
    setError(null);
    await onApplyPreview(preview);
    setPreview(null);
  }

  return (
    <section
      className={`admin-tools ${adminToolsOpen ? "is-open" : "is-collapsed"}`}
      aria-label="관리 도구"
    >
      <button
        type="button"
        className="admin-tools-toggle"
        aria-expanded={adminToolsOpen}
        onClick={() => setAdminToolsOpen((open) => !open)}
      >
        관리 도구 {adminToolsOpen ? "▴" : "▾"}
      </button>

      {adminToolsOpen && (
        <div className="admin-tools-body">
          <p className="admin-tools-hint">
            현재 조건으로 캐디 순번을 다시 계산합니다
          </p>
          <div className="admin-tools-actions">
            <button type="button" className="btn ghost" onClick={onReflow}>
              배치 다시 맞추기
            </button>
            {onResetDraft ? (
              <button
                type="button"
                className="btn danger"
                onClick={() => onResetDraft()}
              >
                작업본 초기화
              </button>
            ) : null}
          </div>
          {onResetDraft ? (
            <p className="admin-tools-hint">
              저장된 작업본만 지웁니다. 이미 적용된 예약·배치는 남습니다.
            </p>
          ) : null}
        </div>
      )}

      {error && <div className="ops-error">{error}</div>}

      {preview && preview.changeType === "MOVE_RESERVATION" && (
        <MovePreviewBlock preview={preview} />
      )}

      {preview && (
        <div className="live-preview-dock" role="status">
          <div className="live-preview-dock-copy">
            <strong>{LIVE_CHANGE_LABELS[preview.changeType]} 미리보기</strong>
            <span>아직 저장되지 않음 · 이대로 적용 시에만 DB 반영</span>
          </div>
          <div className="live-preview-dock-actions">
            <button type="button" className="btn ghost" onClick={onCancelPreview}>
              취소
            </button>
            <button
              type="button"
              className="btn apply"
              disabled={!canApply}
              onClick={() => void onApply()}
            >
              {applying ? "적용 중…" : "이대로 적용"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function SameDayAddSheet({
  date,
  defaultShift,
  onClose,
  onSubmit,
}: {
  date: string;
  defaultShift: ShiftPart;
  onClose: () => void;
  onSubmit: (change: LiveChangeInput) => void;
}) {
  const [shift, setShift] = useState<ShiftPart>(defaultShift);
  const [course, setCourse] = useState<CourseCode>("VERTHILL");
  const [teeTime, setTeeTime] = useState("");
  const [teamName, setTeamName] = useState("추가팀");
  const [formError, setFormError] = useState<string | null>(null);

  function submit() {
    if (!/^\d{2}:\d{2}$/.test(teeTime)) {
      setFormError("티타임은 HH:MM 형식으로 입력하세요.");
      return;
    }
    onSubmit(
      makeAddReservationChange({
        date,
        course,
        shift,
        teeTime,
        teamName: teamName.trim() || "추가팀",
      })
    );
    onClose();
  }

  return (
    <div className="qa-overlay" role="presentation" onClick={onClose}>
      <div
        className="qa-sheet"
        role="dialog"
        aria-label="추가팀 등록"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="qa-sheet-head">
          <strong>추가팀 등록</strong>
          <button type="button" className="btn tiny ghost" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="qa-actions same-day-add-form">
          <label>
            날짜
            <input value={date} readOnly />
          </label>
          <label>
            부
            <select
              value={shift}
              onChange={(e) => setShift(e.target.value as ShiftPart)}
            >
              {SHIFT_PARTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            코스
            <select
              value={course}
              onChange={(e) => setCourse(e.target.value as CourseCode)}
            >
              {COURSE_CODES.map((c) => (
                <option key={c} value={c}>
                  {COURSE_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <label>
            티타임
            <input
              value={teeTime}
              onChange={(e) => setTeeTime(e.target.value)}
              placeholder="11:00"
              inputMode="numeric"
            />
          </label>
          <label>
            팀명
            <input
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
            />
          </label>
          {formError && <div className="ops-error">{formError}</div>}
          <button type="button" className="btn primary" onClick={submit}>
            미리보기
          </button>
        </div>
      </div>
    </div>
  );
}

export function LockToggle({
  row,
  onToggle,
}: {
  row: AutoAssignmentRow;
  onToggle: (locked: boolean) => void;
}) {
  const locked = isPlacementLocked(row);
  return (
    <button
      type="button"
      className={`btn tiny lock-chip ${locked ? "apply" : "ghost"}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(!locked);
      }}
      title={locked ? "LOCK ON — 탭하면 즉시 OFF" : "일반 — 탭하면 즉시 LOCK ON"}
    >
      {locked ? "🔒 LOCK" : "🔓 일반"}
    </button>
  );
}

export function RowLiveActions({
  row,
  swapSelected,
  drivingCandidates,
  onRequestChange,
  onSwapClick,
}: {
  row: AutoAssignmentRow;
  swapSelected: boolean;
  drivingCandidates: AutoAssignCaddy[];
  onRequestChange: (change: LiveChangeInput) => void;
  onSwapClick: () => void;
}) {
  const key = reservationIdentity(row.reservation);
  const limo = row.reservation.limousineCart === true;
  const driving = isDrivingPlacement(row);
  const shift3 = String(row.reservation.shift) === "3부";
  const locked = isPlacementLocked(row);
  return (
    <div className="live-row-actions">
      <button
        type="button"
        className={`btn tiny ${limo ? "apply" : "ghost"}`}
        onClick={() =>
          onRequestChange({
            type: "SET_LIMOUSINE",
            reservationKey: key,
            limousineCart: !limo,
          })
        }
      >
        리무진 {limo ? "OFF" : "ON"}
      </button>
      {shift3 && !driving && (
        <label className="inline">
          드라이빙
          {drivingCandidates.length === 0 ? (
            <span className="muted">등록된 드라이빙 캐디가 없습니다</span>
          ) : (
            <select
              defaultValue=""
              onChange={(e) => {
                const id = Number(e.target.value);
                if (!id) return;
                onRequestChange({
                  type: "ASSIGN_DRIVING",
                  reservationKey: key,
                  caddyId: id,
                });
                e.target.value = "";
              }}
            >
              <option value="">캐디 선택</option>
              {drivingCandidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {formatCaddyLabel(c)}
                </option>
              ))}
            </select>
          )}
        </label>
      )}
      {driving && (
        <button
          type="button"
          className="btn tiny ghost"
          onClick={() =>
            onRequestChange({ type: "CLEAR_DRIVING", reservationKey: key })
          }
        >
          드라이빙 해제
        </button>
      )}
      <button type="button" className="btn tiny" onClick={onSwapClick}>
        {swapSelected ? "상대 캐디를 탭하세요" : "순번 바꿈"}
      </button>
      <LockToggle
        row={row}
        onToggle={(next) =>
          onRequestChange({
            type: "SET_LOCK",
            reservationKey: key,
            locked: next,
          })
        }
      />
      <button
        type="button"
        className="btn tiny ghost"
        onClick={() =>
          onRequestChange({
            type: "CANCEL_RESERVATION",
            reservationKey: key,
          })
        }
      >
        예약 취소
      </button>
      <button
        type="button"
        className="btn tiny ghost"
        onClick={() =>
          onRequestChange({
            type: "TEAM_NOSHOW",
            reservationKey: key,
          })
        }
      >
        팀 노쇼
      </button>
      <button
        type="button"
        className="btn tiny ghost"
        onClick={() =>
          onRequestChange({
            type: "CADDY_SICK",
            caddyId: row.caddy.id,
            shift: row.shift,
          })
        }
      >
        병가
      </button>
      <button
        type="button"
        className="btn tiny ghost"
        onClick={() =>
          onRequestChange({
            type: "CADDY_ATTENDANCE_NOSHOW",
            caddyId: row.caddy.id,
          })
        }
      >
        캐디 결근
      </button>
    </div>
  );
}

export function BoardQuickSheet({
  mode,
  row,
  drivingCandidates,
  swapSelected,
  onClose,
  onRequestChange,
  onSwapClick,
  onStartTeamMove,
}: {
  mode: "team" | "caddy";
  row: AutoAssignmentRow;
  drivingCandidates: AutoAssignCaddy[];
  swapSelected: boolean;
  onClose: () => void;
  onRequestChange: (change: LiveChangeInput) => void;
  onSwapClick: () => void;
  onStartTeamMove: (row: AutoAssignmentRow) => void;
}) {
  const key = reservationIdentity(row.reservation);
  const limo = row.reservation.limousineCart === true;
  const driving = isDrivingPlacement(row);
  const shift3 = String(row.reservation.shift) === "3부";
  const locked = isPlacementLocked(row);
  const teamName = String(row.reservation.teamName || "").trim();
  const teamTitle = teamName ? `${teamName} 팀` : "팀";
  function fire(change: LiveChangeInput) {
    onRequestChange(change);
    onClose();
  }
  return (
    <div className="qa-overlay" role="presentation" onClick={onClose}>
      <div
        className="qa-sheet"
        role="dialog"
        aria-label={mode === "team" ? teamTitle : formatCaddyLabel(row.caddy)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="qa-sheet-head">
          <div className="qa-sheet-title">
            <strong className="qa-title">
              {mode === "team" ? teamTitle : formatCaddyLabel(row.caddy)}
            </strong>
            <span className="qa-sub">
              {row.reservation.shift} {row.reservation.teeTime}
            </span>
          </div>
          <button type="button" className="btn tiny ghost" onClick={onClose}>
            닫기
          </button>
        </div>
        {mode === "team" ? (
          <div className="qa-actions qa-team-actions">
            <button
              type="button"
              className="btn"
              onClick={() => onStartTeamMove(row)}
            >
              팀 이동
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                fire({ type: "CANCEL_RESERVATION", reservationKey: key })
              }
            >
              예약 취소
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => fire({ type: "TEAM_NOSHOW", reservationKey: key })}
            >
              노쇼
            </button>
            <button
              type="button"
              className={`btn ${limo ? "apply" : ""}`}
              onClick={() =>
                fire({
                  type: "SET_LIMOUSINE",
                  reservationKey: key,
                  limousineCart: !limo,
                })
              }
            >
              리무진 {limo ? "OFF" : "ON"}
            </button>
            {shift3 && !driving && (
              drivingCandidates.length === 0 ? (
                <div className="qa-empty">등록된 드라이빙 캐디가 없습니다</div>
              ) : (
                <label className="inline">
                  드라이빙 지정
                  <select
                    defaultValue=""
                    onChange={(e) => {
                      const id = Number(e.target.value);
                      if (!id) return;
                      fire({
                        type: "ASSIGN_DRIVING",
                        reservationKey: key,
                        caddyId: id,
                      });
                    }}
                  >
                    <option value="">선택</option>
                    {drivingCandidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {formatCaddyLabel(c)}
                      </option>
                    ))}
                  </select>
                </label>
              )
            )}
            {driving && (
              <button
                type="button"
                className="btn ghost"
                onClick={() =>
                  fire({ type: "CLEAR_DRIVING", reservationKey: key })
                }
              >
                드라이빙 해제
              </button>
            )}
            <button
              type="button"
              className="btn"
              onClick={() =>
                fire({ type: "SET_LOCK", reservationKey: key, locked: !locked })
              }
            >
              {locked ? "LOCK OFF" : "LOCK ON"}
            </button>
          </div>
        ) : (
          <div className="qa-actions qa-caddy-actions">
            <button
              type="button"
              className="btn"
              onClick={() =>
                fire({
                  type: "CADDY_SICK",
                  caddyId: row.caddy.id,
                  shift: row.shift,
                })
              }
            >
              병가
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                fire({
                  type: "CADDY_ATTENDANCE_NOSHOW",
                  caddyId: row.caddy.id,
                })
              }
            >
              결근
            </button>
            <button
              type="button"
              className={`btn ${swapSelected ? "apply" : ""}`}
              onClick={() => {
                onSwapClick();
                onClose();
              }}
            >
              {swapSelected ? "상대 캐디를 탭하세요" : "순번 바꿈"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MovePreviewBlock({ preview }: { preview: LiveChangePreview }) {
  if (preview.changeType !== "MOVE_RESERVATION") return null;
  const event = preview.events.find((e) => e.type === "MOVE_RESERVATION");
  if (!event || event.type !== "MOVE_RESERVATION") return null;
  const move = summarizeReservationMove({
    before: preview.before,
    after: preview.after,
    event,
    warnings: preview.warnings,
    placementDiffs: preview.placementDiffs,
  });
  if (!move) return null;
  const freezeLabel =
    move.freezeShifts.length > 0 ? move.freezeShifts.join(" · ") : "없음 (전부 재계산)";
  return (
    <div className="move-preview" role="status">
      <div className="move-preview-title">팀 이동 미리보기</div>
      <p className="move-preview-note">
        기존 캐디는 팀과 함께 이동하지 않으며, 아래 캐디는 순번 재계산 결과입니다.
      </p>
      {move.fullDayWarning ? (
        <p className="move-preview-warn">
          1부 이동으로 인해 1·2·3부 캐디 순번이 재계산됩니다.
        </p>
      ) : null}
      <ul className="move-preview-list">
        <li>팀명 {move.teamName || "-"}</li>
        <li>
          기존 {courseLabelKo(move.from.course)} {move.from.shift} {move.from.teeTime}
        </li>
        <li>
          목적 {courseLabelKo(move.to.course)} {move.to.shift} {move.to.teeTime}
        </li>
        <li>
          기존 캐디 {move.beforeCaddy ? formatCaddyLabel(move.beforeCaddy) : "미배치"}
        </li>
        <li>
          이동 후 캐디 {move.afterCaddy ? formatCaddyLabel(move.afterCaddy) : "미배치"}
          {move.sameCaddyBySequence ? " · 순번 결과 동일" : ""}
        </li>
        <li>reflow {move.reflowShifts.join(" · ")}</li>
        <li>고정되는 부 {freezeLabel}</li>
        <li>변경되는 placement {move.placementChangeCount}건</li>
      </ul>
    </div>
  );
}

export function TeamMoveSheet({
  row,
  onClose,
  onCancelMove,
  onSubmit,
}: {
  row: AutoAssignmentRow;
  onClose: () => void;
  onCancelMove: () => void;
  onSubmit: (change: LiveChangeInput) => void;
}) {
  const fromShift =
    (SHIFT_PARTS as readonly string[]).includes(String(row.shift))
      ? (row.shift as ShiftPart)
      : "1부";
  const fromCourse = String(row.reservation.course || "").toUpperCase() as CourseCode;
  const [shift, setShift] = useState<ShiftPart>(fromShift);
  const [course, setCourse] = useState<CourseCode>(
    (COURSE_CODES as readonly string[]).includes(fromCourse) ? fromCourse : "VERTHILL"
  );
  const [teeTime, setTeeTime] = useState(row.reservation.teeTime || "");
  const [formError, setFormError] = useState<string | null>(null);
  const block = reservationMoveBlockReason(row);

  function submit() {
    if (block) {
      setFormError(block.message);
      return;
    }
    if (!/^\d{2}:\d{2}$/.test(teeTime)) {
      setFormError("티타임은 HH:MM 형식으로 입력하세요.");
      return;
    }
    onSubmit(
      makeMoveReservationChange({
        reservationKey: reservationIdentity(row.reservation),
        reservationId: row.reservation.id,
        to: { course, shift, teeTime },
      })
    );
  }

  return (
    <div className="qa-overlay" role="presentation" onClick={onClose}>
      <div
        className="qa-sheet"
        role="dialog"
        aria-label="팀 이동"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="qa-sheet-head">
          <strong>팀 이동 · {row.reservation.teamName || "팀"}</strong>
          <button type="button" className="btn tiny ghost" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="qa-actions same-day-add-form">
          <p className="move-sheet-copy">
            기본은 보드 빈 칸을 탭하세요. 보드에 없는 티타임만 직접 입력합니다.
          </p>
          <p className="move-sheet-from">
            현재 {courseLabelKo(String(row.reservation.course))} {row.shift}{" "}
            {row.reservation.teeTime}
          </p>
          <label>
            목적 부
            <select
              value={shift}
              onChange={(e) => setShift(e.target.value as ShiftPart)}
            >
              {SHIFT_PARTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            목적 코스
            <select
              value={course}
              onChange={(e) => setCourse(e.target.value as CourseCode)}
            >
              {COURSE_CODES.map((c) => (
                <option key={c} value={c}>
                  {COURSE_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <label>
            목적 티타임
            <input
              value={teeTime}
              onChange={(e) => setTeeTime(e.target.value)}
              placeholder="HH:MM"
              inputMode="numeric"
            />
          </label>
          {block ? <div className="ops-error">{block.message}</div> : null}
          {formError ? <div className="ops-error">{formError}</div> : null}
          <button type="button" className="btn primary" onClick={submit} disabled={!!block}>
            미리보기
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            보드에서 빈 칸 선택
          </button>
          <button type="button" className="btn ghost" onClick={onCancelMove}>
            이동 취소
          </button>
        </div>
      </div>
    </div>
  );
}

