/**
 * 배치표 공통 시트(/board·PNG·A4·XLSX) 단위 테스트.
 * 부 분리, 4코스 순서, 코스별 21팀 행, 21팀 초과 잘림 없음, 코스별 실제 시각, 빈/휴장/미배치,
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
  assert(sheet.rowCount === 21 && (h.match(/data-sheet-row="/g) || []).length === 21, `${shift}: 팀 수가 적어도 21행 고정`);
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
assert(ocean.open && ocean.teams === 0 && ocean.slots.length === 0, "오션 열림·예약 0 → 빈 칸");
assert(lake.unassigned === 2, "레이크 미배치 2 (미배치 예약 1 + 빈 캐디 칸 1)");
const eh = html(empty);
assert(eh.includes("휴장") && eh.includes("예약 없음"), "휴장/예약 없음 헤더");
assert((eh.match(/>미배치</g) || []).length === 3, "미배치 칸 3개 (레이크 2 + 베르힐 12:12)");
assert((eh.match(/data-sheet-cell="closed"/g) || []).length === 21 * 2, "휴장 코스: 21행 × 2칸 빗금");
assert(eh.includes("미배치합성팀"), "미배치 예약자명 (옵션 ON)");
assert(!eh.includes("undefined") && !eh.includes("null"), "undefined/null 문자열 없음");
const none = buildBoardPrintSheet(emptyAndUnassignedDraft(), "1부");
assert(none.isEmpty && none.rowCount === 21, "데이터 없는 부: 빈 21행");
assert(html(none).includes("1부 배치 없음"), "데이터 없는 부: '1부 배치 없음'");

console.log("[21팀] 4코스 × 21팀 × 1·2·3부 만석");
const full = fullLoadDraft();
for (const shift of BOARD_PRINT_SHIFTS) {
  const m = buildBoardSheetModel(full, shift);
  assert(m.rowCount === 21 && m.overflowCourses.length === 0, `${shift}: 21행, 초과 없음`);
  assert(m.courses.every((c) => c.slots.length === 21 && c.assigned === 21), `${shift}: 코스마다 21팀 배정`);
  assert(m.totals.assigned === 84, `${shift}: 84팀`);
  const exact = m.courses.every((c) => c.slots.every((s, i) => s.teeTime === fullLoadTeeTime(shift, c.code, i)));
  assert(exact, `${shift}: 코스별 실제 시각 그대로 (스카이 8분·시작 엇갈림)`);
  const own = new Set(full.assignments.filter((a) => a.reservation.shift === shift).map((a) => a.caddy.name));
  const names = caddyNames(m);
  assert(names.length === 84 && names.every((n) => own.has(n)), `${shift}: 다른 부 섞임 없음`);
  const h = html(m);
  const sky1 = fullLoadTeeTime(shift, "SKY", 1);
  const vh1 = fullLoadTeeTime(shift, "VERTHILL", 1);
  assert(h.includes(`data-sheet-course="SKY" data-sheet-time="${sky1}"`) && h.includes(`data-sheet-course="VERTHILL" data-sheet-time="${vh1}"`), `${shift}: 같은 2행에 코스별 다른 시각 (${vh1} / ${sky1})`);
}
{
  const m = buildBoardSheetModel(full, "1부");
  const allTimes = new Set(m.courses.flatMap((c) => c.slots.map((s) => s.teeTime)));
  assert(allTimes.size > 21, `공통 시간축이면 ${allTimes.size}행 필요 → 코스별 시각 열 방식 채택 근거`);
}

console.log("[21팀 초과] 잘림 없음");
const over = fullLoadDraft({ overflow: [{ shift: "2부", course: "OCEAN", extra: 3 }] });
{
  const m = buildBoardSheetModel(over, "2부");
  const oc = m.courses.find((c) => c.code === "OCEAN")!;
  assert(m.rowCount === 24 && oc.slots.length === 24 && oc.overflow, "오션 24팀 → 24행 (잘림 없음)");
  assert(m.overflowCourses.join(",") === "OCEAN", "초과 코스 표시 = 오션");
  const h = html(m);
  assert(h.includes("data-sheet-overflow") && h.includes("21팀 초과 24행"), "상단 초과 경고 표시");
  assert(h.includes("24행(21 초과)"), "코스 헤더에 초과 표시");
  assert((h.match(/bs-row-over/g) || []).length === 3, "22~24행 강조");
  assert(h.includes(fullLoadTeeTime("2부", "OCEAN", 23)), "마지막(24번째) 팀 시각 표시");
  assert(caddyNames(m).length === 87, "87명 모두 표시");
  const other = buildBoardSheetModel(over, "1부");
  assert(other.rowCount === 21 && other.overflowCourses.length === 0, "다른 부는 영향 없음 (21행)");
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
  assert(lk.slots[5].state === "empty" && lk.slots[5].teeTime === fullLoadTeeTime("3부", "LAKE", 5), "빈 티: 실제 시각 유지, 캐디 빈칸");
  assert(lk.assigned === 20 && lk.teams === 20, "빈 티는 팀 수에 미포함");
  // 티시트에 없는 보간 시각은 만들지 않음
  const noSheet = { ...threeShiftDraft(), teeSheet: undefined };
  const m2 = buildBoardSheetModel(noSheet, "1부");
  assert(m2.courses.every((c) => c.slots.every((s) => s.state !== "empty")), "티시트 없으면 빈 시각을 만들지 않음");
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
    const board = buildPublishedShiftBoard(fp, shift, { fillInterior: false });
    const times = board.map((r) => r.teeTime);
    assert(times.length > 21 && times.join() === [...times].sort().join() && new Set(times).size === times.length, `${shift}: 시간축 ${times.length}행 (21행 강제 없음, 정렬·중복 없음)`);
    const real = realTimes(fp, shift);
    assert(times.every((t) => real.has(t)), `${shift}: 모든 행 = 실제 티시트/배정 시각 (계산으로 만든 시각 없음)`);
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
    const b3 = buildPublishedShiftBoard(fp, "3부", { fillInterior: false });
    const t = fullLoadTeeTime("3부", "LAKE", 5);
    const row = b3.find((r) => r.teeTime === t);
    assert(row && row.cells.LAKE.kind === "empty", `빈 티 ${t}: 티시트 시각 유지, 레이크 칸 비움 (팀 수 미포함)`);
  }
  // 21팀 초과
  const op = pubOf(fullLoadDraft({ overflow: [{ shift: "1부", course: "LAKE", extra: 3 }] }));
  {
    const c = countPublishedCourseTeams(buildPublishedShiftBoard(op, "1부", { fillInterior: false }));
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
    const c1 = countPublishedCourseTeams(buildPublishedShiftBoard(base, "1부", { fillInterior: false }));
    const c2 = countPublishedCourseTeams(buildPublishedShiftBoard(two, "1부", { fillInterior: false }));
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
    const ca = countPublishedCourseTeams(buildPublishedShiftBoard(publishedPayloadForReader(rp, "admin"), "1부", { fillInterior: false }));
    const cc = countPublishedCourseTeams(buildPublishedShiftBoard(publishedPayloadForReader(rp, "caddy"), "1부", { fillInterior: false }));
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
  assert(/<PublishedBoardView payload=\{published\.payload\} shift=\{shift\} \/>/.test(page) && /max-width: 720px;/.test(page), "/board: 운영 PublishedBoardView + 720px 복구");
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
  assert(String(aoa[BOARD_XLSX_HEADER_ROW][0]) === "No" && String(aoa[BOARD_XLSX_HEADER_ROW][1]) === "베르힐" && String(aoa[BOARD_XLSX_HEADER_ROW][7]) === "레이크", "헤더: No | 베르힐(2칸) … 레이크(2칸)");
  assert(String(aoa[BOARD_XLSX_SUBHEADER_ROW][1]) === "시각" && String(aoa[BOARD_XLSX_SUBHEADER_ROW][2]) === "캐디", "부 헤더: 시각/캐디");
  assert(aoa.length - BOARD_XLSX_DATA_START_ROW === 24, "2부 엑셀 24행 (초과 잘림 없음)");
  assert(String(aoa[BOARD_XLSX_DATA_START_ROW + 1][3]) === fullLoadTeeTime("2부", "SKY", 1), "엑셀 2행 스카이 시각 = 실제 시각");
  assert(Array.isArray(ws["!merges"]) && ws["!merges"]!.length >= 9, "제목·코스 병합");
  assert(Array.isArray(ws["!cols"]) && ws["!cols"]!.length === 9 && Array.isArray(ws["!rows"]), "열 너비·행 높이 지정");
  const ws1 = wb.Sheets["1부"];
  const aoa1 = XLSX.utils.sheet_to_json<unknown[]>(ws1, { header: 1, defval: "" });
  assert(aoa1.length - BOARD_XLSX_DATA_START_ROW === 21, "1부 엑셀 21행");
  const parsed = await parseBoardExportWorkbook(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
  const p2 = parsed.find((s) => s.name === "2부")!;
  const oceanCount = p2.rows.filter((r) => r.values.OCEAN).length;
  assert(oceanCount === 24, "엑셀 다시 읽기: 오션 24팀");
  const ewb = await buildBoardExportWorkbook(emptyAndUnassignedDraft());
  const eaoa = XLSX.utils.sheet_to_json<unknown[]>(ewb.Sheets["2부"], { header: 1, defval: "" });
  assert(String(eaoa[BOARD_XLSX_SUBHEADER_ROW][3]) === "휴장", "휴장 코스: 엑셀 헤더 '휴장'");
  assert(eaoa.slice(BOARD_XLSX_DATA_START_ROW).some((r) => String(r[8]) === "미배치"), "미배치: 엑셀 '미배치'");
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
}
}

console.log("[PNG] 같은 시트");
{
  const h = renderToStaticMarkup(<BoardSheetExportView model={buildBoardSheetModel(full, "1부")} />);
  assert(h.includes("data-board-sheet") && h.includes("data-board-export-root"), "PNG 뷰 = 공통 시트");
  assert(!h.includes("1부예약"), "PNG: 예약자명 없음");
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
