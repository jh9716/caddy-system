import React from "react";
import {
  BOARD_EXPORT_COURSE_SHORT,
  type BoardExportSlice,
} from "@/lib/assignmentBoardExport";
import { boardAssignmentMarks } from "@/lib/assignmentBoardView";
import type { AutoAssignmentRow } from "@/lib/autoAssignEngine";
import { caddyAffiliation } from "@/lib/caddyDisplay";
import { COURSE_CODES, COURSE_LABELS } from "@/lib/reservationParser";
import { assignmentBoardExportCss } from "@/components/board/assignmentBoardExportCss";

function ExportMarks({
  row,
  allAssignments,
}: {
  row: AutoAssignmentRow;
  allAssignments: AutoAssignmentRow[];
}) {
  const marks = boardAssignmentMarks(row, allAssignments);
  const special = row.kind !== "regular" && row.kind !== "specialSupport";
  if (
    !marks.twoWork &&
    !marks.chageun &&
    !marks.specialSupport &&
    !special &&
    !marks.limousine &&
    !marks.driving
  ) {
    return null;
  }
  return (
    <span className="bx-marks">
      {marks.limousine ? <span className="bx-badge limo">리무진</span> : null}
      {marks.driving ? <span className="bx-badge drive">드라이빙</span> : null}
      {marks.twoWork ? <span className="bx-badge two">투</span> : null}
      {marks.specialSupport ? <span className="bx-badge support">지원</span> : null}
      {marks.chageun ? (
        <span className="bx-badge call">찾근</span>
      ) : special && !marks.driving ? (
        <span className="bx-special">S</span>
      ) : null}
    </span>
  );
}

export function AssignmentBoardExportView({
  slice,
}: {
  slice: BoardExportSlice;
}) {
  const allAssignments = slice.allAssignments;
  const open = new Set(slice.openCourses);
  return (
    <div className="bx-root" data-board-export-root="">
      <header className="bx-head">
        <p className="bx-brand">VERTHILL 배치표</p>
        <p className="bx-date">{slice.date}</p>
        <p className="bx-shift">{slice.shift}</p>
      </header>
      <section className="bx-spares" aria-label={`${slice.shift} 스페어`}>
        <div className="bx-spare">
          <span className="bx-spare-lbl">스페어 1</span>
          <span className={`bx-spare-val${slice.spare.spare1Label ? "" : " muted"}`}>
            {slice.spare.spare1Label || "-"}
          </span>
        </div>
        <div className="bx-spare">
          <span className="bx-spare-lbl">스페어 2</span>
          <span className={`bx-spare-val${slice.spare.spare2Label ? "" : " muted"}`}>
            {slice.spare.spare2Label || "-"}
          </span>
        </div>
      </section>
      <div className="bx-board-head">
        <div>시간</div>
        {COURSE_CODES.map((code) => (
          <div
            key={code}
            className={open.has(code) ? "" : "closed"}
            title={COURSE_LABELS[code]}
          >
            {BOARD_EXPORT_COURSE_SHORT[code]}
          </div>
        ))}
      </div>
      <div className="bx-board" role="table" aria-label={`${slice.shift} 배치표`}>
        {slice.rows.length === 0 ? (
          <div className="bx-empty-board">이 부 배치 없음</div>
        ) : (
          slice.rows.map((tr) => (
            <div key={tr.teeTime} className="bx-row" data-export-teetime={tr.teeTime}>
              <div className="bx-time">{tr.teeTime || "—"}</div>
              {COURSE_CODES.map((code) => {
                const cell = tr.cells[code];
                if (cell.kind === "closed") {
                  return (
                    <div key={code} className="bx-cell closed">
                      닫힘
                    </div>
                  );
                }
                if (cell.kind === "empty") {
                  return (
                    <div key={code} className="bx-cell empty">
                      -
                    </div>
                  );
                }
                const special = cell.rows.some((r) => r.kind !== "regular");
                const two = cell.rows.some((r) =>
                  boardAssignmentMarks(r, allAssignments).twoWork
                );
                const chageun = cell.rows.some((r) =>
                  boardAssignmentMarks(r, allAssignments).chageun
                );
                const limo = cell.rows.some((r) => r.reservation?.limousineCart === true);
                const drive = cell.rows.some((r) => r.kind === "driving");
                return (
                  <div
                    key={code}
                    className={`bx-cell assigned${special ? " special" : ""}${
                      two ? " two-work" : ""
                    }${chageun ? " chageun" : ""}${limo ? " limo" : ""}${
                      drive ? " drive" : ""
                    }`}
                  >
                    {cell.rows.map((row) => (
                      <div
                        key={`${row.reservation.id}-${row.caddy.id}`}
                        className="bx-slot"
                      >
                        <span className="bx-team">
                          {row.reservation.teamName || "팀"}
                        </span>
                        <span className="bx-name">{row.caddy.name}</span>
                        <span className="bx-affil">{caddyAffiliation(row.caddy)}</span>
                        <ExportMarks row={row} allAssignments={allAssignments} />
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
      <style>{assignmentBoardExportCss}</style>
    </div>
  );
}
