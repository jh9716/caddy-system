"use client";

import { useEffect, useMemo, useState } from "react";

type Caddy = {
  id: number;
  name: string;
  team: string;
  status: string;
};

export default function CaddiesPage() {
  const [caddies, setCaddies] = useState<Caddy[]>([]);
  const [loading, setLoading] = useState(false);

  // 입력값 (추가)
  const [name, setName] = useState("");
  const [team, setTeam] = useState("");
  const [status, setStatus] = useState("");

  // 필터
  const [filterName, setFilterName] = useState("");
  const [filterTeam, setFilterTeam] = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  // 수정 중 값
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editTeam, setEditTeam] = useState("");
  const [editStatus, setEditStatus] = useState("");

  // 목록 로딩
  const fetchList = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/caddies", { cache: "no-store" });
      const data = await res.json();
      setCaddies(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
      alert("목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchList();
  }, []);

  // 추가
  const handleAdd = async () => {
    if (!name || !team || !status) {
      alert("이름/조/상태를 모두 입력해주세요.");
      return;
    }
    try {
      const res = await fetch("/api/caddies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, team, status }),
      });
      if (!res.ok) throw new Error();
      setName("");
      setTeam("");
      setStatus("");
      await fetchList();
    } catch {
      alert("추가에 실패했습니다.");
    }
  };

  // 수정 시작
  const startEdit = (c: Caddy) => {
    setEditingId(c.id);
    setEditName(c.name);
    setEditTeam(c.team);
    setEditStatus(c.status);
  };

  // 수정 저장
  const saveEdit = async (id: number) => {
    try {
      const res = await fetch(`/api/caddies/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName, team: editTeam, status: editStatus }),
      });
      if (!res.ok) throw new Error();
      setEditingId(null);
      await fetchList();
    } catch {
      alert("수정에 실패했습니다.");
    }
  };

  // 삭제
  const handleDelete = async (id: number) => {
    if (!confirm("정말 삭제할까요?")) return;
    try {
      const res = await fetch(`/api/caddies/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      await fetchList();
    } catch {
      alert("삭제에 실패했습니다.");
    }
  };

  // 필터 적용
  const filtered = useMemo(() => {
    return caddies.filter((c) => {
      const byName = filterName ? c.name.includes(filterName) : true;
      const byTeam = filterTeam ? c.team.includes(filterTeam) : true;
      const byStatus = filterStatus ? c.status.includes(filterStatus) : true;
      return byName && byTeam && byStatus;
    });
  }, [caddies, filterName, filterTeam, filterStatus]);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">캐디 리스트</h1>

      {/* 필터/추가 */}
      <div className="flex gap-2 mb-4">
        <input
          value={filterName}
          onChange={(e) => setFilterName(e.target.value)}
          placeholder="이름"
          className="border rounded px-2 py-1"
        />
        <input
          value={filterTeam}
          onChange={(e) => setFilterTeam(e.target.value)}
          placeholder="조 (예: 1조)"
          className="border rounded px-2 py-1"
        />
        <input
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          placeholder="상태 (예: 근무중/휴무/병가)"
          className="border rounded px-2 py-1"
        />
      </div>

      <div className="flex gap-2 mb-6">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="이름"
          className="border rounded px-2 py-1"
        />
        <input
          value={team}
          onChange={(e) => setTeam(e.target.value)}
          placeholder="조 (예: 1조)"
          className="border rounded px-2 py-1"
        />
        <input
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          placeholder="상태 (예: 근무중/휴무/병가)"
          className="border rounded px-2 py-1"
        />
        <button
          onClick={handleAdd}
          className="border rounded px-3 py-1 hover:bg-gray-100"
        >
          추가
        </button>
      </div>

      {/* 테이블 */}
      <div className="overflow-x-auto">
        <table className="w-[720px] border-collapse border">
          <thead>
            <tr className="bg-gray-100">
              <th className="border px-3 py-2 w-16">ID</th>
              <th className="border px-3 py-2 w-40">이름</th>
              <th className="border px-3 py-2 w-40">조</th>
              <th className="border px-3 py-2 w-40">상태</th>
              <th className="border px-3 py-2 w-40">액션</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="border px-3 py-2" colSpan={5}>
                  로딩 중…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td className="border px-3 py-8 text-center" colSpan={5}>
                  데이터가 없습니다.
                </td>
              </tr>
            ) : (
              filtered.map((c) => (
                <tr key={c.id}>
                  <td className="border px-3 py-2">{c.id}</td>
                  <td className="border px-3 py-2">
                    {editingId === c.id ? (
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="border rounded px-2 py-1 w-full"
                      />
                    ) : (
                      c.name
                    )}
                  </td>
                  <td className="border px-3 py-2">
                    {editingId === c.id ? (
                      <input
                        value={editTeam}
                        onChange={(e) => setEditTeam(e.target.value)}
                        className="border rounded px-2 py-1 w-full"
                      />
                    ) : (
                      c.team
                    )}
                  </td>
                  <td className="border px-3 py-2">
                    {editingId === c.id ? (
                      <input
                        value={editStatus}
                        onChange={(e) => setEditStatus(e.target.value)}
                        className="border rounded px-2 py-1 w-full"
                      />
                    ) : (
                      c.status
                    )}
                  </td>
                  <td className="border px-3 py-2 text-center">
                    {editingId === c.id ? (
                      <div className="flex gap-2 justify-center">
                        <button
                          onClick={() => saveEdit(c.id)}
                          className="border rounded px-2 py-1 hover:bg-gray-100"
                        >
                          저장
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="border rounded px-2 py-1 hover:bg-gray-100"
                        >
                          취소
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-2 justify-center">
                        <button
                          onClick={() => startEdit(c)}
                          className="border rounded px-2 py-1 hover:bg-gray-100"
                        >
                          수정
                        </button>
                        <button
                          onClick={() => handleDelete(c.id)}
                          className="border rounded px-2 py-1 hover:bg-gray-100"
                        >
                          삭제
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
