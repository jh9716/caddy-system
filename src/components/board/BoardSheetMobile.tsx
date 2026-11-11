import React from "react";
import {
  BOARD_SHEET_BASE_ROWS,
  BOARD_SHEET_UNASSIGNED_LABEL,
  BOARD_SHEET_CLOSED_LABEL,
  boardSheetCourseSummary,
  boardSheetDateLabel,
} from "@/lib/boardSheet";
import type { BoardMobileCourse, BoardMobileModel, BoardMobileSlot } from "@/lib/boardSheetMobile";

/**
 * /board 모바일 4코스 동시 보기 (가로 스크롤 없음).
 * 행 = 코스별 팀 순번(기본 21, 초과 시 확장), 열 = 4코스. 칸 안에 시각 → 캐디 이름 → 소속 조·배지 순서로 세로 배치.
 * PC/인쇄/PNG/엑셀 시트(BoardSheetTable)와 같은 모델·같은 행·같은 빈칸 규칙.
 */
function Slot({ slot }: { slot: BoardMobileSlot }) {
  const team = slot.teamNames.length ? <div className="bm-team">{slot.teamNames.join(", ")}</div> : null;
  if (slot.state === "empty") return null;
  if (slot.state === "unassigned" && slot.caddies.length === 0) {
    return (
      <>
        <div className="bm-vacant" data-mobile-slot="unassigned">{BOARD_SHEET_UNASSIGNED_LABEL}</div>
        {team}
      </>
    );
  }
  return (
    <>
      {team}
      {slot.caddies.map((c, i) =>
        c.vacant ? (
          <div key={`v${i}`} className="bm-vacant" data-mobile-slot="vacant">
            {BOARD_SHEET_UNASSIGNED_LABEL}
          </div>
        ) : (
          <div key={`${c.name}-${i}`} className="bm-caddy" data-mobile-slot="assigned">
            <div className="bm-name">{c.name}</div>
            {c.affiliation || c.badges.length ? (
              <div className="bm-sub">
                {c.affiliation ? <span className="bm-affil">{c.affiliation}</span> : null}
                {c.badges.map((b) => (
                  <span key={b.label} className={`bm-badge ${b.tone}`}>
                    {b.label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        )
      )}
    </>
  );
}

function Cell({ course, index }: { course: BoardMobileCourse; index: number }) {
  if (!course.open) {
    return (
      <td className="bm-cell closed" data-mobile-cell="closed" data-mobile-course={course.code}>
        <span className="bm-closed">{BOARD_SHEET_CLOSED_LABEL}</span>
      </td>
    );
  }
  const slot = course.slots[index];
  if (!slot) return <td className="bm-cell" data-mobile-cell="blank" data-mobile-course={course.code} />;
  const accent = new Set(slot.caddies.flatMap((c) => c.accent));
  const cls = ["bm-cell", slot.state, ...accent].join(" ");
  return (
    <td className={cls} data-mobile-cell={slot.state} data-mobile-course={course.code} data-mobile-time={slot.teeTime}>
      <div className="bm-time">{slot.teeTime}</div>
      <Slot slot={slot} />
    </td>
  );
}

export function BoardSheetMobile({ model }: { model: BoardMobileModel }) {
  const { sheet } = model;
  const rows = Array.from({ length: model.rowCount }, (_, i) => i);
  return (
    <div className="bm-root" data-board-mobile="" data-mobile-shift={sheet.shift} data-mobile-date={sheet.date} data-mobile-rows={model.rowCount}>
      <div className="bm-cap">
        <span className="bm-date">{boardSheetDateLabel(sheet)}</span>
        <span className="bm-shift">{sheet.shift}</span>
        <span className="bm-totals">
          배정 {sheet.totals.assigned} · 미배치 {sheet.totals.unassigned}
        </span>
        <span className="bm-spares">
          스페어1 <b>{sheet.spare.spare1Label || "-"}</b> · 스페어2 <b>{sheet.spare.spare2Label || "-"}</b>
        </span>
        {sheet.isEmpty ? <span className="bm-flag">{sheet.shift} 배치 없음</span> : null}
        {sheet.overflowCourses.length ? (
          <span className="bm-flag" data-mobile-overflow="">
            21팀 초과 {model.rowCount}행 — 잘림 없이 모두 표시
          </span>
        ) : null}
      </div>
      <table className="bm-table" aria-label={`${sheet.date} ${sheet.shift} 배치표 (모바일)`}>
        <colgroup>
          <col className="bm-col-no" />
          {model.courses.map((c) => (
            <col key={c.code} className="bm-col-course" />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="bm-h-no">No</th>
            {model.courses.map((c, k) => (
              <th key={c.code} className={`bm-h-course${c.open ? "" : " closed"}`} data-mobile-course-head={c.code}>
                <span className="bm-h-name">{c.label}</span>
                <span className="bm-h-sub">{boardSheetCourseSummary(sheet.courses[k])}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i} className={i >= BOARD_SHEET_BASE_ROWS ? "bm-row-over" : undefined} data-mobile-row={i + 1}>
              <th className="bm-no" scope="row">
                {i + 1}
              </th>
              {model.courses.map((c) => (
                <Cell key={c.code} course={c} index={i} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const boardSheetMobileCss = `
.bm-root { width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; color: #0f172a; }
.bm-cap { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; padding: 2px 2px 6px; font-size: 12px; }
.bm-date { font-weight: 800; font-size: 13px; }
.bm-shift { font-weight: 900; font-size: 13px; border: 1.5px solid #0f172a; border-radius: 6px; padding: 0 6px; }
.bm-totals { font-weight: 700; color: #334155; }
.bm-spares { flex-basis: 100%; color: #334155; font-size: 11.5px; }
.bm-flag { flex-basis: 100%; font-weight: 800; color: #b91c1c; font-size: 12px; }
.bm-table { width: 100%; max-width: 100%; table-layout: fixed; border-collapse: collapse; background: #fff; border: 1px solid #94a3b8; }
.bm-col-no { width: 18px; }
.bm-col-course { width: calc((100% - 18px) / 4); }
.bm-table thead th { position: sticky; top: 0; z-index: 1; background: #0f172a; color: #fff; border: 1px solid #334155; padding: 3px 1px; text-align: center; vertical-align: middle; }
.bm-h-no { font-size: 9px; font-weight: 700; }
.bm-h-name { display: block; font-size: 13px; font-weight: 900; line-height: 1.15; white-space: nowrap; }
.bm-h-sub { display: block; font-size: 9px; font-weight: 600; color: #cbd5e1; line-height: 1.15; overflow-wrap: anywhere; }
.bm-h-course.closed .bm-h-name { color: #94a3b8; text-decoration: line-through; }
.bm-no { font-size: 9px; font-weight: 700; color: #64748b; background: #f8fafc; border: 1px solid #cbd5e1; padding: 0; text-align: center; }
.bm-row-over .bm-no { background: #fee2e2; color: #b91c1c; }
.bm-cell { border: 1px solid #cbd5e1; padding: 2px 2px 3px; vertical-align: top; text-align: center; overflow: hidden; min-width: 0; height: 46px; box-sizing: border-box; }
.bm-cell.closed { background: repeating-linear-gradient(-45deg, #f1f5f9, #f1f5f9 4px, #e2e8f0 4px, #e2e8f0 8px); vertical-align: middle; }
.bm-closed { font-size: 10px; font-weight: 800; color: #94a3b8; }
.bm-cell.assigned.special { background: #fffbeb; }
.bm-cell.assigned.two-work { background: #f8fafc; box-shadow: inset 2px 0 0 #94a3b8; }
.bm-cell.assigned.chageun { background: #fffdf6; box-shadow: inset 2px 0 0 #d6b37a; }
.bm-cell.assigned.limo { box-shadow: inset 0 -3px 0 #f59e0b; }
.bm-cell.assigned.drive { box-shadow: inset 3px 0 0 #7c3aed; }
.bm-time { font-size: 11px; font-weight: 800; font-variant-numeric: tabular-nums; color: #334155; line-height: 1.2; }
.bm-caddy + .bm-caddy, .bm-team + .bm-caddy { margin-top: 2px; padding-top: 2px; border-top: 1px dashed #94a3b8; }
.bm-name { font-size: 13.5px; font-weight: 900; line-height: 1.2; overflow-wrap: anywhere; word-break: keep-all; }
.bm-sub { display: flex; flex-wrap: wrap; justify-content: center; gap: 1px 2px; margin-top: 1px; line-height: 1.15; }
.bm-affil { font-size: 10px; font-weight: 700; color: #475569; white-space: nowrap; }
.bm-badge { font-size: 9.5px; font-weight: 800; line-height: 1.2; padding: 0 3px; border-radius: 4px; white-space: nowrap; background: #e2e8f0; color: #334155; max-width: 100%; overflow: hidden; text-overflow: clip; }
.bm-badge.two { color: #334155; background: #e2e8f0; }
.bm-badge.call { color: #7c5a1e; background: #f4ead6; }
.bm-badge.support { color: #1e3a8a; background: #dbeafe; }
.bm-badge.support-pat { color: #1e3a8a; background: #eff6ff; }
.bm-badge.house { color: #166534; background: #dcfce7; box-shadow: 0 0 0 1px #86efac inset; }
.bm-badge.limo { color: #7c2d12; background: #fdba74; }
.bm-badge.drive { color: #fff; background: #7c3aed; }
.bm-badge.linked { color: #0f766e; background: #ccfbf1; }
.bm-badge.lock { color: #fff; background: #334155; }
.bm-vacant { display: inline-block; margin-top: 1px; font-size: 11px; font-weight: 800; border: 1px dashed #0f172a; border-radius: 4px; padding: 0 3px; }
.bm-team { font-size: 9.5px; font-weight: 700; color: #475569; line-height: 1.15; overflow-wrap: anywhere; }
@media (max-width: 374px) {
  .bm-name { font-size: 13px; }
  .bm-h-name { font-size: 12px; }
  .bm-cell { padding: 2px 1px 3px; }
}
`;
