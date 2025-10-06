"use client"

import { useEffect, useState } from "react"

type Caddy = {
  id: number
  name: string
  team: string
  status: string
  memo?: string | null
}

type CaddyListResponse =
  | Caddy[] // 혹시 API가 배열을 직접 줄 때 대비
  | {
      total: number
      rows: Caddy[]
      page: number
      pageSize: number
    }

export default function CaddyManagePage() {
  const [caddies, setCaddies] = useState<Caddy[]>([])
  const [loading, setLoading] = useState(false)

  // 등록 폼
  const [name, setName] = useState("")
  const [team, setTeam] = useState("")
  const [memo, setMemo] = useState("")
  const [status, setStatus] = useState("근무중")

  // 공통: 목록 조회
  const load = async () => {
    try {
      setLoading(true)
      const res = await fetch("/api/caddies?page=1&pageSize=9999", {
        cache: "no-store",
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: CaddyListResponse = await res.json()
      // ✅ 배열/객체 응답 모두 대비
      const rows = Array.isArray(data) ? data : data?.rows ?? []
      setCaddies(rows)
    } catch (e) {
      console.error(e)
      alert("목록을 불러오는 중 오류가 발생했습니다.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  // 등록
  const handleAdd = async () => {
    if (!name.trim() || !team.trim()) {
      alert("이름과 조를 입력하세요.")
      return
    }
    try {
      const res = await fetch("/api/caddies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), team: team.trim(), memo: memo.trim() || null, status }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.error || "등록 실패")
      }
      alert("등록 완료!")
      setName("")
      setTeam("")
      setMemo("")
      setStatus("근무중")
      await load()
    } catch (e: any) {
      console.error(e)
      alert(`등록 중 오류가 발생했습니다.\n${e?.message ?? ""}`)
    }
  }

  // 수정 (onBlur / onChange에서 호출)
  const handleUpdate = async (id: number, field: keyof Caddy, value: string) => {
    try {
      const res = await fetch(`/api/caddies/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.error || "수정 실패")
      }
      await load()
    } catch (e: any) {
      console.error(e)
      alert(`수정 중 오류가 발생했습니다.\n${e?.message ?? ""}`)
    }
  }

  // 삭제
  const handleDelete = async (id: number) => {
    if (!confirm("정말 삭제하시겠습니까?")) return
    try {
      const res = await fetch(`/api/caddies/${id}`, { method: "DELETE" })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.error || "삭제 실패")
      }
      await load()
    } catch (e: any) {
      console.error(e)
      alert(`삭제 중 오류가 발생했습니다.\n${e?.message ?? ""}`)
    }
  }

  return (
    <div className="p-8">
      <h1 className="text-xl font-bold mb-4">캐디 등록 / 관리</h1>

      {/* 등록 폼 */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="이름"
          className="border px-3 py-2 rounded w-32"
        />
        <input
          value={team}
          onChange={(e) => setTeam(e.target.value)}
          placeholder="조 (예: 5조)"
          className="border px-3 py-2 rounded w-24"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="border px-3 py-2 rounded"
        >
          <option>근무중</option>
          <option>휴무</option>
          <option>병가</option>
          <option>장기병가</option>
          <option>당번</option>
          <option>마샬</option>
        </select>
        <input
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="메모 (선택)"
          className="border px-3 py-2 rounded w-64"
        />
        <button
          onClick={handleAdd}
          className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
        >
          등록
        </button>
      </div>

      {/* 목록 */}
      <div className="mb-2 text-sm text-gray-600">
        {loading ? "불러오는 중..." : `총 ${caddies.length}명`}
      </div>

      <table className="w-full border text-center">
        <thead>
          <tr className="bg-gray-100">
            <th className="border p-2">ID</th>
            <th className="border p-2">이름</th>
            <th className="border p-2">조</th>
            <th className="border p-2">상태</th>
            <th className="border p-2">메모</th>
            <th className="border p-2">액션</th>
          </tr>
        </thead>
        <tbody>
          {caddies.map((caddy) => (
            <tr key={caddy.id}>
              <td className="border p-2">{caddy.id}</td>
              <td className="border p-2">{caddy.name}</td>
              <td className="border p-2">
                <input
                  defaultValue={caddy.team}
                  className="border p-1 w-20 text-center"
                  onBlur={(e) => handleUpdate(caddy.id, "team", e.target.value)}
                />
              </td>
              <td className="border p-2">
                <select
                  defaultValue={caddy.status || "근무중"}
                  onChange={(e) => handleUpdate(caddy.id, "status", e.target.value)}
                  className="border p-1 rounded"
                >
                  <option>근무중</option>
                  <option>휴무</option>
                  <option>병가</option>
                  <option>장기병가</option>
                  <option>당번</option>
                  <option>마샬</option>
                </select>
              </td>
              <td className="border p-2">
                <input
                  defaultValue={caddy.memo ?? ""}
                  className="border p-1 w-64 text-center"
                  onBlur={(e) => handleUpdate(caddy.id, "memo", e.target.value)}
                />
              </td>
              <td className="border p-2">
                <button
                  onClick={() => handleDelete(caddy.id)}
                  className="bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600"
                >
                  삭제
                </button>
              </td>
            </tr>
          ))}
          {caddies.length === 0 && !loading && (
            <tr>
              <td colSpan={6} className="border p-6 text-gray-500">
                등록된 캐디가 없습니다.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
