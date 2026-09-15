/**
 * 배치표 Excel export 타깃 테스트 (엔진/DB write 없음)
 * 실행: npm run test:assignment-board-export-xlsx-unit
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssignmentDraft } from "../src/lib/assignmentDraft";
import type { AssignmentKind, AutoAssignmentRow } from "../src/lib/autoAssignEngine";
import { COURSE_CODES, type CourseCode, type ShiftPart } from "../src/lib/reservationParser";
import {
  BOARD_EXPORT_SHIFTS,
  buildBoardExportSlice,
} from "../src/lib/assignmentBoardExport";
import {
  BOARD_XLSX_TABLE_HEADERS,
  BOARD_XLSX_TITLE,
  boardExcelAssignmentText,
  boardExportXlsxContentDisposition,
  boardExportXlsxFilename,
  countAssignedExcelCells,
  parseBoardExportWorkbook,
  writeBoardExportXlsxBytes,
} from "../src/lib/assignmentBoardExportXlsx";
import { countBoardAssignments } from "../src/lib/assignmentBoardView";

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

function section(title: string) {
  console.log("\n==", title, "==");
}

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

function row(opts: {
  shift: ShiftPart;
  teeTime: string;
  course: CourseCode | string;
  id: string;
  name?: string;
  kind?: AssignmentKind;
  pairId?: string | null;
  locked?: boolean;
  supportKind?: string;
  supportWorkPattern?: string;
  caddyId?: number;
}): AutoAssignmentRow {
  return {
    date: "2026-09-07",
    shift: opts.shift,
    sequenceIndex: 0,
    reason: "TEST",
    kind: opts.kind ?? "regular",
    pairId: opts.pairId ?? null,
    locked: opts.locked,
    supportKind: opts.supportKind,
    supportWorkPattern: opts.supportWorkPattern,
    reservation: {
      id: opts.id,
      date: "2026-09-07",
      course: opts.course,
      shift: opts.shift,
      teeTime: opts.teeTime,
      teamName: "고객명",
      rawRowIndex: 1,
    },
    caddy: {
      id: opts.caddyId ?? Number(opts.id.replace(/\D/g, "") || 1),
      name: opts.name ?? `C${opts.id}`,
      team: "1조",
      teamOrder: 1,
    },
  };
}

function draftOf(
  assignments: AutoAssignmentRow[],
  extra?: Partial<AssignmentDraft>
): AssignmentDraft {
  return {
    date: "2026-09-07",
    status: "DRAFT",
    assignments,
    unassignedReservations: [],
    closedCourseReservations: [],
    openCourses: [...COURSE_CODES],
    caddyPool: [],
    sparesByShift: [],
    confirmedAt: null,
    ...extra,
  };
}

function cellAt(
  sheets: ReturnType<typeof parseBoardExportWorkbook>,
  shift: ShiftPart,
  teeTime: string,
  course: CourseCode
): string {
  const sheet = sheets.find((s) => s.name === shift);
  const line = sheet?.rows.find((r) => r.teeTime === teeTime);
  return line?.values[course] ?? "";
}

section("파일명 / Content-Disposition");
{
  const name = boardExportXlsxFilename("2026-09-07");
  assert(name === "VERTHILL_배치표_2026-09-07.xlsx", "한국어 파일명");
  const disp = boardExportXlsxContentDisposition(name);
  assert(/filename\*=UTF-8''/.test(disp), "RFC5987 filename*");
  assert(disp.includes(encodeURIComponent(name)), "UTF-8 인코딩 파일명");
  assert(/filename="VERTHILL_[^"]+\.xlsx"/.test(disp), "ASCII fallback filename");
}

section("셀 표시 형식 (metadata만)");
{
  assert(boardExcelAssignmentText(row({
    shift: "1부", teeTime: "05:57", course: "VERTHILL", id: "a1", name: "박지아",
  })) === "박지아", "일반 이름은 접미사 없음");
  assert(boardExcelAssignmentText(row({
    shift: "1부", teeTime: "06:04", course: "VERTHILL", id: "a2", name: "임형규",
    kind: "oneTwo", pairId: "p1",
  })) === "임형규 [1·2]", "1·2");
  assert(boardExcelAssignmentText(row({
    shift: "2부", teeTime: "12:00", course: "SKY", id: "a3", name: "이투쓰리",
    kind: "twoThree", pairId: "p23",
  })) === "이투쓰리 [2·3]", "2·3");
  assert(boardExcelAssignmentText(row({
    shift: "1부", teeTime: "07:00", course: "OCEAN", id: "a4", name: "김일삼",
    kind: "oneThree", pairId: "p13",
  })) === "김일삼 [1·3]", "1·3");
  assert(boardExcelAssignmentText(row({
    shift: "1부", teeTime: "07:10", course: "LAKE", id: "a5", name: "최오사",
    kind: "fiftyFourHole", pairId: "p54",
  })) === "최오사 [54]", "54홀");
  assert(boardExcelAssignmentText(row({
    shift: "1부", teeTime: "08:17", course: "LAKE", id: "a6", name: "김성규",
    kind: "specialSupport", supportKind: "MARSHAL_SUPPORT", supportWorkPattern: "SHIFT_1",
  })) === "김성규 [마]", "마샬 지원 [마]");
  assert(boardExcelAssignmentText(row({
    shift: "1부", teeTime: "08:10", course: "SKY", id: "a7", name: "손지연",
    kind: "specialSupport", supportKind: "SPECIAL_SUPPORT", supportWorkPattern: "SHIFT_1",
  })) === "손지연 [지원]", "특수지원 [지원]");
  assert(boardExcelAssignmentText(row({
    shift: "1부", teeTime: "08:20", course: "VERTHILL", id: "a8", name: "서포트원투",
    kind: "specialSupport", supportKind: "SPECIAL_SUPPORT", supportWorkPattern: "ONE_TWO",
    pairId: "sup12",
  })) === "서포트원투 [지원·1·2]", "SUP12");
  assert(
    !boardExcelAssignmentText(row({
      shift: "1부", teeTime: "06:00", course: "SKY", id: "a9", name: "락드",
      locked: true,
    })).includes("LOCK"),
    "LOCK 텍스트 없음"
  );
  assert(
    boardExcelAssignmentText(row({
      shift: "1부", teeTime: "06:00", course: "OCEAN", id: "vacant", name: "",
      caddyId: -1,
    })) === "",
    "빈칸 직접편집은 빈 셀"
  );
}

section("workbook 구조 / 빈 셀 / 닫힌 코스 / 1부만");
{
  const d = draftOf(
    [
      row({ shift: "1부", teeTime: "05:57", course: "VERTHILL", id: "1", name: "박지아" }),
      row({ shift: "1부", teeTime: "05:57", course: "SKY", id: "2", name: "강보미" }),
    ],
    { openCourses: ["VERTHILL", "SKY"] }
  );
  const bytes = writeBoardExportXlsxBytes(d);
  const sheets = parseBoardExportWorkbook(bytes);
  assert(sheets.map((s) => s.name).join(",") === "1부,2부,3부", "3개 sheet");
  assert(sheets.every((s) => s.title === BOARD_XLSX_TITLE), "제목");
  assert(sheets.every((s) => s.dateLine === "날짜: 2026-09-07"), "날짜 행");
  assert(sheets[0].shiftLine === "부: 1부", "1부 라벨");
  assert(sheets[1].shiftLine === "부: 2부", "2부 라벨");
  assert(sheets[2].shiftLine === "부: 3부", "3부 라벨");
  assert(
    sheets.every((s) => s.headers.slice(0, 5).join("|") === BOARD_XLSX_TABLE_HEADERS.join("|")),
    "시간|베르힐|스카이|오션|레이크"
  );
  assert(cellAt(sheets, "1부", "05:57", "VERTHILL") === "박지아", "베르힐 이름");
  assert(cellAt(sheets, "1부", "05:57", "SKY") === "강보미", "스카이 이름");
  assert(cellAt(sheets, "1부", "05:57", "OCEAN") === "", "닫힌 오션 빈 셀");
  assert(cellAt(sheets, "1부", "05:57", "LAKE") === "", "닫힌 레이크 빈 셀");
  assert(sheets[1].rows.length === 0, "2부 예약 없으면 데이터 행 없음");
  assert(sheets[2].rows.length === 0, "3부 없는 날도 sheet는 존재");
  const asText = Buffer.from(bytes).toString("binary");
  assert(!/sheetProtection/.test(asText), "셀 보호 없음");
  assert(!/workbookProtection/.test(asText), "workbook 비밀번호 없음");
  assert(!/vbaProject/.test(asText), "macro 없음");
  const counts = countAssignedExcelCells(sheets);
  assert(counts.total === 2 && counts.byShift["1부"] === 2, "배정 셀 2");
}

section("직접편집 미publish 상태가 그대로 나옴");
{
  const d = draftOf([
    row({ shift: "1부", teeTime: "06:11", course: "OCEAN", id: "e1", name: "원본이름" }),
  ]);
  d.assignments[0] = {
    ...d.assignments[0],
    caddy: { ...d.assignments[0].caddy, id: 99, name: "직접편집" },
  };
  const sheets = parseBoardExportWorkbook(writeBoardExportXlsxBytes(d));
  assert(cellAt(sheets, "1부", "06:11", "OCEAN") === "직접편집", "화면 draft 이름");
  assert(!Buffer.from(writeBoardExportXlsxBytes(d)).toString("utf8").includes("원본이름"), "이전 이름 없음");
}

section("LOCK / 특수 / 지원 / linked pair 양쪽 sheet");
{
  const d = draftOf([
    row({
      shift: "1부", teeTime: "06:04", course: "VERTHILL", id: "p1a", name: "임형규",
      kind: "oneTwo", pairId: "12-8", locked: true,
    }),
    row({
      shift: "2부", teeTime: "12:11", course: "VERTHILL", id: "p1b", name: "임형규",
      kind: "oneTwo", pairId: "12-8", locked: true, caddyId: Number("8") || 8,
    }),
    row({
      shift: "2부", teeTime: "13:00", course: "SKY", id: "t3a", name: "이투",
      kind: "twoThree", pairId: "23-1",
    }),
    row({
      shift: "3부", teeTime: "17:00", course: "SKY", id: "t3b", name: "이투",
      kind: "twoThree", pairId: "23-1", caddyId: 31,
    }),
    row({
      shift: "1부", teeTime: "07:00", course: "OCEAN", id: "o3a", name: "김일삼",
      kind: "oneThree", pairId: "13-1",
    }),
    row({
      shift: "3부", teeTime: "17:10", course: "OCEAN", id: "o3b", name: "김일삼",
      kind: "oneThree", pairId: "13-1", caddyId: 13,
    }),
    row({
      shift: "1부", teeTime: "07:20", course: "LAKE", id: "f4a", name: "최오사",
      kind: "fiftyFourHole", pairId: "54-1",
    }),
    row({
      shift: "2부", teeTime: "13:20", course: "LAKE", id: "f4b", name: "최오사",
      kind: "fiftyFourHole", pairId: "54-1", caddyId: 54,
    }),
    row({
      shift: "1부", teeTime: "08:00", course: "SKY", id: "s12a", name: "서포트",
      kind: "specialSupport", supportKind: "SPECIAL_SUPPORT", supportWorkPattern: "ONE_TWO",
      pairId: "sup12",
    }),
    row({
      shift: "2부", teeTime: "12:40", course: "SKY", id: "s12b", name: "서포트",
      kind: "specialSupport", supportKind: "SPECIAL_SUPPORT", supportWorkPattern: "ONE_TWO",
      pairId: "sup12", caddyId: 12,
    }),
  ]);
  d.assignments[1].caddy.id = d.assignments[0].caddy.id;
  d.assignments[3].caddy.id = d.assignments[2].caddy.id;
  d.assignments[5].caddy.id = d.assignments[4].caddy.id;
  d.assignments[7].caddy.id = d.assignments[6].caddy.id;
  d.assignments[9].caddy.id = d.assignments[8].caddy.id;
  const bytes = writeBoardExportXlsxBytes(d);
  const sheets = parseBoardExportWorkbook(bytes);
  assert(cellAt(sheets, "1부", "06:04", "VERTHILL") === "임형규 [1·2]", "1부 1·2");
  assert(cellAt(sheets, "2부", "12:11", "VERTHILL") === "임형규 [1·2]", "2부 1·2 동일 캐디");
  assert(cellAt(sheets, "2부", "13:00", "SKY") === cellAt(sheets, "3부", "17:00", "SKY"), "2·3 동일");
  assert(cellAt(sheets, "1부", "07:00", "OCEAN") === cellAt(sheets, "3부", "17:10", "OCEAN"), "1·3 동일");
  assert(cellAt(sheets, "1부", "07:20", "LAKE") === cellAt(sheets, "2부", "13:20", "LAKE"), "54홀 동일");
  assert(cellAt(sheets, "1부", "08:00", "SKY") === "서포트 [지원·1·2]", "SUP12 1부");
  assert(cellAt(sheets, "2부", "12:40", "SKY") === "서포트 [지원·1·2]", "SUP12 2부");
  const allCellText = sheets
    .flatMap((s) => s.rows.flatMap((r) => [r.teeTime, ...Object.values(r.values)]))
    .join("\n");
  assert(!allCellText.includes("12-8"), "pairId 12-8 셀 미노출");
  assert(!allCellText.includes("sup12"), "pairId sup12 셀 미노출");
}

section("export source 안전장치 (호출/의존 금지)");
{
  const xlsx = read("src/lib/assignmentBoardExportXlsx.ts");
  const btn = read("src/components/board/BoardExcelExportButton.tsx");
  const page = read("src/app/manage/assignments/page.tsx");
  for (const [name, src] of [
    ["xlsx lib", xlsx],
    ["excel button", btn],
  ] as const) {
    assert(!/prisma/.test(src), `${name} prisma 없음`);
    assert(!/\/api\/assignments\/draft/.test(src), `${name} draft API 없음`);
    assert(!/computeAutoAssignments/.test(src), `${name} 자동배치 재계산 없음`);
    assert(!/publishDailyBoard|confirmAssignments/.test(src), `${name} publish/confirm 없음`);
    assert(!/\breflow[A-Za-z(]/.test(src), `${name} reflow 없음`);
    assert(!/SET_LOCK|CLEAR_|RESTORE_/.test(src), `${name} SET/CLEAR/RESTORE 없음`);
    assert(!/googleapis|spreadsheets/.test(src), `${name} Spreadsheet write 없음`);
    assert(!/quickBoardMutation|replaceDailyOpsDuties/.test(src), `${name} mutation 없음`);
    assert(!/assignmentBoardCellEdit/.test(src), `${name} 직접편집 mutation 모듈 없음`);
  }
  assert(/buildBoardExportSlice/.test(xlsx), "화면과 같은 buildBoardExportSlice");
  assert(/bookType: "xlsx"/.test(xlsx), "실제 xlsx");
  assert(/BoardExcelExportButton/.test(page), "assignments에 엑셀 버튼");
  assert(/BoardImageExportMenu/.test(page), "이미지 버튼 유지");
  assert(
    /BoardImageExportMenu draft=\{draft\}[\s\S]{0,180}BoardExcelExportButton draft=\{draft\}/.test(page),
    "이미지 옆 엑셀, 동일 draft"
  );
  const engine = read("src/lib/autoAssignEngine.ts");
  const png = read("src/lib/assignmentBoardExportPng.ts");
  const menu = read("src/components/board/BoardImageExportMenu.tsx");
  assert(!/assignmentBoardExportXlsx/.test(engine), "엔진 미변경");
  assert(!/BoardExcelExportButton/.test(menu), "이미지 메뉴 동작 변경 없음");
  assert(/PNG 다운로드/.test(menu) && /공유하기/.test(menu), "이미지 메뉴 문구 유지");
  assert(!/엑셀/.test(png), "PNG 경로에 엑셀 혼입 없음");
}

section("2026-09-07 fixture 209/77/80/52");
{
  const fixturePath = join(process.cwd(), "scripts/fixtures/board-export-2026-09-07.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as AssignmentDraft;
  assert(fixture.date === "2026-09-07", "fixture 날짜");
  assert(fixture.assignments.length === 209, "fixture assignment 209");
  const byShift = { "1부": 0, "2부": 0, "3부": 0 } as Record<ShiftPart, number>;
  for (const a of fixture.assignments) byShift[a.shift] += 1;
  assert(byShift["1부"] === 77, "fixture 1부 77");
  assert(byShift["2부"] === 80, "fixture 2부 80");
  assert(byShift["3부"] === 52, "fixture 3부 52");

  const bytes = writeBoardExportXlsxBytes(fixture);
  const outDir = "/opt/cursor/artifacts";
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, boardExportXlsxFilename(fixture.date));
  writeFileSync(outFile, bytes);
  console.log("  wrote", outFile, bytes.byteLength, "bytes");

  const sheets = parseBoardExportWorkbook(bytes);
  assert(sheets.length === 3, "reparse 3 sheets");
  const counted = countAssignedExcelCells(sheets);
  assert(counted.total === 209, `Excel 배정 셀 209 (실제 ${counted.total})`);
  assert(counted.byShift["1부"] === 77, `Excel 1부 77 (실제 ${counted.byShift["1부"]})`);
  assert(counted.byShift["2부"] === 80, `Excel 2부 80 (실제 ${counted.byShift["2부"]})`);
  assert(counted.byShift["3부"] === 52, `Excel 3부 52 (실제 ${counted.byShift["3부"]})`);

  for (const shift of BOARD_EXPORT_SHIFTS) {
    const sliceCount = countBoardAssignments(buildBoardExportSlice(fixture, shift).rows);
    assert(sliceCount === counted.byShift[shift], `${shift} board slice와 Excel 셀 수 일치`);
  }

  const seen = new Set<string>();
  let missing = 0;
  let mismatch = 0;
  for (const a of fixture.assignments) {
    const course = a.reservation.course as CourseCode;
    const key = `${a.shift}|${a.reservation.teeTime}|${course}`;
    if (seen.has(key)) {
      console.error("  duplicate key", key);
    }
    seen.add(key);
    const text = cellAt(sheets, a.shift, a.reservation.teeTime, course);
    if (!text) missing += 1;
    else if (!text.startsWith(a.caddy.name)) mismatch += 1;
  }
  assert(seen.size === 209, "teeTime/course 중복 없음");
  assert(missing === 0, "누락 없음");
  assert(mismatch === 0, "이름/코스/시간이 원본과 일치");

  const pairs = new Map<string, AutoAssignmentRow[]>();
  for (const a of fixture.assignments) {
    if (!a.pairId) continue;
    const list = pairs.get(a.pairId) || [];
    list.push(a);
    pairs.set(a.pairId, list);
  }
  let pairOk = 0;
  for (const [, list] of pairs) {
    const names = list.map((a) =>
      cellAt(sheets, a.shift, a.reservation.teeTime, a.reservation.course as CourseCode)
    );
    if (names.length === 2 && names[0] === names[1] && names[0].includes(list[0].caddy.name)) {
      pairOk += 1;
    }
  }
  assert(pairs.size === 2 && pairOk === 2, "1·2 pair 두 쌍 동일 캐디");

  const s1 = cellAt(sheets, "1부", "05:57", "VERTHILL");
  const sOneTwo = cellAt(sheets, "1부", "06:04", "VERTHILL");
  const sSky = cellAt(sheets, "1부", "06:04", "SKY");
  assert(s1 === "박지아", "05:57 베르힐 박지아");
  assert(sOneTwo === "임형규 [1·2]", "06:04 베르힐 임형규 [1·2]");
  assert(sSky === "구본의 [1·2]", "06:04 스카이 구본의 [1·2]");
  assert(cellAt(sheets, "2부", "12:11", "VERTHILL") === "임형규 [1·2]", "2부 pair 임형규");
  assert(cellAt(sheets, "2부", "12:11", "SKY") === "구본의 [1·2]", "2부 pair 구본의");
  assert(cellAt(sheets, "1부", "08:10", "SKY") === "손지연 [지원]", "손지연 [지원]");
  assert(!/�/.test(s1 + sOneTwo + sSky), "이름 깨짐 없음");
  assert(sheets.every((s) => !s.rows.some((r) => Object.values(r.values).some((v) => v.includes("�")))), "전 sheet 한글 정상");
}

section("기존 이미지 export 회귀 문구");
{
  const menu = read("src/components/board/BoardImageExportMenu.tsx");
  assert(menu.includes("{busy ? \"이미지…\" : \"이미지\"}"), "이미지 버튼 라벨");
  const page = read("src/app/manage/assignments/page.tsx");
  assert(page.includes("직접편집"), "직접편집 토글 유지");
  assert(page.includes("+ 추가팀"), "추가팀 유지");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
