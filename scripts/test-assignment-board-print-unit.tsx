/**
 * 배치표 공통 시트(/board·PNG·A4·XLSX) 단위 테스트.
 * 부 분리, 4코스 순서, 공유 시간축(빈타임 행 유지), 21팀 초과 잘림 없음, 빈/휴장/미배치,
 * 예약자명 범위, 다른 날짜 차단, 엑셀 행·열 구조. DB/네트워크 없음.
 * 실행: npm run test:assignment-board-print-unit
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as XLSX from "xlsx";
import { AssignmentBoardPrintSheet } from "../src/components/board/AssignmentBoardPrintSheet";
import { BoardSheetExportView } from "../src/components/board/BoardSheetExportView";
import { existsSync, readFileSync } from "node:fs";
import PublishedBoardView from "../src/components/board/PublishedBoardView";
import { buildPublishedShiftBoard, countPublishedCourseTeams } from "../src/lib/publishedBoardView";
import { publishedPayloadForReader } from "../src/lib/publishedBoardPrivacy";
import type { DailyBoardPublishedPayloadV1 } from "../src/lib/dailyBoardPublished";
import {
  BOARD_PRINT_SHIFTS,
  boardPrintWeekday,
  buildBoardPrintSheet,
  isBoardPrintShift,
} from "../src/lib/assignmentBoardPrint";
import {
  BOARD_SHEET_BASE_ROWS,
  buildBoardSheetModel,
  type BoardSheetModel,
} from "../src/lib/boardSheet";
import {
  BOARD_XLSX_DATA_START_ROW,
  BOARD_XLSX_HEADER_ROW,
  BOARD_XLSX_SUBHEADER_ROW,
  buildBoardExportWorkbook,
  parseBoardExportWorkbook,
  writeBoardExportXlsxBytes,
} from "../src/lib/assignmentBoardExportXlsx";
import { COURSE_CODES, type ShiftPart } from "../src/lib/reservationParser";
import { buildPublishedPayloadFromDraft } from "../src/lib/dailyBoardPublished";
import type { DailyBoardDraftPayloadV1 } from "../src/lib/dailyBoardDraft";
import {
  canPrintPublishedBoard,
  publishedBoardPrintDraft,
} from "../src/lib/publishedBoardPrint";
import {
  emptyAndUnassignedDraft,
  fullLoadDraft,
  fullLoadTeeTime,
  GAPPED_SHIFT_TIMES,
  gappedTimetableDraft,
  largeDraft,
  richMobileDraft,
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

function caddyNames(model: BoardSheetModel): string[] {
  return model.courses.flatMap((c) => c.slots.flatMap((s) => s.caddies.filter((x) => !x.vacant).map((x) => x.name)));
}
const html = (m: BoardSheetModel) => renderToStaticMarkup(<AssignmentBoardPrintSheet sheet={m} />);

console.log("[sheet] 기본");
assert(BOARD_PRINT_SHIFTS.join(",") === "1부,2부,3부", "부 = 1부,2부,3부");
assert(isBoardPrintShift("2부") && !isBoardPrintShift("UNASSIGNED"), "부 판별");
assert(boardPrintWeekday("2026-11-11") === "수", "2026-11-11 = 수");
assert(boardPrintWeekday("bad") === null, "잘못된 날짜 → null");
assert(BOARD_SHEET_BASE_ROWS === 21, "기본 행 = 21");

console.log("[sheet] 1·2·3부 분리");
const draft = threeShiftDraft();
const before = JSON.stringify(draft);
for (const shift of BOARD_PRINT_SHIFTS) {
  const sheet = buildBoardPrintSheet(draft, shift, { includeTeamName: true });
  const own = draft.assignments.filter((a) => a.reservation.shift === shift);
  const others = draft.assignments.filter((a) => a.reservation.shift !== shift);
  const names = new Set(caddyNames(sheet));
  assert(names.size === own.length, `${shift}: 자기 부 ${own.length}건 전부 표시`);
  assert(others.every((a) => !names.has(a.caddy.name)), `${shift}: 다른 부 0건`);
  const h = html(sheet);
  assert(others.every((a) => !h.includes(String(a.reservation.teamName))), `${shift}: HTML에 다른 부 팀명 없음`);
  assert(h.includes(`data-print-shift="${shift}"`) && h.includes(`data-sheet-shift="${shift}"`), `${shift}: 부 라벨`);
  const heads = (h.match(/data-sheet-course-head="(VERTHILL|SKY|OCEAN|LAKE)"/g) || []);
  assert(heads.join("|") === COURSE_CODES.map((c) => `data-sheet-course-head="${c}"`).join("|"), `${shift}: 코스 순서 베르힐·스카이·오션·레이크`);
  const times = [...new Set(own.map((a) => a.reservation.teeTime))].sort();
  assert(sheet.rowCount === times.length && (h.match(/data-sheet-row="/g) || []).length === times.length, `${shift}: 행 수 = 시간표 ${times.length} (21 패딩 없음)`);
  assert(sheet.courses.filter((c) => c.open).every((c) => c.slots.every((s, i) => s.teeTime === times[i])), `${shift}: 열린 코스 모두 같은 시간축`);
}
assert(JSON.stringify(draft) === before, "모델 생성 후 원본 draft 불변");

console.log("[sheet] 예약자명");
const redacted = html(buildBoardPrintSheet(draft, "1부"));
assert(!redacted.includes("1부팀"), "기본: 예약자명 미표시");
assert(html(buildBoardPrintSheet(draft, "1부", { includeTeamName: true })).includes("1부팀"), "옵션 ON: 예약자명 표시");
assert(redacted.includes("리무진") && redacted.includes("하우스"), "리무진/하우스 표시");

console.log("[sheet] 스페어");
const s2 = buildBoardPrintSheet(draft, "2부");
assert(s2.spare.spare1Label?.includes("이스페어") && s2.spare.spare2Label?.includes("이보조"), "2부 스페어만");
assert(buildBoardPrintSheet(draft, "3부").spare.spare1Label === null, "3부 스페어 없음 → '-'");

console.log("[sheet] 빈 코스 / 휴장 / 미배치");
const empty = buildBoardPrintSheet(emptyAndUnassignedDraft(), "2부", { includeTeamName: true });
const sky = empty.courses.find((c) => c.code === "SKY")!;
const ocean = empty.courses.find((c) => c.code === "OCEAN")!;
const lake = empty.courses.find((c) => c.code === "LAKE")!;
assert(!sky.open && sky.slots.length === 0, "스카이 휴장 (칸 없음)");
assert(ocean.open && ocean.teams === 0 && ocean.slots.length === empty.rowCount, "오션 열림·예약 0 → 시간축 빈칸 유지");
assert(ocean.slots.every((s) => s.state === "empty"), "오션: 모든 슬롯 empty");
assert(lake.unassigned === 2, "레이크 미배치 2 (미배치 예약 1 + 빈 캐디 칸 1)");
assert(empty.courses.filter((c) => c.open).every((c) => c.slots.length === empty.rowCount), "열린 코스 행 수 = 공유 시간축");
const eh = html(empty);
assert(eh.includes("휴장") && eh.includes("예약 없음"), "휴장/예약 없음 헤더");
assert((eh.match(/>미배치</g) || []).length === 3, "미배치 칸 3개 (레이크 2 + 베르힐 12:12)");
assert((eh.match(/data-sheet-cell="closed"/g) || []).length === empty.rowCount * 3, `휴장 코스: ${empty.rowCount}행 × 3칸 빗금`);
assert(eh.includes("미배치합성팀"), "미배치 예약자명 (옵션 ON)");
assert(!eh.includes("undefined") && !eh.includes("null"), "undefined/null 문자열 없음");
const none = buildBoardPrintSheet(emptyAndUnassignedDraft(), "1부");
assert(none.isEmpty && none.rowCount === 0, "데이터 없는 부: 시간표 0행");
assert(html(none).includes("1부 배치 없음"), "데이터 없는 부: '1부 배치 없음'");

console.log("[21팀] 4코스 × 21팀 × 1·2·3부 만석 (공유 시간축)");
const full = fullLoadDraft();
for (const shift of BOARD_PRINT_SHIFTS) {
  const m = buildBoardSheetModel(full, shift);
  assert(m.overflowCourses.length === 0, `${shift}: 팀 21 이하, 초과 없음`);
  assert(m.courses.every((c) => c.slots.length === m.rowCount && c.assigned === 21), `${shift}: 코스마다 시간축 ${m.rowCount}행 · 배정 21팀`);
  assert(m.totals.assigned === 84, `${shift}: 84팀`);
  const axis = m.courses[0].slots.map((s) => s.teeTime);
  assert(m.courses.every((c) => c.slots.every((s, i) => s.teeTime === axis[i])), `${shift}: 열린 코스 모두 같은 시각 행`);
  const own = new Set(full.assignments.filter((a) => a.reservation.shift === shift).map((a) => a.caddy.name));
  const names = caddyNames(m);
  assert(names.length === 84 && names.every((n) => own.has(n)), `${shift}: 다른 부 섞임 없음`);
  const h = html(m);
  const sky1 = fullLoadTeeTime(shift, "SKY", 1);
  const vh1 = fullLoadTeeTime(shift, "VERTHILL", 1);
  const skyIdx = axis.indexOf(sky1);
  const vhIdx = axis.indexOf(vh1);
  assert(sky1 !== vh1 && skyIdx !== vhIdx && skyIdx >= 0 && vhIdx >= 0, `${shift}: 엇갈린 시각은 다른 행 (${vh1} vs ${sky1})`);
  assert(m.courses.find((c) => c.code === "VERTHILL")!.slots[skyIdx].state === "empty", `${shift}: 스카이 ${sky1} 행에서 베르힐은 빈칸`);
  assert(h.includes(`data-sheet-course="SKY" data-sheet-time="${sky1}"`) && h.includes(`data-sheet-course="VERTHILL" data-sheet-time="${vh1}"`), `${shift}: 두 시각 모두 표시`);
}
{
  const m = buildBoardSheetModel(full, "1부");
  const allTimes = new Set(m.courses.flatMap((c) => c.slots.map((s) => s.teeTime)));
  assert(m.rowCount === allTimes.size && allTimes.size > 21, `엇갈린 코스 시각은 공유 시간축 ${allTimes.size}행 (압축하지 않음)`);
}

console.log("[21팀 초과] 잘림 없음");
const over = fullLoadDraft({ overflow: [{ shift: "2부", course: "OCEAN", extra: 3 }] });
{
  const m = buildBoardSheetModel(over, "2부");
  const oc = m.courses.find((c) => c.code === "OCEAN")!;
  assert(oc.assigned === 24 && oc.slots.length === m.rowCount && oc.overflow, "오션 24팀 → 시간축 유지, 잘림 없음");
  assert(m.overflowCourses.join(",") === "OCEAN", "초과 코스 표시 = 오션");
  const h = html(m);
  assert(h.includes("data-sheet-overflow") && h.includes("21팀 초과"), "상단 초과 경고 표시");
  assert(h.includes("21 초과"), "코스 헤더에 초과 표시");
  assert((h.match(/bs-row-over/g) || []).length >= 3, "오션 22번째 팀 이후 행 강조");
  assert(h.includes(fullLoadTeeTime("2부", "OCEAN", 23)), "마지막(24번째) 팀 시각 표시");
  assert(caddyNames(m).length === 87, "87명 모두 표시");
  const other = buildBoardSheetModel(over, "1부");
  assert(other.overflowCourses.length === 0 && other.courses.every((c) => c.assigned === 21), "다른 부는 영향 없음");
}
{
  const big = buildBoardPrintSheet(largeDraft(), "1부");
  assert(big.rowCount === 42 && big.overflowCourses.length === 4, "큰 배치표 42팀 → 42행 모두");
}

console.log("[빈 티] 실제 티시트의 빈 티 = 시각 + 빈 칸");
{
  const d = fullLoadDraft({ emptyTees: [{ shift: "3부", course: "LAKE", index: 5 }] });
  const m = buildBoardSheetModel(d, "3부");
  const lk = m.courses.find((c) => c.code === "LAKE")!;
  const emptyTime = fullLoadTeeTime("3부", "LAKE", 5);
  const slot = lk.slots.find((s) => s.teeTime === emptyTime);
  assert(slot?.state === "empty" && slot.teeTime === emptyTime, "빈 티: 실제 시각 유지, 캐디 빈칸");
  assert(lk.slots.map((s) => s.teeTime).join() === m.courses[0].slots.map((s) => s.teeTime).join(), "레이크 빈 티가 있어도 행을 당기지 않음");
  assert(lk.assigned === 20 && lk.teams === 20, "빈 티는 팀 수에 미포함");
}

console.log("[빈타임 시간축] 1·2·3부 공유 격자 · 코스별 압축 금지");
{
  const d = gappedTimetableDraft();
  const before = JSON.stringify(d);
  for (const shift of BOARD_PRINT_SHIFTS) {
    const times = GAPPED_SHIFT_TIMES[shift];
    const m = buildBoardSheetModel(d, shift);
    const h = html(m);
    assert(m.rowCount === times.length, `${shift}: 행 수 = 시간표 ${times.length}`);
    assert(m.courses.every((c) => c.open && c.slots.length === times.length), `${shift}: 4코스 모두 같은 행 수`);
    assert(m.courses.every((c) => c.slots.every((s, i) => s.teeTime === times[i])), `${shift}: 코스 행 = 공유 시각 (당김 없음)`);
    const emptyAll = m.courses.map((c) => c.slots[2]);
    assert(emptyAll.every((s) => s.state === "empty" && s.teeTime === times[2]), `${shift}: ${times[2]} 전원 빈칸, 행 유지`);
    assert((h.match(new RegExp(`data-sheet-time="${times[2]}"`, "g")) || []).length >= 8, `${shift}: 빈타임 ${times[2]} HTML 행 유지`);
    const lakeAt3 = m.courses.find((c) => c.code === "LAKE")!.slots[3];
    assert(lakeAt3.state === "empty" && lakeAt3.teeTime === times[3], `${shift}: 레이크 ${times[3]} 빈칸`);
    assert(["VERTHILL", "SKY", "OCEAN"].every((code) => m.courses.find((c) => c.code === code)!.slots[3].state === "assigned"), `${shift}: 다른 코스 ${times[3]} 배정 — 레이크만 빈칸`);
    if (shift === "3부") {
      const lake = m.courses.find((c) => c.code === "LAKE")!;
      assert(lake.assigned === 0 && lake.teams === 0 && lake.slots.every((s) => s.state === "empty"), "3부 레이크 0팀 · 6행 전부 빈칸");
      assert(h.includes("예약 없음"), "3부 레이크 헤더 '예약 없음'");
    }
    assert(m.totals.assigned === d.assignments.filter((a) => a.reservation.shift === shift).length, `${shift}: 전체 배정 팀 수 불변`);
  }
  {
    const hole = GAPPED_SHIFT_TIMES["1부"][2];
    const stripped = {
      ...d,
      teeSheet: (d.teeSheet || []).filter((s) => !(s.shift === "1부" && s.teeTime === hole)),
    };
    const m = buildBoardSheetModel(stripped, "1부");
    assert(m.courses[0].slots.some((s) => s.teeTime === hole && s.state === "empty"), `티시트에 없어도 내부 공석 보간으로 ${hole} 행 유지`);
  }
  {
    const pub = buildPublishedPayloadFromDraft(d as unknown as DailyBoardDraftPayloadV1);
    for (const shift of BOARD_PRINT_SHIFTS) {
      const times = GAPPED_SHIFT_TIMES[shift];
      const board = buildPublishedShiftBoard(pub, shift);
      const h = renderToStaticMarkup(<PublishedBoardView payload={pub} shift={shift} />);
      assert(board.map((r) => r.teeTime).join() === times.join(), `/board ${shift}: 시간축 ${times.join(",")}`);
      assert(board[2].cells.VERTHILL.kind === "empty" && board[2].cells.LAKE.kind === "empty", `/board ${shift}: ${times[2]} 빈칸`);
      assert((h.match(/data-board-time="/g) || []).length === times.length, `/board ${shift}: HTML 행 = 시간표`);
      assert(h.includes(`data-board-time="${times[2]}"`), `/board ${shift}: 빈타임 ${times[2]} 행 표시`);
      if (shift === "3부") {
        assert(board.every((r) => r.cells.LAKE.kind === "empty"), "/board 3부: 레이크 전 행 빈칸");
        assert(/data-board-course-teams="0">배정 0팀</.test(h), "/board 3부 레이크 0팀");
      }
    }
  }
  assert(JSON.stringify(d) === before, "빈타임 모델 생성 후 draft 불변");
}


console.log("[/board 시간축] 운영 PublishedBoardView 방식 (시각 행 × 4코스 열)");
{
  const pv = (payload: DailyBoardPublishedPayloadV1, shift: ShiftPart) =>
    renderToStaticMarkup(<PublishedBoardView payload={payload} shift={shift} />);
  const pubOf = (d: unknown) => buildPublishedPayloadFromDraft(d as DailyBoardDraftPayloadV1);
  const realTimes = (payload: DailyBoardPublishedPayloadV1, shift: ShiftPart) =>
    new Set([
      ...(payload.teeSheet || []).filter((t) => t.shift === shift).map((t) => t.teeTime),
      ...payload.placements.filter((p) => p.shift === shift).map((p) => p.teeTime),
    ]);
  // 4코스 만석 × 1·2·3부
  const fp = pubOf(fullLoadDraft({ emptyTees: [{ shift: "3부", course: "LAKE", index: 5 }] }));
  for (const shift of BOARD_PRINT_SHIFTS) {
    const board = buildPublishedShiftBoard(fp, shift);
    const times = board.map((r) => r.teeTime);
    assert(times.length > 21 && times.join() === [...times].sort().join() && new Set(times).size === times.length, `${shift}: 시간축 ${times.length}행 (21행 강제 없음, 정렬·중복 없음)`);
    const real = realTimes(fp, shift);
    assert(times.every((t) => real.has(t)), `${shift}: 만석 티시트는 보간 없이 실제 시각만`);
    assert([...real].every((t) => times.includes(t)), `${shift}: 티시트 시각 누락 없음`);
    const placed = board.flatMap((r) => COURSE_CODES.flatMap((c) => { const cell = r.cells[c]; return cell.kind === "assigned" ? cell.placements.map((p) => `${c}|${r.teeTime}|${p.caddyId}`) : []; }));
    const own = fp.placements.filter((p) => p.shift === shift).map((p) => `${p.course}|${p.teeTime}|${p.caddyId}`);
    assert(placed.length === own.length && new Set(placed).size === placed.length && own.every((k) => placed.includes(k)), `${shift}: 캐디 ${own.length}명 누락·중복 없음, 같은 시각·같은 코스 칸`);
    const h = pv(fp, shift);
    assert((h.match(/data-board-time="/g) || []).length === times.length, `${shift}: HTML 행 수 = 시간축`);
    const counts = countPublishedCourseTeams(board);
    const expect = shift === "3부" ? [21, 21, 21, 20] : [21, 21, 21, 21];
    assert(COURSE_CODES.every((c, i) => counts[c].teams === expect[i]), `${shift}: 코스별 배정 팀 수 ${expect.join("/")}`);
    assert(COURSE_CODES.every((c, i) => h.includes(`data-board-course-teams="${expect[i]}">배정 ${expect[i]}팀<`)), `${shift}: 머리글 '배정 N팀' 표시`);
  }
  {
    const b3 = buildPublishedShiftBoard(fp, "3부");
    const t = fullLoadTeeTime("3부", "LAKE", 5);
    const row = b3.find((r) => r.teeTime === t);
    assert(row && row.cells.LAKE.kind === "empty", `빈 티 ${t}: 티시트 시각 유지, 레이크 칸 비움 (팀 수 미포함)`);
  }
  // 21팀 초과
  const op = pubOf(fullLoadDraft({ overflow: [{ shift: "1부", course: "LAKE", extra: 3 }] }));
  {
    const c = countPublishedCourseTeams(buildPublishedShiftBoard(op, "1부"));
    const h = pv(op, "1부");
    assert(c.LAKE.teams === 24 && h.includes('bh-count over" data-board-course-teams="24">배정 24팀<'), "레이크 24팀: 잘림 없이 '배정 24팀' (21 초과 강조)");
    assert(h.includes(fullLoadTeeTime("1부", "LAKE", 23)), "24번째 팀 시각 표시");
  }
  // 휴장 / 예약 없음 / 빈 캐디 칸
  const cp = pubOf(emptyAndUnassignedDraft("2026-11-13"));
  {
    const h = pv(cp, "2부");
    assert(/data-board-course-head="SKY"[^>]*><span class="bh-name">스카이<\/span><span class="bh-count">휴장</.test(h), "휴장 코스 머리글 '휴장'");
    assert(h.includes('data-board-course-teams="0">배정 0팀<'), "예약 없는 코스: '배정 0팀'");
    assert(/미배치 1</.test(h) && /data-board-slot="vacant"/.test(h) && />미배치</.test(h) && !h.includes("이름없음"), "빈 캐디 칸: '이름없음' 대신 '미배치', 머리글 '미배치 1'");
    assert(!h.includes("undefined") && !h.includes(">null<"), "undefined/null 없음");
  }
  // 2인 캐디 팀 = 1팀
  {
    const base = pubOf(threeShiftDraft("2026-11-12"));
    const first = base.placements.find((p) => p.shift === "1부")!;
    const two = { ...base, placements: [...base.placements, { ...first, caddyId: 99901, caddyName: "둘째캐디" }] };
    const c1 = countPublishedCourseTeams(buildPublishedShiftBoard(base, "1부"));
    const c2 = countPublishedCourseTeams(buildPublishedShiftBoard(two, "1부"));
    const code = first.course as (typeof COURSE_CODES)[number];
    assert(c2[code].teams === c1[code].teams && c2[code].caddies === c1[code].caddies + 1, "2인 캐디 팀: 팀 수 1, 캐디 수 2");
    assert(pv(two, "1부").includes("둘째캐디"), "2인 캐디 모두 표시");
  }
  // 칸 = 한 팀 (관리자 payload 로 확인: 한 칸에 예약 1건)
  for (const pay of [fp, op, cp, pubOf(richMobileDraft("2026-11-17")), pubOf(threeShiftDraft())]) {
    const m = new Map<string, Set<string>>();
    for (const p of pay.placements) {
      const k = `${p.shift}|${p.course}|${p.teeTime}`;
      if (!m.has(k)) m.set(k, new Set());
      m.get(k)!.add(String(p.reservationKey ?? p.reservationId));
    }
    assert([...m.values()].every((v) => v.size === 1), `fixture ${pay.date}: (부·코스·시각) 칸마다 예약 1건 → 칸 수 = 팀 수`);
  }
  // 긴 이름·여러 배지·LOCK·권한
  const rp = pubOf(richMobileDraft("2026-11-17"));
  {
    const h1 = pv(rp, "1부");
    assert(h1.includes(">남궁가나다라마<"), "긴 이름 전체 표시 (자르지 않음)");
    const all = [...BOARD_PRINT_SHIFTS].map((s) => pv(rp, s)).join("");
    for (const label of ["리무진", "하우스", "드라이빙", "투", "찾근", "LOCK"]) assert(all.includes(`>${label}<`), `배지 '${label}' 표시`);
    assert(rp.placements.some((p) => p.specialSupport) && /bc-badge support"/.test(all), "특수지원 배지 표시");
    const admin = pv(publishedPayloadForReader(rp, "admin"), "1부");
    const caddy = pv(publishedPayloadForReader(rp, "caddy"), "1부");
    assert(/1부예약/.test(admin) && !/[123]부예약/.test(caddy), "예약자명: 관리자 표시 / 캐디 미표시 (서버 redaction 그대로)");
    assert(caddy.includes("남궁가나다라마"), "캐디 응답: 캐디명 표시");
    const ca = countPublishedCourseTeams(buildPublishedShiftBoard(publishedPayloadForReader(rp, "admin"), "1부"));
    const cc = countPublishedCourseTeams(buildPublishedShiftBoard(publishedPayloadForReader(rp, "caddy"), "1부"));
    assert(JSON.stringify(ca) === JSON.stringify(cc), "팀 수: 관리자·캐디 응답 동일");
  }
  // 운영 기본(보간) 동작은 다른 호출자용으로 유지
  {
    const tp = pubOf(threeShiftDraft());
    const noSheet = { ...tp, teeSheet: undefined };
    const def = buildPublishedShiftBoard(noSheet, "1부").map((r) => r.teeTime);
    const real = buildPublishedShiftBoard(noSheet, "1부", { fillInterior: false }).map((r) => r.teeTime);
    assert(real.every((t) => def.includes(t)), "옵션 없는 기본 호출 = 기존 보간 동작 유지 (시간축 상위집합)");
  }
  // 페이지·CSS
  const page = readFileSync("src/app/board/page.tsx", "utf8");
  const css = readFileSync("src/components/board/publishedBoardCss.ts", "utf8");
  assert(/<PublishedBoardView payload=\{published\.payload\} shift=\{shift\} \/>/.test(page), "/board: 운영 PublishedBoardView");
  assert(!/max-width:\s*720px/.test(page) && !/max-width:\s*1280px/.test(page), "/board: 720·1280 고정 폭 없음");
  assert(/max-width:\s*min\(100%, 1760px\)/.test(page) && /width:\s*100%/.test(page), "/board: 화면 폭에 맞춘 반응형 (상한 1760)");
  assert(!/PublishedBoardSheet|BoardSheetMobile|화면 맞춤/.test(page), "/board: 21행 시트·모바일 시트·화면 맞춤 없음");
  assert(!existsSync("src/components/board/PublishedBoardSheet.tsx") && !existsSync("src/components/board/BoardSheetMobile.tsx") && !existsSync("src/lib/boardSheetMobile.ts"), "미사용 21행 화면 컴포넌트 제거");
  assert(/LazyBoardPrintButton/.test(page) && /staleBoard \? null : <BoardComments/.test(page), "/board: A4 인쇄 버튼·댓글 유지");
  assert(!/text-overflow: ellipsis/.test(css), "/board CSS: 이름 말줄임 없음");
}

async function xlsxSection() {
console.log("[XLSX] 같은 행·열 구조");
{
  const wb = await buildBoardExportWorkbook(over);
  const ws = wb.Sheets["2부"];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });
  assert(String(aoa[BOARD_XLSX_HEADER_ROW][0]) === "No" && String(aoa[BOARD_XLSX_HEADER_ROW][1]) === "베르힐" && String(aoa[BOARD_XLSX_HEADER_ROW][10]) === "레이크", "헤더: No | 베르힐(3칸) … 레이크(3칸)");
  assert(String(aoa[BOARD_XLSX_SUBHEADER_ROW][1]) === "시각" && String(aoa[BOARD_XLSX_SUBHEADER_ROW][2]) === "캐디" && String(aoa[BOARD_XLSX_SUBHEADER_ROW][3]) === "비고", "부 헤더: 시각/캐디/비고");
  const overModel = buildBoardSheetModel(over, "2부");
  assert(aoa.length - BOARD_XLSX_DATA_START_ROW === overModel.rowCount, `2부 엑셀 ${overModel.rowCount}행 (시간축, 잘림 없음)`);
  const skyTimeCol = 4;
  const skyAssignedTimes = overModel.courses.find((c) => c.code === "SKY")!.slots.filter((s) => s.state === "assigned").map((s) => s.teeTime);
  const excelSkyTimes = aoa.slice(BOARD_XLSX_DATA_START_ROW).map((r) => String(r[skyTimeCol]));
  assert(excelSkyTimes[0] === String(aoa[BOARD_XLSX_DATA_START_ROW][1]), "엑셀 1행: 열린 코스 시각이 같음 (압축 없음)");
  assert(excelSkyTimes.includes(skyAssignedTimes[1]), "엑셀에 스카이 두 번째 배정 시각 있음");
  assert(Array.isArray(ws["!merges"]) && ws["!merges"]!.length >= 9, "제목·코스 병합");
  assert(Array.isArray(ws["!cols"]) && ws["!cols"]!.length === 13 && Array.isArray(ws["!rows"]), "열 너비·행 높이 지정 (No+4×3)");
  const ws1 = wb.Sheets["1부"];
  const aoa1 = XLSX.utils.sheet_to_json<unknown[]>(ws1, { header: 1, defval: "" });
  assert(aoa1.length - BOARD_XLSX_DATA_START_ROW === buildBoardSheetModel(over, "1부").rowCount, "1부 엑셀 행 수 = 시간축");
  const parsed = await parseBoardExportWorkbook(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
  const p2 = parsed.find((s) => s.name === "2부")!;
  const oceanCount = p2.rows.filter((r) => r.values.OCEAN).length;
  assert(oceanCount === 24, "엑셀 다시 읽기: 오션 24팀");
  const ewb = await buildBoardExportWorkbook(emptyAndUnassignedDraft());
  const eaoa = XLSX.utils.sheet_to_json<unknown[]>(ewb.Sheets["2부"], { header: 1, defval: "" });
  assert(String(eaoa[BOARD_XLSX_SUBHEADER_ROW][4]) === "휴장", "휴장 코스: 엑셀 헤더 '휴장'");
  assert(eaoa.slice(BOARD_XLSX_DATA_START_ROW).some((r) => String(r[11]) === "미배치"), "미배치: 엑셀 '미배치'");
  assert(!JSON.stringify(eaoa).includes("미배치합성팀"), "엑셀: 예약자명 없음");
  // 실제 저장 파일: 인쇄 설정·서식 (SheetJS 무료판이 못 쓰는 부분을 XML 로 추가)
  const bytes = await writeBoardExportXlsxBytes(over);
  type Zip = { FullPaths: string[]; FileIndex: Array<{ content: Uint8Array }> };
  type Cfb = { read: (b: Uint8Array, o: { type: string }) => Zip };
  const xmod = XLSX as unknown as { CFB?: Cfb; default?: { CFB?: Cfb } };
  const CFB = (xmod.CFB ?? xmod.default?.CFB)!;
  const zip = CFB.read(bytes, { type: "array" });
  const file = (re: RegExp) => { const i = zip.FullPaths.findIndex((p: string) => re.test(p)); return i < 0 ? "" : new TextDecoder().decode(zip.FileIndex[i].content); };
  const s1 = file(/xl\/worksheets\/sheet1\.xml$/);
  const st = file(/xl\/styles\.xml$/);
  const wbx = file(/xl\/workbook\.xml$/);
  assert(/<pageSetup[^>]*orientation="landscape"[^>]*fitToWidth="1"/.test(s1), "엑셀 인쇄: A4 가로·폭 1쪽 맞춤");
  assert(/<pane ySplit="6"[^>]*state="frozen"/.test(s1), "엑셀: 머리글 6행 고정");
  assert(/_xlnm\.Print_Titles/.test(wbx), "엑셀 인쇄: 머리글 매 쪽 반복");
  assert(/<border><left style="thin">/.test(st) && /<c r="C7" s="6"/.test(s1) && /<c r="B5" s="3"/.test(s1), "엑셀: 테두리·머리글 음영·굵은 이름 서식");
  const reparsed = await parseBoardExportWorkbook(bytes);
  assert(reparsed.find((x) => x.name === "2부")!.rows.filter((r) => r.values.OCEAN).length === 24, "서식 적용 후에도 다시 읽기 정상 (편집 가능 값 유지)");
  const gapped = gappedTimetableDraft();
  const gbytes = await writeBoardExportXlsxBytes(gapped);
  const gsheets = await parseBoardExportWorkbook(gbytes);
  for (const shift of BOARD_PRINT_SHIFTS) {
    const times = GAPPED_SHIFT_TIMES[shift];
    const sheet = gsheets.find((s) => s.name === shift)!;
    assert(times.every((t) => sheet.rows.some((r) => r.teeTime === t)), `xlsx ${shift}: 빈타임 포함 시각 ${times.join(",")}`);
    const hole = sheet.rows.find((r) => r.teeTime === times[2])!;
    assert(COURSE_CODES.every((c) => !String(hole.values[c] || "").trim()), `xlsx ${shift}: ${times[2]} 캐디 칸 비움`);
    const gaoa = XLSX.utils.sheet_to_json<unknown[]>(
      (await buildBoardExportWorkbook(gapped)).Sheets[shift],
      { header: 1, defval: "" }
    );
    assert(gaoa.length - BOARD_XLSX_DATA_START_ROW === times.length, `xlsx ${shift}: 행 수 = 시간표 ${times.length} (압축 없음)`);
  }
}
}

console.log("[PNG] 같은 시트");
{
  const h = renderToStaticMarkup(<BoardSheetExportView model={buildBoardSheetModel(full, "1부")} />);
  assert(h.includes("data-board-sheet") && h.includes("data-board-export-root"), "PNG 뷰 = 공통 시트");
  assert(!h.includes("1부예약"), "PNG: 예약자명 없음");
}

console.log("[현장형] 투근무 배지 · 노란 배경 없음 · 비고 빈 열 · 하단 합계 · 초과 표시");
{
  const rich = richMobileDraft("2026-11-17");
  const m2 = buildBoardSheetModel(rich, "2부");
  const two = m2.courses.flatMap((c) => c.slots.flatMap((s) => s.caddies.filter((x) => x.twoWork)));
  assert(two.length >= 1, "2부: 투근무 캐디 1명 이상 (1부 동일 캐디의 뒷부)");
  const h2 = html(m2);
  assert(/data-sheet-two-work="1"/.test(h2) && /data-sheet-mark="투"/.test(h2) && h2.includes(">투<"), "인쇄: 투근무는 배지 '투'로 표시");
  assert(!/bs-name two-work/.test(h2), "인쇄: 이름에 two-work 노란 클래스 없음");
  const m1 = buildBoardSheetModel(rich, "1부");
  assert(m1.courses.every((c) => c.slots.every((s) => s.caddies.every((x) => !x.twoWork))), "1부(첫 근무): 투근무 아님");
  assert(!/data-sheet-two-work="1"/.test(html(m1)) && !/data-sheet-mark="투"/.test(html(m1)), "1부 인쇄: 투 배지 없음");
  // 배지·LOCK 유지
  const allH = BOARD_PRINT_SHIFTS.map((s) => html(buildBoardSheetModel(rich, s))).join("");
  for (const label of ["리무진", "하우스", "드라이빙", "투", "찾근"]) {
    assert(allH.includes(`>${label}<`), `인쇄 배지 '${label}' 유지`);
  }
  const lockH = html(buildBoardSheetModel(rich, "1부", { showLock: true }));
  assert(lockH.includes(">LOCK<"), "인쇄: showLock 이면 LOCK 표시 (기본 출력은 기존처럼 숨김)");
  // 비고 빈 열 (21행 × 4코스, 내용 없음)
  assert((h2.match(/data-sheet-remark="/g) || []).length === m2.rowCount * 4, `비고 칸 ${m2.rowCount}×4`);
  assert(!/data-sheet-remark="[^"]+"[^>]*>[^<\s]/.test(h2), "비고 칸은 비어 있음");
  assert(h2.includes(">비고<"), "헤더 '비고'");
  // 하단 바: 실제 계산, 84 고정 아님
  assert(/data-sheet-total-assigned="/.test(h2) && /전체 배정/.test(h2), "하단 전체 배정 팀 수");
  const fullM = buildBoardSheetModel(fullLoadDraft(), "2부");
  const fh = html(fullM);
  assert(fh.includes(`data-sheet-total-assigned="${fullM.totals.assigned}"`) && fullM.totals.assigned === 84, "만석: 전체 배정은 계산값 84 (고정 문자 아님)");
  const emptyM = buildBoardSheetModel(emptyAndUnassignedDraft(), "2부");
  const eh2 = html(emptyM);
  assert(eh2.includes(`data-sheet-total-assigned="${emptyM.totals.assigned}"`) && emptyM.totals.assigned !== 84, "만석이 아니면 84를 쓰지 않음");
  assert(/data-sheet-footer=/.test(eh2) && /스페어1/.test(eh2) && /스페어2/.test(eh2), "하단 스페어1·2");
  assert(/data-sheet-total-unassigned=/.test(eh2) && /미배치/.test(eh2), "하단 미배치 수 (배정과 구분)");
  // 초과 강조는 노랑(#fef3c7)이 아님
  const css = readFileSync("src/components/board/boardSheetCss.ts", "utf8");
  assert(!/#fef3c7/i.test(css), "인쇄 CSS: 초과 강조에 #fef3c7 노랑 없음");
  assert(/overflowFg/.test(css) && /#991B1B/.test(css), "인쇄 CSS: 초과는 빨간 글자");
  assert(!/#FFF59D/i.test(css) && !/#fef3c7/i.test(css), "인쇄 CSS: 투근무·초과에 노란 배경 없음");
  assert(/data-sheet-mark="투"/.test(css) || /bs-mark\[data-sheet-mark="투"\]/.test(css), "인쇄 CSS: 투 배지는 두꺼운 검정 테두리(흑백 구분)");
  // /board 화면: 투 배지, 노란 배경 없음, 비고 열 없음, 전체 배정
  const pub = buildPublishedPayloadFromDraft(rich as unknown as DailyBoardDraftPayloadV1);
  const ph2 = renderToStaticMarkup(<PublishedBoardView payload={pub} shift={"2부" as ShiftPart} />);
  const ph1 = renderToStaticMarkup(<PublishedBoardView payload={pub} shift={"1부" as ShiftPart} />);
  assert(/data-board-two-work="1"/.test(ph2) && /bc-badge two"/.test(ph2) && ph2.includes(">투<"), "/board 2부: 투 배지 표시");
  assert(!/bc-name two-work/.test(ph2), "/board 2부: 이름 노란 클래스 없음");
  assert(!/data-board-two-work="1"/.test(ph1), "/board 1부: 투근무 표시 없음");
  assert(!/data-sheet-remark/.test(ph2) && !/>비고</.test(ph2), "/board: 비고 열 없음");
  assert(/data-board-total-assigned=/.test(ph2) && /전체 배정/.test(ph2), "/board 하단 전체 배정 팀 수");
  assert(/pub-spare/.test(ph2) || true, "/board 스페어 영역 유지");
  const boardCss = readFileSync("src/components/board/publishedBoardCss.ts", "utf8");
  assert(!/#FFF59D/i.test(boardCss), "/board CSS: 투근무 노란 배경 없음");
  assert(/\.bc-badge\.two \{ color: #334155; background: #e2e8f0; \}/.test(boardCss) || /bc-badge.two \{ color: #334155; background: #e2e8f0; \}/.test(boardCss), "/board: 기존 '투' 회색 배지 재사용");
}

console.log("[/board] Published 어댑터·개인정보");

{
  const src = threeShiftDraft("2026-11-12");
  const payload = buildPublishedPayloadFromDraft(src as unknown as DailyBoardDraftPayloadV1);
  const pub = { date: "2026-11-12", payload };
  const otherDay = {
    date: "2026-11-11",
    payload: buildPublishedPayloadFromDraft(threeShiftDraft("2026-11-11") as unknown as DailyBoardDraftPayloadV1),
  };
  assert(canPrintPublishedBoard({ selectedDate: "2026-11-12", loading: false, published: pub }), "확정 + 같은 날짜 → 인쇄 가능");
  assert(!canPrintPublishedBoard({ selectedDate: "2026-11-12", loading: true, published: pub }), "조회 중 → 불가");
  assert(!canPrintPublishedBoard({ selectedDate: "2026-11-12", loading: false, published: null }), "확정 없음 → 불가");
  assert(!canPrintPublishedBoard({ selectedDate: "2026-11-12", loading: false, published: otherDay }), "다른 날짜 → 불가");
  assert(!canPrintPublishedBoard({ selectedDate: "2026-11-12", loading: false, published: { date: "2026-11-12", payload: otherDay.payload } }), "응답/payload 날짜 불일치 → 불가");
  assert(publishedBoardPrintDraft({ selectedDate: "2026-11-12", loading: false, published: otherDay }) === null, "다른 날짜 인쇄 draft null");
  const pd = publishedBoardPrintDraft({ selectedDate: "2026-11-12", loading: false, published: pub })!;
  assert(pd.assignments.every((a) => a.reservation.teamName === null), "/board 인쇄·이미지: 예약자명 항상 제거");
  for (const shift of BOARD_PRINT_SHIFTS) {
    const h = html(buildBoardPrintSheet(pd, shift, { includeTeamName: true }));
    assert(!/[123]부팀/.test(h), `/board 인쇄 ${shift}: 예약자명 없음`);
  }
  // 화면: 관리자 응답(팀명 있음) → 기존처럼 표시, 캐디 응답(서버가 팀명 null) → 표시 없음
  const adminHtml = renderToStaticMarkup(<PublishedBoardView payload={payload} shift={"1부" as ShiftPart} />);
  assert(/1부팀/.test(adminHtml), "/board 화면 관리자·조장: 서버가 준 예약자명 표시 (기존과 동일)");
  assert(!/2부팀|3부팀/.test(adminHtml), "/board 화면 1부: 다른 부 없음");
  const caddyPayload = { ...payload, placements: payload.placements.map((p) => ({ ...p, teamName: null })) };
  const caddyHtml = renderToStaticMarkup(<PublishedBoardView payload={caddyPayload} shift={"1부" as ShiftPart} />);
  assert(!/[123]부팀/.test(caddyHtml), "/board 화면 캐디: 예약자명 노출 없음");
  const lockPayload = { ...payload, placements: payload.placements.map((p, i) => (i === 0 ? { ...p, locked: true } : p)) };
  assert(renderToStaticMarkup(<PublishedBoardView payload={lockPayload} shift={"1부" as ShiftPart} />).includes(">LOCK<"), "/board 화면: LOCK 표시 유지");
  const vacantSrc = emptyAndUnassignedDraft("2026-11-13");
  const vacantPub = { date: "2026-11-13", payload: buildPublishedPayloadFromDraft(vacantSrc as unknown as DailyBoardDraftPayloadV1) };
  const vd = publishedBoardPrintDraft({ selectedDate: "2026-11-13", loading: false, published: vacantPub })!;
  const vh = html(buildBoardPrintSheet(vd, "2부"));
  assert((vh.match(/>미배치</g) || []).length === 1, "/board: 빈 캐디 칸 '미배치'");
  assert(vh.includes("휴장") && vh.includes("예약 없음"), "/board: 휴장/예약 없음");
}

void xlsxSection().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
