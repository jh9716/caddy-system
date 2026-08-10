/**
 * 예약표 파싱 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-reservation-parse-unit.ts
 */

import {
  detectCourseBlocks,
  detectHeaderRow,
  inferShiftFromTeeTime,
  matchHeaderKind,
  normalizeCourse,
  normalizeShift,
  parseDateValue,
  parseReservationSheets,
  parseTeeTime,
  type CourseCode,
  type ParsedReservation,
  type ShiftPart,
} from "../src/lib/reservationParser";
import {
  buildTestReservationXlsxBuffer,
  parseReservationWorkbook,
} from "../src/lib/reservationImportXlsx";

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

function okRows(rows: ParsedReservation[]) {
  return rows.filter((r) => !r.needsReview);
}

section("normalize helpers");
assert(normalizeCourse("베르힐") === "VERTHILL", "베르힐");
assert(normalizeCourse("Verthill CC") === "VERTHILL", "Verthill CC");
assert(normalizeCourse("스카이코스") === "SKY", "스카이코스");
assert(normalizeCourse("OCEAN") === "OCEAN", "OCEAN");
assert(normalizeCourse("레이크") === "LAKE", "레이크");
assert(normalizeCourse("미지") === null, "unknown course");
assert(normalizeShift("1부") === "1부", "1부");
assert(normalizeShift("제2부") === "2부", "제2부");
assert(normalizeShift("3") === "3부", "3");
assert(inferShiftFromTeeTime("06:30") === "1부", "06:30 → 1부");
assert(inferShiftFromTeeTime("13:10") === "2부", "13:10 → 2부");
assert(inferShiftFromTeeTime("16:00") === "3부", "16:00 → 3부");

section("parseTeeTime / parseDateValue");
assert(parseTeeTime("6:30") === "06:30", "6:30");
assert(parseTeeTime("06:30") === "06:30", "06:30");
assert(parseTeeTime("0630") === "06:30", "0630");
assert(parseTeeTime("6시30분") === "06:30", "6시30분");
assert(parseTeeTime(6.5 / 24) === "06:30", "excel serial time");
assert(parseTeeTime("xx:yy") === null, "bad time");
assert(parseTeeTime("25:00") === null, "invalid hour");
assert(parseDateValue("2026-08-10") === "2026-08-10", "ymd");
assert(parseDateValue("2026.8.10") === "2026-08-10", "dotted");
assert(parseDateValue("2026년 8월 10일") === "2026-08-10", "korean date");

section("header detection");
assert(matchHeaderKind("티타임") === "teeTime", "티타임 header");
assert(matchHeaderKind("예약자명") === "teamName", "예약자명");
assert(matchHeaderKind("출발홀") === "startingHole", "출발홀");
assert(matchHeaderKind("홀수") === "hole", "홀수");
const detected = detectHeaderRow([
  ["예약표"],
  [],
  ["날짜", "시간", "코스", "팀명", "출발홀"],
  ["2026-08-10", "06:30", "베르힐", "홍길동", "1"],
]);
assert(detected?.headerRow === 2, "header on row 2");
assert(detected?.columns.teeTime === 1, "time col");
assert(detected?.columns.teamName === 3, "team col");

section("정상 행");
{
  const result = parseReservationSheets([
    {
      name: "베르힐",
      matrix: [
        ["날짜", "티타임", "예약자", "홀", "출발홀"],
        ["2026-08-10", "06:30", "김예약", 18, 1],
        ["2026-08-10", "06:37", "이팀", 18, 10],
        ["2026-08-10", "13:00", "오후팀", 18, 1],
        ["2026-08-10", "16:10", "야간팀", 18, 1],
      ],
    },
  ]);
  assert(result.summary.totals.teams === 4, "4 valid teams");
  assert(result.needsReview.length === 0, "no review");
  assert(result.reservations[0].course === "VERTHILL", "course from sheet");
  assert(result.reservations[0].shift === "1부", "infer 1부");
  assert(result.reservations[2].shift === "2부", "infer 2부");
  assert(result.reservations[3].shift === "3부", "infer 3부");
  assert(result.reservations[0].startingHole === 1, "startingHole");
  assert(result.reservations[0].rawData["예약자"] === "김예약", "rawData kept");
  assert(result.reservations[0].sourceSheet === "베르힐", "sourceSheet");
  assert(result.reservations[0].rawRowIndex === 2, "rawRowIndex 1-based");
  const day = result.summary.byDate[0];
  assert(day?.byShift["1부"] === 2, "day 1부 count");
  assert(day?.byShift["2부"] === 1, "day 2부 count");
  assert(day?.byShift["3부"] === 1, "day 3부 count");
}

