'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import {
  NOTICE_CADDY_TYPES,
  NOTICE_TARGET_ALL,
  NOTICE_TARGET_CADDY_TYPE,
  NOTICE_TARGET_TEAM,
} from '@/lib/noticeConstants'
import { DRIVING_POOL_TEAM, PRIMARY_TEAMS } from '@/lib/caddyManage'

type Props = {
  mode?: 'new' | 'edit'
  initial?: {
    id: number
    title: string
    body: string
    important?: boolean
    pinned?: boolean
    targetType?: string
    targetValue?: string | null
    publishStartAt?: string | null
    publishEndAt?: string | null
  }
}

function toDatetimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return ''
  const dt = new Date(iso)
  if (Number.isNaN(dt.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`
}

export default function NewNoticeForm({ mode = 'new', initial }: Props) {
  const router = useRouter()
  const [title, setTitle] = useState(initial?.title ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [important, setImportant] = useState(Boolean(initial?.important))
  const [pinned, setPinned] = useState(Boolean(initial?.pinned))
  const [targetType, setTargetType] = useState(initial?.targetType ?? NOTICE_TARGET_ALL)
  const [targetValue, setTargetValue] = useState(initial?.targetValue ?? '')
  const [publishStartAt, setPublishStartAt] = useState(
    toDatetimeLocalValue(initial?.publishStartAt)
  )
  const [publishEndAt, setPublishEndAt] = useState(
    toDatetimeLocalValue(initial?.publishEndAt)
  )
  const [busy, setBusy] = useState(false)
  const isEdit = mode === 'edit'

  const teamOptions = useMemo(
    () => [...PRIMARY_TEAMS, DRIVING_POOL_TEAM],
    []
  )

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    const payload = {
      title,
      content: body,
      body,
      important,
      pinned,
      targetType,
      targetValue:
        targetType === NOTICE_TARGET_ALL ? null : targetValue || null,
      publishStartAt: publishStartAt ? new Date(publishStartAt).toISOString() : null,
      publishEndAt: publishEndAt ? new Date(publishEndAt).toISOString() : null,
    }

    const url = isEdit ? `/api/notice/${initial?.id}` : '/api/notice'
    const method = isEdit ? 'PATCH' : 'POST'

    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setBusy(false)

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      alert(
        typeof data.message === 'string'
          ? data.message
          : isEdit
            ? '수정 실패'
            : '등록 실패'
      )
      return
    }

    if (isEdit) {
      router.replace(`/notice/${initial?.id}`)
    } else {
      const data = await res.json().catch(() => ({}))
      if (typeof data.id === 'number') {
        router.replace(`/notice/${data.id}`)
      } else {
        router.replace('/notice')
      }
    }
  }

  return (
    <form onSubmit={onSubmit} className="notice-form">
      <label className="notice-field">
        <span>제목</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="제목"
          required
        />
      </label>
      <label className="notice-field">
        <span>내용</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="내용"
          required
        />
      </label>
      <label className="notice-field">
        <span>대상</span>
        <select
          value={targetType}
          onChange={(e) => {
            const next = e.target.value
            setTargetType(next)
            if (next === NOTICE_TARGET_ALL) setTargetValue('')
            if (next === NOTICE_TARGET_CADDY_TYPE && !NOTICE_CADDY_TYPES.includes(targetValue as typeof NOTICE_CADDY_TYPES[number])) {
              setTargetValue('HOUSE')
            }
            if (next === NOTICE_TARGET_TEAM && !teamOptions.includes(targetValue as typeof teamOptions[number])) {
              setTargetValue('1조')
            }
          }}
        >
          <option value={NOTICE_TARGET_ALL}>전체</option>
          <option value={NOTICE_TARGET_CADDY_TYPE}>캐디구분</option>
          <option value={NOTICE_TARGET_TEAM}>조</option>
        </select>
      </label>
      {targetType === NOTICE_TARGET_CADDY_TYPE ? (
        <label className="notice-field">
          <span>캐디구분</span>
          <select value={targetValue} onChange={(e) => setTargetValue(e.target.value)}>
            {NOTICE_CADDY_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
      ) : null}
      {targetType === NOTICE_TARGET_TEAM ? (
        <label className="notice-field">
          <span>조</span>
          <select value={targetValue} onChange={(e) => setTargetValue(e.target.value)}>
            {teamOptions.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="notice-check">
        <input
          type="checkbox"
          checked={important}
          onChange={(e) => setImportant(e.target.checked)}
        />
        중요공지
      </label>
      <label className="notice-check">
        <input
          type="checkbox"
          checked={pinned}
          onChange={(e) => setPinned(e.target.checked)}
        />
        상단고정
      </label>
      <label className="notice-field">
        <span>게시 시작일 (선택)</span>
        <input
          type="datetime-local"
          value={publishStartAt}
          onChange={(e) => setPublishStartAt(e.target.value)}
        />
      </label>
      <label className="notice-field">
        <span>게시 종료일 (선택)</span>
        <input
          type="datetime-local"
          value={publishEndAt}
          onChange={(e) => setPublishEndAt(e.target.value)}
        />
      </label>
      <div className="notice-form-actions">
        <button type="submit" disabled={busy} className="ui-btn ui-btn-primary">
          {busy ? (isEdit ? '수정 중…' : '등록 중…') : (isEdit ? '수정' : '등록')}
        </button>
        <a href={isEdit ? `/notice/${initial?.id}` : '/notice'} className="ui-btn ui-btn-ghost">
          취소
        </a>
      </div>
    </form>
  )
}
