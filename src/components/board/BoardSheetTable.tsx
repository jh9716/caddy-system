import React from "react";
import {
  BOARD_SHEET_BASE_ROWS,
  BOARD_SHEET_COLS_PER_COURSE,
  BOARD_SHEET_REMARK_LABEL,
  BOARD_SHEET_TITLE,
  BOARD_SHEET_UNASSIGNED_LABEL,
  boardSheetCourseSummary,
  boardSheetDateLabel,
  type BoardSheetCourse,
  type BoardSheetModel,
  type BoardSheetSlot,
} from "@/lib/boardSheet";

/**
 * 배치표 공통 표 (hook 없음 → 서버 렌더/PNG/인쇄/테스트 공용).
 * 행 = 팀 순번 1..N(기본 21), 열 = 코스별 [시각 | 캐디 | 비고(빈 칸)]. 시각은 코스마다 실제 값.
 * 카트번호·현장 번호 열은 넣지 않는다. No 는 행 순번이다.
 */
function SlotCell({ slot, includeTeamName }: { slot: BoardSheetSlot; includeTeamName: boolean }) {
  const team =
    includeTeamName && slot.teamNames.length ? (
      <span className="bs-team">{slot.teamNames.join(", ")}</span>
    ) : null;
  if (slot.state === "unassigned" && slot.caddies.length === 0) {
    return (
      <div className="bs-slot" data-sheet-slot="unassigned">
        <span className="bs-vacant">{BOARD_SHEET_UNASSIGNED_LABEL}</span>
        {team}
      </div>
    );
  }
  return (
    <>
      {slot.caddies.map((c, i) =>
        c.vacant ? (
          <div key={`v${i}`} className="bs-slot" data-sheet-slot="vacant">
            <span className="bs-vacant">{BOARD_SHEET_UNASSIGNED_LABEL}</span>
          </div>
        ) : (
          <div key={`${c.name}-${i}`} className="bs-slot" data-sheet-slot="assigned">
            <span
              className={`bs-name${c.twoWork ? " two-work" : ""}`}
              data-sheet-two-work={c.twoWork ? "1" : undefined}
            >
              {c.name}
            </span>
            {c.affiliation ? <span className="bs-affil">{c.affiliation}</span> : null}
            {c.marks.length ? (
              <span className="bs-marks">
                {c.marks.map((m) => (
                  <span key={m} className="bs-mark">
                    {m}
                  </span>
                ))}
              </span>
            ) : null}
          </div>
        )
      )}
      {team ? <div className="bs-slot">{team}</div> : null}
    </>
  );
}

function RemarkCell({
  course,
  extraClass = "",
  cell = "remark",
}: {
  course: BoardSheetCourse;
  extraClass?: string;
  cell?: string;
}) {
  return (
    <td
      className={`bs-remark${extraClass ? ` ${extraClass}` : ""}`}
      data-sheet-cell={cell}
      data-sheet-course={course.code}
      data-sheet-remark=""
    />
  );
}

function CourseCells({
  course,
  index,
  includeTeamName,
}: {
  course: BoardSheetCourse;
  index: number;
  includeTeamName: boolean;
}) {
  if (!course.open) {
    return (
      <>
        <td className="bs-time closed" data-sheet-cell="closed" data-sheet-course={course.code} />
        <td className="bs-cell closed" data-sheet-cell="closed" data-sheet-course={course.code} />
        <RemarkCell course={course} extraClass="closed" cell="closed" />
      </>
    );
  }
  const slot = course.slots[index];
  if (!slot) {
    return (
      <>
        <td className="bs-time" data-sheet-cell="blank" data-sheet-course={course.code} />
        <td className="bs-cell" data-sheet-cell="blank" data-sheet-course={course.code} />
        <RemarkCell course={course} cell="blank" />
      </>
    );
  }
  return (
    <>
      <td className="bs-time" data-sheet-course={course.code} data-sheet-time={slot.teeTime}>
        {slot.teeTime}
      </td>
      <td
        className={`bs-cell ${slot.state}`}
        data-sheet-cell={slot.state}
        data-sheet-course={course.code}
        data-sheet-time={slot.teeTime}
      >
        {slot.state === "empty" ? null : <SlotCell slot={slot} includeTeamName={includeTeamName} />}
      </td>
      <td
        className="bs-remark"
        data-sheet-cell="remark"
        data-sheet-course={course.code}
        data-sheet-time={slot.teeTime}
        data-sheet-remark=""
      />
    </>
  );
}

