"use client";

import type { ReactNode } from "react";
import {
  MARSHAL_GRID_COLUMNS,
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
          {entry.isPenalty ? <span className="ms-xg-tag">벌</span> : null}
        </span>
      ))}
    </span>
  );
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
          const panelId = `marshal-dense-panel-${row.ymd}`;
          return (
            <li
              key={row.ymd}
              className={`ms-xg-row is-w${row.weekday}${open ? " is-open" : ""}${
                row.isWeekend ? " is-weekend" : ""
              }${row.isToday ? " is-today" : ""}`}
              data-marshal-grid-row={row.ymd}
            >
              <button
                type="button"
                className="ms-xg-main"
                aria-expanded={open}
                aria-controls={panelId}
                aria-current={row.isToday ? "date" : undefined}
                data-marshal-day={row.ymd}
                onClick={() => onToggleDay(row.ymd)}
              >
                <span className="ms-xg-date">
                  <span className="ms-xg-day">{row.day}</span>
                  <span className="ms-xg-wd">{row.weekdayLabel}</span>
                  {row.isToday ? <span className="ms-xg-today">오늘</span> : null}
                </span>
                <GridCell cell={row.am1} />
                <GridCell cell={row.am2} />
                <GridCell cell={row.pm} />
              </button>
              {open && renderDayDetail ? renderDayDetail(row, panelId) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
