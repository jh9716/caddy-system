"use client";

import { useMemo, useState } from "react";
import {
  assignCaddyToUnassigned,
  assignmentsByShift,
  confirmDraft,
  createDraftFromAutoResult,
  detectDraftWarnings,
  replaceAssignmentCaddy,
  reservationIdentity,
  swapAssignmentCaddies,
  unassignReservation,
  unusedCaddies,
  type AssignmentDraft,
  type DraftWarning,
} from "@/lib/assignmentDraft";
import type {
  AutoAssignCaddy,
  AutoAssignResultV1,
  AutoAssignmentRow,
} from "@/lib/autoAssignEngine";
import type { AvailabilityResult } from "@/lib/availabilityEngine";
import type { ShiftPart } from "@/lib/reservationParser";

type RunResponse = AutoAssignResultV1 & {
  error?: string;
  filename?: string;
  availabilityCounts?: { available: number; special: number; excluded: number };
};

const SHIFTS: ShiftPart[] = ["1부", "2부", "3부"];

export default function ManageAssignmentsOpsPage() {
  const [date, setDate] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [availability, setAvailability] = useState<AvailabilityResult | null>(
    null
  );
  const [autoResult, setAutoResult] = useState<RunResponse | null>(null);
  const [draft, setDraft] = useState<AssignmentDraft | null>(null);
  const [warnings, setWarnings] = useState<DraftWarning[]>([]);
  const [shiftTab, setShiftTab] = useState<ShiftPart | "UNASSIGNED">("1부");
  const [loadingAvail, setLoadingAvail] = useState(false);
  const [loadingRun, setLoadingRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [swapKey, setSwapKey] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

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
  const liveWarnings = draft ? detectDraftWarnings(draft) : warnings;

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
      setShiftTab("1부");
      showToast("자동배치 완료 · DRAFT");
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
    if (liveWarnings.some((w) => w.level === "error")) {
      const ok = window.confirm(
        "충돌/중복 경고가 있습니다. 그래도 CONFIRMED로 둘까요?\n(Production DB에는 저장되지 않습니다)"
      );
      if (!ok) return;
    } else {
      const ok = window.confirm(
        "CONFIRMED로 표시합니다. Production DB에는 저장되지 않습니다."
      );
      if (!ok) return;
    }
    setDraft(confirmDraft(draft));
    showToast("CONFIRMED (메모리 only)");
  }

  const shiftRows =
    draft && shiftTab !== "UNASSIGNED"
      ? assignmentsByShift(draft, shiftTab)
      : [];

  return (
    <div className="ops-root">
      <header className="ops-header">
        <div>
          <h1>자동배치 운영</h1>
          <p>Excel → 자동배치 → 수동 수정 · DB 저장 없음</p>
        </div>
        {draft && (
          <StatusBadge status={draft.status} confirmedAt={draft.confirmedAt} />
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
            disabled={!draft || draft.status === "CONFIRMED"}
            onClick={onConfirm}
          >
            CONFIRMED
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
            {autoResult.meta.unassignedCount} · 파일 {autoResult.filename || "-"}
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
                  {
                    draft.assignments.filter((a) => a.shift === s).length
                  }
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
          </nav>

          {shiftTab !== "UNASSIGNED" && (
            <ul className="ops-list">
              {shiftRows.length === 0 && (
                <li className="ops-empty">이 부 배치 없음</li>
              )}
              {shiftRows.map((row) => {
                const key = reservationIdentity(row.reservation);
                const special = row.kind !== "regular";
                return (
                  <li
                    key={key}
                    className={`ops-item ${special ? "special" : ""} ${
                      swapKey === key ? "swap-on" : ""
                    }`}
                  >
                    <div className="ops-item-top">
                      <strong>{row.reservation.teeTime}</strong>
                      <span className="chip">{row.kind}</span>
                      {special && <span className="chip warn">special</span>}
                    </div>
                    <div className="ops-item-main">
                      <div>
                        {row.reservation.teamName || "-"} ·{" "}
                        {row.reservation.courseLabel || row.reservation.course}
                      </div>
                      <div className="caddy">
                        {row.caddy.name}{" "}
                        <span className="muted">
                          #{row.caddy.id} · {row.caddy.team}
                        </span>
                      </div>
                    </div>
                    <div className="ops-item-actions">
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
                      <button type="button" className="btn tiny" onClick={() => onSwapClick(row)}>
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
                  </li>
                );
              })}
            </ul>
          )}

          {shiftTab === "UNASSIGNED" && (
            <ul className="ops-list">
              {draft.unassignedReservations.length === 0 && (
                <li className="ops-empty">미배치 없음</li>
              )}
              {draft.unassignedReservations.map((u) => {
                const key = reservationIdentity(u.reservation);
                return (
                  <li key={key} className="ops-item">
                    <div className="ops-item-top">
                      <strong>
                        {u.reservation.shift} {u.reservation.teeTime}
                      </strong>
                    </div>
                    <div className="ops-item-main">
                      {u.reservation.teamName || "-"} · {u.reason}
                    </div>
                    <div className="ops-item-actions">
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
}: {
  status: string;
  confirmedAt: string | null;
}) {
  return (
    <div className={`status ${status}`}>
      <div className="status-label">{status}</div>
      {confirmedAt && (
        <div className="status-sub">{new Date(confirmedAt).toLocaleString("ko-KR")}</div>
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
    padding-bottom: 72px;
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
    .ops-actions { grid-template-columns: repeat(3, 1fr); }
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
  .ops-tabs {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    position: sticky;
    top: 0;
    z-index: 2;
    background: #f8fafc;
    padding: 6px 0;
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
  .ops-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .ops-item {
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 10px;
    background: #fff;
    display: grid;
    gap: 8px;
  }
  .ops-item.special { border-color: #f59e0b; background: #fffbeb; }
  .ops-item.swap-on { outline: 2px solid #2563eb; }
  .ops-item-top {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .chip {
    font-size: 0.7rem;
    padding: 2px 6px;
    border-radius: 999px;
    background: #e2e8f0;
  }
  .chip.warn { background: #fde68a; }
  .caddy { font-weight: 700; margin-top: 2px; }
  .muted { color: #64748b; font-weight: 500; font-size: 0.8rem; }
  .ops-item-actions {
    display: grid;
    gap: 6px;
    grid-template-columns: 1fr auto auto;
    align-items: end;
  }
  .inline {
    display: grid;
    gap: 2px;
    font-size: 0.75rem;
    color: #64748b;
  }
  .ops-empty {
    padding: 16px;
    text-align: center;
    color: #64748b;
    border: 1px dashed #cbd5e1;
    border-radius: 12px;
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
