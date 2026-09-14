"use client";

import { useCallback, useEffect, useMemo, useState, memo } from "react";
import { formatCaddyLabel } from "@/lib/caddyDisplay";
import {
  DAILY_SPECIAL_SUPPORT_KINDS,
  DAILY_SPECIAL_SUPPORT_KIND_CHIP_LABELS,
  DAILY_SPECIAL_SUPPORT_KIND_LABELS,
  DAILY_SPECIAL_SUPPORT_WORK_PATTERNS,
  DAILY_SPECIAL_SUPPORT_WORK_PATTERN_CHIP_LABELS,
  DEFAULT_SPECIAL_SUPPORT_KIND,
  SPECIAL_SUPPORT_CHANGED_MESSAGE,
  engineQueuesFromSupportRecords,
  isEligibleSpecialSupportCandidate,
  type DailySpecialSupportKind,
  type DailySpecialSupportWorkPattern,
  type SpecialSupportRecord,
} from "@/lib/dailySpecialSupport";
import { RECALC_RUNNING_LABEL } from "@/lib/assignmentDraft";
import { type ShiftPart } from "@/lib/reservationParser";

type Candidate = {
  id: number;
  name: string;
  team: string;
  teamOrder?: number;
  employmentStatus?: string | null;
  excludedReasons?: string[] | null;
  exclusionLabel?: string;
};

type Payload = {
  date?: string;
  items?: SpecialSupportRecord[];
  byShift?: Record<ShiftPart, SpecialSupportRecord[]>;
  byKindPattern?: Record<
    DailySpecialSupportKind,
    Record<DailySpecialSupportWorkPattern, SpecialSupportRecord[]>
  >;
  countsByKind?: Record<DailySpecialSupportKind, number>;
  candidates?: Candidate[];
  counts?: Record<ShiftPart, number>;
  error?: string;
};

function groupItems(
  payload: Payload | null,
  kind: DailySpecialSupportKind,
  pattern: DailySpecialSupportWorkPattern
): SpecialSupportRecord[] {
  const fromGroup = payload?.byKindPattern?.[kind]?.[pattern];
  if (fromGroup) return fromGroup;
  return (payload?.items || []).filter(
    (row) => row.kind === kind && row.workPattern === pattern
  );
}

