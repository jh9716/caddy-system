"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { normalizePersonName } from "@/lib/dailyCaddyNameMatch";
import {
  DAILY_SPECIAL_KINDS,
  DAILY_SPECIAL_KIND_LABELS,
  annotateSpecialDutyConflicts,
  unavailableReasonsFromRows,
  type DailySpecialKind,
  type SpecialDutyConflict,
  type SpecialDutyRecord,
} from "@/lib/dailySpecialDuty";

type GroupPayload = {
  kind: DailySpecialKind;
  label: string;
  count: number;
  items: Array<
    SpecialDutyRecord & { id?: number; conflicts: SpecialDutyConflict[] }
  >;
};

type ListPayload = {
  date: string;
  groups: GroupPayload[];
  added?: SpecialDutyRecord[];
  reviews?: Array<{ status: string; name: string; reason?: string }>;
  duplicates?: Array<{ caddyId: number; name?: string }>;
  error?: string;
};

type SearchCaddy = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
};

export function SpecialDutyPanel({
  date,
  excludedRows,
}: {
  date: string;
  excludedRows?: Array<{ id: number; excludedReasons?: string[] | null }>;
}) {
  const [groups, setGroups] = useState<GroupPayload[]>([]);
  const [openKinds, setOpenKinds] = useState<Set<DailySpecialKind>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [kind, setKind] = useState<DailySpecialKind>("ONE_TWO");
  const [query, setQuery] = useState("");
  const [paste, setPaste] = useState("");
  const [caddies, setCaddies] = useState<SearchCaddy[]>([]);
  const [busy, setBusy] = useState(false);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }, []);

  const applyPayload = useCallback((data: ListPayload) => {
    setGroups(data.groups || []);
  }, []);

  const load = useCallback(async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setGroups([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/daily-special-duties?date=${encodeURIComponent(date)}`,
        { credentials: "include" }
      );
      const data = (await res.json()) as ListPayload;
      if (!res.ok) {
        setError(data.error || "특수근무 목록을 불러오지 못했습니다.");
        return;
      }
      applyPayload(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "특수근무 목록 실패");
    } finally {
      setLoading(false);
    }
  }, [date, applyPayload]);

  useEffect(() => {
    void load();
  }, [load]);

  const displayGroups = useMemo(() => {
    if (!excludedRows?.length) return groups;
    const extra = unavailableReasonsFromRows(excludedRows);
    return groups.map((group) => {
      const annotated = annotateSpecialDutyConflicts(
        groups.flatMap((g) => g.items),
        extra
      );
      const items = annotated.filter((row) => row.kind === group.kind);
      return { ...group, items, count: items.length };
    });
  }, [groups, excludedRows]);

  async function ensureCaddies() {
    if (caddies.length) return;
    const res = await fetch("/api/caddies?employment=all", {
      credentials: "include",
    });
    const data = await res.json();
    if (Array.isArray(data)) setCaddies(data as SearchCaddy[]);
  }

  async function openModal() {
    setModalOpen(true);
    setQuery("");
    setPaste("");
    await ensureCaddies();
  }

  const hits = useMemo(() => {
    const q = normalizePersonName(query);
    if (!q) return [];
    return caddies
      .filter((c) => normalizePersonName(c.name).includes(q))
      .slice(0, 12);
  }, [caddies, query]);

  async function postAdd(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/daily-special-duties", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, kind, ...body }),
      });
      const data = (await res.json()) as ListPayload;
      if (!res.ok) {
        setError(data.error || "등록 실패");
        return;
      }
      applyPayload(data);
      setOpenKinds((prev) => new Set(prev).add(kind));
      const dup = data.duplicates?.length || 0;
      const added = data.added?.length || 0;
      const reviews = data.reviews?.length || 0;
      const bits = [`${DAILY_SPECIAL_KIND_LABELS[kind]} ${added}명 추가`];
      if (dup) bits.push(`중복 ${dup}`);
      if (reviews) bits.push(`확인 ${reviews}`);
      showToast(bits.join(" · "));
      if (data.reviews?.length) {
        setError(
          data.reviews
            .map((r) => `${r.name}: ${r.reason || r.status}`)
            .join(" / ")
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "등록 실패");
    } finally {
      setBusy(false);
    }
  }

  async function onPick(caddyId: number) {
    await postAdd({ caddyIds: [caddyId] });
    setQuery("");
  }

  async function onPaste() {
    if (!paste.trim()) return;
    await postAdd({ namesText: paste });
    setPaste("");
  }

  async function onMove(id: number, direction: "up" | "down") {
    setBusy(true);
    try {
      const res = await fetch("/api/daily-special-duties", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "move", id, direction }),
      });
      const data = (await res.json()) as ListPayload;
      if (!res.ok) {
        setError(data.error || "순서 변경 실패");
        return;
      }
      applyPayload(data);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: number) {
    setBusy(true);
    try {
      const res = await fetch(`/api/daily-special-duties/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = (await res.json()) as ListPayload;
      if (!res.ok) {
        setError(data.error || "삭제 실패");
        return;
      }
      applyPayload(data);
      showToast("삭제 · 우선순위 재번호");
    } finally {
      setBusy(false);
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return (
      <section className="sd-panel">
        <div className="sd-title">특수근무</div>
        <p className="sd-hint">날짜를 선택하면 해당 날짜 특수근무만 표시됩니다.</p>
      </section>
    );
  }

  return (
    <section className="sd-panel">
      <div className="sd-head">
        <div>
          <div className="sd-title">특수근무</div>
          <p className="sd-hint">같은 유형 안 입력 순서가 우선순위입니다.</p>
        </div>
        <button type="button" className="sd-add" onClick={() => void openModal()}>
          + 특수근무 등록
        </button>
      </div>
      {loading ? <div className="sd-hint">불러오는 중…</div> : null}
      {error ? <div className="sd-error">{error}</div> : null}
      <div className="sd-groups">
        {displayGroups.map((group) => (
          <div key={group.kind} className="sd-group">
            <button
              type="button"
              className="sd-group-head"
              onClick={() =>
                setOpenKinds((prev) => {
                  const next = new Set(prev);
                  if (next.has(group.kind)) next.delete(group.kind);
                  else next.add(group.kind);
                  return next;
                })
              }
            >
              <span>
                {group.label} {group.count}명
              </span>
              <span className="sd-caret">
                {openKinds.has(group.kind) ? "▾" : "▸"}
              </span>
            </button>
            {openKinds.has(group.kind) ? (
              group.items.length === 0 ? (
                <div className="sd-empty">등록 없음</div>
              ) : (
                <ol className="sd-list">
                  {group.items.map((item, index) => (
                    <li key={item.id || `${item.caddyId}-${index}`}>
                      <div className="sd-row">
                        <span className="sd-pri">{item.sortOrder}</span>
                        <div className="sd-who">
                          <strong>{item.name}</strong>
                          <span>
                            {item.team} {item.teamOrder}번
                          </span>
                          {item.conflicts?.length
                            ? item.conflicts.map((c, i) => (
                                <em key={`${c.code}-${i}`} className="sd-warn">
                                  {c.message}
                                </em>
                              ))
                            : null}
                        </div>
                        <div className="sd-ops">
                          <button
                            type="button"
                            disabled={busy || index === 0}
                            onClick={() => item.id && void onMove(item.id, "up")}
                          >
                            위
                          </button>
                          <button
                            type="button"
                            disabled={busy || index === group.items.length - 1}
                            onClick={() =>
                              item.id && void onMove(item.id, "down")
                            }
                          >
                            아래
                          </button>
                          <button
                            type="button"
                            className="danger"
                            disabled={busy}
                            onClick={() => item.id && void onDelete(item.id)}
                          >
                            삭제
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )
            ) : null}
          </div>
        ))}
      </div>

      {modalOpen ? (
        <div className="sd-modal" role="dialog" aria-modal="true">
          <div className="sd-sheet">
            <div className="sd-sheet-head">
              <strong>특수근무 등록</strong>
              <button type="button" onClick={() => setModalOpen(false)}>
                닫기
              </button>
            </div>
            <div className="sd-kinds">
              {DAILY_SPECIAL_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={kind === k ? "on" : ""}
                  onClick={() => setKind(k)}
                >
                  {DAILY_SPECIAL_KIND_LABELS[k]}
                </button>
              ))}
            </div>
            <label className="sd-field">
              <span>이름 검색 · 연속 추가</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="이름 일부"
                autoComplete="off"
              />
            </label>
            {hits.length > 0 ? (
              <ul className="sd-hits">
                {hits.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onPick(c.id)}
                    >
                      {c.name} · {c.team} {c.teamOrder}번
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <label className="sd-field">
              <span>이름 붙여넣기 (줄바꿈)</span>
              <textarea
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                rows={4}
                placeholder={"김A\n김B\n김C"}
              />
            </label>
            <button
              type="button"
              className="sd-save"
              disabled={busy || !paste.trim()}
              onClick={() => void onPaste()}
            >
              {busy ? "저장 중…" : `${DAILY_SPECIAL_KIND_LABELS[kind]} 일괄등록`}
            </button>
            <p className="sd-hint">
              한 명씩 탭하거나 붙여넣은 뒤에도 창이 유지됩니다. 같은 유형은
              입력 순서가 우선순위입니다.
            </p>
          </div>
        </div>
      ) : null}
      {toast ? <div className="sd-toast">{toast}</div> : null}
      <style>{`
        .sd-panel {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid #e2e8f0;
        }
        .sd-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 8px;
        }
        .sd-title {
          font-weight: 800;
          font-size: 0.95rem;
        }
        .sd-hint {
          margin: 4px 0 0;
          color: #64748b;
          font-size: 0.78rem;
          line-height: 1.4;
        }
        .sd-add,
        .sd-save {
          min-height: 44px;
          border-radius: 10px;
          border: 0;
          background: #0f172a;
          color: #fff;
          font-weight: 700;
          padding: 0 12px;
        }
        .sd-error {
          margin-top: 8px;
          color: #b45309;
          font-size: 0.8rem;
        }
        .sd-groups {
          margin-top: 8px;
          display: grid;
          gap: 6px;
        }
        .sd-group {
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          overflow: hidden;
          background: #fff;
        }
        .sd-group-head {
          width: 100%;
          min-height: 44px;
          display: flex;
          justify-content: space-between;
          padding: 0 12px;
          background: #f8fafc;
          border: 0;
          font-weight: 700;
        }
        .sd-empty {
          padding: 10px 12px;
          color: #94a3b8;
          font-size: 0.8rem;
        }
        .sd-list {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        .sd-row {
          display: grid;
          grid-template-columns: 28px 1fr;
          gap: 6px;
          padding: 8px 10px;
          border-top: 1px solid #f1f5f9;
        }
        .sd-pri {
          font-weight: 800;
          color: #0f172a;
          padding-top: 2px;
        }
        .sd-who {
          display: flex;
          flex-direction: column;
          gap: 2px;
          font-size: 0.8rem;
        }
        .sd-who span {
          color: #64748b;
          font-size: 0.72rem;
        }
        .sd-warn {
          color: #b45309;
          font-style: normal;
          font-size: 0.72rem;
        }
        .sd-ops {
          grid-column: 1 / -1;
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 6px;
        }
        .sd-ops button {
          min-height: 40px;
          border-radius: 8px;
          border: 1px solid #e2e8f0;
          background: #fff;
        }
        .sd-ops button.danger {
          color: #b91c1c;
        }
        .sd-modal {
          position: fixed;
          inset: 0;
          background: rgba(15, 23, 42, 0.45);
          z-index: 80;
          display: flex;
          align-items: flex-end;
        }
        .sd-sheet {
          width: 100%;
          max-height: 92vh;
          overflow: auto;
          background: #fff;
          border-radius: 16px 16px 0 0;
          padding: 12px;
        }
        .sd-sheet-head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        .sd-sheet-head button {
          min-height: 40px;
          border: 0;
          background: transparent;
          font-weight: 700;
        }
        .sd-kinds {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 6px;
          margin-bottom: 10px;
        }
        .sd-kinds button {
          min-height: 40px;
          border-radius: 8px;
          border: 1px solid #e2e8f0;
          background: #fff;
        }
        .sd-kinds button.on {
          background: #0f172a;
          color: #fff;
          border-color: #0f172a;
          font-weight: 700;
        }
        .sd-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-bottom: 8px;
          font-size: 0.78rem;
        }
        .sd-field input,
        .sd-field textarea {
          min-height: 44px;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          padding: 8px;
          font-size: 1rem;
        }
        .sd-hits {
          list-style: none;
          margin: 0 0 8px;
          padding: 0;
          display: grid;
          gap: 4px;
        }
        .sd-hits button {
          width: 100%;
          min-height: 44px;
          text-align: left;
          padding: 0 10px;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          background: #fff;
        }
        .sd-save {
          width: 100%;
          margin-bottom: 8px;
        }
        .sd-toast {
          position: fixed;
          left: 50%;
          bottom: 16px;
          transform: translateX(-50%);
          background: #0f172a;
          color: #fff;
          padding: 8px 12px;
          border-radius: 8px;
          font-size: 0.8rem;
          z-index: 90;
        }
      `}</style>
    </section>
  );
}
