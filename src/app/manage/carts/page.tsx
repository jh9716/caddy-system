"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CART_KIND_LABELS,
  CART_KINDS,
  CART_OPERATIONAL_STATUSES,
  CART_STATUS_LABELS,
  type CartKind,
  type CartOperationalStatus,
} from "@/lib/cartManage";
import { isOperationalEmploymentStatus } from "@/lib/operationalRoster";

type Owner = {
  id: number;
  name: string;
  team: string;
  employmentStatus: string;
};

type CartRow = {
  id: number;
  number: string;
  kind: CartKind | string;
  kindLabel: string | null;
  ownerCaddyId: number | null;
  dormitoryOnly: boolean;
  operationalStatus: CartOperationalStatus | string;
  note: string | null;
  owner: Owner | null;
};

type CaddyOption = {
  id: number;
  name: string;
  team: string;
  employmentStatus: string;
};

type Draft = {
  number: string;
  kind: CartKind;
  kindLabel: string;
  ownerCaddyId: string;
  dormitoryOnly: boolean;
  operationalStatus: CartOperationalStatus;
  note: string;
};

const emptyDraft = (): Draft => ({
  number: "",
  kind: "STANDARD",
  kindLabel: "",
  ownerCaddyId: "",
  dormitoryOnly: false,
  operationalStatus: "ACTIVE",
  note: "",
});

function toDraft(row: CartRow): Draft {
  return {
    number: row.number,
    kind: row.kind === "OTHER" ? "OTHER" : "STANDARD",
    kindLabel: row.kindLabel ?? "",
    ownerCaddyId: row.ownerCaddyId ? String(row.ownerCaddyId) : "",
    dormitoryOnly: row.dormitoryOnly === true,
    operationalStatus:
      row.operationalStatus === "MAINTENANCE" ||
      row.operationalStatus === "DISABLED"
        ? row.operationalStatus
        : "ACTIVE",
    note: row.note ?? "",
  };
}

function draftPayload(draft: Draft) {
  return {
    number: draft.number.trim(),
    kind: draft.kind,
    kindLabel: draft.kindLabel.trim() || null,
    ownerCaddyId: draft.dormitoryOnly
      ? null
      : draft.ownerCaddyId
        ? Number(draft.ownerCaddyId)
        : null,
    dormitoryOnly: draft.dormitoryOnly === true,
    operationalStatus: draft.operationalStatus,
    note: draft.note.trim() || null,
  };
}

