"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import MarshalManageNav from "@/components/manage/MarshalManageNav";
import { employmentStatusLabel } from "@/lib/caddyManage";
import { caddyTypeLabel } from "@/lib/marshalDomain";
import type { MarshalRosterRow } from "@/lib/marshalDomain";

type CaddyOption = {
  id: number;
  name: string;
  team: string;
  teamOrder: number;
  caddyType?: string | null;
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

  const load = useCallback(async () => {
    setLoading(true);
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
      setLoading(false);
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
    () =>
      caddies
        .filter((caddy) => !registeredIds.has(caddy.id))
        .sort((a, b) => {
          const team = String(a.team).localeCompare(String(b.team), "ko");
          if (team !== 0) return team;
          return (a.teamOrder || 0) - (b.teamOrder || 0);
        }),
    [caddies, registeredIds]
  );
  const visible = (showInactive ? marshals : marshals.filter((row) => row.active)).slice().sort((a, b) => {
    const ao = a.rotationOrder ?? 9999;
    const bo = b.rotationOrder ?? 9999;
    if (ao !== bo) return ao - bo;
    return a.id - b.id;
  });

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
        body: JSON.stringify({
          caddyId: Number(caddyId),
          rotationOrder: rotationOrder ? Number(rotationOrder) : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || "등록 실패");
      }
      setCaddyId("");
      setRotationOrder("");
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "등록 실패");
    } finally {
      setCreating(false);
    }
  };

  const patchMarshal = async (
    row: MarshalRosterRow,
    body: { active?: boolean; startedOn?: string; rotationOrder?: number | null }
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
        throw new Error(data?.error || "수정 실패");
      }
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "수정 실패");
    } finally {
      setBusyId(null);
    }
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
        className="ui-card"
        style={{ marginBottom: 16, padding: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          void createMarshal();
        }}
      >
        <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>마샬 추가</h2>
        <p style={{ margin: "0 0 12px", color: "var(--vh-ink-soft)" }}>
          재직(ACTIVE) 캐디만 등록할 수 있습니다. 조·유형은 캐디 관리 값을
          그대로 표시합니다.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            aria-label="캐디"
            value={caddyId}
            onChange={(e) => setCaddyId(e.target.value)}
            disabled={creating}
            style={{
              minWidth: 220,
              flex: "1 1 220px",
              padding: "8px 10px",
              border: "1px solid var(--vh-border-strong)",
              borderRadius: 8,
              fontSize: 16,
            }}
          >
            <option value="">캐디 선택</option>
            {addable.map((caddy) => (
              <option key={caddy.id} value={caddy.id}>
                {caddy.team} {caddy.name} · {caddyTypeLabel(caddy.caddyType)}
              </option>
            ))}
          </select>
          <input
            aria-label="마샬 순번"
            type="number"
            min={1}
            placeholder="순번"
            value={rotationOrder}
            onChange={(e) => setRotationOrder(e.target.value)}
            disabled={creating}
            style={{
              width: 88,
              padding: "8px 10px",
              border: "1px solid var(--vh-border-strong)",
              borderRadius: 8,
              fontSize: 16,
            }}
          />
          <button
            type="submit"
            className="ui-btn"
            disabled={creating || !caddyId}
          >
            {creating ? "등록 중…" : "명단에 추가"}
          </button>
        </div>
      </form>

      {error && (
        <p className="vh-auth-error" style={{ marginBottom: 12 }}>
          {error}
        </p>
      )}

      <label
        style={{
          display: "inline-flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 12,
        }}
      >
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
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr>
                <th>순번</th>
                <th>이름</th>
                <th>조</th>
                <th>유형</th>
                <th>재직</th>
                <th>시작일</th>
                <th>상태</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={8}>등록된 마샬이 없습니다.</td>
                </tr>
              ) : (
                visible.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <input
                        aria-label={`${row.caddy.name} 순번`}
                        type="number"
                        min={1}
                        defaultValue={row.rotationOrder ?? ""}
                        disabled={busyId === row.id}
                        onBlur={(e) => {
                          const raw = e.target.value.trim();
                          const next = raw === "" ? null : Number(raw);
                          if (next === row.rotationOrder) return;
                          void patchMarshal(row, { rotationOrder: next });
                        }}
                        style={{ width: 72 }}
                      />
                    </td>
                    <td>{row.caddy.name}</td>
                    <td>{row.caddy.team}</td>
                    <td>{caddyTypeLabel(row.caddy.caddyType)}</td>
                    <td>{employmentStatusLabel(row.caddy.employmentStatus)}</td>
                    <td>
                      <input
                        aria-label={`${row.caddy.name} 시작일`}
                        type="date"
                        defaultValue={row.startedOn}
                        disabled={busyId === row.id}
                        onBlur={(e) => {
                          const next = e.target.value;
                          if (!next || next === row.startedOn) return;
                          void patchMarshal(row, { startedOn: next });
                        }}
                      />
                    </td>
                    <td>{row.active ? "활성" : "비활성"}</td>
                    <td>
                      <button
                        type="button"
                        className="ui-btn"
                        disabled={busyId === row.id}
                        onClick={() =>
                          void patchMarshal(row, { active: !row.active })
                        }
                      >
                        {busyId === row.id
                          ? "저장 중…"
                          : row.active
                            ? "비활성"
                            : "복구"}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
