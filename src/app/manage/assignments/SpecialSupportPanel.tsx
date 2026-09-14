"use client";

import { useCallback, useEffect, useMemo, useState, memo } from "react";
import { formatCaddyLabel } from "@/lib/caddyDisplay";
import {
  DAILY_SPECIAL_SUPPORT_KINDS,
  DAILY_SPECIAL_SUPPORT_KIND_CHIP_LABELS,
  DAILY_SPECIAL_SUPPORT_KIND_LABELS,
  DAILY_SPECIAL_SUPPORT_WORK_PATTERNS,
  DAILY_SPECIAL_SUPPORT_WORK_PATTERN_LABELS,
  SPECIAL_SUPPORT_CHANGED_MESSAGE,
  displaySupportRecords,
  engineQueuesFromSupportRecords,
  isEligibleSpecialSupportCandidate,
  resolveSupportKind,
  resolveSupportWorkPattern,
  sameSupportGroup,
  supportListBadgeLabels,
  type DailySpecialSupportKind,
  type DailySpecialSupportWorkPattern,
  type SpecialSupportRecord,
} from "@/lib/dailySpecialSupport";
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

type FilterKind = "ALL" | DailySpecialSupportKind;

function groupCaddyIds(
  items: readonly SpecialSupportRecord[],
  kind: DailySpecialSupportKind,
  pattern: DailySpecialSupportWorkPattern
): number[] {
  return items
    .filter(
      (row) =>
        resolveSupportKind(row) === kind &&
        resolveSupportWorkPattern(row) === pattern
    )
    .sort(
      (a, b) =>
        (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) ||
        (a.id || 0) - (b.id || 0)
    )
    .map((row) => row.caddyId);
}