function FooterBar({ model }: { model: BoardSheetModel }) {
  return (
    <div className="bs-footer-bar" data-sheet-footer="">
      <span className="bs-foot-spare" data-sheet-spare="1">
        스페어1 <b>{model.spare.spare1Label || "-"}</b>
      </span>
      <span className="bs-foot-spare" data-sheet-spare="2">
        스페어2 <b>{model.spare.spare2Label || "-"}</b>
      </span>
      <span className="bs-foot-assigned" data-sheet-total-assigned={model.totals.assigned}>
        전체 배정 <b>{model.totals.assigned}</b>
      </span>
      <span className="bs-foot-unassigned" data-sheet-total-unassigned={model.totals.unassigned}>
        미배치 <b>{model.totals.unassigned}</b>
      </span>
      {model.isEmpty ? <span className="bs-flag">{model.shift} 배치 없음</span> : null}
      {model.overflowCourses.length ? (
        <span className="bs-flag" data-sheet-overflow="">
          21팀 초과 {model.rowCount}행 — 잘림 없이 모두 표시
        </span>
      ) : null}
    </div>
  );
}

export function BoardSheetTable({
  model,
  footnote,
}: {
  model: BoardSheetModel;
  /** 표 아래 작은 안내 (출력 시각 등) */
  footnote?: string | null;
}) {
  const colCount = 1 + model.courses.length * BOARD_SHEET_COLS_PER_COURSE;
  const rows = Array.from({ length: model.rowCount }, (_, i) => i);
  return (
    <div
      className="bs-sheet"
      data-board-sheet=""
      data-sheet-shift={model.shift}
      data-sheet-date={model.date}
      data-sheet-rows={model.rowCount}
    >
      <table className="bs-table" aria-label={`${model.date} ${model.shift} 배치표`}>
        <colgroup>
          <col className="bs-col-no" />
          {model.courses.map((c) => (
            <React.Fragment key={c.code}>
              <col className="bs-col-time" />
              <col className="bs-col-caddy" />
              <col className="bs-col-remark" />
            </React.Fragment>
          ))}
        </colgroup>
        <thead>
          <tr className="bs-cap-row">
            <th colSpan={colCount} className="bs-cap">
              <div className="bs-cap-inner">
                <span className="bs-title">{BOARD_SHEET_TITLE}</span>
                <span className="bs-date" data-sheet-date-label="">
                  {boardSheetDateLabel(model)}
                </span>
                <span className="bs-shift" data-sheet-shift-label="">
                  {model.shift}
                </span>
                {model.isEmpty ? <span className="bs-flag">{model.shift} 배치 없음</span> : null}
                {model.overflowCourses.length ? (
                  <span className="bs-flag" data-sheet-overflow="">
                    21팀 초과 {model.rowCount}행 — 잘림 없이 모두 표시
                  </span>
                ) : null}
              </div>
            </th>
          </tr>
          <tr className="bs-course-row">
            <th rowSpan={2} className="bs-h-no">
              No
            </th>
            {model.courses.map((c) => (
              <th
                key={c.code}
                colSpan={BOARD_SHEET_COLS_PER_COURSE}
                className={`bs-h-course${c.open ? "" : " closed"}`}
                data-sheet-course-head={c.code}
              >
                <span className="bs-h-name">{c.label}</span>
                <span className="bs-h-sub">{boardSheetCourseSummary(c)}</span>
              </th>
            ))}
          </tr>
          <tr className="bs-sub-row">
            {model.courses.map((c) => (
              <React.Fragment key={c.code}>
                <th className={c.open ? "" : "closed"}>시각</th>
                <th className={c.open ? "" : "closed"}>캐디</th>
                <th className={c.open ? "" : "closed"}>{BOARD_SHEET_REMARK_LABEL}</th>
              </React.Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr
              key={i}
              className={`bs-row${i >= BOARD_SHEET_BASE_ROWS ? " bs-row-over" : ""}`}
              data-sheet-row={i + 1}
            >
              <th className="bs-no" scope="row">
                {i + 1}
              </th>
              {model.courses.map((c) => (
                <CourseCells key={c.code} course={c} index={i} includeTeamName={model.includeTeamName} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <FooterBar model={model} />
      <p className="bs-foot">
        {footnote ? `${footnote} · ` : ""}
        행 = 코스별 팀 순번(기본 21팀) · 시각은 코스별 실제 티오프 · 표시: 리무진/하우스(예약 요청), 투(투근무), 찾근, 지원, 1·2/2·3 등 연속근무
        {" · "}배정 = 캐디가 있는 팀 · 미배치 = 예약 칸은 있으나 캐디 없음
        {" · "}게시본에는 미배정 예약 목록이 없어, 칸 자체가 없는 예약은 집계하지 못함
        {" · "}비고는 빈 칸(저장 없음)
      </p>
    </div>
  );
}
