'use client'

import {
  NOTICE_PUBLISH_MODE_LABELS,
  NOTICE_PUBLISH_MODES,
  noticePublishSummary,
  noticeRangeDefaultEndYmd,
  type NoticePublishComputeResult,
  type NoticePublishFormState,
  type NoticePublishMode,
  type NoticePublishWindowValue,
} from '@/lib/noticePublishWindow'

type Props = {
  value: NoticePublishFormState
  onChange: (next: NoticePublishFormState) => void
  result: NoticePublishComputeResult
  /** 수정 화면에서 아직 손대지 않았을 때 저장될 기존 값. */
  untouchedWindow?: NoticePublishWindowValue | null
  disabled?: boolean
}

/** 공지 게시기간: 방식 버튼 4개 + 선택한 방식에 필요한 칸만. */
export default function NoticePublishWindowFields({
  value,
  onChange,
  result,
  untouchedWindow,
  disabled,
}: Props) {
  const set = (patch: Partial<NoticePublishFormState>) => onChange({ ...value, ...patch })

  const pickMode = (mode: NoticePublishMode) => set({ mode })

  const onRangeStart = (ymd: string) => {
    const patch: Partial<NoticePublishFormState> = { rangeStartYmd: ymd }
    // 종료일이 비었거나 시작일보다 앞서면 기본(시작일 + 7일)으로 맞춘다.
    if (ymd && (!value.rangeEndYmd || value.rangeEndYmd < ymd)) {
      patch.rangeEndYmd = noticeRangeDefaultEndYmd(ymd)
    }
    set(patch)
  }

  const summaryWindow = untouchedWindow ?? (result.ok ? result.window : null)

  return (
    <fieldset className="notice-publish" disabled={disabled}>
      <legend>게시 기간</legend>
      <div className="notice-publish-modes" role="radiogroup" aria-label="게시 방식">
        {NOTICE_PUBLISH_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={value.mode === mode}
            className={value.mode === mode ? 'is-active' : undefined}
            onClick={() => pickMode(mode)}
          >
            {NOTICE_PUBLISH_MODE_LABELS[mode]}
          </button>
        ))}
      </div>

      {value.mode === 'range' ? (
        <div className="notice-publish-inputs">
          <label>
            <span>시작일</span>
            <input
              type="date"
              value={value.rangeStartYmd}
              onChange={(e) => onRangeStart(e.target.value)}
              required
            />
          </label>
          <label>
            <span>종료일</span>
            <input
              type="date"
              value={value.rangeEndYmd}
              min={value.rangeStartYmd || undefined}
              onChange={(e) => set({ rangeEndYmd: e.target.value })}
              required
            />
          </label>
        </div>
      ) : null}

      {value.mode === 'scheduled' ? (
        <div className="notice-publish-inputs is-scheduled">
          <label>
            <span>게시 시작</span>
            <input
              type="datetime-local"
              value={value.scheduledStartLocal}
              onChange={(e) => set({ scheduledStartLocal: e.target.value })}
              required
            />
          </label>
          <label>
            <span>종료일 (선택)</span>
            <input
              type="date"
              value={value.scheduledEndYmd}
              min={value.scheduledStartLocal.slice(0, 10) || undefined}
              onChange={(e) => set({ scheduledEndYmd: e.target.value })}
            />
          </label>
        </div>
      ) : null}

      {result.ok || untouchedWindow ? (
        summaryWindow ? (
          <p className="notice-publish-summary" role="status">
            {noticePublishSummary(summaryWindow, value.mode)}
          </p>
        ) : null
      ) : (
        <p className="notice-publish-error" role="alert">
          {result.message}
        </p>
      )}
      <p className="notice-publish-note">한국 시간 기준입니다.</p>
    </fieldset>
  )
}
