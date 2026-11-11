"use client";

import {
  NOTICE_PUBLISH_CLEAR_LABEL,
  NOTICE_PUBLISH_END_EXCLUSIVE_HINT,
  NOTICE_PUBLISH_MODE_HINTS,
  NOTICE_PUBLISH_MODE_LABELS,
  NOTICE_PUBLISH_MODES,
  NOTICE_PUBLISH_QUICK_RANGE_LABELS,
  NOTICE_PUBLISH_QUICK_RANGES,
  NOTICE_PUBLISH_STATUS_LABELS,
  NOTICE_SCHEDULED_PUSH_HINT,
  type NoticePublishMode,
  type NoticePublishQuickRange,
  type NoticePublishStatus,
} from "@/lib/noticeConstants";

type Props = {
  mode: NoticePublishMode;
  startLocal: string;
  endLocal: string;
  status: NoticePublishStatus;
  scheduled: boolean;
  onModeChange: (mode: NoticePublishMode) => void;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  onQuickRange: (key: NoticePublishQuickRange) => void;
  invalidWindow: boolean;
};

export default function NoticePublishWindowFields({
  mode,
  startLocal,
  endLocal,
  status,
  scheduled,
  onModeChange,
  onStartChange,
  onEndChange,
  onQuickRange,
  invalidWindow,
}: Props) {
  const showDates = mode !== "always";
  const showQuick = mode === "range";
  const showTimeFields = mode === "range" || mode === "scheduled";

  return (
    <fieldset className="notice-publish">
      <legend>게시 기간</legend>
      <div className="notice-publish-modes" role="radiogroup" aria-label="게시 방식">
        {NOTICE_PUBLISH_MODES.map((key) => (
          <label
            key={key}
            className={`notice-publish-mode${mode === key ? " is-active" : ""}`}
          >
            <input
              type="radio"
              name="notice-publish-mode"
              value={key}
              checked={mode === key}
              onChange={() => onModeChange(key)}
            />
            <span>
              <strong>{NOTICE_PUBLISH_MODE_LABELS[key]}</strong>
              <em>{NOTICE_PUBLISH_MODE_HINTS[key]}</em>
            </span>
          </label>
        ))}
      </div>

      {showQuick ? (
        <div className="notice-publish-quick" role="group" aria-label="빠른 선택">
          {NOTICE_PUBLISH_QUICK_RANGES.map((key) => (
            <button
              key={key}
              type="button"
              className="notice-publish-chip"
              onClick={() => onQuickRange(key)}
            >
              {NOTICE_PUBLISH_QUICK_RANGE_LABELS[key]}
            </button>
          ))}
        </div>
      ) : null}

      {showDates && showTimeFields ? (
        <div className="notice-publish-dates">
          <label className="notice-field">
            <span>{mode === "scheduled" ? "게시 시작 (필수)" : "게시 시작"}</span>
            <span className="notice-publish-date-row">
              <input
                type="datetime-local"
                value={startLocal}
                onChange={(e) => onStartChange(e.target.value)}
              />
              <button
                type="button"
                className="ui-btn ui-btn-ghost notice-publish-clear"
                onClick={() => onStartChange("")}
              >
                {NOTICE_PUBLISH_CLEAR_LABEL}
              </button>
            </span>
          </label>
          <label className="notice-field">
            <span>{mode === "scheduled" ? "게시 종료 (선택)" : "게시 종료"}</span>
            <span className="notice-publish-date-row">
              <input
                type="datetime-local"
                value={endLocal}
                onChange={(e) => onEndChange(e.target.value)}
              />
              <button
                type="button"
                className="ui-btn ui-btn-ghost notice-publish-clear"
                onClick={() => onEndChange("")}
              >
                {NOTICE_PUBLISH_CLEAR_LABEL}
              </button>
            </span>
          </label>
          <p className="notice-publish-end-hint">{NOTICE_PUBLISH_END_EXCLUSIVE_HINT}</p>
        </div>
      ) : null}

      {mode === "today" ? (
        <p className="notice-publish-end-hint">{NOTICE_PUBLISH_MODE_HINTS.today}</p>
      ) : null}

      <p
        className={`notice-publish-status is-${status}`}
        role="status"
      >
        현재 상태: {NOTICE_PUBLISH_STATUS_LABELS[status]}
      </p>
      {invalidWindow ? (
        <p className="notice-publish-error" role="alert">
          게시 시작일이 종료일보다 늦을 수 없습니다.
        </p>
      ) : null}
      {scheduled ? (
        <p className="notice-scheduled-push-hint" role="status">
          {NOTICE_SCHEDULED_PUSH_HINT}
        </p>
      ) : null}
    </fieldset>
  );
}