section("빈 행 무시");
{
  const result = parseReservationSheets([
    {
      name: "스카이",
      matrix: [
        ["날짜", "시간", "팀명"],
        ["2026-08-11", "07:00", "A"],
        ["", "", ""],
        [null, null, null],
        ["2026-08-11", "07:08", "B"],
      ],
    },
  ]);
  assert(okRows(result.reservations).length === 2, "skip blank rows");
  assert(result.reservations.every((r) => r.course === "SKY"), "sky from sheet");
}

section("잘못된 시간 형식 → needsReview");
{
  const result = parseReservationSheets([
    {
      name: "오션",
      matrix: [
        ["날짜", "티타임", "예약자"],
        ["2026-08-12", "아침일찍", "이상행"],
        ["2026-08-12", "08:00", "정상"],
      ],
    },
  ]);
  assert(result.needsReview.length === 1, "1 needs review");
  assert(
    result.needsReview[0].reviewReasons.some((x) => x.includes("시간")),
    "bad time reason"
  );
  assert(result.summary.totals.teams === 1, "1 valid");
}

section("중복 티타임");
{
  const result = parseReservationSheets([
    {
      name: "레이크",
      matrix: [
        ["날짜", "티타임", "팀명"],
        ["2026-08-13", "09:00", "팀1"],
        ["2026-08-13", "09:00", "팀2"],
        ["2026-08-13", "09:08", "팀3"],
      ],
    },
  ]);
  assert(result.duplicates.length === 2, "2 duplicate rows");
  assert(result.summary.totals.duplicates === 2, "dup count");
  assert(
    result.duplicates.every((r) => r.reviewReasons.includes("중복 티타임")),
    "dup reason"
  );
  assert(result.summary.totals.teams === 1, "only non-dup valid in summary");
}

section("여러 시트 + 코스명 변형");
{
  const result = parseReservationSheets([
    {
      name: "본관(베르힐)",
      matrix: [
        ["일자", "Tee Time", "Guest", "Course"],
        ["2026-08-14", "06:40", "V1", "Verthill"],
      ],
    },
    {
      name: "Sky Course",
      matrix: [
        ["date", "time", "name"],
        ["2026-08-14", "07:00", "S1"],
      ],
    },
    {
      name: "OCEAN",
      matrix: [
        ["날짜", "시간", "예약자", "코스"],
        ["2026-08-14", "12:10", "O1", "오션"],
      ],
    },
    {
      name: "기타",
      matrix: [
        ["날짜", "시간", "팀명", "코스명"],
        ["2026-08-14", "16:20", "L1", "Lake"],
      ],
    },
  ]);
  assert(result.summary.totals.sheets === 4, "4 sheets");
  assert(result.summary.totals.teams === 4, "4 teams multi-sheet");
  const courses = new Set(okRows(result.reservations).map((r) => r.course));
  assert(courses.has("VERTHILL"), "VERTHILL");
  assert(courses.has("SKY"), "SKY");
  assert(courses.has("OCEAN"), "OCEAN");
  assert(courses.has("LAKE"), "LAKE");
  const day = result.summary.byDate.find((d) => d.date === "2026-08-14");
  assert(day?.totalTeams === 4, "day total 4");
  assert(day?.byCourse.length === 4, "4 courses in summary");
}

section("헤더 위치가 다른 경우");
{
  const result = parseReservationSheets(
    [
      {
        name: "스카이",
        matrix: [
          ["베르힐CC 예약현황"],
          ["작성: 관리자"],
          [],
          ["No", "경기일", "티업시간", "단체명", "부", "코스"],
          [1, "2026-08-15", "06:50", "헤더아래", "1부", "스카이"],
          [2, "2026-08-15", "14:00", "오후", "2부", "스카이"],
        ],
      },
    ],
    { defaultDate: "2026-08-15" }
  );
  assert(result.summary.totals.teams === 2, "header offset ok");
  assert(result.reservations[0].shift === "1부", "explicit shift");
  assert(result.reservations[1].teamName === "오후", "team name");
}

