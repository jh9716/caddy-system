'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
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
  NOTICE_PHOTO_ACCEPT,
  NOTICE_PHOTO_MAX,
  noticePhotoLimitMessage,
  type NoticePhotoPublic,
} from '@/lib/noticePhotoConstants'
import { noticePhotoSrc } from '@/lib/noticePhotoConstants'
import {
  NOTICE_PASTE_EXCEL_FALLBACK,
  NOTICE_PASTE_HINT,
  NOTICE_PASTE_WHILE_SAVING,
  classifyNoticeClipboard,
  noticeClipboardFromData,
} from '@/lib/noticeClipboardPaste'
import {
  instantNoticePhotoPicks,
  prepareNoticePendingPhoto,
  revokeNoticePreviewUrl,
  uploadNoticePendingPhotos,
  type NoticePendingPick,
} from '@/lib/noticePhotoClient'
import {
  NOTICE_FILE_ACCEPT,
  NOTICE_FILE_MAX,
  type NoticeFilePublic,
} from '@/lib/noticeFileConstants'
import { noticeFileSrc } from '@/lib/noticeFileConstants'
import {
  pickNoticeFiles,
  uploadNoticePendingFiles,
  type NoticePendingFile,
} from '@/lib/noticeFileClient'
import {
  consumeUnauthorizedMemberResponse,
  isMemberSessionRedirectScheduled,
} from '@/lib/memberSessionRedirect'

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
    files?: NoticeFilePublic[]
  }
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
  const formRef = useRef<HTMLFormElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const pdfRef = useRef<HTMLInputElement>(null)
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
  const [pending, setPending] = useState<NoticePendingPick[]>([])
  const [saveProgress, setSaveProgress] = useState('')
  const [pasteNote, setPasteNote] = useState('')
  const pendingRef = useRef<NoticePendingPick[]>([])
  const submitLock = useRef(false)
  const busyRef = useRef(false)
  const existingCountRef = useRef(0)
  const reservedPasteRef = useRef(0)
  const fingerprintsRef = useRef(new Set<string>())
  const mountedRef = useRef(true)
  const [existingFiles, setExistingFiles] = useState<NoticeFilePublic[]>(
    initial?.files ?? []
  )
  const [pendingFiles, setPendingFiles] = useState<NoticePendingFile[]>([])
  const isEdit = mode === 'edit'
  const scheduled = isFutureNoticeStart(publishStartAt || null)
  busyRef.current = busy
  existingCountRef.current = existingPhotos.length
  const totalPhotos = existingPhotos.length + pending.length
  const canAdd = totalPhotos < NOTICE_PHOTO_MAX
  const totalFiles = existingFiles.length + pendingFiles.length
  const canAddFile = totalFiles < NOTICE_FILE_MAX

  const teamOptions = useMemo(
    () => [...PRIMARY_TEAMS, DRIVING_POOL_TEAM],
    []
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const item of pendingRef.current) revokeNoticePreviewUrl(item.previewUrl)
    }
  }, [])

  function syncPending(next: NoticePendingPick[]) {
    pendingRef.current = next
    setPending(next)
  }

  function photoRoomLeft() {
    return Math.max(
      0,
      NOTICE_PHOTO_MAX -
        existingCountRef.current -
        pendingRef.current.length -
        reservedPasteRef.current
    )
  }

  async function addPhotoFiles(files: File[]) {
    if (!files.length || busyRef.current || !mountedRef.current) return
    setStatusNote('')
    const room = photoRoomLeft()
    if (room <= 0) {
      setStatusNote(noticePhotoLimitMessage())
      return
    }
    const { items, note } = instantNoticePhotoPicks(files, room, {
      fileIds: pendingRef.current.map((p) => p.fileId),
    })
    if (items.length < files.length && items.length >= room) {
      setStatusNote(noticePhotoLimitMessage())
    } else if (note) {
      setStatusNote(note)
    }
    if (!items.length) return
    syncPending([...pendingRef.current, ...items])
    for (const item of items) {
      const prepared = await prepareNoticePendingPhoto(item)
      if (!mountedRef.current) {
        revokeNoticePreviewUrl(prepared.previewUrl)
        return
      }
      const current = pendingRef.current
      const still = current.find((p) => p.key === item.key)
      if (!still) {
        if (prepared.previewUrl !== item.previewUrl) revokeNoticePreviewUrl(prepared.previewUrl)
        continue
      }
      if (
        prepared.status === 'ready' &&
        prepared.fingerprint &&
        (fingerprintsRef.current.has(prepared.fingerprint) ||
          current.some((p) => p.key !== item.key && p.fingerprint === prepared.fingerprint))
      ) {
        revokeNoticePreviewUrl(prepared.previewUrl)
        syncPending(pendingRef.current.filter((p) => p.key !== item.key))
        setStatusNote('이미 추가한 사진입니다.')
        continue
      }
      if (prepared.status === 'ready' && prepared.fingerprint) {
        fingerprintsRef.current.add(prepared.fingerprint)
      }
      syncPending(pendingRef.current.map((p) => (p.key === item.key ? prepared : p)))
      if (prepared.status === 'failed' && prepared.error) setStatusNote(prepared.error)
    }
  }

  const addPhotoFilesRef = useRef(addPhotoFiles)
  addPhotoFilesRef.current = addPhotoFiles

  function releasePasteReservation() {
    reservedPasteRef.current = Math.max(0, reservedPasteRef.current - 1)
  }

  async function pasteExcelTable(html: string) {
    if (photoRoomLeft() <= 0) {
      setStatusNote(noticePhotoLimitMessage())
      return
    }
    reservedPasteRef.current += 1
    setPasteNote('엑셀 표를 이미지로 만드는 중…')
    let released = false
    const release = () => {
      if (released) return
      released = true
      releasePasteReservation()
    }
    try {
      const { excelClipboardHtmlToNoticePhoto } = await import('@/lib/noticeExcelTableImage')
      const file = await excelClipboardHtmlToNoticePhoto(html)
      release()
      if (!mountedRef.current) return
      setPasteNote('')
      await addPhotoFilesRef.current([file])
    } catch (error) {
      release()
      if (!mountedRef.current) return
      setPasteNote('')
      setStatusNote(error instanceof Error ? error.message : NOTICE_PASTE_EXCEL_FALLBACK)
    }
  }

  const pasteExcelRef = useRef(pasteExcelTable)
  pasteExcelRef.current = pasteExcelTable

  useEffect(() => {
    function onDocPaste(event: ClipboardEvent) {
      const form = formRef.current
      if (!form) return
      const target = event.target
      if (target instanceof Node) {
        const inside = form.contains(target)
        const atRoot = target === document.body || target === document.documentElement
        if (!inside && !atRoot) return
      }
      const decision = classifyNoticeClipboard(noticeClipboardFromData(event.clipboardData))
      if (decision.kind === 'text') return
      event.preventDefault()
      if (busyRef.current) {
        setStatusNote(NOTICE_PASTE_WHILE_SAVING)
        return
      }
      if (decision.kind === 'unsupported') {
        setPasteNote('')
        setStatusNote(decision.message)
        return
      }
      if (decision.kind === 'image') {
        setPasteNote('')
        void addPhotoFilesRef.current(decision.files)
        return
      }
      void pasteExcelRef.current(decision.html)
    }
    document.addEventListener('paste', onDocPaste, true)
    return () => document.removeEventListener('paste', onDocPaste, true)
  }, [])

  async function onPick(files: FileList | null) {
    if (!files || busyRef.current) return
    await addPhotoFiles(Array.from(files))
    if (fileRef.current) fileRef.current.value = ''
  }

  function removePending(key: string) {
    const hit = pendingRef.current.find((p) => p.key === key)
    if (hit) {
      revokeNoticePreviewUrl(hit.previewUrl)
      if (hit.fingerprint) fingerprintsRef.current.delete(hit.fingerprint)
    }
    syncPending(pendingRef.current.filter((p) => p.key !== key))
  }

  async function removeExisting(photoId: number) {
    if (!initial?.id) return
    const res = await fetch(`/api/notice/${initial.id}/photos/${photoId}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    if (consumeUnauthorizedMemberResponse(res)) return
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setStatusNote(typeof data.message === 'string' ? data.message : '사진 삭제 실패')
      return
    }
    setExistingPhotos((cur) => cur.filter((p) => p.id !== photoId))
  }

  async function onPickPdf(files: FileList | null) {
    if (!files || busy) return
    setStatusNote('')
    const room = NOTICE_FILE_MAX - existingFiles.length - pendingFiles.length
    const { items, note } = pickNoticeFiles(Array.from(files), room, {
      fileIds: pendingFiles.map((p) => p.fileId),
    })
    if (note) setStatusNote(note)
    if (items.length) {
      setPendingFiles((cur) => {
        const roomLeft = NOTICE_FILE_MAX - existingFiles.length - cur.length
        return [...cur, ...items.slice(0, Math.max(0, roomLeft))]
      })
    }
    if (pdfRef.current) pdfRef.current.value = ''
  }

  function removePendingFile(key: string) {
    setPendingFiles((cur) => cur.filter((p) => p.key !== key))
  }

  async function removeExistingFile(fileId: number) {
    if (!initial?.id) return
    const res = await fetch(`/api/notice/${initial.id}/files/${fileId}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    if (consumeUnauthorizedMemberResponse(res)) return
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setStatusNote(typeof data.message === 'string' ? data.message : '첨부파일 삭제 실패')
      return
    }
    setExistingFiles((cur) => cur.filter((f) => f.id !== fileId))
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitLock.current || busy) return
    submitLock.current = true
    busyRef.current = true
    setBusy(true)
    setStatusNote('')
    try {
      if (pendingRef.current.some((p) => p.status === 'preparing')) {
        setSaveProgress('사진 준비 중…')
        const deadline = Date.now() + 60_000
        while (pendingRef.current.some((p) => p.status === 'preparing')) {
          if (Date.now() > deadline) {
            setStatusNote('사진 준비가 너무 오래 걸립니다. 다시 시도해 주세요.')
            return
          }
          await new Promise((r) => setTimeout(r, 50))
        }
      }
      const currentPending = pendingRef.current
      if (currentPending.some((p) => p.status === 'failed')) {
        setStatusNote('준비에 실패한 사진이 있습니다. 삭제 후 다시 선택해 주세요.')
        return
      }
      if (currentPending.some((p) => p.status !== 'ready' || !p.blob)) {
        setStatusNote('아직 준비되지 않은 사진이 있습니다. 잠시 후 다시 저장해 주세요.')
        return
      }

      setSaveProgress('공지 저장 중…')
      const plan = planNoticeClientAutoPush({
        sendPushRequested: sendPush && !scheduled,
        pendingPhotoCount: currentPending.length,
        pendingFileCount: pendingFiles.length,
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

      if (consumeUnauthorizedMemberResponse(res)) return

      if (!res.ok) {
        const failData = await res.json().catch(() => ({}))
        alert(
          typeof failData.message === 'string'
            ? failData.message
            : isEdit
              ? '공지 수정에 실패했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.'
              : '공지 등록에 실패했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.'
        )
        return
      }

      const data = await res.json().catch(() => ({}))
      const noticeId = isEdit
        ? initial?.id
        : typeof data.id === 'number'
          ? data.id
          : null

      let photoFailed = 0
      let fileFailed = 0
      const readyPhotos = currentPending.filter((p) => p.status === 'ready' && p.blob)
      const photoSortStart =
        existingPhotos.reduce((max, photo) => Math.max(max, photo.sortOrder), -1) + 1
      if (noticeId && readyPhotos.length > 0) {
        setSaveProgress(`사진 업로드 중 0/${readyPhotos.length}`)
        const uploaded = await uploadNoticePendingPhotos(noticeId, readyPhotos, {
          onProgress: (p) =>
            setSaveProgress(`사진 업로드 중 ${p.done}/${p.total}`),
          sortOrderStart: photoSortStart,
        })
        if (isMemberSessionRedirectScheduled()) return
        photoFailed = uploaded.failed
        if (uploaded.failedIndexes.length > 0) {
          const failedKeys = new Set(
            uploaded.failedIndexes.map((i) => readyPhotos[i]?.key).filter(Boolean)
          )
          const kept = pendingRef.current.filter((p) => failedKeys.has(p.key))
          fingerprintsRef.current = new Set(
            kept.map((p) => p.fingerprint).filter((fp): fp is string => Boolean(fp))
          )
          syncPending(kept)
        } else {
          for (const item of readyPhotos) revokeNoticePreviewUrl(item.previewUrl)
          fingerprintsRef.current.clear()
          syncPending([])
        }
      }
      const fileSortStart =
        existingFiles.reduce((max, file) => Math.max(max, file.sortOrder), -1) + 1
      if (noticeId && pendingFiles.length > 0) {
        setSaveProgress(`첨부파일 업로드 중 0/${pendingFiles.length}`)
        const uploadedFiles = await uploadNoticePendingFiles(noticeId, pendingFiles, {
          onProgress: (p) =>
            setSaveProgress(`첨부파일 업로드 중 ${p.done}/${p.total}`),
          sortOrderStart: fileSortStart,
        })
        if (isMemberSessionRedirectScheduled()) return
        fileFailed = uploadedFiles.failed
        if (uploadedFiles.failedIndexes.length > 0) {
          setPendingFiles((cur) => cur.filter((_, i) => uploadedFiles.failedIndexes.includes(i)))
        } else {
          setPendingFiles([])
        }
      }
      if (photoFailed > 0 || fileFailed > 0) {
        const parts = [
          photoFailed > 0 ? `사진 ${photoFailed}장` : '',
          fileFailed > 0 ? `첨부파일 ${fileFailed}개` : '',
        ].filter(Boolean)
        alert(
          `공지는 저장됐지만 ${parts.join(', ')}를 올리지 못했습니다. 기존 첨부 파일은 그대로 두었습니다. 자동 푸시는 보내지 않았습니다.`
        )
        router.replace(`/notice/${noticeId}/edit`)
        return
      }

      if (noticeId && plan.sendAfterPhotos) {
        setSaveProgress('푸시 발송 중…')
        const after = await requestNoticePushSend(noticeId)
        if (!after.ok) {
          alert(after.message || '공지와 첨부 파일은 저장됐지만 푸시 알림 발송에 실패했습니다.')
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
        if (pushNote) alert(pushNote)
      }

      if (noticeId) {
        router.replace(`/notice/${noticeId}`)
      } else {
        router.replace('/notice')
      }
    } catch {
      alert(
        isEdit
          ? '공지 수정 중 오류가 발생했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.'
          : '공지 등록 중 오류가 발생했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.'
      )
    } finally {
      if (!isMemberSessionRedirectScheduled()) {
        submitLock.current = false
        setBusy(false)
        setSaveProgress('')
      }
    }
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="notice-form">
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
        <legend>사진 첨부 (최대 {NOTICE_PHOTO_MAX}장)</legend>
        <div className="course-report-photo-composer">
          {existingPhotos.map((photo) => (
            <div key={photo.id} className="course-report-photo-item">
              {/* object URL / 저장된 사진은 즉시 표시 (is-revealed: 공용 CSS 의 opacity:0 페이드 대상에서 제외) */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="is-revealed" src={noticePhotoSrc(initial!.id, photo.id)} alt="" />
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
            <div
              key={photo.key}
              className={`course-report-photo-item${photo.status === 'failed' ? ' is-failed' : ''}${photo.status === 'preparing' ? ' is-preparing' : ''}`}
            >
              {photo.previewUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  className="is-revealed"
                  src={photo.previewUrl}
                  alt=""
                  onError={(e) => {
                    e.currentTarget.style.opacity = '1'
                  }}
                />
              ) : (
                <span className="notice-photo-thumb-fallback" aria-hidden>
                  {photo.status === 'preparing' ? '준비 중' : '미리보기 없음'}
                </span>
              )}
              {photo.status === 'preparing' ? (
                <span className="notice-photo-thumb-status">사진 준비 중…</span>
              ) : null}
              {photo.status === 'failed' ? (
                <span className="notice-photo-thumb-status">준비 실패</span>
              ) : null}
              <button
                type="button"
                className="course-report-photo-remove"
                aria-label="사진 삭제"
                disabled={busy}
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
              accept={NOTICE_PHOTO_ACCEPT}
              multiple
              disabled={!canAdd || busy}
              onChange={(e) => void onPick(e.target.files)}
            />
          </label>
        </div>
        <p className="notice-photo-paste-hint">{NOTICE_PASTE_HINT}</p>
        {pasteNote ? (
          <p className="notice-form-progress" role="status">
            {pasteNote}
          </p>
        ) : null}
        {statusNote ? <p className="course-report-photo-note">{statusNote}</p> : null}
      </fieldset>
      <fieldset className="course-report-fieldset">
        <legend>첨부파일 (최대 {NOTICE_FILE_MAX}개 · PDF/Excel/한글)</legend>
        <ul className="notice-files-composer">
          {existingFiles.map((file) => (
            <li key={file.id} className="notice-files-composer-item">
              <a href={noticeFileSrc(initial!.id, file.id)} target="_blank" rel="noopener">
                {file.originalName}
              </a>
              <button
                type="button"
                className="notice-files-composer-remove"
                aria-label="첨부파일 삭제"
                onClick={() => void removeExistingFile(file.id)}
              >
                삭제
              </button>
            </li>
          ))}
          {pendingFiles.map((file) => (
            <li key={file.key} className="notice-files-composer-item">
              <span>{file.file.name}</span>
              <button
                type="button"
                className="notice-files-composer-remove"
                aria-label="첨부파일 삭제"
                onClick={() => removePendingFile(file.key)}
              >
                삭제
              </button>
            </li>
          ))}
        </ul>
        <p className="notice-photo-paste-hint">
          PDF, Excel(.xlsx/.xls), 한글(.hwp/.hwpx) · 파일당 20MB · 최대 {NOTICE_FILE_MAX}개
        </p>
        <label className={`notice-file-add${canAddFile ? '' : ' is-disabled'}`}>
          + 파일
          <input
            ref={pdfRef}
            type="file"
            accept={NOTICE_FILE_ACCEPT}
            multiple
            disabled={!canAddFile || busy}
            onChange={(e) => void onPickPdf(e.target.files)}
          />
        </label>
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
      {saveProgress ? (
        <p className="notice-form-progress" role="status" aria-live="polite">
          {saveProgress}
        </p>
      ) : null}
      <div className="notice-form-actions">
        <button type="submit" disabled={busy} className="ui-btn ui-btn-primary">
          {busy
            ? saveProgress || (isEdit ? '수정 중…' : '등록 중…')
            : isEdit
              ? '수정'
              : '등록'}
        </button>
        <a href={isEdit ? `/notice/${initial?.id}` : '/notice'} className="ui-btn ui-btn-ghost">
          취소
        </a>
      </div>
    </form>
  )
}
