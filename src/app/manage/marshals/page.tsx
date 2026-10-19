"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import MarshalCaddyPicker from "@/components/manage/MarshalCaddyPicker";
import MarshalManageNav from "@/components/manage/MarshalManageNav";
import type { MarshalRosterRow } from "@/lib/marshalDomain";
import {
  MARSHAL_ROSTER_PC_COLUMN_COUNT,
  MARSHAL_ROSTER_UNSAVED_LEAVE_MESSAGE,
  buildMarshalActivePatch,
  buildMarshalCreateBody,
  buildMarshalEditorPatch,
  buildMarshalRotationPatch,
  columnizeMarshalRoster,
  listMarshalAddableCaddies,
  marshalRosterColumnTitle,
  marshalRosterEditorDraftFromRow,
  marshalRosterEditorIsDirty,
  marshalRosterSaveErrorMessage,
  parseMarshalRosterOrderInput,
  toMarshalRosterDenseView,
  visibleMarshalRoster,
  type MarshalPickerCaddy,
  type MarshalRosterEditorDraft,
} from "@/lib/marshalRosterUi";

type CaddyOption = MarshalPickerCaddy & {
  employmentStatus?: string | null;
};

export default function ManageMarshalsPage() {
  const [marshals, setMarshals] = useState<MarshalRosterRow[]>([]);
  const [caddies, setCaddies] = useState<CaddyOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [caddyId, setCaddyId] = useState("");
  const [rotationOrder, setRotationOrder] = useState("");
  const [showInactive, setShowInactive] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [orderDrafts, setOrderDrafts] = useState<Record<number, string>>({});
  const [pcEditor, setPcEditor] = useState<MarshalRosterEditorDraft | null>(
    null
  );

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const [marshalRes, caddyRes] = await Promise.all([
        fetch("/api/marshals", { credentials: "include" }),
        fetch("/api/caddies?employment=ACTIVE", { credentials: "include" }),
      ]);
      const marshalJson = await marshalRes.json().catch(() => ({}));
      const caddyJson = await caddyRes.json().catch(() => []);
      if (!marshalRes.ok) {
        throw new Error(marshalJson?.error || "마샬 명단 조회 실패");
      }
      if (!caddyRes.ok) {
        throw new Error(caddyJson?.error || "캐디 목록 조회 실패");
      }
      setMarshals(Array.isArray(marshalJson.marshals) ? marshalJson.marshals : []);
      setCaddies(Array.isArray(caddyJson) ? caddyJson : []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "조회 실패");
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const registeredIds = useMemo(
    () => new Set(marshals.map((row) => row.caddyId)),
    [marshals]
  );
  const addable = useMemo(
    () => listMarshalAddableCaddies(caddies, registeredIds),
    [caddies, registeredIds]
  );
  const visible = visibleMarshalRoster(marshals, showInactive);
  const boardColumns = useMemo(
    () => columnizeMarshalRoster(visible, MARSHAL_ROSTER_PC_COLUMN_COUNT),
    [visible]
  );
  const selectedRow =
    selectedId == null
      ? null
      : (visible.find((row) => row.id === selectedId) ?? null);
  const selectedView = selectedRow
    ? toMarshalRosterDenseView(selectedRow)
    : null;
  const pcDirty = marshalRosterEditorIsDirty(selectedRow, pcEditor);

  useEffect(() => {
    if (selectedId == null) return;
    if (!visible.some((row) => row.id === selectedId)) {
      setSelectedId(null);
      setPcEditor(null);
    }
  }, [visible, selectedId]);

  useEffect(() => {
    if (!pcDirty) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [pcDirty]);

  const clearOrderDraft = (id: number) => {
    setOrderDrafts((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const confirmLeaveUnsaved = () => {
    if (!pcDirty) return true;
    return window.confirm(MARSHAL_ROSTER_UNSAVED_LEAVE_MESSAGE);
  };

  const closePcPanel = (opts?: { force?: boolean }) => {
    if (!opts?.force && !confirmLeaveUnsaved()) return false;
    setSelectedId(null);
    setPcEditor(null);
    return true;
  };

  useEffect(() => {
    if (selectedRow == null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closePcPanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedRow, pcDirty]);

  const openPcEditor = (row: MarshalRosterRow) => {
    if (selectedId === row.id) {
      closePcPanel();
      return;
    }
    if (selectedId != null && selectedId !== row.id && !confirmLeaveUnsaved()) {
      return;
    }
    setSelectedId(row.id);
    setPcEditor(marshalRosterEditorDraftFromRow(row));
    setError(null);
  };

  const createMarshal = async () => {
    if (!caddyId) {
      setError("캐디를 선택하세요.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/marshals", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildMarshalCreateBody({ caddyId, rotationOrder })),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          marshalRosterSaveErrorMessage({
            status: res.status,
            code: (data as { code?: unknown }).code,
            error: (data as { error?: unknown }).error,
            fallback: "등록 실패",
          })
        );
      }
      setCaddyId("");
      setRotationOrder("");
      setAddOpen(false);
      await load({ silent: true });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "등록 실패");
    } finally {
      setCreating(false);
    }
  };

  const patchMarshal = async (
    row: MarshalRosterRow,
    body: { active?: boolean; rotationOrder?: number | null }
  ) => {
    setBusyId(row.id);
    setError(null);
    try {
      const res = await fetch(`/api/marshals/${row.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.rotationOrder !== undefined) clearOrderDraft(row.id);
        throw new Error(
          marshalRosterSaveErrorMessage({
            status: res.status,
            code: (data as { code?: unknown }).code,
            error: (data as { error?: unknown }).error,
            fallback: "수정 실패",
          })
        );
      }
      clearOrderDraft(row.id);
      await load({ silent: true });
      return true;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "수정 실패");
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const orderValue = (row: MarshalRosterRow) =>
    Object.prototype.hasOwnProperty.call(orderDrafts, row.id)
      ? orderDrafts[row.id]
      : row.rotationOrder == null
        ? ""
        : String(row.rotationOrder);

  const commitRotation = (row: MarshalRosterRow, raw: string) => {
    const parsed = parseMarshalRosterOrderInput(raw);
    if (!parsed.ok) {
      setError(parsed.message);
      clearOrderDraft(row.id);
      return;
    }
    if (parsed.value === row.rotationOrder) {
      clearOrderDraft(row.id);
      return;
    }
    void patchMarshal(row, buildMarshalRotationPatch(parsed.value));
  };

  const savePcEditor = async () => {
    if (!selectedRow || !pcEditor) return;
    const next = buildMarshalEditorPatch({ row: selectedRow, draft: pcEditor });
    if (!next.ok) {
      setError(next.message);
      return;
    }
    if (next.body == null) {
      setPcEditor(marshalRosterEditorDraftFromRow(selectedRow));
      return;
    }
    const ok = await patchMarshal(selectedRow, next.body);
    if (ok) {
      setPcEditor((current) =>
        current && current.marshalId === selectedRow.id
          ? {
              marshalId: selectedRow.id,
              orderText: current.orderText,
              active: current.active,
            }
          : current
      );
    }
  };

  const renderRosterRow = (
    row: MarshalRosterRow,
    opts?: { showType?: boolean; surface?: "dense" | "board" }
  ) => {
    const view = toMarshalRosterDenseView(row);
    const busy = busyId === row.id;
    const surface = opts?.surface ?? "dense";
    const inlineEdit = surface === "dense";
    const open = selectedId === row.id;
    const panelId = inlineEdit
      ? `marshal-panel-${surface}-${row.id}`
      : "marshal-detail-panel";
    const showType = opts?.showType === true;
    return (
      <li
        key={row.id}
        className={`mr-dense-row${view.active ? "" : " is-inactive"}${
          open ? " is-open" : ""
        }`}
        data-marshal-row={row.id}
        data-marshal-surface={surface}
      >
        <button
          type="button"
          className="mr-dense-main"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            if (inlineEdit) {
              setSelectedId((id) => (id === row.id ? null : row.id));
              return;
            }
            openPcEditor(row);
          }}
        >
          <span className="mr-dense-order">{view.orderText}</span>
          {showType ? (
            <span className="mr-dense-copy">
              <span className="mr-dense-name">{view.name}</span>
              <span className="mr-dense-sub">
                {view.team} · {view.typeLabel}
              </span>
            </span>
          ) : (
            <>
              <span className="mr-dense-name">{view.name}</span>
              <span className="mr-dense-team">{view.team}</span>
            </>
          )}
          <span
            className={`ui-pill mr-dense-status${view.active ? "" : " muted"}`}
          >
            {view.statusLabel}
          </span>
          <span className="mr-dense-more" aria-hidden>
            {open ? (inlineEdit ? "▾" : "‹") : "›"}
          </span>
        </button>
        {inlineEdit && open ? (
          <div
            id={panelId}
            className="mr-dense-panel"
            data-marshal-panel={row.id}
          >
            <p className="mr-dense-meta">{view.metaText}</p>
            <div className="mr-dense-actions">
              <label className="mr-dense-order-field">
                <span>순번</span>
                <input
                  aria-label={`${row.caddy.name} 순번`}
                  className="ui-input mr-order-input"
                  type="number"
                  min={1}
                  value={orderValue(row)}
                  disabled={busy}
                  onChange={(e) =>
                    setOrderDrafts((current) => ({
                      ...current,
                      [row.id]: e.target.value,
                    }))
                  }
                  onBlur={(e) => commitRotation(row, e.target.value)}
                />
              </label>
              <button
                type="button"
                className={`ui-btn mr-action-btn${
                  row.active ? "" : " ui-btn-primary"
                }`}
                disabled={busy}
                onClick={() =>
                  void patchMarshal(row, buildMarshalActivePatch(!row.active))
                }
              >
                {busy ? "저장 중…" : view.actionLabel}
              </button>
            </div>
          </div>
        ) : null}
      </li>
    );
  };

  const pcBusy = selectedRow != null && busyId === selectedRow.id;
  const pcActive = pcEditor?.active ?? selectedRow?.active ?? false;

  return (
    <div className="vh-page">
      <div className="vh-page-head">
        <h1>마샬 관리</h1>
        <p>
          관리자가 지정한 마샬만 순환 대상입니다. 순번은 월을 넘어 이어집니다.
        </p>
      </div>
      <MarshalManageNav />

      <div className="mr-toolbar">
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          aria-expanded={addOpen}
          aria-controls="marshal-add-panel"
          data-marshal-add-toggle="1"
          onClick={() => setAddOpen((open) => !open)}
        >
          {addOpen ? "추가 닫기" : "마샬 추가"}
        </button>
        <label className="mr-inactive-toggle">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          비활성 포함
        </label>
        <span className="mr-toolbar-count">명단 {visible.length}명</span>
      </div>

      {addOpen ? (
        <form
          id="marshal-add-panel"
          className="ui-card mr-add-card"
          data-marshal-add-form="1"
          data-marshal-add-panel="1"
          onSubmit={(e) => {
            e.preventDefault();
            void createMarshal();
          }}
        >
          <h2>마샬 추가</h2>
          <p>
            재직(ACTIVE) 캐디만 등록할 수 있습니다. 조·유형은 캐디 관리 값을
            그대로 표시합니다.
          </p>
          <div className="mr-add-row">
            <div className="mr-add-picker">
              <MarshalCaddyPicker
                aria-label="캐디"
                options={addable}
                value={caddyId}
                onChange={setCaddyId}
                disabled={creating}
              />
            </div>
            <input
              aria-label="마샬 순번"
              className="ui-input mr-add-order"
              type="number"
              min={1}
              placeholder="순번"
              value={rotationOrder}
              onChange={(e) => setRotationOrder(e.target.value)}
              disabled={creating}
            />
            <button
              type="submit"
              className="ui-btn ui-btn-primary mr-add-submit"
              disabled={creating || !caddyId}
            >
              {creating ? "등록 중…" : "명단에 추가"}
            </button>
          </div>
        </form>
      ) : null}

      {error && (
        <p className="vh-auth-error" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </p>
      )}

      {loading ? (
        <p>불러오는 중…</p>
      ) : (
        <>
          <ul className="mr-roster-dense" data-marshal-roster="dense">
            {visible.length === 0 ? (
              <li className="mr-roster-dense-empty">등록된 마샬이 없습니다.</li>
            ) : (
              visible.map((row) => renderRosterRow(row, { surface: "dense" }))
            )}
          </ul>

          <div
            className="mr-roster-frame"
            data-marshal-roster-frame="1"
          >
          <div
            className={`mr-roster-workspace${
              selectedRow ? " is-split" : ""
            }`}
            data-marshal-workspace={selectedRow ? "split" : "board"}
          >
            <div className="mr-roster-board-scroll">
            <div
              className="mr-roster-board"
              data-marshal-roster="board"
              data-marshal-board-cols={MARSHAL_ROSTER_PC_COLUMN_COUNT}
              aria-label="마샬 압축 명단"
            >
              {visible.length === 0 ? (
                <p className="mr-roster-board-empty">등록된 마샬이 없습니다.</p>
              ) : (
                boardColumns.map((column, index) => (
                  <section
                    key={index}
                    className="mr-roster-col"
                    data-marshal-col={index}
                  >
                    <header className="mr-roster-col-head">
                      <span className="mr-roster-col-title">
                        {marshalRosterColumnTitle(column)}
                      </span>
                      <span className="mr-roster-col-count">
                        {column.length}명
                      </span>
                    </header>
                    <ul className="mr-roster-col-list">
                      {column.length === 0 ? (
                        <li className="mr-roster-dense-empty">없음</li>
                      ) : (
                        column.map((row) =>
                          renderRosterRow(row, {
                            showType: true,
                            surface: "board",
                          })
                        )
                      )}
                    </ul>
                  </section>
                ))
              )}
            </div>
            </div>

            {selectedRow && selectedView && pcEditor ? (
              <>
              <button
                type="button"
                className="mr-detail-backdrop"
                data-marshal-detail-backdrop="1"
                aria-label="상세 패널 닫기"
                onClick={() => closePcPanel()}
              />
              <aside
                id="marshal-detail-panel"
                className="ui-card mr-detail"
                data-marshal-detail-panel="1"
                data-marshal-detail-dirty={pcDirty ? "1" : "0"}
                aria-label={`${selectedView.name} 상세 편집`}
              >
                <div className="mr-detail-head">
                  <div>
                    <h2>{selectedView.name}</h2>
                    <p className="mr-detail-meta">{selectedView.metaText}</p>
                  </div>
                  <button
                    type="button"
                    className="ui-btn"
                    onClick={() => closePcPanel()}
                  >
                    닫기
                  </button>
                </div>
                <dl className="mr-detail-dl">
                  <dt>조</dt>
                  <dd>{selectedView.team}</dd>
                  <dt>유형</dt>
                  <dd>{selectedView.typeLabel}</dd>
                  <dt>재직</dt>
                  <dd>{selectedView.employmentLabel}</dd>
                  <dt>상태</dt>
                  <dd>
                    <span
                      className={`ui-pill${pcActive ? "" : " muted"}`}
                    >
                      {pcActive ? "활성" : "비활성"}
                    </span>
                  </dd>
                </dl>
                <label className="mr-detail-order-field">
                  <span>순번</span>
                  <input
                    aria-label={`${selectedRow.caddy.name} 순번`}
                    className="ui-input mr-order-input"
                    type="number"
                    min={1}
                    value={pcEditor.orderText}
                    disabled={pcBusy}
                    onChange={(e) =>
                      setPcEditor((current) =>
                        current
                          ? { ...current, orderText: e.target.value }
                          : current
                      )
                    }
                  />
                </label>
                <div className="mr-detail-actions">
                  <button
                    type="button"
                    className={`ui-btn mr-action-btn${
                      pcActive ? "" : " ui-btn-primary"
                    }`}
                    disabled={pcBusy}
                    onClick={() =>
                      setPcEditor((current) =>
                        current
                          ? { ...current, active: !current.active }
                          : current
                      )
                    }
                  >
                    {pcActive ? "비활성" : "복구"}
                  </button>
                  <button
                    type="button"
                    className="ui-btn"
                    disabled={pcBusy || !pcDirty}
                    onClick={() =>
                      setPcEditor(
                        marshalRosterEditorDraftFromRow(selectedRow)
                      )
                    }
                  >
                    취소
                  </button>
                  <button
                    type="button"
                    className="ui-btn ui-btn-primary"
                    disabled={pcBusy || !pcDirty}
                    onClick={() => void savePcEditor()}
                  >
                    {pcBusy ? "저장 중…" : "저장"}
                  </button>
                </div>
              </aside>
              </>
            ) : null}
          </div>
          </div>
        </>
      )}
    </div>
  );
}
