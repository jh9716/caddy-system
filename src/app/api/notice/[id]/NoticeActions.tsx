'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

export default function NoticeActions({
  id,
  isAdmin,
}: { id: number; isAdmin: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  if (!isAdmin) return null

  async function onDelete() {
    if (!confirm('정말 삭제하시겠습니까?')) return
    setBusy(true)
    const res = await fetch(`/api/notice/${id}`, { method: 'DELETE' })
    setBusy(false)
    if (!res.ok) {
      alert('삭제 실패')
      return
    }
    router.replace('/notice')
  }

  return (
    <div className="mt-6 flex gap-2">
      <a
        href={`/notice/${id}/edit`}
        className="btn btn-ghost"
      >
        수정
      </a>
      <button
        onClick={onDelete}
        disabled={busy}
        className="btn btn-primary"
      >
        {busy ? '삭제 중…' : '삭제'}
      </button>
    </div>
  )
}
