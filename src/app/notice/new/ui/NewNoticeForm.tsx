'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useRef, useState } from 'react'
import {
  NOTICE_CADDY_TYPES,
  NOTICE_CREATE_SEND_PUSH_LABEL,
  NOTICE_EDIT_SEND_PUSH_LABEL,
  NOTICE_SCHEDULED_PUSH_HINT,
  NOTICE_TARGET_ALL,
  NOTICE_TARGET_CADDY_TYPE,
  NOTICE_TARGET_TEAM,
} from '@/lib/noticeConstants'
import { isFutureNoticeStart, planNoticeClientAutoPush } from '@/lib/noticeAutoPushPlan'
import { requestNoticePushSend } from '@/lib/noticePushClient'
import { DRIVING_POOL_TEAM, PRIMARY_TEAMS } from '@/lib/caddyManage'
import {
  COURSE_REPORT_PHOTO_ACCEPT,
  COURSE_REPORT_PHOTO_MAX,
  pickCourseReportPhotos,
} from '@/lib/courseReportPhotoClient'
import type { NoticePhotoPublic } from '@/lib/noticePhotoConstants'
import { noticePhotoSrc } from '@/lib/noticePhotoConstants'
import { uploadNoticePendingPhotos } from '@/lib/noticePhotoClient'

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
    photos?: NoticePhotoPublic[]
  }
}

type PendingPhoto = {
  key: string
  blob: Blob
  previewUrl: string
  fileId: string
  fingerprint: string
}

function toDatetimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return ''
  const dt = new Date(iso)
  if (Number.isNaN(dt.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`
}

function pushResultMessage(push: {
  ok?: boolean
  skipped?: string | null
  message?: string
  error?: string
} | undefined): string | null {
  if (!push) return null
  if (push.skipped === 'disabled') return null
  if (push.skipped === 'scheduled') {
    return '게시 시작일이 미래라 지금은 푸시를 보내지 않았습니다. 게시 후 상세에서 보낼 수 있습니다.'
  }
  if (push.skipped === 'outside_window') {
    return '게시 기간이 아니라 푸시를 보내지 않았습니다.'
  }
  if (push.ok === false) {
    return push.message || '공지는 저장됐지만 푸시 알림 발송에 실패했습니다.'
  }
  if (push.error === 'no_recipients') {
    return '공지는 저장됐습니다. 구독 중인 캐디가 없어 푸시는 발송되지 않았습니다.'
  }
  return null
}

export default function NewNoticeForm({ mode = 'new', initial }: Props) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
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
  const [sendPush, setSendPush] = useState(mode !== 'edit')
  const [busy, setBusy] = useState(false)
  const [statusNote, setStatusNote] = useState('')
  const [existingPhotos, setExistingPhotos] = useState<NoticePhotoPublic[]>(
    initial?.photos ?? []
  )
  const [pending, setPending] = useState<PendingPhoto[]>([])
  const isEdit = mode === 'edit'
  const scheduled = isFutureNoticeStart(publishStartAt || null)
  const totalPhotos = existingPhotos.length + pending.length
  const canAdd = totalPhotos < COURSE_REPORT_PHOTO_MAX

  const teamOptions = useMemo(
    () => [...PRIMARY_TEAMS, DRIVING_POOL_TEAM],
    []
  )

  async function onPick(files: FileList | null) {
    if (!files) return
    setStatusNote('')
    const room = COURSE_REPORT_PHOTO_MAX - existingPhotos.length - pending.length
    const { items, note } = await pickCourseReportPhotos(Array.from(files), room, undefined, {
      fileIds: pending.map((p) => p.fileId),
      fingerprints: pending.map((p) => p.fingerprint),
    })
    if (note) setStatusNote(note)
    if (items.length) {
      setPending((cur) => {
        const roomLeft = COURSE_REPORT_PHOTO_MAX - existingPhotos.length - cur.length
        return [...cur, ...items.slice(0, Math.max(0, roomLeft))]
      })
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  function removePending(key: string) {
    setPending((cur) => {
      const hit = cur.find((p) => p.key === key)
      if (hit) URL.revokeObjectURL(hit.previewUrl)
      return cur.filter((p) => p.key !== key)
    })
  }

  async function removeExisting(photoId: number) {
    if (!initial?.id) return
    const res = await fetch(`/api/notice/${initial.id}/photos/${photoId}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setStatusNote(typeof data.message === 'string' ? data.message : '사진 삭제 실패')
      return
    }
    setExistingPhotos((cur) => cur.filter((p) => p.id !== photoId))
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setStatusNote('')
    const plan = planNoticeClientAutoPush({
      sendPushRequested: sendPush && !scheduled,
      pendingPhotoCount: pending.length,
      publishStartAt: publishStartAt || null,
    })
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
      sendPush: plan.sendOnCreate,
    }

    const url = isEdit ? `/api/notice/${initial?.id}` : '/api/notice'
    const method = isEdit ? 'PATCH' : 'POST'

    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      setBusy(false)
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

    const data = await res.json().catch(() => ({}))
    const noticeId = isEdit
      ? initial?.id
      : typeof data.id === 'number'
        ? data.id
        : null

    if (noticeId && pending.length > 0) {
      const uploaded = await uploadNoticePendingPhotos(noticeId, pending)
      if (uploaded.failed > 0) {
        setBusy(false)
        alert(
          `공지는 저장됐지만 사진 ${uploaded.failed}장을 올리지 못했습니다. 자동 푸시는 보내지 않았습니다.`
        )
        router.replace(`/notice/${noticeId}`)
        return
      }
    }

    if (noticeId && plan.sendAfterPhotos) {
      const after = await requestNoticePushSend(noticeId)
      setBusy(false)
      if (!after.ok) {
        alert(after.message || '공지와 사진은 저장됐지만 푸시 알림 발송에 실패했습니다.')
        router.replace(`/notice/${noticeId}`)
        return
      }
      const pushNote = pushResultMessage({
        ok: after.ok,
        error: after.error,
        message: after.message,
      })
      if (pushNote) alert(pushNote)
    } else {
      const pushNote = pushResultMessage(data.push)
      setBusy(false)
      if (pushNote) alert(pushNote)
    }

    if (noticeId) {
      router.replace(`/notice/${noticeId}`)
    } else {
      router.replace('/notice')
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
      <fieldset className="course-report-fieldset">
        <legend>사진 첨부 (최대 {COURSE_REPORT_PHOTO_MAX}장)</legend>
        <div className="course-report-photo-composer">
          {existingPhotos.map((photo) => (
            <div key={photo.id} className="course-report-photo-item">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={noticePhotoSrc(initial!.id, photo.id)} alt="" />
              <button
                type="button"
                className="course-report-photo-remove"
                aria-label="사진 삭제"
                onClick={() => void removeExisting(photo.id)}
              >
                ×
              </button>
            </div>
          ))}
          {pending.map((photo) => (
            <div key={photo.key} className="course-report-photo-item">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo.previewUrl} alt="" />
              <button
                type="button"
                className="course-report-photo-remove"
                aria-label="사진 삭제"
                onClick={() => removePending(photo.key)}
              >
                ×
              </button>
            </div>
          ))}
          <label className={`course-report-photo-add${canAdd ? '' : ' is-disabled'}`}>
            + 사진
            <input
              ref={fileRef}
              type="file"
              accept={COURSE_REPORT_PHOTO_ACCEPT}
              multiple
              disabled={!canAdd || busy}
              onChange={(e) => void onPick(e.target.files)}
            />
          </label>
        </div>
        {statusNote ? <p className="course-report-photo-note">{statusNote}</p> : null}
      </fieldset>
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
              <option key={t} value={t}>{t === 'HOUSE' ? '하우스' : t === 'THIRD' ? '3부반' : '드라이빙'}</option>
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
          onChange={(e) => setImportant(e.currentTarget.checked)}
        />
        중요공지
      </label>
      <label className="notice-check">
        <input
          type="checkbox"
          checked={pinned}
          onChange={(e) => setPinned(e.currentTarget.checked)}
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
      {scheduled ? (
        <p className="notice-scheduled-push-hint" role="status">
          {NOTICE_SCHEDULED_PUSH_HINT}
        </p>
      ) : (
        <label className="notice-check notice-check-push">
          <input
            type="checkbox"
            checked={sendPush}
            onChange={(e) => setSendPush(e.currentTarget.checked)}
          />
          {isEdit ? NOTICE_EDIT_SEND_PUSH_LABEL : NOTICE_CREATE_SEND_PUSH_LABEL}
        </label>
      )}
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
