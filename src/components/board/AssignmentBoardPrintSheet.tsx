import React from "react";
import {
  BOARD_PRINT_CLOSED_LABEL,
  BOARD_PRINT_EMPTY_COURSE_LABEL,
  BOARD_PRINT_TITLE,
  BOARD_PRINT_UNASSIGNED_LABEL,
  boardPrintCaddyAffiliation,
  boardPrintMarks,
  isVacantPrintCaddy,
  type BoardPrintSheet,
} from "@/lib/assignmentBoardPrint";
import type { AutoAssignmentRow } from "@/lib/autoAssignEngine";
import { COURSE_CODES } from "@/lib/reservationParser";

/**
 * A4 가로 인쇄용 배치표 (읽기 전용, hook 없음 → 서버 렌더/테스트 가능).
 * 시간 × 4코스(베르힐·스카이·오션·레이크) 표. thead는 페이지마다 반복된다.
 */
function PrintSlot({
  row,
  sheet,
}: {
  row: AutoAssignmentRow;
  sheet: BoardPrintSheet;
}) {
  if (isVacantPrintCaddy(row)) {
    return (
      <div className="bp-slot bp-slot-vacant" data-print-slot="vacant">
        <span className="bp-vacant">{BOARD_PRINT_UNASSIGNED_LABEL}</span>
        {sheet.includeTeamName && row.reservation.teamName ? (
          <span className="bp-team">{row.reservation.teamName}</span>
        ) : null}
      </div>
    );
  }
  const marks = boardPrintMarks(row, sheet.allAssignments);
  const affil = boardPrintCaddyAffiliation(row);
  return (
    <div className="bp-slot" data-print-slot="assigned">
      <span className="bp-name">{row.caddy.name}</span>
      {affil ? <span className="bp-affil">{affil}</span> : null}
      {marks.length > 0 ? (
        <span className="bp-marks">
          {marks.map((m) => (
            <span key={m} className="bp-mark">
              {m}
            </span>
          ))}
        </span>
      ) : null}
      {sheet.includeTeamName && row.reservation.teamName ? (
        <span className="bp-team">{row.reservation.teamName}</span>
      ) : null}
    </div>
  );
}

export function AssignmentBoardPrintSheet({
  sheet,
  printedAt,
}: {
  sheet: BoardPrintSheet;
  /** 화면에서 만든 출력 시각 문자열 (테스트 재현성을 위해 주입) */
  printedAt?: string | null;
}) {
  const colCount = COURSE_CODES.length + 1;
  const dateLabel = sheet.weekday ? `${sheet.date} (${sheet.weekday})` : sheet.date;
  return (
    <div
      className="bp-sheet"
      data-board-print-sheet=""
      data-print-shift={sheet.shift}
      data-print-date={sheet.date}
    >
      <table className="bp-table" aria-label={`${sheet.date} ${sheet.shift} 배치표`}>
        <colgroup>
          <col className="bp-col-time" />
          {COURSE_CODES.map((code) => (
            <col key={code} className="bp-col-course" />
          ))}
        </colgroup>
        <thead>
          <tr className="bp-cap-row">
            <th colSpan={colCount} className="bp-cap">
              <div className="bp-cap-inner">
                <span className="bp-title">{BOARD_PRINT_TITLE}</span>
                <span className="bp-date" data-print-date-label="">
                  {dateLabel}
                </span>
                <span className="bp-shift" data-print-shift-label="">
                  {sheet.shift}
                </span>
                <span className="bp-spares">
                  <span>
                    스페어1 <b>{sheet.spare.spare1Label || "-"}</b>
                  </span>
                  <span>
                    스페어2 <b>{sheet.spare.spare2Label || "-"}</b>
                  </span>
                </span>
                <span className="bp-totals">
                  배정 {sheet.totals.assigned} · 미배치 {sheet.totals.unassigned}
                </span>
              </div>
            </th>
          </tr>
          <tr className="bp-head-row">
            <th className="bp-h-time">시간</th>
            {sheet.courses.map((c) => (
              <th
                key={c.code}
                className={`bp-h-course${c.open ? "" : " closed"}`}
                data-print-course={c.code}
              >
                <span className="bp-h-name">{c.label}</span>
                <span className="bp-h-sub">
                  {!c.open
                    ? BOARD_PRINT_CLOSED_LABEL
                    : c.assigned + c.unassigned === 0
                      ? BOARD_PRINT_EMPTY_COURSE_LABEL
                      : `배정 ${c.assigned}${c.unassigned ? ` · 미배치 ${c.unassigned}` : ""}`}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.length === 0 ? (
            <tr className="bp-row bp-row-none">
              <td colSpan={colCount} className="bp-none">
                {sheet.shift} 배치 없음
              </td>
            </tr>
          ) : (
            sheet.rows.map((tr) => (
              <tr key={tr.teeTime} className="bp-row" data-print-teetime={tr.teeTime}>
                <th className="bp-time" scope="row">
                  {tr.teeTime || "—"}
                </th>
                {COURSE_CODES.map((code) => {
                  const cell = tr.cells[code];
                  if (cell.kind === "closed") {
                    return <td key={code} className="bp-cell closed" data-print-cell="closed" />;
                  }
                  if (cell.kind === "empty") {
                    return <td key={code} className="bp-cell empty" data-print-cell="empty" />;
                  }
                  if (cell.kind === "unassigned") {
                    return (
                      <td key={code} className="bp-cell unassigned" data-print-cell="unassigned">
                        <div className="bp-slot bp-slot-vacant">
                          <span className="bp-vacant">{BOARD_PRINT_UNASSIGNED_LABEL}</span>
                          {sheet.includeTeamName && cell.reservation.teamName ? (
                            <span className="bp-team">{cell.reservation.teamName}</span>
                          ) : null}
                        </div>
                      </td>
                    );
                  }
                  return (
                    <td
                      key={code}
                      className="bp-cell assigned"
                      data-print-cell="assigned"
                      data-print-course={code}
                    >
                      {cell.rows.map((row, i) => (
                        <PrintSlot
                          key={`${row.reservation.id ?? row.reservation.uid ?? i}-${row.caddy?.id ?? i}`}
                          row={row}
                          sheet={sheet}
                        />
                      ))}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
      <p className="bp-foot">
        {printedAt ? `출력 ${printedAt} · ` : ""}
        화면에 보이는 최신 배치 기준 · 표시: 리무진/하우스(예약 요청), 투(투근무), 찾근, 지원, 1·2/2·3 등 연속근무
      </p>
    </div>
  );
}
