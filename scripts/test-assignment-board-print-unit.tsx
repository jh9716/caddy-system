/**
 * 배치표 A4 인쇄: 부 분리, 4코스 열, 빈 코스/휴장/미배치, 고객명 기본 비표시, 원본 불변.
 * DB/네트워크 없음. 실행: npm run test:assignment-board-print-unit
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssignmentBoardPrintSheet } from "../src/components/board/AssignmentBoardPrintSheet";
import {
  BOARD_PRINT_SHIFTS,
  boardPrintWeekday,
  buildBoardPrintSheet,
  isBoardPrintShift,
} from "../src/lib/assignmentBoardPrint";
import { COURSE_CODES } from "../src/lib/reservationParser";
import {
  emptyAndUnassignedDraft,
  largeDraft,
  threeShiftDraft,
} from "./fixtures/boardPrintFixtures";

(globalThis as unknown as { React: typeof React }).React = React;

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}

console.log("[print] 기본");
assert(BOARD_PRINT_SHIFTS.join(",") === "1부,2부,3부", "인쇄 부 = 1부,2부,3부");
assert(isBoardPrintShift("2부") && !isBoardPrintShift("UNASSIGNED"), "부 판별");
assert(boardPrintWeekday("2026-11-11") === "수", "2026-11-11 = 수");
assert(boardPrintWeekday("bad") === null, "잘못된 날짜 → null");

console.log("[print] 1·2·3부 분리");
const draft = threeShiftDraft();
const before = JSON.stringify(draft);
for (const shift of BOARD_PRINT_SHIFTS) {
  const sheet = buildBoardPrintSheet(draft, shift, { includeTeamName: true });
  const own = draft.assignments.filter((a) => a.reservation.shift === shift);
  const others = draft.assignments.filter((a) => a.reservation.shift !== shift);
  const cellIds = new Set<string>();
  for (const tr of sheet.rows) {
    for (const code of COURSE_CODES) {
      const cell = tr.cells[code];
      if (cell.kind === "assigned") cell.rows.forEach((r) => cellIds.add(String(r.reservation.id)));
    }
  }
  assert(cellIds.size === own.length, `${shift}: 자기 부 ${own.length}건 전부 표시`);
  assert(others.every((a) => !cellIds.has(String(a.reservation.id))), `${shift}: 다른 부 0건`);
  const html = renderToStaticMarkup(<AssignmentBoardPrintSheet sheet={sheet} />);
  const foreign = others.filter((a) => html.includes(String(a.reservation.teamName)));
  assert(foreign.length === 0, `${shift}: HTML에 다른 부 팀명 없음`);
  assert(html.includes(`data-print-shift="${shift}"`), `${shift}: 시트 부 라벨`);
  const heads = (html.match(/data-print-course="(VERTHILL|SKY|OCEAN|LAKE)"/g) || []).slice(0, 4);
  assert(
    heads.join("|") === COURSE_CODES.map((c) => `data-print-course="${c}"`).join("|"),
    `${shift}: 헤더 4코스 순서 베르힐·스카이·오션·레이크`
  );
  assert(["베르힐", "스카이", "오션", "레이크"].every((l) => html.includes(l)), `${shift}: 코스 한글명`);
}
assert(JSON.stringify(draft) === before, "인쇄 데이터 생성 후 원본 draft 불변 (읽기 전용)");

console.log("[print] 고객명");
const redacted = buildBoardPrintSheet(draft, "1부");
const redactedHtml = renderToStaticMarkup(<AssignmentBoardPrintSheet sheet={redacted} />);
assert(!redactedHtml.includes("1부팀"), "기본: 예약자명 미표시 (기존 PNG/엑셀 정책)");
const withName = renderToStaticMarkup(
  <AssignmentBoardPrintSheet sheet={buildBoardPrintSheet(draft, "1부", { includeTeamName: true })} />
);
assert(withName.includes("1부팀"), "옵션 ON: 예약자명 표시");
assert(redactedHtml.includes("리무진") && redactedHtml.includes("하우스"), "리무진/하우스 요청 표시");

console.log("[print] 스페어");
const s2 = buildBoardPrintSheet(draft, "2부");
assert(s2.spare.spare1Label?.includes("이스페어") && s2.spare.spare2Label?.includes("이보조"), "2부 스페어만");
assert(buildBoardPrintSheet(draft, "3부").spare.spare1Label === null, "3부 스페어 없음 → '-'");

console.log("[print] 빈 코스 / 휴장 / 미배치");
const empty = buildBoardPrintSheet(emptyAndUnassignedDraft(), "2부", { includeTeamName: true });
const sky = empty.courses.find((c) => c.code === "SKY")!;
const ocean = empty.courses.find((c) => c.code === "OCEAN")!;
const lake = empty.courses.find((c) => c.code === "LAKE")!;
assert(!sky.open, "스카이 휴장");
assert(ocean.open && ocean.assigned === 0 && ocean.unassigned === 0, "오션 열림·예약 0");
assert(lake.unassigned === 2, "레이크 미배치 2 (미배치 예약 1 + 빈 캐디 칸 1)");
const emptyHtml = renderToStaticMarkup(<AssignmentBoardPrintSheet sheet={empty} />);
assert(emptyHtml.includes("휴장") && emptyHtml.includes("이 부 예약 없음"), "휴장/예약 없음 헤더 문구");
assert((emptyHtml.match(/>미배치</g) || []).length === 3, "미배치 칸 3개 (레이크 2 + 베르힐 12:12)");
assert(emptyHtml.includes("미배치합성팀"), "미배치 예약자명 (옵션 ON)");
assert(!emptyHtml.includes("undefined") && !emptyHtml.includes("null"), "undefined/null 문자열 없음");

const none = buildBoardPrintSheet(emptyAndUnassignedDraft(), "1부");
assert(none.rows.length === 0, "1부 데이터 없음");
assert(
  renderToStaticMarkup(<AssignmentBoardPrintSheet sheet={none} />).includes("1부 배치 없음"),
  "데이터 없는 부: '1부 배치 없음'"
);

console.log("[print] 큰 배치표");
const big = buildBoardPrintSheet(largeDraft(), "1부");
assert(big.rows.length >= 40, `티타임 ${big.rows.length}행`);
assert(
  big.totals.assigned === big.rows.length * 4,
  "모든 칸 배정 (2인 칸은 1칸으로 집계)"
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