function ownerLabel(row: { name: string; team: string; id?: number }) {
  return `${row.name} · ${row.team}${row.id ? ` (#${row.id})` : ""}`;
}

export default function ManageCartsPage() {
  const [carts, setCarts] = useState<CartRow[]>([]);
  const [caddies, setCaddies] = useState<CaddyOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState<Draft>(emptyDraft);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft());
  const [savingId, setSavingId] = useState<number | null>(null);

  const ownerOptions = useMemo(
    () =>
      caddies.filter((c) => isOperationalEmploymentStatus(c.employmentStatus)),
    [caddies]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cartRes, caddyRes] = await Promise.all([
        fetch("/api/carts", { credentials: "include", cache: "no-store" }),
        fetch("/api/caddies?employment=all", {
          credentials: "include",
          cache: "no-store",
        }),
      ]);
      const cartJson = await cartRes.json().catch(() => ({}));
      if (!cartRes.ok) {
        throw new Error(cartJson?.error || "카트 목록을 불러오지 못했습니다.");
      }
      setCarts(Array.isArray(cartJson.carts) ? cartJson.carts : []);
      if (caddyRes.ok) {
        const list = await caddyRes.json().catch(() => []);
        setCaddies(Array.isArray(list) ? list : []);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function applyXorPatch(prev: Draft, patch: Partial<Draft>): Draft {
    const next = { ...prev, ...patch };
    if (patch.dormitoryOnly === true) {
      next.ownerCaddyId = "";
      next.dormitoryOnly = true;
    } else if (patch.ownerCaddyId) {
      next.dormitoryOnly = false;
    }
    return next;
  }

  function applyCreatePatch(patch: Partial<Draft>) {
    setCreateDraft((prev) => applyXorPatch(prev, patch));
  }

  function applyEditPatch(patch: Partial<Draft>) {
    setEditDraft((prev) => applyXorPatch(prev, patch));
  }

  async function createCart() {
    setCreating(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/carts", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftPayload(createDraft)),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || "등록 실패");
      }
      setCreateDraft(emptyDraft());
      setMessage(`카트 ${data.number} 등록됨`);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "등록 실패");
    } finally {
      setCreating(false);
    }
  }

  async function saveEdit(id: number) {
    setSavingId(id);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/carts/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftPayload(editDraft)),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || "수정 실패");
      }
      setEditingId(null);
      setMessage(`카트 ${data.number} 저장됨`);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "수정 실패");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="vh-page">
      <div className="vh-page-head">
        <h1>카트 관리</h1>
        <p>
          카트 번호, 종류, 고정 주인, 기숙사 전용, 운행 상태만 관리합니다.
          날짜별 배정은 다음 단계에서 추가됩니다. 삭제는 하지 않고 사용중지로
          둡니다.
        </p>
      </div>

      {error ? (
        <p className="ui-card" style={{ padding: 12, color: "crimson" }}>
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="ui-card" style={{ padding: 12 }}>
          {message}
        </p>
      ) : null}

      <form
        className="ui-card"
        style={{ marginBottom: 16, padding: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          void createCart();
        }}
      >
        <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>카트 등록</h2>
        <CartFields
          draft={createDraft}
          owners={ownerOptions}
          onChange={applyCreatePatch}
        />
        <div style={{ marginTop: 12 }}>
          <button type="submit" className="cm-btn cm-btn-primary" disabled={creating}>
            {creating ? "등록 중…" : "등록"}
          </button>
        </div>
      </form>

      <section className="ui-card" style={{ padding: 16 }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 16 }}>카트 목록</h2>
        {loading ? <p>불러오는 중…</p> : null}
        {!loading && carts.length === 0 ? <p>등록된 카트가 없습니다.</p> : null}
        {carts.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table className="cm-table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>번호</th>
                  <th style={{ textAlign: "left" }}>종류</th>
                  <th style={{ textAlign: "left" }}>고정 주인</th>
                  <th style={{ textAlign: "left" }}>기숙사</th>
                  <th style={{ textAlign: "left" }}>상태</th>
                  <th style={{ textAlign: "left" }}>메모</th>
                  <th style={{ textAlign: "left" }}>동작</th>
                </tr>
              </thead>
              <tbody>
                {carts.map((row) => {
                  const editing = editingId === row.id;
                  return (
                    <tr key={row.id}>
                      {editing ? (
                        <td colSpan={7} style={{ padding: "12px 0" }}>
                          <CartFields
                            draft={editDraft}
                            owners={ownerOptions}
                            onChange={applyEditPatch}
                            keepOwner={row.owner}
                          />
                          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                            <button
                              type="button"
                              className="cm-btn cm-btn-primary cm-btn-sm"
                              disabled={savingId === row.id}
                              onClick={() => void saveEdit(row.id)}
                            >
                              {savingId === row.id ? "저장 중…" : "저장"}
                            </button>
                            <button
                              type="button"
                              className="cm-btn cm-btn-sm"
                              disabled={savingId === row.id}
                              onClick={() => setEditingId(null)}
                            >
                              취소
                            </button>
                          </div>
                        </td>
                      ) : (
                        <>
                          <td>
                            <strong>{row.number}</strong>
                          </td>
                          <td>
                            {CART_KIND_LABELS[row.kind as CartKind] || row.kind}
                            {row.kindLabel ? ` · ${row.kindLabel}` : ""}
                          </td>
                          <td>
                            {row.owner
                              ? ownerLabel(row.owner)
                              : "—"}
                          </td>
                          <td>{row.dormitoryOnly ? "전용" : "—"}</td>
                          <td>
                            {CART_STATUS_LABELS[
                              row.operationalStatus as CartOperationalStatus
                            ] || row.operationalStatus}
                          </td>
                          <td>{row.note || "—"}</td>
                          <td>
                            <button
                              type="button"
                              className="cm-btn cm-btn-sm"
                              onClick={() => {
                                setEditingId(row.id);
                                setEditDraft(toDraft(row));
                              }}
                            >
                              수정
                            </button>
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function CartFields({
  draft,
  owners,
  onChange,
  keepOwner,
}: {
  draft: Draft;
  owners: CaddyOption[];
  onChange: (patch: Partial<Draft>) => void;
  keepOwner?: Owner | null;
}) {
  const ownerChoices = keepOwner
    ? [
        keepOwner,
        ...owners.filter((row) => row.id !== keepOwner.id),
      ]
    : owners;

  return (
    <div
      className="cm-form-grid"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        gap: 10,
      }}
    >
      <label>
        카트 번호
        <input
          value={draft.number}
          onChange={(e) => onChange({ number: e.target.value })}
          required
        />
      </label>
      <label>
        종류
        <select
          value={draft.kind}
          onChange={(e) => onChange({ kind: e.target.value as CartKind })}
        >
          {CART_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {CART_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>
      {draft.kind === "OTHER" ? (
        <label>
          종류 설명
          <input
            value={draft.kindLabel}
            onChange={(e) => onChange({ kindLabel: e.target.value })}
          />
        </label>
      ) : null}
      <label>
        고정 주인
        <select
          value={draft.ownerCaddyId}
          disabled={draft.dormitoryOnly}
          onChange={(e) => onChange({ ownerCaddyId: e.target.value })}
        >
          <option value="">없음</option>
          {ownerChoices.map((caddy) => (
            <option key={caddy.id} value={String(caddy.id)}>
              {ownerLabel(caddy)}
            </option>
          ))}
        </select>
      </label>
      <label className="cm-check" style={{ alignSelf: "end" }}>
        <input
          type="checkbox"
          checked={draft.dormitoryOnly}
          disabled={Boolean(draft.ownerCaddyId)}
          onChange={(e) => onChange({ dormitoryOnly: e.target.checked })}
        />
        기숙사 전용
      </label>
      <label>
        상태
        <select
          value={draft.operationalStatus}
          onChange={(e) =>
            onChange({
              operationalStatus: e.target.value as CartOperationalStatus,
            })
          }
        >
          {CART_OPERATIONAL_STATUSES.map((status) => (
            <option key={status} value={status}>
              {CART_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </label>
      <label style={{ gridColumn: "1 / -1" }}>
        메모
        <input
          value={draft.note}
          onChange={(e) => onChange({ note: e.target.value })}
        />
      </label>
    </div>
  );
}
