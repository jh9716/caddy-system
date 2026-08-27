"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatCaddyLabel } from "@/lib/caddyDisplay";
import {
  SPECIAL_SUPPORT_CHANGED_MESSAGE,
  SPECIAL_SUPPORT_SHIFTS,
  engineQueuesFromSupportRecords,
  isEligibleSpecialSupportCandidate,
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
  candidates?: Candidate[];
  counts?: Record<ShiftPart, number>;
  error?: string;
};

function countLabel(counts: Record<ShiftPart, number> | undefined): string {
  const c = counts || { "1부": 0, "2부": 0, "3부": 0 };
  return `1부 지원 ${c["1부"] || 0}명 · 2부 지원 ${c["2부"] || 0}명 · 3부 지원 ${c["3부"] || 0}명`;
}

export function SpecialSupportPanel({
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
  const [shift, setShift] = useState<ShiftPart>("1부");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (opts?: { includeCandidates?: boolean }) => {
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
      const res = await fetch(
        `/api/daily-special-supports?${qs.toString()}`,
        { credentials: "include" }
      );
      const data = (await res.json()) as Payload;
      if (data.date && data.date !== date) return null;
      if (!res.ok) {
        setError(data.error || "특수지원 조회 실패");
        return null;
      }
      setPayload((prev) => ({
        ...data,
        candidates:
          data.candidates && data.candidates.length
            ? data.candidates
            : prev?.candidates,
      }));
      onLoaded?.(engineQueuesFromSupportRecords(data.byShift));
      return data;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "특수지원 조회 실패");
      return null;
    } finally {
      setLoading(false);
    }
  }, [date, onLoaded]);

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
        exclusionLabel: (row.excludedReasons || []).filter(Boolean).join(" · ") || "제외",
      }));
  }, [payload?.candidates, excludedRows]);

  const counts = payload?.counts || {
    "1부": payload?.byShift?.["1부"]?.length || 0,
    "2부": payload?.byShift?.["2부"]?.length || 0,
    "3부": payload?.byShift?.["3부"]?.length || 0,
  };

  async function openModal() {
    const current = new Set(
      (payload?.byShift?.[shift] || []).map((row) => row.caddyId)
    );
    setSelected(current);
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

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/daily-special-supports", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date,
          shift,
          caddyIds: [...selected],
        }),
      });
      const data = (await res.json()) as Payload & { ok?: boolean };
      if (!res.ok) {
        setError(data.error || "특수지원 저장 실패");
        return;
      }
      setPayload((prev) => ({
        ...data,
        candidates:
          (data.candidates && data.candidates.length
            ? data.candidates
            : prev?.candidates) || [],
      }));
      setModalOpen(false);
      if (hasDraft) setNotice(SPECIAL_SUPPORT_CHANGED_MESSAGE);
      onLoaded?.(engineQueuesFromSupportRecords(data.byShift));
      onChanged?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "특수지원 저장 실패");
    } finally {
      setBusy(false);
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return (
      <section className="ss-panel">
        <div className="ss-title">특수지원</div>
        <p className="ss-hint">날짜를 선택하면 해당 날짜 특수지원만 표시됩니다.</p>
      </section>
    );
  }

  return (
    <section className="ss-panel">
      <div className="ss-head">
        <div>
          <div className="ss-title">특수지원</div>
          <p className="ss-hint">
            휴무·당번·마샬·조장 등 제외 캐디가 지정 부에만 보충 근무합니다. 정상
            출근자 순번을 밀어내지 않습니다.
          </p>
        </div>
        <button type="button" className="ss-add" onClick={openModal}>
          특수지원 등록
        </button>
      </div>
      {loading ? <div className="ss-hint">불러오는 중…</div> : null}
      {error ? <div className="ss-error">{error}</div> : null}
      <div className="ss-summary">{countLabel(counts)}</div>
      {notice ? <p className="ss-draft">{notice}</p> : null}

      {modalOpen ? (
        <div className="ss-modal" role="dialog" aria-modal="true">
          <div className="ss-sheet">
            <div className="ss-sheet-head">
              <strong>특수지원 등록</strong>
              <button type="button" onClick={() => setModalOpen(false)}>
                닫기
              </button>
            </div>
            <div className="ss-kinds">
              {SPECIAL_SUPPORT_SHIFTS.map((part) => (
                <button
                  key={part}
                  type="button"
                  className={shift === part ? "on" : ""}
                  onClick={() => {
                    setShift(part);
                    setSelected(
                      new Set(
                        (payload?.byShift?.[part] || []).map((row) => row.caddyId)
                      )
                    );
                  }}
                >
                  {part}
                </button>
              ))}
            </div>
            <p className="ss-hint">
              {shift} · 선택 {selected.size}명. 병가·결근·휴직·퇴사는 목록에 없습니다.
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
              <button type="button" disabled={busy} onClick={() => void save()}>
                {busy ? "저장 중…" : `${shift} 저장`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <style>{`
        .ss-panel { margin-top: 14px; padding-top: 12px; border-top: 1px solid #e5e7eb; }
        .ss-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
        .ss-title { font-weight: 800; }
        .ss-hint, .ss-summary, .ss-draft { font-size: 13px; color: #475569; margin: 6px 0 0; }
        .ss-error { color: #b91c1c; font-size: 13px; }
        .ss-add {
          border: 1px solid #1e3a8a; background: #1e3a8a; color: #fff;
          border-radius: 10px; padding: 8px 12px; font-weight: 700; cursor: pointer;
        }
        .ss-modal {
          position: fixed; inset: 0; background: rgba(15,23,42,.45);
          display: grid; place-items: center; z-index: 80; padding: 16px;
        }
        .ss-sheet {
          width: min(520px, 100%); max-height: 86vh; overflow: auto;
          background: #fff; border-radius: 16px; padding: 16px; display: grid; gap: 10px;
        }
        .ss-sheet-head { display: flex; justify-content: space-between; align-items: center; }
        .ss-kinds { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
        .ss-kinds button {
          border: 1px solid #e5e7eb; background: #f8fafc; border-radius: 10px;
          padding: 8px; font-weight: 700; cursor: pointer;
        }
        .ss-kinds button.on { background: #1e3a8a; color: #fff; border-color: #1e3a8a; }
        .ss-cands { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
        .ss-cands label { display: flex; gap: 8px; align-items: center; }
        .ss-empty { color: #64748b; font-size: 13px; }
        .ss-actions button {
          width: 100%; border: 0; background: #0f172a; color: #fff;
          border-radius: 10px; padding: 10px; font-weight: 800; cursor: pointer;
        }
      `}</style>
    </section>
  );
}
