'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

type Props = {
  mode?: 'new' | 'edit'
  initial?: { id: number; title: string; body: string }
}

export default function NewNoticeForm({ mode = 'new', initial }: Props) {
  const router = useRouter()
  const [title, setTitle] = useState(initial?.title ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [busy, setBusy] = useState(false)
  const isEdit = mode === 'edit'

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    const payload = { title, body }

    const url = isEdit ? `/api/notice/${initial?.id}` : '/api/notice'
    const method = isEdit ? 'PATCH' : 'POST'

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setBusy(false)

    if (!res.ok) {
      alert(isEdit ? '수정 실패' : '등록 실패')
      return
    }

    if (isEdit) {
      router.replace(`/notice/${initial?.id}`)
    } else {
      router.replace('/notice')
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-4">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="제목"
        className="w-full rounded-lg border border-slate-200 px-3 py-2"
        required
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="내용"
        className="min-h-[220px] w-full rounded-lg border border-slate-200 px-3 py-2"
        required
      />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-primary">
          {busy ? (isEdit ? '수정 중…' : '등록 중…') : (isEdit ? '수정' : '등록')}
        </button>
        <a href={isEdit ? `/notice/${initial?.id}` : '/notice'} className="btn btn-ghost">
          취소
        </a>
      </div>
    </form>
  )
}
