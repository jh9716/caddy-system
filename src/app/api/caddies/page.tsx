// src/app/caddies/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";

type Caddy = {
  id: number;
  name: string;
  team: string | null;
  status: string;
  memo: string | null;
  createdAt: string;
  updatedAt: string;
};

type ListRes = {
  total: number;
  page: number;
  pageSize: number;
  items: Caddy[];
};

const PAGE_SIZE = 10;
const STATUS_OPTIONS = ["근무중", "휴무", "병가", "장기병가", "당번", "마샬"];

export default function CaddiesRegisterPage() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [list, setList] = useState<ListRes | null>(null);
  const [loading, setLoading] = useState(false);

  // 신규 등록 폼
  const [newName, setNewName] = useState("");
  const [newTeam, setNewTeam] = useState("");
  const [newStatus, setNewStatus] = useState("근무중");
  const [newMemo, setNewMemo] = useState("");

  const totalPages = useMemo(() => {
    if (!list) return 1;
    return Math.max(1, Math.ceil(list.total / list.pageSize));
  }, [list]);

  async function fetchList(p = page, q = search) {
    setLoading(true);
    try {
      const r = await fetch(`/api/caddies?search=${encodeURIComponent(q)}&page=${p}&pageSize=${PAGE_SIZE}`, {
        cache: "no-store",
      });
      const data = (await r.json()) as ListRes;
      setList(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchList(1, search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    fetchList(1, search);
  }

  async function onCreate() {
    if (!newName.trim()) {
      alert("이름은 필수입니다.");
      return;
    }
    const res = await fetch("/api/caddies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newName.trim(),
        team: newTeam.trim(),
        status: newStatus,
        memo: newMemo.trim(),
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      alert(j?.error ?? "등록 실패");
      return;
    }
    // 입력폼 초기화 + 목록 새로고침
    setNewName("");
    setNewTeam("");
    setNewStatus("근무중");
    setNewMemo("");
    await fetchList(1, search);
    setPage(1);
  }

  async function onUpdate(row: Caddy) {
    const res = await fetch(`/api/caddies/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: row.name,
        team: row.team,
        status: row.status,
        memo: row.memo,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      alert(j?.error ?? "수정 실패");
      return;
    }
    await fetchList(page, search);
  }

  async function onDelete(id: number) {
    if (!confirm("정말 삭제하시겠어요? 이 작업은 되돌릴 수 없습니다.")) return;
    const res = await fetch(`/api/caddies/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      alert(j?.error ?? "삭제 실패");
      return;
    }
    // 현재 페이지에서 하나 삭제되었고 마지막 페이지가 비면 한 페이지 앞으로
    const nextPage =
      list && list.items.length === 1 && page > 1 ? page - 1 : page;
    setPage(nextPage);
    await fetchList(nextPage, search);
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">캐디 등록</h1>

      {/* 검색 */}
      <form onSubmit={onSearchSubmit} className="flex gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="이름, 팀, 상태, 메모 검색"
          className="border px-3 py-2 rounded w-72"
        />
        <button
          type="submit"
          className="border px-4 py-2 rounded hover:bg-gray-50"
        >
          검색
        </button>
        <button
          type="button"
          onClick={() => {
            setSearch("");
            setPage(1);
            fetchList(1, "");
          }}
          className="border px-3 py-2 rounded hover:bg-gray-50"
        >
          초기화
        </button>
      </form>

      {/* 신규 등록 */}
      <div className="border rounded p-4 space-y-3">
        <div className="font-semibold">신규 캐디 등록</div>
        <div className="grid grid-cols-4 gap-2 max-w-4xl">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="이름*"
            className="border px-3 py-2 rounded"
          />
          <input
            value={newTeam}
            onChange={(e) => setNewTeam(e.target.value)}
            placeholder="팀 (예: 1조)"
            className="border px-3 py-2 rounded"
          />
          <select
            value={newStatus}
            onChange={(e) => setNewStatus(e.target.value)}
            className="border px-3 py-2 rounded"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            value={newMemo}
            onChange={(e) => setNewMemo(e.target.value)}
            placeholder="메모"
            className="border px-3 py-2 rounded"
          />
        </div>
        <button
          onClick={onCreate}
          className="border px-4 py-2 rounded hover:bg-gray-50"
        >
          등록
        </button>
      </div>

      {/* 목록 */}
      <div className="border rounded">
        <div className="p-3 flex items-center justify-between">
          <div className="font-semibold">캐디 목록</div>
          {loading && <div className="text-sm text-gray-500">로딩중…</div>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-t">
            <thead className="bg-gray-50">
              <tr>
                <th className="border p-2 w-14">ID</th>
                <th className="border p-2 w-48">이름</th>
                <th className="border p-2 w-48">팀</th>
                <th className="border p-2 w-40">상태</th>
                <th className="border p-2">메모</th>
                <th className="border p-2 w-40">액션</th>
              </tr>
            </thead>
            <tbody>
              {list?.items.map((row) => (
                <EditableRow
                  key={row.id}
                  row={row}
                  onSave={onUpdate}
                  onDelete={onDelete}
                />
              ))}
              {(!list || list.items.length === 0) && (
                <tr>
                  <td className="border p-3 text-center" colSpan={6}>
                    데이터가 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* 페이지네이션 */}
        <div className="p-3 flex gap-2 items-center">
          <button
            disabled={page <= 1}
            onClick={() => {
              const p = Math.max(1, page - 1);
              setPage(p);
              fetchList(p, search);
            }}
            className="border px-3 py-1 rounded disabled:opacity-40"
          >
            이전
          </button>
          <div className="text-sm">
            {page} / {totalPages}
          </div>
          <button
            disabled={page >= totalPages}
            onClick={() => {
              const p = Math.min(totalPages, page + 1);
              setPage(p);
              fetchList(p, search);
            }}
            className="border px-3 py-1 rounded disabled:opacity-40"
          >
            다음
          </button>
        </div>
      </div>
    </div>
  );
}

function EditableRow({
  row,
  onSave,
  onDelete,
}: {
  row: Caddy;
  onSave: (r: Caddy) => void;
  onDelete: (id: number) => void;
}) {
  const [draft, setDraft] = useState(row);
  useEffect(() => setDraft(row), [row.id]); // 다른 행으로 바뀌면 초기화

  return (
    <tr>
      <td className="border p-2 text-center">{row.id}</td>

      <td className="border p-2">
        <input
          value={draft.name ?? ""}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          className="border px-2 py-1 rounded w-full"
        />
      </td>

      <td className="border p-2">
        <input
          value={draft.team ?? ""}
          onChange={(e) => setDraft({ ...draft, team: e.target.value })}
          className="border px-2 py-1 rounded w-full"
        />
      </td>

      <td className="border p-2">
        <select
          value={draft.status ?? "근무중"}
          onChange={(e) => setDraft({ ...draft, status: e.target.value })}
          className="border px-2 py-1 rounded w-full"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </td>

      <td className="border p-2">
        <input
          value={draft.memo ?? ""}
          onChange={(e) => setDraft({ ...draft, memo: e.target.value })}
          className="border px-2 py-1 rounded w-full"
        />
      </td>

      <td className="border p-2 text-center">
        <button
          onClick={() => onSave(draft)}
          className="border px-2 py-1 rounded mr-2 hover:bg-gray-50"
        >
          저장
        </button>
        <button
          onClick={() => onDelete(row.id)}
          className="border px-2 py-1 rounded hover:bg-gray-50"
        >
          삭제
        </button>
      </td>
    </tr>
  );
}
