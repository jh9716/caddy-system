"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { normalizePersonName } from "@/lib/dailyCaddyNameMatch";
import {
  DAILY_SPECIAL_KINDS,
  DAILY_SPECIAL_KIND_LABELS,
  ANCHOR_SPECIAL_KINDS,
  annotateSpecialDutyConflicts,
  appendSpecialDutyPick,
  isSpecialDutyPayloadForSelectedDate,
  mergePastedSpecialDutyPicks,
  moveItemIndex,
  renumberSortOrders,
  unavailableReasonsFromRows,
  type DailySpecialKind,
  type SpecialDutyAnchors,
  type SpecialDutyConflict,
  type SpecialDutyPick,
  type SpecialDutyRecord,
  type SpecialStartAnchor,
} from "@/lib/dailySpecialDuty";
import { formatCaddyLabel } from "@/lib/caddyDisplay";
import {
  computeShift1SpecialWindow,
  formatShift1Range,
  parseProtectedTailCount,
  PROTECTED_TAIL_COUNT_DEFAULT,
  sliceShift1WindowSlots,
  type SpecialPlacementMode,
} from "@/lib/specialPlacement";
import { resolveCourseCode } from "@/lib/autoAssignEngine";
import { COURSE_LABELS } from "@/lib/reservationParser";

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
  anchors?: SpecialDutyAnchors;
  placement?: {
    mode: SpecialPlacementMode;
    protectedTailCount: number;
  };
  added?: SpecialDutyRecord[];
  reviews?: Array<{ status: string; name: string; reason?: string }>;
  duplicates?: Array<{ caddyId: number; name?: string }>;
  error?: string;
};

export type Shift1StartOption = {
  course: string;
  teeTime: string;
  teamName?: string | null;
  label: string;
};

type SearchCaddy = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  employmentStatus: string;
};

const EMPTY_ANCHORS: SpecialDutyAnchors = {
  ONE_THREE: null,
  ONE_MAK: null,
};

function anchorValue(anchor: SpecialStartAnchor | null | undefined): string {
  if (!anchor?.course || !anchor?.teeTime) return "";
  return `${anchor.course}@@${anchor.teeTime}`;
}

