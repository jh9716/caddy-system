"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import MarshalCaddyPicker from "@/components/manage/MarshalCaddyPicker";
import MarshalManageNav from "@/components/manage/MarshalManageNav";
import { employmentStatusLabel } from "@/lib/caddyManage";
import { caddyTypeLabel } from "@/lib/marshalDomain";
import type { MarshalRosterRow } from "@/lib/marshalDomain";
import {
  MARSHAL_ROSTER_TABLE_COLUMNS,
  buildMarshalActivePatch,
  buildMarshalCreateBody,
  buildMarshalRotationPatch,
  listMarshalAddableCaddies,
  marshalRosterSaveErrorMessage,
  toMarshalRosterDenseView,
  visibleMarshalRoster,
  type MarshalPickerCaddy,
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
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [orderDrafts, setOrderDrafts] = useState<Record<number, string>>({});

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

  useEffect(() => {
    if (expandedId == null) return;
    if (!visible.some((row) => row.id === expandedId)) {
      setExpandedId(null);
    }
  }, [visible, expandedId]);

  const clearOrderDraft = (id: number) => {
    setOrderDrafts((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
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
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "수정 실패");
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
    const trimmed = raw.trim();
    const next = trimmed === "" ? null : Number(trimmed);
    if (trimmed !== "" && (!Number.isInteger(next) || Number(next) < 1)) {
      setError("마샬 순번은 1 이상 정수여야 합니다.");
      clearOrderDraft(row.id);
      return;
    }
    if (next === row.rotationOrder) {
      clearOrderDraft(row.id);
      return;
    }
    void patchMarshal(row, buildMarshalRotationPatch(next));
  };

  return (
    <div className="vh-page">
      <div className="vh-page-head">
        <h1>마샬 관리</h1>
        <p>
          관리자가 지정한 마샬만 순환 대상입니다. 순번은 월을 넘어 이어집니다.
        </p>
      </div>
      <MarshalManageNav />

      <form
        className="ui-card mr-add-card"
        data-marshal-add-form="1"
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

      {error && (
        <p className="vh-auth-error" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </p>
      )}

      <label className="mr-inactive-toggle">
        <input
          type="checkbox"
          checked={showInactive}
          onChange={(e) => setShowInactive(e.target.checked)}
        />
        비활성 포함
      </label>

      {loading ? (
        <p>불러오는 중…</p>
      ) : (
        <>
          <ul className="mr-roster-dense" data-marshal-roster="dense">
            {visible.length === 0 ? (
              <li className="mr-roster-dense-empty">등록된 마샬이 없습니다.</li>
            ) : (
              visible.map((row) => {
                const view = toMarshalRosterDenseView(row);
                const busy = busyId === row.id;
                const open = expandedId === row.id;
                const panelId = `marshal-panel-${row.id}`;
                return (
                  <li
                    key={row.id}
                    className={`mr-dense-row${view.active ? "" : " is-inactive"}${
                      open ? " is-open" : ""
                    }`}
                    data-marshal-row={row.id}
                  >
                    <button
                      type="button"
                      className="mr-dense-main"
                      aria-expanded={open}
                      aria-controls={panelId}
                      onClick={() =>
                        setExpandedId((id) => (id === row.id ? null : row.id))
                      }
                    >
                      <span className="mr-dense-order">{view.orderText}</span>
                      <span className="mr-dense-name">{view.name}</span>
                      <span className="mr-dense-team">{view.team}</span>
                      <span
                        className={`ui-pill mr-dense-status${
                          view.active ? "" : " muted"
                        }`}
                      >
                        {view.statusLabel}
                      </span>
                      <span className="mr-dense-more" aria-hidden>
                        {open ? "▾" : "›"}
                      </span>
                    </button>
                    {open ? (
                      <div
                        id={panelId}
                        className="mr-dense-panel"
                        data-marshal-panel={row.id}
                      >
                        <p className="mr-dense-meta">
                          조 {view.team} · 유형 {view.typeLabel} · 재직{" "}
                          {view.employmentLabel}
                        </p>
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
                              void patchMarshal(
                                row,
                                buildMarshalActivePatch(!row.active)
                              )
                            }
                          >
                            {busy ? "저장 중…" : view.actionLabel}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })
            )}
          </ul>

          <div
            className="ui-table-wrap mr-roster-table"
            data-marshal-roster="table"
          >
            <table className="ui-table">
              <thead>
                <tr>
                  {MARSHAL_ROSTER_TABLE_COLUMNS.map((col) => (
                    <th key={col}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 ? (
                  <tr>
                    <td colSpan={7}>등록된 마샬이 없습니다.</td>
                  </tr>
                ) : (
                  visible.map((row) => {
                    const busy = busyId === row.id;
                    return (
                      <tr key={row.id}>
                        <td className="mr-order-cell">
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
                        </td>
                        <td className="mr-name">{row.caddy.name}</td>
                        <td>{row.caddy.team}</td>
                        <td>{caddyTypeLabel(row.caddy.caddyType)}</td>
                        <td>{employmentStatusLabel(row.caddy.employmentStatus)}</td>
                        <td>
                          <span
                            className={`ui-pill${row.active ? "" : " muted"}`}
                          >
                            {row.active ? "활성" : "비활성"}
                          </span>
                        </td>
                        <td className="mr-action-cell">
                          <button
                            type="button"
                            className={`ui-btn mr-action-btn${
                              row.active ? "" : " ui-btn-primary"
                            }`}
                            disabled={busy}
                            onClick={() =>
                              void patchMarshal(
                                row,
                                buildMarshalActivePatch(!row.active)
                              )
                            }
                          >
                            {busy
                              ? "저장 중…"
                              : row.active
                                ? "비활성"
                                : "복구"}
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