export const SpecialSupportPanel = memo(function SpecialSupportPanel({
  date,
  excludedRows,
  hasDraft,
  onChanged,
  onLoaded,
  onRecalcDraft,
  recalcBusy,
  recalcDisabled,
}: {
  date: string;
  excludedRows?: Array<{
    id: number;
    name?: string;
    team?: string;
    teamOrder?: number;
    employmentStatus?: string | null;
    excludedReasons?: string[] | null;
  }>;
  hasDraft?: boolean;
  onChanged?: () => void;
  onLoaded?: (byShift: ReturnType<typeof engineQueuesFromSupportRecords>) => void;
  onRecalcDraft?: () => void;
  recalcBusy?: boolean;
  recalcDisabled?: boolean;
}) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [kind, setKind] = useState<DailySpecialSupportKind>(
    DEFAULT_SPECIAL_SUPPORT_KIND
  );
  const [workPattern, setWorkPattern] =
    useState<DailySpecialSupportWorkPattern>("SHIFT_1");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const applyPayload = useCallback(
    (data: Payload) => {
      setPayload((prev) => ({
        ...data,
        candidates:
          data.candidates && data.candidates.length
            ? data.candidates
            : prev?.candidates,
      }));
      onLoaded?.(engineQueuesFromSupportRecords(data.byShift));
    },
    [onLoaded]
  );

  const load = useCallback(
    async (opts?: { includeCandidates?: boolean }) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        setPayload(null);
        onLoaded?.(engineQueuesFromSupportRecords(null));
        return null as Payload | null;
      }
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ date });
        if (opts?.includeCandidates) qs.set("includeCandidates", "1");
        const res = await fetch(`/api/daily-special-supports?${qs.toString()}`, {
          credentials: "include",
        });
        const data = (await res.json()) as Payload;
        if (data.date && data.date !== date) return null;
        if (!res.ok) {
          setError(data.error || "지원근무 조회 실패");
          return null;
        }
        applyPayload(data);
        return data;
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "지원근무 조회 실패");
        return null;
      } finally {
        setLoading(false);
      }
    },
    [date, onLoaded, applyPayload]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const candidates = useMemo(() => {
    const fromApi = payload?.candidates || [];
    if (fromApi.length) return fromApi;
    return (excludedRows || [])
      .filter((row) => isEligibleSpecialSupportCandidate(row))
      .map((row) => ({
        id: row.id,
        name: row.name || "",
        team: row.team || "",
        teamOrder: row.teamOrder,
        employmentStatus: row.employmentStatus,
        excludedReasons: row.excludedReasons,
        exclusionLabel:
          (row.excludedReasons || []).filter(Boolean).join(" · ") || "제외",
      }));
  }, [payload?.candidates, excludedRows]);

  const countsByKind = payload?.countsByKind || {
    CHAGEUN: 0,
    SPECIAL_SUPPORT: 0,
    OFF_SUPPORT: 0,
    MARSHAL_SUPPORT: 0,
    LEADER_SUPPORT: 0,
    FIFTY_FOUR_SUPPORT: 0,
  };
  const groupRows = groupItems(payload, kind, workPattern);

  async function openModal() {
    setSelected(new Set());
    setModalOpen(true);
    if (!(payload?.candidates && payload.candidates.length)) {
      await load({ includeCandidates: true });
    }
  }

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveGroup(caddyIds: number[]) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/daily-special-supports", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date,
          kind,
          workPattern,
          caddyIds,
        }),
      });
      const data = (await res.json()) as Payload & { ok?: boolean };
      if (!res.ok) {
        setError(data.error || "지원근무 저장 실패");
        return false;
      }
      applyPayload(data);
      if (hasDraft) {
        setNotice(SPECIAL_SUPPORT_CHANGED_MESSAGE);
        onChanged?.();
      }
      return true;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "지원근무 저장 실패");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addSelected() {
    const current = groupRows.map((row) => row.caddyId);
    const merged = [...current];
    for (const id of selected) {
      if (!merged.includes(id)) merged.push(id);
    }
    const ok = await saveGroup(merged);
    if (ok) {
      setModalOpen(false);
      setSelected(new Set());
    }
  }

  async function patchRow(id: number, action: "move" | "delete", direction?: "up" | "down") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/daily-special-supports", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, id, direction }),
      });
      const data = (await res.json()) as Payload;
      if (!res.ok) {
        setError(data.error || "지원근무 수정 실패");
        return;
      }
      applyPayload(data);
      if (hasDraft) {
        setNotice(SPECIAL_SUPPORT_CHANGED_MESSAGE);
        onChanged?.();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "지원근무 수정 실패");
    } finally {
      setBusy(false);
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return (
      <section className="ss-panel">
        <div className="ss-title">지원근무</div>
        <p className="ss-hint">날짜를 선택하세요.</p>
      </section>
    );
  }

  return (
    <section className="ss-panel">
      <div className="ss-head">
        <div className="ss-title">지원근무</div>
        <button type="button" className="ss-add" onClick={() => void openModal()}>
          + 등록
        </button>
      </div>
      {loading ? <div className="ss-hint">불러오는 중…</div> : null}
      {error ? <div className="ss-error">{error}</div> : null}
      {notice ? <p className="ss-draft">{notice}</p> : null}

      <div className="ss-kinds" role="tablist" aria-label="지원 유형">
        {DAILY_SPECIAL_SUPPORT_KINDS.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={kind === item}
            className={kind === item ? "on" : ""}
            onClick={() => setKind(item)}
          >
            {DAILY_SPECIAL_SUPPORT_KIND_CHIP_LABELS[item]} {countsByKind[item] || 0}
          </button>
        ))}
      </div>

      <div className="ss-pattern-label">패턴</div>
      <div className="ss-patterns" role="tablist" aria-label="근무 패턴">
        {DAILY_SPECIAL_SUPPORT_WORK_PATTERNS.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={workPattern === item}
            className={workPattern === item ? "on" : ""}
            onClick={() => setWorkPattern(item)}
          >
            {DAILY_SPECIAL_SUPPORT_WORK_PATTERN_CHIP_LABELS[item]}{" "}
            {payload?.byKindPattern?.[kind]?.[item]?.length || 0}
          </button>
        ))}
      </div>

      <div className="ss-current">
        {DAILY_SPECIAL_SUPPORT_KIND_LABELS[kind]} ·{" "}
        {DAILY_SPECIAL_SUPPORT_WORK_PATTERN_CHIP_LABELS[workPattern]} · {groupRows.length}명
      </div>

      {groupRows.length === 0 ? (
        <div className="ss-empty">등록 없음</div>
      ) : (
        <ol className="ss-list">
          {groupRows.map((row, index) => (
            <li key={row.id || `${row.caddyId}-${index}`}>
              <span className="ss-pri">{index + 1}</span>
              <span className="ss-who">{formatCaddyLabel(row)}</span>
              <span className="ss-ops">
                <button
                  type="button"
                  disabled={busy || index === 0}
                  onClick={() => row.id && void patchRow(row.id, "move", "up")}
                >
                  위
                </button>
                <button
                  type="button"
                  disabled={busy || index === groupRows.length - 1}
                  onClick={() => row.id && void patchRow(row.id, "move", "down")}
                >
                  아래
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => row.id && void patchRow(row.id, "delete")}
                >
                  삭제
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}

      {hasDraft ? (
        <div className="ss-recalc">
          <button
            type="button"
            className="ss-recalc-btn"
            disabled={recalcBusy || recalcDisabled || !onRecalcDraft}
            onClick={() => onRecalcDraft?.()}
          >
            {recalcBusy ? RECALC_RUNNING_LABEL : "배치 다시 맞추기"}
          </button>
        </div>
      ) : null}

      {modalOpen ? (
        <div className="ss-modal" role="dialog" aria-modal="true">
          <div className="ss-sheet">
            <div className="ss-sheet-head">
              <strong>지원근무 등록</strong>
              <button type="button" onClick={() => setModalOpen(false)}>
                닫기
              </button>
            </div>
            <div className="ss-kinds">
              {DAILY_SPECIAL_SUPPORT_KINDS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={kind === item ? "on" : ""}
                  onClick={() => setKind(item)}
                >
                  {DAILY_SPECIAL_SUPPORT_KIND_CHIP_LABELS[item]}
                </button>
              ))}
            </div>
            <div className="ss-patterns">
              {DAILY_SPECIAL_SUPPORT_WORK_PATTERNS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={workPattern === item ? "on" : ""}
                  onClick={() => setWorkPattern(item)}
                >
                  {DAILY_SPECIAL_SUPPORT_WORK_PATTERN_CHIP_LABELS[item]}
                </button>
              ))}
            </div>
            <p className="ss-hint">
              {DAILY_SPECIAL_SUPPORT_KIND_LABELS[kind]} ·{" "}
              {DAILY_SPECIAL_SUPPORT_WORK_PATTERN_CHIP_LABELS[workPattern]} · 추가{" "}
              {selected.size}명. 병가·결근·휴직·퇴사는 목록에 없습니다.
            </p>
            {candidates.length === 0 ? (
              <div className="ss-empty">이 날짜에 지원 가능한 제외 캐디가 없습니다.</div>
            ) : (
              <ul className="ss-cands">
                {candidates.map((row) => (
                  <li key={row.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() => toggle(row.id)}
                      />
                      <span>
                        {formatCaddyLabel({
                          name: row.name,
                          team: row.team,
                        })}{" "}
                        · {row.exclusionLabel || "제외"}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <div className="ss-actions">
              <button type="button" disabled={busy} onClick={() => void addSelected()}>
                {busy ? "저장 중…" : "추가 저장"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <style>{`
        .ss-panel { margin-top: 4px; }
        .ss-head { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
        .ss-title { font-weight: 800; font-size: 0.9rem; }
        .ss-hint, .ss-draft { font-size: 0.78rem; color: #475569; margin: 6px 0 0; }
        .ss-current { font-size: 0.78rem; color: #0f172a; font-weight: 700; margin-top: 8px; }
        .ss-error { color: #b91c1c; font-size: 0.8rem; }
        .ss-add {
          min-height: 36px; border: 0; background: #0f172a; color: #fff;
          border-radius: 8px; padding: 0 12px; font-weight: 700; font-size: 0.82rem; cursor: pointer;
        }
        .ss-kinds, .ss-patterns {
          display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px;
        }
        .ss-kinds button, .ss-patterns button {
          min-height: 36px; border: 1px solid #e5e7eb; background: #fff; border-radius: 8px;
          font-weight: 700; font-size: 0.78rem; cursor: pointer; color: #475569;
          padding: 0 10px;
        }
        .ss-kinds button.on, .ss-patterns button.on {
          background: #0f172a; color: #fff; border-color: #0f172a;
        }
        .ss-pattern-label { margin-top: 8px; font-size: 0.72rem; color: #64748b; font-weight: 700; }
        .ss-list { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 4px; }
        .ss-list li {
          display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 6px; align-items: center;
          min-height: 32px; font-size: 0.85rem;
        }
        .ss-pri { font-weight: 800; color: #0f172a; }
        .ss-ops { display: flex; gap: 4px; }
        .ss-ops button {
          min-height: 28px; border: 1px solid #e5e7eb; background: #fff; border-radius: 6px;
          font-size: 0.7rem; font-weight: 700; cursor: pointer; padding: 0 6px;
        }
        .ss-ops button:disabled { opacity: 0.4; }
        .ss-modal {
          position: fixed; inset: 0; background: rgba(15,23,42,.45);
          display: grid; place-items: center; z-index: 80; padding: 16px;
        }
        .ss-sheet {
          width: min(520px, 100%); max-height: 86vh; overflow: auto;
          background: #fff; border-radius: 16px; padding: 16px; display: grid; gap: 10px;
        }
        .ss-sheet-head { display: flex; justify-content: space-between; align-items: center; }
        .ss-cands { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
        .ss-cands label { display: flex; gap: 8px; align-items: center; min-height: 36px; }
        .ss-empty { color: #64748b; font-size: 0.78rem; margin-top: 8px; }
        .ss-actions button {
          width: 100%; min-height: 40px; border: 0; background: #0f172a; color: #fff;
          border-radius: 10px; padding: 10px; font-weight: 800; cursor: pointer;
        }
        .ss-recalc { margin-top: 10px; }
        .ss-recalc-btn {
          width: 100%; min-height: 40px; border: 0; background: #0f172a; color: #fff;
          border-radius: 10px; font-weight: 800; cursor: pointer;
        }
        .ss-recalc-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      `}</style>
    </section>
  );
});
