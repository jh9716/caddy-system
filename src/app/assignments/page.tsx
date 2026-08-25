'use client'
import { useState, useEffect } from 'react'
import { formatCaddyLabel } from '@/lib/caddyDisplay'

type AssignmentType = 'OFF' | 'SICK' | 'LONG_SICK' | 'DUTY' | 'MARSHAL'

// 화면 표시용 한글 라벨 매핑
const TYPE_LABELS: Record<AssignmentType, string> = {
  OFF: '휴무',
  SICK: '병가',
  LONG_SICK: '장기병가',
  DUTY: '당번',
  MARSHAL: '마샬',
}

// 셀렉트에서 사용할 옵션 (value는 DB enum, label은 한글)
const TYPE_OPTIONS: { value: AssignmentType; label: string }[] = [
  { value: 'OFF', label: '휴무' },
  { value: 'SICK', label: '병가' },
  { value: 'LONG_SICK', label: '장기병가' },
  { value: 'DUTY', label: '당번' },
  { value: 'MARSHAL', label: '마샬' },
]

export default function AssignmentPage() {
  const [caddies, setCaddies] = useState<any[]>([])
  const [assignments, setAssignments] = useState<any[]>([])
  const [form, setForm] = useState({
    caddyId: '',
    type: 'OFF' as AssignmentType,
    startDate: '',
    endDate: '',
  })

  useEffect(() => {
    // 캐디 목록
    fetch('/api/caddies')
      .then((r) => r.json())
      .then((d) => setCaddies(d.rows || []))

    // 배정 목록
    fetch('/api/assignments')
      .then((r) => r.json())
      .then((d) => setAssignments(d || []))
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    await fetch('/api/assignments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    // 새로고침 대신 목록만 다시 불러오고 폼 초기화
    const refreshed = await fetch('/api/assignments').then((r) => r.json())
    setAssignments(refreshed || [])
    setForm({ caddyId: '', type: 'OFF', startDate: '', endDate: '' })
  }

  return (
    <div className="p-10">
      <h1 className="text-xl font-bold mb-4">📋 캐디 일정 관리</h1>

      <form onSubmit={submit} className="mb-8 flex flex-wrap gap-3 items-center">
        {/* 캐디 선택 */}
        <select
          className="border p-2 min-w-[160px]"
          value={form.caddyId}
          onChange={(e) => setForm((s) => ({ ...s, caddyId: e.target.value }))}
        >
          <option value="">캐디 선택</option>
          {caddies.map((c) => (
            <option key={c.id} value={c.id}>
              {formatCaddyLabel(c)}
            </option>
          ))}
        </select>

        {/* 유형 선택: value는 영어 enum, 라벨은 한글 */}
        <select
          className="border p-2"
          value={form.type}
          onChange={(e) => setForm((s) => ({ ...s, type: e.target.value as AssignmentType }))}
        >
          {TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        {/* 날짜 */}
        <input
          type="date"
          className="border p-2"
          value={form.startDate}
          onChange={(e) => setForm((s) => ({ ...s, startDate: e.target.value }))}
        />
        <input
          type="date"
          className="border p-2"
          value={form.endDate}
          onChange={(e) => setForm((s) => ({ ...s, endDate: e.target.value }))}
        />

        <button className="bg-blue-600 text-white px-4 py-2 rounded">등록</button>
      </form>

      {/* 목록 */}
      <table className="border-collapse border w-full max-w-4xl">
        <thead>
          <tr className="bg-gray-100">
            <th className="border p-2">이름</th>
            <th className="border p-2">유형</th>
            <th className="border p-2">시작일</th>
            <th className="border p-2">종료일</th>
          </tr>
        </thead>
        <tbody>
          {assignments.map((a) => (
            <tr key={a.id}>
              <td className="border p-2">{a.caddy?.name}</td>
              <td className="border p-2">
                {TYPE_LABELS[(a.type as AssignmentType) || 'OFF']}
              </td>
              <td className="border p-2">{String(a.startDate).slice(0, 10)}</td>
              <td className="border p-2">{String(a.endDate).slice(0, 10)}</td>
            </tr>
          ))}
          {assignments.length === 0 && (
            <tr>
              <td className="border p-4 text-center text-gray-500" colSpan={4}>
                등록된 일정이 없습니다.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