export const SpecialSupportPanel = memo(function SpecialSupportPanel({
  date,
  excludedRows,
  hasDraft,
  onChanged,
  onLoaded,
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
}) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [filterKind, setFilterKind] = useState<FilterKind>("ALL");
  const [modalKind, setModalKind] = useState<DailySpecialSupportKind | null>(
    null
  );
  const [modalPattern, setModalPattern] =
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

  const items = payload?.items || [];
  const visibleRows = useMemo(
    () => displaySupportRecords(items, filterKind),
    [payload?.items, filterKind]
  );

  const candidates = useMemo(() => {
    const fromApi = payload?.candidates || [];
    const registered = new Set(
      modalKind ? groupCaddyIds(items, modalKind, modalPattern) : []
    );
    const source = fromApi.length
      ? fromApi
      : (excludedRows || [])
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
    return source.filter((row) => !registered.has(row.id));
  }, [payload?.candidates, excludedRows, items, modalKind, modalPattern]);

  const countsByKind = payload?.countsByKind || {
    CHAGEUN: 0,
    SPECIAL_SUPPORT: 0,
    OFF_SUPPORT: 0,
    MARSHAL_SUPPORT: 0,
    LEADER_SUPPORT: 0,
    FIFTY_FOUR_SUPPORT: 0,
  };
  const totalCount = items.length;

  async function openModal() {
    setSelected(new Set());
    setModalKind(filterKind === "ALL" ? null : filterKind);
    setModalPattern("SHIFT_1");
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

  async function saveGroup(
    kind: DailySpecialSupportKind,
    workPattern: DailySpecialSupportWorkPattern,
    caddyIds: number[]
  ) {
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
    if (!modalKind) {
      setError("지원 종류를 선택하세요.");
      return;
    }
    const current = groupCaddyIds(items, modalKind, modalPattern);
    const merged = [...current];
    for (const id of selected) {
      if (!merged.includes(id)) merged.push(id);
    }
    const ok = await saveGroup(modalKind, modalPattern, merged);
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

      <div className="ss-kinds" role="tablist" aria-label="지원 유형 필터">
        <button
          type="button"
          role="tab"
          aria-selected={filterKind === "ALL"}
          className={filterKind === "ALL" ? "on" : ""}
          onClick={() => setFilterKind("ALL")}
        >
          전체 {totalCount}
        </button>
        {DAILY_SPECIAL_SUPPORT_KINDS.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={filterKind === item}
            className={filterKind === item ? "on" : ""}
            onClick={() => setFilterKind(item)}
          >
            {DAILY_SPECIAL_SUPPORT_KIND_CHIP_LABELS[item]} {countsByKind[item] || 0}
          </button>
        ))}
      </div>

      <div className="ss-current">현재 등록 {visibleRows.length}명</div>

      {visibleRows.length === 0 ? (
        <div className="ss-empty">등록 없음</div>
      ) : (
        <ol className="ss-list">
          {visibleRows.map((row, index) => {
            const badges = supportListBadgeLabels(
              row.kind,
              row.workPattern,
              row.shift
            );
            const prev = visibleRows[index - 1];
            const next = visibleRows[index + 1];
            const canUp = Boolean(prev && sameSupportGroup(row, prev));
            const canDown = Boolean(next && sameSupportGroup(row, next));
            return (
              <li key={row.id || `${row.caddyId}-${index}`}>
                <span className="ss-pri">{index + 1}</span>
                <span className="ss-who">
                  <span className="ss-name">{formatCaddyLabel(row)}</span>
                  <span className="ss-badges">
                    <span className="ss-badge kind">{badges.kind}</span>
                    <span className="ss-badge pat">{badges.pattern}</span>
                  </span>
                </span>
                <span className="ss-ops">
                  <button
                    type="button"
                    disabled={busy || !canUp || !row.id}
                    onClick={() => row.id && void patchRow(row.id, "move", "up")}
                  >
                    위
                  </button>
                  <button
                    type="button"
                    disabled={busy || !canDown || !row.id}
                    onClick={() => row.id && void patchRow(row.id, "move", "down")}
                  >
                    아래
                  </button>
                  <button
                    type="button"
                    disabled={busy || !row.id}
                    onClick={() => row.id && void patchRow(row.id, "delete")}
                  >
                    삭제
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {modalOpen ? (
        <div className="ss-modal" role="dialog" aria-modal="true">
          <div className="ss-sheet">
            <div className="ss-sheet-head">
              <strong>지원근무 등록</strong>
              <button type="button" onClick={() => setModalOpen(false)}>
                닫기
              </button>
            </div>
            <div className="ss-step">1. 지원 종류</div>
            <div className="ss-kinds">
              {DAILY_SPECIAL_SUPPORT_KINDS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={modalKind === item ? "on" : ""}
                  aria-pressed={modalKind === item}
                  onClick={() => setModalKind(item)}
                >
                  {DAILY_SPECIAL_SUPPORT_KIND_LABELS[item]}
                </button>
              ))}
            </div>
            <div className="ss-step">2. 근무 패턴</div>
            <div className="ss-patterns">
              {DAILY_SPECIAL_SUPPORT_WORK_PATTERNS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={modalPattern === item ? "on" : ""}
                  onClick={() => setModalPattern(item)}
                >
                  {DAILY_SPECIAL_SUPPORT_WORK_PATTERN_LABELS[item]}
                </button>
              ))}
            </div>
            <div className="ss-step">3. 캐디 선택</div>
            <p className="ss-hint">
              {modalKind
                ? `${DAILY_SPECIAL_SUPPORT_KIND_LABELS[modalKind]} · ${DAILY_SPECIAL_SUPPORT_WORK_PATTERN_LABELS[modalPattern]} · 추가 ${selected.size}명. 병가·결근·휴직·퇴사는 목록에 없습니다.`
                : "지원 종류를 먼저 고르세요. 병가·결근·휴직·퇴사는 목록에 없습니다."}
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
              <button
                type="button"
                disabled={busy || !modalKind || selected.size === 0}
                onClick={() => void addSelected()}
              >
                {busy ? "저장 중…" : "저장"}
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
        .ss-step { margin-top: 8px; font-size: 0.72rem; color: #64748b; font-weight: 700; }
        .ss-list { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }
        .ss-list li {
          display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 6px; align-items: center;
          min-height: 36px; font-size: 0.85rem;
        }
        .ss-pri { font-weight: 800; color: #0f172a; }
        .ss-who { display: grid; gap: 3px; min-width: 0; }
        .ss-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ss-badges { display: flex; flex-wrap: wrap; gap: 4px; }
        .ss-badge {
          display: inline-flex; align-items: center; min-height: 18px;
          border-radius: 6px; padding: 0 6px; font-size: 0.68rem; font-weight: 700;
        }
        .ss-badge.kind { color: #1e3a8a; background: #dbeafe; }
        .ss-badge.pat { color: #334155; background: #e2e8f0; }
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
      `}</style>
    </section>
  );
});