section("xlsx buffer roundtrip");
{
  const buf = buildTestReservationXlsxBuffer([
    {
      name: "오션",
      aoa: [
        ["날짜", "티타임", "예약자", "출발홀"],
        ["2026-08-16", "08:00", "버퍼팀", 1],
        ["2026-08-16", "08:08", "버퍼팀2", 1],
        ["2026-08-16", "bad", "리뷰팀", 1],
      ],
    },
    {
      name: "레이크",
      aoa: [
        ["날짜", "시간", "팀명"],
        ["2026-08-16", "09:00", "L"],
        ["2026-08-16", "09:00", "L-dup"],
      ],
    },
  ]);
  const result = parseReservationWorkbook(buf, {
    filename: "예약_2026-08-16.xlsx",
  });
  assert(result.summary.totals.sheets === 2, "xlsx sheets");
  assert(result.summary.totals.teams === 2, "xlsx valid teams (2 ocean; lake dups excluded)");
  assert(result.needsReview.length === 3, "xlsx review (bad time + 2 dups)");
  assert(result.duplicates.length === 2, "xlsx duplicates");
  assert(
    result.reservations.some((r) => r.rawData && Object.keys(r.rawData).length > 0),
    "rawData present"
  );
}

section("빈 예약자 → 예약팀으로 세지 않음 (스킵)");
{
  const result = parseReservationSheets([
    {
      name: "베르힐",
      matrix: [
        ["날짜", "티타임", "예약자"],
        ["2026-08-17", "10:00", ""],
        ["2026-08-17", "10:08", "실제팀"],
      ],
    },
  ]);
  assert(result.reservations.length === 1, "empty team skipped");
  assert(result.summary.totals.teams === 1, "1 team counted");
  assert(result.needsReview.length === 0, "no review for vacant slot");
  assert(result.reservations[0].teamName === "실제팀", "kept real team");
}

section("코스 판별 실패 → needsReview (VERTHILL 강제 없음)");
{
  const result = parseReservationSheets([
    {
      name: "기타시트",
      matrix: [
        ["날짜", "티타임", "예약자"],
        ["2026-08-18", "10:00", "무코스팀"],
      ],
    },
  ]);
  assert(result.needsReview.length === 1, "course fail → review");
  assert(result.needsReview[0].course === null, "course null not VERTHILL");
  assert(
    result.needsReview[0].reviewReasons.some((x) => x.includes("코스")),
    "course reason"
  );
  assert(result.summary.totals.teams === 0, "not counted as valid team");
}

