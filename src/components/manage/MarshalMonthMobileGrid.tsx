"use client";

import { useEffect, useState, type ReactNode } from "react";
import { occurrenceCalendarBadgeText } from "@/lib/marshalPenaltyOccurrenceUi";
import {
  MARSHAL_GRID_COLUMNS,
  marshalDayFlagBadges,
  msUntilNextSeoulMidnight,
  seoulTodayYmd,
  marshalGridEntryOrderText,
  type MarshalGridCell,
  type MarshalGridRow,
  type MarshalPlanStatusKind,
} from "@/lib/marshalScheduleUi";

/**
 * 모바일(≤719px) 엑셀형 월표. 날짜+요일 | 조출1 | 조출2 | 후출.
 * 행을 누르면 기존 일자 상세(교체 포함)를 그대로 펼친다.
 */
function GridCell({ cell }: { cell: MarshalGridCell }) {
  if (cell.entries.length === 0) {
    return (
      <span className="ms-xg-cell is-empty" data-marshal-grid-cell={cell.label}>
        <span className="ms-xg-unassigned">미배정</span>
      </span>
    );
  }
  return (
    <span className="ms-xg-cell" data-marshal-grid-cell={cell.label}>
      {cell.entries.map((entry) => (
        <span
          key={entry.slotId}
          className={`ms-xg-entry${entry.isSubstitute ? " is-sub" : ""}${
            entry.isPenalty ? " is-penalty" : ""
          }`}
          data-marshal-grid-source={entry.source}
          title={
            entry.isSubstitute && entry.originalName
              ? `대타 (원래 ${entry.originalName})`
              : undefined
          }
        >
          <span
            className={`ms-xg-order${entry.rotationOrder == null ? " is-unknown" : ""}`}
            aria-label={entry.rotationOrder == null ? "순번 없음" : `순번 ${entry.rotationOrder}`}
          >
            {marshalGridEntryOrderText(entry)}
          </span>
          <span className="ms-xg-name">{entry.name}</span>
          {entry.isPenalty ? (
            <span className="ms-xg-tag" title="벌당 근무 배정">
              <span aria-hidden>벌</span>
              <span className="vh-sr-only">벌당 근무 배정</span>
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

/** 기존 DayFlags 와 같은 조건의 상태 배지(경고·대타·벌당·전일 벌당 발생 기록) */
function GridFlags({ row }: { row: MarshalGridRow }) {
  const flags = marshalDayFlagBadges(row.board, occurrenceCalendarBadgeText);
  if (flags.length === 0) return null;
  return (
    <span className="ms-xg-flags" data-marshal-grid-flags={row.ymd}>
      {flags.map((flag) => (
        <span
          key={flag.key}
          className={`ms-xg-flag is-${flag.kind}${
            flag.source ? ` is-${flag.source.toLowerCase()}` : ""
          }`}
          data-marshal-grid-flag={flag.kind}
        >
          <span aria-hidden>{flag.text}</span>
          <span className="vh-sr-only">{flag.srText}</span>
        </span>
      ))}
    </span>
  );
}

/** Asia/Seoul 기준 오늘. 자정·탭 복귀 시 갱신 */
function useSeoulToday(): string {
  const [today, setToday] = useState(() => seoulTodayYmd());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => setToday(seoulTodayYmd());
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        refresh();
        schedule();
      }, msUntilNextSeoulMidnight() + 500);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refresh();
        schedule();
      }
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return today;
}

export default function MarshalMonthMobileGrid({
  rows,
  status,
  selectedDate,
  onToggleDay,
  renderDayDetail,
}: {
  rows: readonly MarshalGridRow[];
  status: MarshalPlanStatusKind;
  selectedDate: string | null;
  onToggleDay: (ymd: string) => void;
  renderDayDetail?: (row: MarshalGridRow, panelId: string) => ReactNode;
}) {
  const today = useSeoulToday();
  return (
    <div
      className="ms-dense ms-xg"
      data-marshal-schedule="dense"
      data-marshal-grid-status={status}
    >
      <div className="ms-xg-head" role="row">
        {MARSHAL_GRID_COLUMNS.map((label) => (
          <span key={label} className="ms-xg-hcell" role="columnheader">
            {label}
          </span>
        ))}
      </div>
      <ul className="ms-xg-body">
        {rows.map((row) => {
          const open = selectedDate === row.ymd;
          const isToday = row.ymd === today;
          const panelId = `marshal-dense-panel-${row.ymd}`;
          return (
            <li
              key={row.ymd}
              className={`ms-xg-row is-w${row.weekday}${open ? " is-open" : ""}${
                row.isWeekend ? " is-weekend" : ""
              }${isToday ? " is-today" : ""}`}
              data-marshal-grid-row={row.ymd}
            >
              <button
                type="button"
                className="ms-xg-main"
                aria-expanded={open}
                aria-controls={panelId}
                aria-current={isToday ? "date" : undefined}
                data-marshal-day={row.ymd}
                onClick={() => onToggleDay(row.ymd)}
              >
                <span className="ms-xg-date">
                  <span className="ms-xg-day">{row.day}</span>
                  <span className="ms-xg-wd">{row.weekdayLabel}</span>
                  {isToday ? <span className="ms-xg-today">오늘</span> : null}
                </span>
                <GridCell cell={row.am1} />
                <GridCell cell={row.am2} />
                <GridCell cell={row.pm} />
                <GridFlags row={row} />
              </button>
              {open && renderDayDetail ? renderDayDetail(row, panelId) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
