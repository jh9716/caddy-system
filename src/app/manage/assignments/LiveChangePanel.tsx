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
  LIVE_CHANGE_LABELS,
  LIVE_CHANGE_TYPES,
  makeAddReservation,
  previewLiveAssignmentChange,
  type LiveChangeInput,
  type LiveChangePreview,
  type LiveChangeType,
} from "@/lib/assignmentChange";
import {
  isPlacementLocked,
  reservationIdentity,
  unusedCaddies,
  type AssignmentDraft,
} from "@/lib/assignmentDraft";
import {
  isDrivingPlacement,
  reservationKey,
  type AutoAssignCaddy,
  type AutoAssignResultV1,
  type AutoAssignmentRow,
} from "@/lib/autoAssignEngine";

type Props = {
  draft: AssignmentDraft;
  previous: AutoAssignResultV1;
  onApplyPreview: (preview: LiveChangePreview) => Promise<void> | void;
  applying?: boolean;
  preset?: LiveChangeInput | null;
  onPresetConsumed?: () => void;
};

export function LiveChangePanel({
  draft,
  previous,
  onApplyPreview,
  applying,
  preset,
  onPresetConsumed,
}: Props) {
  const [changeType, setChangeType] = useState<LiveChangeType>("CANCEL_RESERVATION");
  const [reservationKeyValue, setReservationKeyValue] = useState("");
  const [caddyId, setCaddyId] = useState<number | "">("");
  const [swapA, setSwapA] = useState("");
  const [swapB, setSwapB] = useState("");
  const [limousineOn, setLimousineOn] = useState(true);
  const [addCourse, setAddCourse] = useState<CourseCode>("VERTHILL");
  const [addShift, setAddShift] = useState<ShiftPart>("1부");
  const [addTeeTime, setAddTeeTime] = useState("07:00");
  const [addTeamName, setAddTeamName] = useState("당추");
  const [preview, setPreview] = useState<LiveChangePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const assignedOptions = useMemo(
    () =>
      [...draft.assignments].map((row) => ({
        key: reservationIdentity(row.reservation),
        label: `${row.reservation.shift} ${row.reservation.teeTime} ${COURSE_LABELS[row.reservation.course as CourseCode] || row.reservation.course} · ${row.caddy.name}`,
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
  const freeCaddies = useMemo(() => unusedCaddies(draft), [draft]);

  useEffect(() => {
    if (!preset) return;
    setChangeType(preset.type);
    setReservationKeyValue(preset.reservationKey || "");
    setCaddyId(preset.caddyId || "");
    setSwapA(preset.reservationKeyA || "");
    setSwapB(preset.reservationKeyB || "");
    setLimousineOn(preset.limousineCart !== false);
    setError(null);
    const eventsReady =
      (preset.type === "CANCEL_RESERVATION" && !!preset.reservationKey) ||
      (preset.type === "TEAM_NOSHOW" && !!preset.reservationKey) ||
      (preset.type === "CADDY_SICK" && !!preset.caddyId) ||
      (preset.type === "CADDY_ATTENDANCE_NOSHOW" && !!preset.caddyId) ||
      (preset.type === "SWAP_CADDY" &&
        !!preset.reservationKeyA &&
        !!preset.reservationKeyB) ||
      (preset.type === "SET_LIMOUSINE" && !!preset.reservationKey) ||
      (preset.type === "ASSIGN_DRIVING" &&
        !!preset.reservationKey &&
        !!preset.caddyId) ||
      (preset.type === "CLEAR_DRIVING" && !!preset.reservationKey);
    if (eventsReady) {
      const next = previewLiveAssignmentChange({
        previous,
        regularCaddyPool: draft.caddyPool,
        change: preset,
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
      return { type: changeType, caddyId: Number(caddyId) };
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
          teamName: addTeamName || "당추",
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
    return null;
  }

  function onReflow() {
    setError(null);
    const change = buildChange();
    if (!change) {
      setError("변경 대상을 선택하세요.");
      return;
    }
    const next = previewLiveAssignmentChange({
      previous,
      regularCaddyPool: draft.caddyPool,
      change,
    });
    setPreview(next);
  }

  function onCancelPreview() {
    setPreview(null);
    setError(null);
  }

  async function onApply() {
    if (!preview) return;
    setError(null);
    await onApplyPreview(preview);
    setPreview(null);
  }

  return (
    <section className="live-change" aria-label="현장 배치 변경">
      <div className="live-change-head">
        <strong>현장 배치 변경</strong>
        <span>변경 선택 → 배치 다시 맞추기 → 미리보기 → 이대로 적용</span>
      </div>

      <div className="live-change-grid">
        <label>
          변경 유형
          <select
            value={changeType}
            onChange={(e) => {
              setChangeType(e.target.value as LiveChangeType);
              setPreview(null);
            }}
          >
            {LIVE_CHANGE_TYPES.map((t) => (
              <option key={t} value={t}>
                {LIVE_CHANGE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        {(changeType === "CANCEL_RESERVATION" || changeType === "TEAM_NOSHOW") && (
          <label>
            대상 예약
            <select
              value={reservationKeyValue}
              onChange={(e) => setReservationKeyValue(e.target.value)}
            >
              <option value="">선택</option>
              {assignedOptions.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                  {isPlacementLocked(o.row) ? " · LOCK" : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        {(changeType === "CADDY_SICK" ||
          changeType === "CADDY_ATTENDANCE_NOSHOW") && (
          <label>
            대상 캐디
            <select
              value={caddyId}
              onChange={(e) =>
                setCaddyId(e.target.value ? Number(e.target.value) : "")
              }
            >
              <option value="">선택</option>
              {assignedCaddies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} (#{c.id}/{c.team})
                </option>
              ))}
            </select>
          </label>
        )}

        {changeType === "ADD_RESERVATION" && (
          <>
            <label>
              코스
              <select
                value={addCourse}
                onChange={(e) => setAddCourse(e.target.value as CourseCode)}
              >
                {COURSE_CODES.map((c) => (
                  <option key={c} value={c}>
                    {COURSE_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              부
              <select
                value={addShift}
                onChange={(e) => setAddShift(e.target.value as ShiftPart)}
              >
                {SHIFT_PARTS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label>
              티타임
              <input
                value={addTeeTime}
                onChange={(e) => setAddTeeTime(e.target.value)}
                placeholder="07:00"
              />
            </label>
            <label>
              팀명
              <input
                value={addTeamName}
                onChange={(e) => setAddTeamName(e.target.value)}
              />
            </label>
          </>
        )}

        {changeType === "SWAP_CADDY" && (
          <>
            <label>
              캐디 A 예약
              <select value={swapA} onChange={(e) => setSwapA(e.target.value)}>
                <option value="">선택</option>
                {assignedOptions.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              캐디 B 예약
              <select value={swapB} onChange={(e) => setSwapB(e.target.value)}>
                <option value="">선택</option>
                {assignedOptions.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {changeType === "SET_LIMOUSINE" && (
          <>
            <label>
              대상 예약
              <select
                value={reservationKeyValue}
                onChange={(e) => setReservationKeyValue(e.target.value)}
              >
                <option value="">선택</option>
                {assignedOptions.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                    {o.row.reservation.limousineCart ? " · 리무진" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              리무진카트
              <select
                value={limousineOn ? "on" : "off"}
                onChange={(e) => setLimousineOn(e.target.value === "on")}
              >
                <option value="on">ON</option>
                <option value="off">OFF</option>
              </select>
            </label>
          </>
        )}

        {changeType === "ASSIGN_DRIVING" && (
          <>
            <label>
              3부 예약
              <select
                value={reservationKeyValue}
                onChange={(e) => setReservationKeyValue(e.target.value)}
              >
                <option value="">선택</option>
                {shift3Options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              드라이빙 캐디
              <select
                value={caddyId}
                onChange={(e) =>
                  setCaddyId(e.target.value ? Number(e.target.value) : "")
                }
              >
                <option value="">가용 캐디 선택</option>
                {freeCaddies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} (#{c.id}/{c.team})
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {changeType === "CLEAR_DRIVING" && (
          <label>
            드라이빙 예약
            <select
              value={reservationKeyValue}
              onChange={(e) => setReservationKeyValue(e.target.value)}
            >
              <option value="">선택</option>
              {assignedOptions
                .filter((o) => isDrivingPlacement(o.row))
                .map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>

      <div className="live-change-actions">
        <button type="button" className="btn primary" onClick={onReflow}>
          배치 다시 맞추기
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={!preview}
          onClick={onCancelPreview}
        >
          취소
        </button>
        <button
          type="button"
          className="btn apply"
          disabled={!preview || applying}
          onClick={() => void onApply()}
        >
          {applying ? "적용 중…" : "이대로 적용"}
        </button>
      </div>

      {error && <div className="ops-error">{error}</div>}

      {preview && (
        <div className="live-preview">
          <div className="live-preview-title">변경 미리보기 (아직 저장되지 않음)</div>
          <div className="live-preview-meta">
            당겨진 인원 {preview.summary.pulledCount} · 밀린 인원{" "}
            {preview.summary.pushedCount} · LOCK 유지{" "}
            {preview.summary.lockedPreservedCount}
          </div>
          <div className="live-preview-spares">
            {preview.after.sparesByShift.map((s) => (
              <div key={s.shift}>
                {s.shift} Spare1 {s.spare1 ? `${s.spare1.name}` : "-"} / Spare2{" "}
                {s.spare2 ? `${s.spare2.name}` : "-"}
              </div>
            ))}
          </div>
          {preview.warnings.length > 0 && (
            <ul className="live-preview-warn">
              {preview.warnings.map((w, i) => (
                <li key={`${w.code}-${i}`}>
                  {w.level === "error" ? "⚠" : "ℹ"} {w.message}
                </li>
              ))}
            </ul>
          )}
          {preview.lockedPreserved.length > 0 && (
            <div className="live-preview-lock">
              LOCK 유지:{" "}
              {preview.lockedPreserved
                .map((r) => `${r.caddy.name}(${r.kind})`)
                .join(", ")}
            </div>
          )}
          <ul className="live-preview-diff">
            {preview.placementDiffs
              .filter(
                (d) =>
                  (d.beforeCaddy?.id ?? null) !== (d.afterCaddy?.id ?? null) ||
                  d.lockedPreserved
              )
              .slice(0, 40)
              .map((d) => (
                <li key={d.reservationKey}>
                  {d.reservation.shift} {d.reservation.teeTime}{" "}
                  {d.reservation.course}: {d.beforeCaddy?.name || "미배치"} →{" "}
                  {d.afterCaddy?.name || "미배치"}
                  {d.lockedPreserved ? " · LOCK" : ""}
                </li>
              ))}
          </ul>
          {(preview.after.unassignedReservations || []).length > 0 && (
            <div className="live-preview-unassigned">
              미배치 {preview.after.unassignedReservations.length}건
              <ul>
                {preview.after.unassignedReservations.slice(0, 8).map((u) => (
                  <li key={reservationKey(u.reservation)}>
                    {u.reservation.shift} {u.reservation.teeTime}{" "}
                    {u.reservation.course} · {u.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
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
  const special = row.kind !== "regular";
  if (!special && !locked && row.kind === "regular") {
    return (
      <button
        type="button"
        className="btn tiny ghost"
        onClick={() => onToggle(true)}
        title="이 배치를 LOCK ON"
      >
        LOCK OFF
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`btn tiny ${locked ? "apply" : "ghost"}`}
      onClick={() => onToggle(!locked)}
    >
      {locked ? "LOCK ON" : "LOCK OFF"}
    </button>
  );
}

export function RowLiveActions({
  row,
  swapSelected,
  freeCaddies,
  onRequestChange,
  onSwapClick,
}: {
  row: AutoAssignmentRow;
  swapSelected: boolean;
  freeCaddies: AutoAssignCaddy[];
  onRequestChange: (change: LiveChangeInput) => void;
  onSwapClick: () => void;
}) {
  const key = reservationIdentity(row.reservation);
  const limo = row.reservation.limousineCart === true;
  const driving = isDrivingPlacement(row);
  const shift3 = String(row.reservation.shift) === "3부";
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
            {freeCaddies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
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
        {swapSelected ? "선택됨" : "순번 바꿈"}
      </button>
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
            type: "CADDY_SICK",
            caddyId: row.caddy.id,
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
        노쇼
      </button>
    </div>
  );
}