section("가로 4코스 블록 (경기진행등록 구조) → 205팀");
{
  const DATE = "2026-08-20";
  const specs: Array<{
    course: CourseCode;
    label: string;
    shifts: Record<ShiftPart, number>;
  }> = [
    { course: "VERTHILL", label: "베르힐", shifts: { "1부": 24, "2부": 12, "3부": 18 } },
    { course: "SKY", label: "스카이", shifts: { "1부": 24, "2부": 7, "3부": 16 } },
    { course: "OCEAN", label: "오션", shifts: { "1부": 24, "2부": 13, "3부": 16 } },
    { course: "LAKE", label: "레이크", shifts: { "1부": 24, "2부": 10, "3부": 17 } },
  ];

  function teeTimes(shift: ShiftPart, n: number): string[] {
    const start =
      shift === "1부" ? 6 * 60 : shift === "2부" ? 12 * 60 : 16 * 60;
    return Array.from({ length: n }, (_, i) => {
      const m = start + i * 7;
      return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    });
  }

  const blockRows: Array<
    Array<{ course: string; time: string; team: string }>
  > = specs.map((s) => {
    const rows: Array<{ course: string; time: string; team: string }> = [];
    for (const shift of ["1부", "2부", "3부"] as ShiftPart[]) {
      for (const t of teeTimes(shift, s.shifts[shift])) {
        rows.push({
          course: s.label,
          time: t,
          team: `${s.label}-${t}`,
        });
      }
    }
    return rows;
  });

  const maxRows = Math.max(...blockRows.map((b) => b.length));
  const header = [
    ...["코스명", "시간", "예약자", "내장객1", "내장객2", "내장객3", "내장객4", "x", "y", "z", "캐디명"],
    ...["코스명", "시간", "예약자", "내장객1", "내장객2", "내장객3", "내장객4", "x", "y", "z", "캐디명"],
    ...["코스명", "시간", "예약자", "내장객1", "내장객2", "내장객3", "내장객4", "x", "y", "z", "캐디명"],
    ...["코스명", "시간", "예약자", "내장객1", "내장객2", "내장객3", "내장객4", "x", "y", "z", "캐디명"],
  ];

  const matrix: unknown[][] = [
    ["경기진행등록", "", "", DATE],
    header,
  ];
  for (let i = 0; i < maxRows; i++) {
    const row: unknown[] = [];
    for (let b = 0; b < 4; b++) {
      const cell = blockRows[b][i];
      if (cell) {
        row.push(
          cell.course,
          cell.time,
          cell.team,
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          ""
        );
      } else {
        // 공석: 시간은 있어도 예약자 비움 → 세지 않음
        row.push("", "", "", "", "", "", "", "", "", "", "");
      }
    }
    matrix.push(row);
  }

  const blocks = detectCourseBlocks(matrix.map((r) => r.map((c) => String(c ?? ""))));
  assert(blocks.length === 4, "4 horizontal course blocks");
  assert(blocks[0].startCol === 0 && blocks[0].endCol === 10, "block0 A:K");
  assert(blocks[1].startCol === 11 && blocks[1].endCol === 21, "block1 L:V");
  assert(blocks[2].startCol === 22 && blocks[2].endCol === 32, "block2 W:AG");
  assert(blocks[3].startCol === 33 && blocks[3].endCol === 43, "block3 AH:AR");

  const result = parseReservationSheets(
    [{ name: "경기진행등록", matrix }],
    { defaultDate: DATE }
  );

  assert(result.summary.totals.teams === 205, "total 205 teams");
  assert(result.needsReview.length === 0, "no review rows");

  const day = result.summary.byDate.find((d) => d.date === DATE);
  assert(day?.totalTeams === 205, "day total 205");
  assert(day?.byCourse.length === 4, "4 courses in summary");

  const byCode = Object.fromEntries(
    (day?.byCourse || []).map((c) => [c.course, c])
  ) as Record<string, { totalTeams: number; byShift: Record<ShiftPart, number> }>;

  assert(byCode.VERTHILL?.totalTeams === 54, "베르힐 54");
  assert(byCode.VERTHILL?.byShift["1부"] === 24, "V 1부 24");
  assert(byCode.VERTHILL?.byShift["2부"] === 12, "V 2부 12");
  assert(byCode.VERTHILL?.byShift["3부"] === 18, "V 3부 18");

  assert(byCode.SKY?.totalTeams === 47, "스카이 47");
  assert(byCode.SKY?.byShift["1부"] === 24, "S 1부 24");
  assert(byCode.SKY?.byShift["2부"] === 7, "S 2부 7");
  assert(byCode.SKY?.byShift["3부"] === 16, "S 3부 16");

  assert(byCode.OCEAN?.totalTeams === 53, "오션 53");
  assert(byCode.OCEAN?.byShift["1부"] === 24, "O 1부 24");
  assert(byCode.OCEAN?.byShift["2부"] === 13, "O 2부 13");
  assert(byCode.OCEAN?.byShift["3부"] === 16, "O 3부 16");

  assert(byCode.LAKE?.totalTeams === 51, "레이크 51");
  assert(byCode.LAKE?.byShift["1부"] === 24, "L 1부 24");
  assert(byCode.LAKE?.byShift["2부"] === 10, "L 2부 10");
  assert(byCode.LAKE?.byShift["3부"] === 17, "L 3부 17");

  assert(day?.byShift["1부"] === 96, "all 1부 96");
  assert(day?.byShift["2부"] === 42, "all 2부 42");
  assert(day?.byShift["3부"] === 67, "all 3부 67");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
