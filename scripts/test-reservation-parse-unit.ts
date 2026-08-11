/**
 * 예약표 파싱 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-reservation-parse-unit.ts
 *
 * 핵심: shift는 teeTime/빈행/출발홀 숫자가 아니라
 * 시트 공통 rowShiftMap(명시적 1부/2부/3부)으로만 확정.
 */

import {
  buildRowShiftMap,
  detectCourseBlocks,
  detectExplicitShiftLabel,
  detectHeaderRow,
  detectShiftSectionLabel,
  matchHeaderKind,
  normalizeCourse,
  normalizeShift,
  normalizeShiftColumn,
  parseDateValue,
  parseReservationSheets,
  parseTeeTime,
  SHIFT_NOT_DETECTED,
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

function empty11() {
  return Array(11).fill("");
}

function blockHeader() {
  return [
    "코스명",
    "시간",
    "예약자",
    "내장객1",
    "내장객2",
    "내장객3",
    "내장객4",
    "x",
    "y",
    "출발홀",
    "캐디명",
  ];
}

function fourCourseHeader() {
  return [
    ...blockHeader(),
    ...blockHeader(),
    ...blockHeader(),
    ...blockHeader(),
  ];
}

function data11(
  course: string,
  time: string,
  team: string,
  opts?: { hole?: string | number; caddy?: string }
) {
  return [
    course,
    time,
    team,
    "",
    "",
    "",
    "",
    "",
    "",
    opts?.hole ?? "",
    opts?.caddy ?? "",
  ];
}

function timesFrom(start: string, n: number, step = 7): string[] {
  const [h, m] = start.split(":").map(Number);
  let mins = h * 60 + m;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(
        mins % 60
      ).padStart(2, "0")}`
    );
    mins += step;
  }
  return out;
}

function sectionRow(label: ShiftPart): unknown[] {
  // 병합 셀: 라벨이 첫 열(A)에만 존재
  const row = Array(44).fill("");
  row[0] = label;
  return row;
}

section("normalize / explicit shift labels (bare digit 금지)");
assert(normalizeCourse("베르힐") === "VERTHILL", "베르힐");
assert(normalizeCourse("스카이코스") === "SKY", "스카이코스");
assert(detectExplicitShiftLabel("1부") === "1부", "explicit 1부");
assert(detectExplicitShiftLabel("제2부") === "2부", "제2부");
assert(detectExplicitShiftLabel("◆3부") === "3부", "◆3부");
assert(detectExplicitShiftLabel("[2부]") === "2부", "[2부]");
assert(detectExplicitShiftLabel("1") === null, "bare 1 rejected");
assert(detectExplicitShiftLabel("2") === null, "bare 2 rejected");
assert(detectExplicitShiftLabel("3") === null, "bare 3 rejected");
assert(detectExplicitShiftLabel("10") === null, "bare 10 rejected");
assert(normalizeShift("3") === null, "normalizeShift bare 3 null");
assert(normalizeShiftColumn("1부") === "1부", "column 1부");
assert(normalizeShiftColumn("1") === null, "column bare 1 null");
assert(
  detectShiftSectionLabel(["", "1", "10", "팀"], 0, 3) === null,
  "hole digits not section"
);
assert(
  detectShiftSectionLabel(["2부", "", ""], 0, 2) === "2부",
  "detect 2부 section"
);

section("parseTeeTime / parseDateValue");
assert(parseTeeTime("6:30") === "06:30", "6:30");
assert(parseTeeTime("0630") === "06:30", "0630");
assert(parseTeeTime("xx:yy") === null, "bad time");
assert(parseDateValue("2026년 8월 10일") === "2026-08-10", "korean date");

section("header detection");
assert(matchHeaderKind("출발홀") === "startingHole", "출발홀");
assert(matchHeaderKind("캐디명") !== "teamName", "캐디명 ≠ teamName");
const detected = detectHeaderRow([
  ["예약표"],
  [],
  ["날짜", "시간", "코스", "팀명", "출발홀"],
  ["2026-08-10", "06:30", "베르힐", "홍길동", "1"],
]);
assert(detected?.headerRow === 2, "header on row 2");

section("정상 행: 부 구간 헤더 + 출발홀=1이 shift를 바꾸지 않음");
{
  const result = parseReservationSheets([
    {
      name: "베르힐",
      matrix: [
        ["날짜", "티타임", "예약자", "홀", "출발홀"],
        ["1부", "", "", "", ""],
        ["2026-08-10", "06:30", "김예약", 18, 1],
        ["2026-08-10", "06:37", "이팀", 18, 10],
        ["2부", "", "", "", ""],
        ["2026-08-10", "11:20", "오후팀", 18, 1],
        ["3부", "", "", "", ""],
        ["2026-08-10", "17:01", "야간팀", 18, 1],
      ],
    },
  ]);
  assert(result.summary.totals.teams === 4, "4 valid teams");
  assert(result.needsReview.length === 0, "no review");
  assert(result.reservations[0].shift === "1부", "section 1부");
  assert(result.reservations[2].shift === "2부", "11:20 is 2부");
  assert(result.reservations[3].shift === "3부", "17:01 is 3부");
  assert(result.reservations[0].startingHole === 1, "startingHole 1 kept");
}

section("SHIFT_NOT_DETECTED: 라벨 없으면 null (1부 fallback 없음)");
{
  const result = parseReservationSheets([
    {
      name: "스카이",
      matrix: [
        ["날짜", "시간", "팀명"],
        ["2026-08-11", "07:00", "A"],
        ["2026-08-11", "13:00", "B"],
        ["2026-08-11", "17:00", "C"],
      ],
    },
  ]);
  assert(result.reservations.length === 3, "3 parsed rows");
  assert(
    result.reservations.every((r) => r.shift === null),
    "shift null"
  );
  assert(
    result.reservations.every((r) =>
      r.reviewReasons.includes(SHIFT_NOT_DETECTED)
    ),
    "SHIFT_NOT_DETECTED reason"
  );
  assert(result.summary.totals.teams === 0, "not counted as valid");
  assert(
    !result.reservations.some((r) => r.teeTime === "13:00" && r.shift === "2부"),
    "no teeTime→2부"
  );
}

section("빈 행 무시 + 라벨 유지");
{
  const result = parseReservationSheets([
    {
      name: "스카이",
      matrix: [
        ["날짜", "시간", "팀명"],
        ["1부", "", ""],
        ["2026-08-11", "07:00", "A"],
        ["", "", ""],
        [null, null, null],
        ["2026-08-11", "07:08", "B"],
      ],
    },
  ]);
  assert(okRows(result.reservations).length === 2, "skip blank rows");
  assert(
    okRows(result.reservations).every((r) => r.shift === "1부"),
    "blank rows do not advance shift"
  );
}

section("본문 부 구간: 11:20~11:55는 2부");
{
  const result = parseReservationSheets([
    {
      name: "베르힐",
      matrix: [
        ["날짜", "티타임", "예약자"],
        ["1부", "", ""],
        ["2026-08-20", "06:30", "아침A"],
        ["2026-08-20", "11:13", "아침후반"],
        ["2부", "", ""],
        ["2026-08-20", "11:20", "오후A"],
        ["2026-08-20", "11:27", "오후B"],
        ["2026-08-20", "11:34", "오후C"],
        ["2026-08-20", "11:41", "오후D"],
        ["2026-08-20", "11:48", "오후E"],
        ["2026-08-20", "11:55", "오후F"],
      ],
    },
  ]);
  const s1 = okRows(result.reservations).filter((r) => r.shift === "1부");
  const s2 = okRows(result.reservations).filter((r) => r.shift === "2부");
  assert(s1.length === 2, "1부 2팀");
  assert(s2.length === 6, "2부 6팀");
  assert(!s1.some((r) => r.teeTime >= "11:20"), "no 11:xx in 1부");
}

section("병합 셀 A열 라벨 → 전 코스 블록 공유");
{
  const DATE = "2026-08-21";
  const header = [...blockHeader(), ...blockHeader()];
  const matrix: unknown[][] = [
    ["경기진행등록", "", "", DATE],
    header,
    ["1부", ...Array(21).fill("")],
    [
      ...data11("베르힐", "06:30", "V1", { hole: 1, caddy: "김캐디" }),
      ...data11("스카이", "06:30", "S1", { hole: 10, caddy: "이캐디" }),
    ],
    ["2부", ...Array(21).fill("")],
    [
      ...data11("베르힐", "11:20", "V2", { hole: 1, caddy: "박캐디" }),
      ...data11("스카이", "11:27", "S2", { hole: 1 }),
    ],
  ];
  const map = buildRowShiftMap(matrix);
  assert(map[2] === "1부", "rowShiftMap 1부");
  assert(map[4] === "2부", "rowShiftMap 2부");
  const result = parseReservationSheets([{ name: "경기진행등록", matrix }], {
    defaultDate: DATE,
  });
  const ok = okRows(result.reservations);
  assert(ok.length === 4, "4 teams");
  assert(
    ok.filter((r) => r.shift === "2부").map((r) => r.teamName).sort().join(",") ===
      "S2,V2",
    "A-column merge label shared"
  );
  assert(
    ok.find((r) => r.teamName === "V1")?.rawData["캐디명"] === "김캐디",
    "caddy preserved in rawData"
  );
}

section("잘못된 시간 → needsReview");
{
  const result = parseReservationSheets([
    {
      name: "오션",
      matrix: [
        ["날짜", "티타임", "예약자"],
        ["1부", "", ""],
        ["2026-08-12", "아침일찍", "이상행"],
        ["2026-08-12", "08:00", "정상"],
      ],
    },
  ]);
  assert(result.needsReview.length === 1, "1 needs review");
  assert(result.summary.totals.teams === 1, "1 valid");
}

section("중복 티타임");
{
  const result = parseReservationSheets([
    {
      name: "레이크",
      matrix: [
        ["날짜", "티타임", "팀명"],
        ["1부", "", ""],
        ["2026-08-13", "09:00", "팀1"],
        ["2026-08-13", "09:00", "팀2"],
        ["2026-08-13", "09:08", "팀3"],
      ],
    },
  ]);
  assert(result.duplicates.length === 2, "2 duplicate rows");
  assert(result.summary.totals.teams === 1, "only non-dup valid");
}

section("여러 시트 + 명시 부 컬럼");
{
  const result = parseReservationSheets([
    {
      name: "본관(베르힐)",
      matrix: [
        ["일자", "Tee Time", "Guest", "Course", "부"],
        ["2026-08-14", "06:40", "V1", "Verthill", "1부"],
      ],
    },
    {
      name: "Sky Course",
      matrix: [
        ["date", "time", "name", "부"],
        ["2026-08-14", "07:00", "S1", "1부"],
      ],
    },
    {
      name: "OCEAN",
      matrix: [
        ["날짜", "시간", "예약자", "코스", "부"],
        ["2026-08-14", "12:10", "O1", "오션", "2부"],
      ],
    },
    {
      name: "기타",
      matrix: [
        ["날짜", "시간", "팀명", "코스명", "부"],
        ["2026-08-14", "17:20", "L1", "Lake", "3부"],
      ],
    },
  ]);
  assert(result.summary.totals.teams === 4, "4 teams multi-sheet");
  assert(
    okRows(result.reservations).find((r) => r.teamName === "L1")?.shift ===
      "3부",
    "explicit column 3부"
  );
}

section("헤더 offset + 부 컬럼");
{
  const result = parseReservationSheets([
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
  ]);
  assert(result.summary.totals.teams === 2, "header offset ok");
  assert(result.reservations[0].shift === "1부", "explicit shift");
}

section("xlsx buffer roundtrip");
{
  const buf = buildTestReservationXlsxBuffer([
    {
      name: "오션",
      aoa: [
        ["날짜", "티타임", "예약자", "출발홀"],
        ["1부", "", "", ""],
        ["2026-08-16", "08:00", "버퍼팀", 1],
        ["2026-08-16", "08:08", "버퍼팀2", 1],
        ["2026-08-16", "bad", "리뷰팀", 1],
      ],
    },
    {
      name: "레이크",
      aoa: [
        ["날짜", "시간", "팀명"],
        ["1부", "", ""],
        ["2026-08-16", "09:00", "L"],
        ["2026-08-16", "09:00", "L-dup"],
      ],
    },
  ]);
  const result = parseReservationWorkbook(buf, {
    filename: "예약_2026-08-16.xlsx",
  });
  assert(result.summary.totals.teams === 2, "xlsx valid teams");
  assert(result.duplicates.length === 2, "xlsx duplicates");
}

section("빈 예약자 스킵");
{
  const result = parseReservationSheets([
    {
      name: "베르힐",
      matrix: [
        ["날짜", "티타임", "예약자"],
        ["1부", "", ""],
        ["2026-08-17", "10:00", ""],
        ["2026-08-17", "10:08", "실제팀"],
      ],
    },
  ]);
  assert(result.reservations.length === 1, "empty team skipped");
  assert(result.reservations[0].teamName === "실제팀", "kept real team");
}

section("코스 판별 실패 → needsReview");
{
  const result = parseReservationSheets([
    {
      name: "기타시트",
      matrix: [
        ["날짜", "티타임", "예약자"],
        ["1부", "", ""],
        ["2026-08-18", "10:00", "무코스팀"],
      ],
    },
  ]);
  assert(result.needsReview[0].course === null, "course null");
  assert(result.summary.totals.teams === 0, "not valid");
}

section("회귀: 가로 4코스 205팀 = 1부96 / 2부42 / 3부67");
{
  const DATE = "2026-08-20";
  const specs: Array<{
    course: CourseCode;
    label: string;
    n1: number;
    n2: number;
    n3: number;
    s2: string;
  }> = [
    {
      course: "VERTHILL",
      label: "베르힐",
      n1: 24,
      n2: 12,
      n3: 18,
      s2: "11:20",
    },
    { course: "SKY", label: "스카이", n1: 24, n2: 7, n3: 16, s2: "11:27" },
    { course: "OCEAN", label: "오션", n1: 24, n2: 13, n3: 16, s2: "11:20" },
    { course: "LAKE", label: "레이크", n1: 24, n2: 10, n3: 17, s2: "11:34" },
  ];

  // 공유 밴드: 코스별 길이가 달라 일부 블록은 중간부터 빈 칸
  // 2부는 코스마다 시작 시각이 다름 → 행을 공유하되 앞쪽 슬롯은 빈 칸
  const t1 = timesFrom("08:32", 24); // …11:13
  const t2Slots = timesFrom("11:20", 13); // 11:20 … 
  const t3 = timesFrom("16:10", 18); // includes 17~18

  const matrix: unknown[][] = [
    ["경기진행등록", "", "", DATE],
    fourCourseHeader(),
  ];

  const pushBand1or3 = (
    times: string[],
    nOf: (i: number) => number,
    label: ShiftPart
  ) => {
    matrix.push(sectionRow(label));
    for (let i = 0; i < times.length; i++) {
      const row: unknown[] = [];
      for (let b = 0; b < 4; b++) {
        if (i < nOf(b)) {
          const hole = i % 2 === 0 ? 1 : 10;
          const caddy = `캐디${specs[b].label}${i}`;
          row.push(
            ...data11(specs[b].label, times[i], `${specs[b].label}-${times[i]}`, {
              hole,
              caddy,
            })
          );
        } else {
          row.push(...empty11());
        }
      }
      matrix.push(row);
    }
  };

  pushBand1or3(t1, (b) => specs[b].n1, "1부");

  // 2부: 각 코스는 s2부터 n2개. 공유 슬롯 행에서 시작 전은 빈 블록.
  matrix.push(sectionRow("2부"));
  for (let i = 0; i < t2Slots.length; i++) {
    const slot = t2Slots[i];
    const row: unknown[] = [];
    for (let b = 0; b < 4; b++) {
      const s = specs[b];
      const startIdx = t2Slots.indexOf(s.s2);
      const local = i - startIdx;
      if (local >= 0 && local < s.n2) {
        const hole = local % 2 === 0 ? 1 : 10;
        row.push(
          ...data11(s.label, slot, `${s.label}-${slot}`, {
            hole,
            caddy: `캐디${s.label}${local}`,
          })
        );
      } else {
        row.push(...empty11());
      }
    }
    matrix.push(row);
  }

  pushBand1or3(t3, (b) => specs[b].n3, "3부");

  const blocks = detectCourseBlocks(
    matrix.map((r) => r.map((c) => String(c ?? "")))
  );
  assert(blocks.length === 4, "4 horizontal course blocks");
  assert(blocks[0].startCol === 0 && blocks[0].endCol === 10, "A:K");
  assert(blocks[1].startCol === 11 && blocks[1].endCol === 21, "L:V");
  assert(blocks[2].startCol === 22 && blocks[2].endCol === 32, "W:AG");
  assert(blocks[3].startCol === 33 && blocks[3].endCol === 43, "AH:AR");

  const result = parseReservationSheets([{ name: "경기진행등록", matrix }], {
    defaultDate: DATE,
  });

  assert(result.summary.totals.teams === 205, "total 205");
  assert(result.needsReview.length === 0, "shift 누락 0");
  assert(
    result.reservations.every((r) => r.shift != null && !r.needsReview),
    "every reservation has shift"
  );

  const day = result.summary.byDate.find((d) => d.date === DATE);
  assert(day?.byShift["1부"] === 96, "all 1부 96");
  assert(day?.byShift["2부"] === 42, "all 2부 42");
  assert(day?.byShift["3부"] === 67, "all 3부 67");

  const byCode = Object.fromEntries(
    (day?.byCourse || []).map((c) => [c.course, c])
  ) as Record<
    string,
    { totalTeams: number; byShift: Record<ShiftPart, number> }
  >;
  assert(byCode.VERTHILL?.byShift["1부"] === 24, "V 1부 24");
  assert(byCode.VERTHILL?.byShift["2부"] === 12, "V 2부 12");
  assert(byCode.VERTHILL?.byShift["3부"] === 18, "V 3부 18");
  assert(byCode.SKY?.totalTeams === 47, "스카이 47");
  assert(byCode.OCEAN?.totalTeams === 53, "오션 53");
  assert(byCode.LAKE?.totalTeams === 51, "레이크 51");

  for (const s of specs) {
    const first2 = result.reservations
      .filter((r) => r.course === s.course && r.shift === "2부")
      .map((r) => r.teeTime)
      .sort()[0];
    assert(first2 === s.s2, `${s.label} 2부 starts ${s.s2}`);
    const leaked1 = result.reservations.filter(
      (r) =>
        r.course === s.course &&
        r.shift === "1부" &&
        r.teeTime >= s.s2
    );
    assert(leaked1.length === 0, `${s.label}: no 11:xx+ in 1부`);
  }

  const eveningWrong = result.reservations.filter(
    (r) =>
      r.teeTime >= "17:00" &&
      (r.shift === "1부" || r.shift === "2부")
  );
  assert(eveningWrong.length === 0, "17~18 not in 1/2부");
  assert(
    result.reservations.filter((r) => r.shift === "3부" && r.teeTime >= "17:00")
      .length > 0,
    "17~18 in 3부"
  );

  // 출발홀=1 이 있어도 shift 유지 + 캐디명 rawData만 보존
  const withHole1 = result.reservations.filter((r) => r.startingHole === 1);
  assert(withHole1.length > 0, "startingHole=1 present");
  assert(
    withHole1.every((r) => r.shift != null),
    "hole=1 did not clear shift"
  );
  assert(
    result.reservations.some(
      (r) => r.rawData["캐디명"] && String(r.rawData["캐디명"]).startsWith("캐디")
    ),
    "caddy names in rawData"
  );
  assert(
    !result.reservations.some((r) => r.teamName?.startsWith("캐디")),
    "caddy not used as teamName"
  );
}

section("코스 1개 Close(예약 0) + 나머지 정상");
{
  const DATE = "2026-08-22";
  const matrix: unknown[][] = [
    ["경기진행등록", "", "", DATE],
    fourCourseHeader(),
    sectionRow("1부"),
    [
      ...data11("베르힐", "06:30", "V", { hole: 1 }),
      ...empty11(), // 스카이 Close
      ...data11("오션", "06:30", "O", { hole: 10 }),
      ...data11("레이크", "06:30", "L", { hole: 1, caddy: "과거캐디" }),
    ],
    sectionRow("2부"),
    [
      ...data11("베르힐", "11:20", "V2", { hole: 1 }),
      ...empty11(),
      ...data11("오션", "11:20", "O2", { hole: 1 }),
      ...empty11(), // 레이크 2부 없음
    ],
    sectionRow("3부"),
    [
      ...data11("베르힐", "17:01", "V3", { hole: 1 }),
      ...empty11(),
      ...empty11(),
      ...data11("레이크", "18:53", "L3", { hole: 10 }),
    ],
  ];
  const result = parseReservationSheets([{ name: "경기진행등록", matrix }], {
    defaultDate: DATE,
  });
  const ok = okRows(result.reservations);
  assert(ok.length === 7, "7 teams (SKY closed)");
  assert(!ok.some((r) => r.course === "SKY"), "no SKY rows");
  assert(
    ok.filter((r) => r.shift === "1부").length === 3,
    "1부 3 (V/O/L)"
  );
  assert(ok.filter((r) => r.shift === "2부").length === 2, "2부 2");
  assert(ok.filter((r) => r.shift === "3부").length === 2, "3부 2");
  assert(
    ok.find((r) => r.teamName === "L")?.rawData["캐디명"] === "과거캐디",
    "legacy caddy kept"
  );
  // 빈 스카이 블록이 있어도 라벨 행의 shift는 유지
  const map = buildRowShiftMap(matrix);
  const idx3 = matrix.findIndex((r) => cellHas(r, "3부"));
  assert(map[idx3] === "3부", "row map 3부 after empty sky blocks");
}

function cellHas(row: unknown[], text: string) {
  return row.some((c) => String(c ?? "") === text);
}

section("출발홀 숫자만 있는 행이 shift state를 바꾸지 않음");
{
  const matrix: unknown[][] = [
    ["경기진행등록"],
    fourCourseHeader(),
    sectionRow("2부"),
    [
      ...data11("베르힐", "11:20", "V", { hole: 1 }),
      ...data11("스카이", "11:27", "S", { hole: 1 }),
      ...data11("오션", "11:20", "O", { hole: 10 }),
      ...data11("레이크", "11:34", "L", { hole: 1 }),
    ],
    // 다음 행: 일부 코스만 비고 출발홀 잔재처럼 보이면 안 됨 — 완전 빈 블록
    [...empty11(), ...empty11(), ...empty11(), ...empty11()],
    [
      ...data11("베르힐", "11:41", "V2", { hole: 1 }),
      ...empty11(),
      ...empty11(),
      ...empty11(),
    ],
  ];
  const result = parseReservationSheets([{ name: "경기진행등록", matrix }], {
    defaultDate: "2026-08-23",
  });
  const ok = okRows(result.reservations);
  assert(ok.every((r) => r.shift === "2부"), "all stay 2부");
  assert(ok.length === 5, "5 teams");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