export function SpecialDutyPanel({
  date,
  excludedRows,
  shift1Options = [],
}: {
  date: string;
  excludedRows?: Array<{ id: number; excludedReasons?: string[] | null }>;
  shift1Options?: Shift1StartOption[];
}) {
  const [groups, setGroups] = useState<GroupPayload[]>([]);
  const [anchors, setAnchors] = useState<SpecialDutyAnchors>(EMPTY_ANCHORS);
  const [placementMode, setPlacementMode] =
    useState<SpecialPlacementMode>("AUTO");
  const [protectedTailCount, setProtectedTailCount] = useState(
    PROTECTED_TAIL_COUNT_DEFAULT
  );
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
  const [selected, setSelected] = useState<SpecialDutyPick[]>([]);
  const [pasteWarnings, setPasteWarnings] = useState<string | null>(null);
  const [deletedIdsByKind, setDeletedIdsByKind] = useState<
    Partial<Record<DailySpecialKind, number[]>>
  >({});
  const [dirtyKinds, setDirtyKinds] = useState<Set<DailySpecialKind>>(new Set());

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }, []);

  const applyPayload = useCallback((data: ListPayload) => {
    setGroups(data.groups || []);
    if (data.anchors) setAnchors(data.anchors);
    if (data.placement?.mode) {
      setPlacementMode(data.placement.mode);
      const parsed = parseProtectedTailCount(data.placement.protectedTailCount);
      setProtectedTailCount(
        parsed.ok ? parsed.value : PROTECTED_TAIL_COUNT_DEFAULT
      );
    }
  }, []);

  const load = useCallback(async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setGroups([]);
      setAnchors(EMPTY_ANCHORS);
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
      if (!isSpecialDutyPayloadForSelectedDate(data, date)) {
        return;
      }
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
    setGroups([]);
    setAnchors(EMPTY_ANCHORS);
    setPlacementMode("AUTO");
    setProtectedTailCount(PROTECTED_TAIL_COUNT_DEFAULT);
    setError(null);
    setSelected([]);
    setPasteWarnings(null);
    setDeletedIdsByKind({});
    setDirtyKinds(new Set());
    const ac = new AbortController();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return () => ac.abort();
    }
    void (async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/daily-special-duties?date=${encodeURIComponent(date)}`,
          { credentials: "include", signal: ac.signal }
        );
        const data = (await res.json()) as ListPayload;
        if (ac.signal.aborted) return;
        if (!isSpecialDutyPayloadForSelectedDate(data, date)) return;
        if (!res.ok) {
          setError(data.error || "특수근무 목록을 불러오지 못했습니다.");
          return;
        }
        applyPayload(data);
      } catch (e) {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : "특수근무 목록 실패");
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [date, applyPayload]);

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
    const res = await fetch("/api/caddies", {
      credentials: "include",
    });
    const data = await res.json();
    if (Array.isArray(data)) setCaddies(data as SearchCaddy[]);
  }

  async function openModal() {
    setModalOpen(true);
    setQuery("");
    setPaste("");
    setSelected([]);
    setPasteWarnings(null);
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

  function onPick(caddy: SearchCaddy) {
    setPasteWarnings(null);
    const next = appendSpecialDutyPick(selected, {
      caddyId: caddy.id,
      name: caddy.name,
      team: caddy.team,
      teamOrder: caddy.teamOrder,
    });
    setSelected(next.selected);
    if (next.duplicate) setPasteWarnings(`${caddy.name}은(는) 이미 선택됨`);
    setQuery("");
  }

  function onPasteLocal() {
    if (!paste.trim()) return;
    const merged = mergePastedSpecialDutyPicks({
      selected,
      namesText: paste,
      caddies,
    });
    setSelected(merged.selected);
    const bits: string[] = [];
    if (merged.unmatched.length) bits.push(`불일치 ${merged.unmatched.join(", ")}`);
    if (merged.duplicates.length) bits.push(`중복 ${merged.duplicates.join(", ")}`);
    setPasteWarnings(bits.length ? bits.join(" · ") : null);
    setPaste("");
  }

  function moveSelected(index: number, direction: -1 | 1) {
    setSelected(moveItemIndex(selected, index, direction));
  }

  function removeSelected(caddyId: number) {
    setSelected(selected.filter((row) => row.caddyId !== caddyId));
  }

  async function onRegisterBatch() {
    if (!selected.length) return;
    await postAdd({ caddyIds: selected.map((row) => row.caddyId) });
    setSelected([]);
    setPasteWarnings(null);
  }

  function markDirty(kind: DailySpecialKind) {
    setDirtyKinds((prev) => new Set(prev).add(kind));
  }

  function onMoveLocal(kind: DailySpecialKind, index: number, direction: "up" | "down") {
    setGroups((prev) =>
      prev.map((group) => {
        if (group.kind !== kind) return group;
        const items = renumberSortOrders(
          moveItemIndex(group.items, index, direction === "up" ? -1 : 1)
        );
        return { ...group, items };
      })
    );
    markDirty(kind);
  }

  function onDeleteLocal(kind: DailySpecialKind, item: SpecialDutyRecord & { id?: number }) {
    if (item.id) {
      setDeletedIdsByKind((prev) => ({
        ...prev,
        [kind]: [...(prev[kind] || []), item.id!],
      }));
    }
    setGroups((prev) =>
      prev.map((group) => {
        if (group.kind !== kind) return group;
        const items = renumberSortOrders(
          group.items.filter((row) => row.caddyId !== item.caddyId)
        );
        return { ...group, items, count: items.length };
      })
    );
    markDirty(kind);
  }

  async function onSaveKind(kind: DailySpecialKind) {
    const group = groups.find((g) => g.kind === kind);
    if (!group) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/daily-special-duties", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "commitKind",
          date,
          kind,
          orderedCaddyIds: group.items.map((row) => row.caddyId),
          deleteIds: deletedIdsByKind[kind] || [],
        }),
      });
      const data = (await res.json()) as ListPayload;
      if (!res.ok) {
        setError(data.error || "저장 실패");
        return;
      }
      applyPayload(data);
      setDeletedIdsByKind((prev) => {
        const next = { ...prev };
        delete next[kind];
        return next;
      });
      setDirtyKinds((prev) => {
        const next = new Set(prev);
        next.delete(kind);
        return next;
      });
      showToast(`${DAILY_SPECIAL_KIND_LABELS[kind]} 저장`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  }

  async function onPlacement(
    nextMode: SpecialPlacementMode,
    nextTail: number
  ) {
    const parsed = parseProtectedTailCount(nextTail);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/daily-special-duties", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "placement",
          date,
          mode: nextMode,
          protectedTailCount: parsed.value,
        }),
      });
      const data = (await res.json()) as ListPayload;
      if (!res.ok) {
        setError(data.error || "위치 설정 저장 실패");
        return;
      }
      applyPayload(data);
      showToast(
        nextMode === "AUTO"
          ? `자동 배치 · 끝 ${parsed.value}팀 제외`
          : "수동 위치 지정"
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "위치 설정 저장 실패");
    } finally {
      setBusy(false);
    }
  }

  const eligibleCount = (kind: DailySpecialKind) =>
    (displayGroups.find((g) => g.kind === kind)?.items || []).filter(
      (row) => !row.conflicts?.length
    ).length;

  const windowPreview = useMemo(() => {
    return computeShift1SpecialWindow({
      N: shift1Options.length,
      R: protectedTailCount,
      A: eligibleCount("ONE_THREE"),
      B: eligibleCount("ONE_MAK"),
    });
  }, [shift1Options.length, protectedTailCount, displayGroups]);

  async function onAnchor(kind: DailySpecialKind, value: string) {
    const [course, teeTime] = value ? value.split("@@") : ["", ""];
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/daily-special-duties", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "anchor",
          date,
          kind,
          anchor: { course: course || "", teeTime: teeTime || "" },
        }),
      });
      const data = (await res.json()) as ListPayload;
      if (!res.ok) {
        setError(data.error || "시작 예약 저장 실패");
        return;
      }
      applyPayload(data);
      showToast(
        value
          ? `${DAILY_SPECIAL_KIND_LABELS[kind]} 시작 ${(data.anchors as SpecialDutyAnchors | undefined)?.[kind as "ONE_THREE" | "ONE_MAK"]?.teeTime || teeTime}`
          : `${DAILY_SPECIAL_KIND_LABELS[kind]} 시작 해제`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "시작 예약 저장 실패");
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
          <p className="sd-hint">
            같은 유형 안 선택 순서가 우선순위입니다. 순서/삭제는 화면에서 정리한 뒤
            한 번에 저장합니다.
          </p>
        </div>
        <button type="button" className="sd-add" onClick={() => void openModal()}>
          + 특수근무 등록
        </button>
      </div>
      {loading ? <div className="sd-hint">불러오는 중…</div> : null}
      {error ? <div className="sd-error">{error}</div> : null}
      <div className="sd-place">
        <div className="sd-place-title">1·3부 / 1막 1부 위치</div>
        <label className="sd-radio">
          <input
            type="radio"
            name="special-place-mode"
            checked={placementMode === "AUTO"}
            disabled={busy}
            onChange={() => void onPlacement("AUTO", protectedTailCount)}
          />
          <span>자동 배치</span>
        </label>
        {placementMode === "AUTO" ? (
          <div className="sd-auto">
            <div className="sd-tail">
              <span>뒤 일반순번 보호</span>
              <button
                type="button"
                className="sd-step"
                disabled={busy || protectedTailCount <= 0}
                onClick={() => void onPlacement("AUTO", protectedTailCount - 1)}
              >
                −
              </button>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={20}
                className="sd-tail-input"
                value={protectedTailCount}
                disabled={busy}
                onChange={(e) => {
                  const parsed = parseProtectedTailCount(e.target.value);
                  if (parsed.ok) setProtectedTailCount(parsed.value);
                }}
                onBlur={() => void onPlacement("AUTO", protectedTailCount)}
              />
              <button
                type="button"
                className="sd-step"
                disabled={busy || protectedTailCount >= 20}
                onClick={() => void onPlacement("AUTO", protectedTailCount + 1)}
              >
                +
              </button>
              <span>팀</span>
            </div>
            <div className="sd-window">
              {shift1Options.length === 0 ? (
                <p>1부 예약을 불러오면 순번과 코스/티타임을 표시합니다.</p>
              ) : windowPreview.ok ? (
                <>
                  <p>현재 1부 {windowPreview.N}팀</p>
                  <p>
                    1·3부 {formatShift1Range(windowPreview.oneThreeStart, windowPreview.oneThreeEnd)} 팀
                    {sliceShift1WindowSlots(
                      shift1Options,
                      windowPreview.oneThreeStart,
                      windowPreview.oneThreeEnd
                    ).map((slot) => (
                      <span key={`13-${slot.index}`} className="sd-slot">
                        {slot.index} {COURSE_LABELS[resolveCourseCode(slot.course) || "VERTHILL"] || slot.course}{" "}
                        {slot.teeTime}
                        {slot.teamName ? ` · ${slot.teamName}` : ""}
                      </span>
                    ))}
                  </p>
                  <p>
                    1막 {formatShift1Range(windowPreview.oneMakStart, windowPreview.oneMakEnd)} 팀
                    {sliceShift1WindowSlots(
                      shift1Options,
                      windowPreview.oneMakStart,
                      windowPreview.oneMakEnd
                    ).map((slot) => (
                      <span key={`1m-${slot.index}`} className="sd-slot">
                        {slot.index} {COURSE_LABELS[resolveCourseCode(slot.course) || "VERTHILL"] || slot.course}{" "}
                        {slot.teeTime}
                        {slot.teamName ? ` · ${slot.teamName}` : ""}
                      </span>
                    ))}
                  </p>
                  <p>마지막 {windowPreview.R}팀은 1·3부/1막 제외</p>
                </>
              ) : (
                <p className="sd-error">{windowPreview.message}</p>
              )}
            </div>
          </div>
        ) : null}
        <label className="sd-radio">
          <input
            type="radio"
            name="special-place-mode"
            checked={placementMode === "MANUAL"}
            disabled={busy}
            onChange={() => void onPlacement("MANUAL", protectedTailCount)}
          />
          <span>수동 위치 지정</span>
        </label>
      </div>
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
              <>
                {placementMode === "MANUAL" &&
                ANCHOR_SPECIAL_KINDS.includes(
                  group.kind as (typeof ANCHOR_SPECIAL_KINDS)[number]
                ) ? (
                  <label className="sd-anchor">
                    <span>1부 시작 예약 (코스+티타임)</span>
                    <select
                      value={anchorValue(
                        anchors[group.kind as "ONE_THREE" | "ONE_MAK"]
                      )}
                      disabled={busy || shift1Options.length === 0}
                      onChange={(e) =>
                        void onAnchor(group.kind, e.target.value)
                      }
                    >
                      <option value="">
                        {shift1Options.length === 0
                          ? "예약 Excel 업로드 후 선택"
                          : "시작 예약 선택…"}
                      </option>
                      {shift1Options.map((opt) => (
                        <option
                          key={`${opt.course}-${opt.teeTime}-${opt.label}`}
                          value={`${opt.course}@@${opt.teeTime}`}
                        >
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : group.kind === "FIFTY_FOUR" || group.kind === "ONE_TWO" ? (
                  <div className="sd-empty sd-rule">
                    {group.kind === "FIFTY_FOUR"
                      ? "1부 세 번째 자리부터 자동 배치"
                      : "1부는 첫 2자리(및 54홀) 다음, 2부는 HOUSE 첫근무 종료 지점"}
                  </div>
                ) : null}
                {group.items.length === 0 ? (
                  <div className="sd-empty">등록 없음</div>
                ) : (
                  <ol className="sd-list">
                  {group.items.map((item, index) => (
                    <li key={item.id || `${item.caddyId}-${index}`}>
                      <div className="sd-row">
                        <span className="sd-pri">{item.sortOrder}</span>
                        <div className="sd-who">
                          <strong>{formatCaddyLabel(item)}</strong>
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
                            disabled={index === 0}
                            onClick={() =>
                              onMoveLocal(group.kind, index, "up")
                            }
                          >
                            위
                          </button>
                          <button
                            type="button"
                            disabled={index === group.items.length - 1}
                            onClick={() =>
                              onMoveLocal(group.kind, index, "down")
                            }
                          >
                            아래
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => onDeleteLocal(group.kind, item)}
                          >
                            삭제
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
                )}
                {dirtyKinds.has(group.kind) ? (
                  <button
                    type="button"
                    className="sd-save sd-kind-save"
                    disabled={busy}
                    onClick={() => void onSaveKind(group.kind)}
                  >
                    {busy ? "저장 중…" : `${group.label} 변경 저장`}
                  </button>
                ) : null}
              </>
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
                    <button type="button" onClick={() => onPick(c)}>
                      {formatCaddyLabel(c)}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="sd-selected">
              <strong>선택 {selected.length}명</strong>
              {selected.length === 0 ? (
                <div className="sd-empty">검색 또는 붙여넣기로 추가</div>
              ) : (
                <ol className="sd-list">
                  {selected.map((row, index) => (
                    <li key={row.caddyId}>
                      <div className="sd-row">
                        <span className="sd-pri">{index + 1}</span>
                        <div className="sd-who">
                          <strong>{formatCaddyLabel(row)}</strong>
                        </div>
                        <div className="sd-ops">
                          <button
                            type="button"
                            disabled={index === 0}
                            onClick={() => moveSelected(index, -1)}
                          >
                            위
                          </button>
                          <button
                            type="button"
                            disabled={index === selected.length - 1}
                            onClick={() => moveSelected(index, 1)}
                          >
                            아래
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => removeSelected(row.caddyId)}
                          >
                            빼기
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
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
              disabled={!paste.trim()}
              onClick={onPasteLocal}
            >
              붙여넣기 목록에 추가
            </button>
            {pasteWarnings ? <div className="sd-error">{pasteWarnings}</div> : null}
            <button
              type="button"
              className="sd-save"
              disabled={busy || selected.length === 0}
              onClick={() => void onRegisterBatch()}
            >
              {busy
                ? "저장 중…"
                : `${selected.length}명 한번에 등록`}
            </button>
            <p className="sd-hint">
              선택 중에는 서버에 요청하지 않습니다. 마지막 등록 한 번만 저장됩니다.
            </p>
          </div>
        </div>
      ) : null}
      {toast ? <div className="sd-toast vh-manage-toast">{toast}</div> : null}
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
        .sd-place {
          margin-top: 10px;
          padding: 10px 12px;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
          background: #fff;
        }
        .sd-place-title {
          font-weight: 800;
          margin-bottom: 8px;
        }
        .sd-radio {
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 40px;
          font-weight: 700;
        }
        .sd-auto {
          padding: 0 0 8px 22px;
        }
        .sd-tail {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 6px;
          font-size: 0.85rem;
        }
        .sd-step,
        .sd-tail-input {
          min-height: 40px;
          min-width: 40px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          background: #fff;
          font-size: 1rem;
          font-weight: 700;
        }
        .sd-tail-input {
          width: 64px;
          text-align: center;
        }
        .sd-window {
          margin-top: 8px;
          font-size: 0.8rem;
          color: #334155;
        }
        .sd-window p {
          margin: 4px 0;
        }
        .sd-slot {
          display: block;
          color: #64748b;
          font-weight: 500;
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
        .sd-rule {
          padding-bottom: 0;
        }
        .sd-anchor {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 8px 12px;
          font-size: 0.75rem;
          color: #475569;
        }
        .sd-anchor select {
          min-height: 40px;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          background: #fff;
          font-size: 0.85rem;
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
          margin: 8px 0;
        }
        .sd-kind-save {
          margin: 8px;
          width: calc(100% - 16px);
        }
        .sd-selected {
          margin: 8px 0;
          padding: 8px;
          border: 1px solid #e2e8f0;
          border-radius: 10px;
        }
        .sd-toast {
          position: fixed;
          background: #0f172a;
          color: #fff;
          padding: 8px 12px;
          border-radius: 8px;
          font-size: 0.8rem;
          text-align: center;
        }
      `}</style>
    </section>
  );
}
