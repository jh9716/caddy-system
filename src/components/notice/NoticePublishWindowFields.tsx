"use client";

import {
  NOTICE_PUBLISH_CLEAR_LABEL,
  NOTICE_PUBLISH_CUSTOM_TIME_LABEL,
  NOTICE_PUBLISH_INVALID_WINDOW_MESSAGE,
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
import { formatKstDateTimeLocal } from "@/lib/kstDate";
import {
  inclusiveEndYmdFromExclusiveEnd,
  kstExclusiveEndOfDay,
  kstYmdFromInstant,
  noticePublishEndGuidance,
  parseNoticePublishInstant,
} from "@/lib/noticePublishWindow";

type Props = {
  mode: NoticePublishMode;
  startLocal: string;
  endLocal: string;
  customStartTime: boolean;
  customEndTime: boolean;
  status: NoticePublishStatus;
  scheduled: boolean;
  onModeChange: (mode: NoticePublishMode) => void;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  onCustomStartTimeChange: (value: boolean) => void;
  onCustomEndTimeChange: (value: boolean) => void;
  onQuickRange: (key: NoticePublishQuickRange) => void;
  activeQuickRange: NoticePublishQuickRange | null;
  invalidWindow: boolean;
};

export default function NoticePublishWindowFields({
  mode,
  startLocal,
  endLocal,
  customStartTime,
  customEndTime,
  status,
  scheduled,
  onModeChange,
  onStartChange,
  onEndChange,
  onCustomStartTimeChange,
  onCustomEndTimeChange,
  onQuickRange,
  activeQuickRange,
  invalidWindow,
}: Props) {
  const startInstant = parseNoticePublishInstant(startLocal || null);
  const endInstant = parseNoticePublishInstant(endLocal || null);
  const startYmd = startInstant ? kstYmdFromInstant(startInstant) : "";
  const endYmd = endInstant
    ? customEndTime
      ? kstYmdFromInstant(endInstant)
      : inclusiveEndYmdFromExclusiveEnd(endInstant)
    : "";
  const showQuick = mode === "range";
  const showRangeDates = mode === "range";
  const showScheduledTimes = mode === "scheduled";
  const endHint = noticePublishEndGuidance({
    end: endInstant,
    customEnd: customEndTime,
    endYmd,
  });

  function onStartDateChange(ymd: string) {
    if (!ymd) {
      onStartChange("");
      return;
    }
    onStartChange(`${ymd}T00:00`);
  }

  function onEndDateChange(ymd: string) {
    if (!ymd) {
      onEndChange("");
      return;
    }
    onEndChange(formatKstDateTimeLocal(kstExclusiveEndOfDay(ymd)));
  }

  function toggleCustomStart(next: boolean) {
    onCustomStartTimeChange(next);
    if (!next && startYmd) onStartChange(`${startYmd}T00:00`);
  }

  function toggleCustomEnd(next: boolean) {
    onCustomEndTimeChange(next);
    if (!next && endInstant) {
      const ymd = inclusiveEndYmdFromExclusiveEnd(endInstant);
      onEndChange(formatKstDateTimeLocal(kstExclusiveEndOfDay(ymd)));
    }
  }

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
              className={`notice-publish-chip${activeQuickRange === key ? " is-active" : ""}`}
              aria-pressed={activeQuickRange === key}
              onClick={() => onQuickRange(key)}
            >
              {NOTICE_PUBLISH_QUICK_RANGE_LABELS[key]}
            </button>
          ))}
        </div>
      ) : null}

      {showRangeDates ? (
        <div className="notice-publish-dates">
          {customStartTime ? (
            <label className="notice-field notice-publish-custom-time">
              <span>시작 시각</span>
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
          ) : (
            <label className="notice-field">
              <span>시작일</span>
              <span className="notice-publish-date-row">
                <input
                  type="date"
                  value={startYmd}
                  onChange={(e) => onStartDateChange(e.target.value)}
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
          )}
          <label className="notice-check notice-publish-custom-toggle">
            <input
              type="checkbox"
              checked={customStartTime}
              onChange={(e) => toggleCustomStart(e.currentTarget.checked)}
            />
            {NOTICE_PUBLISH_CUSTOM_TIME_LABEL}
          </label>

          {customEndTime ? (
            <label className="notice-field notice-publish-custom-time">
              <span>종료 시각</span>
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
          ) : (
            <label className="notice-field">
              <span>종료일</span>
              <span className="notice-publish-date-row">
                <input
                  type="date"
                  value={endYmd}
                  onChange={(e) => onEndDateChange(e.target.value)}
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
          )}
          <label className="notice-check notice-publish-custom-toggle">
            <input
              type="checkbox"
              checked={customEndTime}
              onChange={(e) => toggleCustomEnd(e.currentTarget.checked)}
            />
            {NOTICE_PUBLISH_CUSTOM_TIME_LABEL}
          </label>
          <p
            className={`notice-publish-end-hint${customEndTime ? " is-custom" : ""}`}
            role="status"
          >
            {endHint}
          </p>
        </div>
      ) : null}

      {showScheduledTimes ? (
        <div className="notice-publish-dates">
          <label className="notice-field">
            <span>게시 시작 (필수)</span>
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
            <span>게시 종료일 (선택)</span>
            <span className="notice-publish-date-row">
              <input
                type="date"
                value={endYmd}
                onChange={(e) => onEndDateChange(e.target.value)}
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
          <label className="notice-check notice-publish-custom-toggle">
            <input
              type="checkbox"
              checked={customEndTime}
              disabled={!endYmd && !endLocal}
              onChange={(e) => toggleCustomEnd(e.currentTarget.checked)}
            />
            {NOTICE_PUBLISH_CUSTOM_TIME_LABEL}
          </label>
          {customEndTime ? (
            <label className="notice-field notice-publish-custom-time">
              <span>종료 시각</span>
              <input
                type="datetime-local"
                value={endLocal}
                onChange={(e) => onEndChange(e.target.value)}
              />
            </label>
          ) : null}
          {endYmd || endLocal ? (
            <p
              className={`notice-publish-end-hint${customEndTime ? " is-custom" : ""}`}
              role="status"
            >
              {endHint}
            </p>
          ) : (
            <p className="notice-publish-end-hint">종료일을 비우면 시작 이후 계속 보입니다.</p>
          )}
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
          {NOTICE_PUBLISH_INVALID_WINDOW_MESSAGE}
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
