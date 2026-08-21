/**
 * 3부반 주간 시작조 순환 + 주말반 우선 + 공휴일 판정 (DB 없음)
 * 실행: npx tsx scripts/test-third-weekly-rotation-unit.ts
 */

import {
  computeAutoAssignmentsV1,
  parseOptionalThirdStartCaddyId,
  REASON,
  reflowRegularAssignments,
  reservationKey,
  ThirdStartCaddyError,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "../src/lib/autoAssignEngine";
import {
  isKrPublicHoliday,
  isWeekendBandPriorityDate,
  weekdaySun0,
} from "../src/lib/krHolidays";
import {
  automaticThirdStartTeam,
  effectiveThirdStartTeam,
  extractWeekendBandInRotationOrder,
  mondayOfWeek,
  rotateThirdQueueFromStartCaddy,
  rotateThirdQueueFromStartTeam,
  rotateThirdTeamsFromStart,
  THIRD_WEEKLY_CYCLE,
} from "../src/lib/thirdWeeklyRotation";
import fs from "node:fs";
import path from "node:path";

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
  console.log(`\n▶ ${title}`);
}

function caddy(
  id: number,
  team: string,
  teamOrder: number,
  extra?: Partial<AutoAssignCaddy>
): AutoAssignCaddy {
  return {
    id,
    name: extra?.name || `${team}-${teamOrder}`,
    team,
    teamOrder,
    caddyType: extra?.caddyType || "THIRD",
    thirdBandSubgroup: extra?.thirdBandSubgroup ?? null,
    inputOrder: extra?.inputOrder,
  };
}

function res(
  date: string,
  shift: "1부" | "2부" | "3부",
  n: number,
  hour: number
): AutoAssignReservation[] {
  const out: AutoAssignReservation[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      date,
      course: (["VERTHILL", "SKY", "OCEAN", "LAKE"] as const)[i % 4],
      shift,
      teeTime: `${String(hour).padStart(2, "0")}:${String(i).padStart(2, "0")}`,
      teamName: `${shift}-${i + 1}`,
    });
  }
  return out;
}

function housePool(n: number): AutoAssignCaddy[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 1000 + i,
    name: `H${i + 1}`,
    team: `${(i % 8) + 1}조`,
    teamOrder: Math.floor(i / 8) + 1,
    caddyType: "HOUSE" as const,
  }));
}

section("주간 시작조 자동 순환 (2026-08-17=12조)");
{
  const weeks: Array<[string, string]> = [
    ["2026-08-17", "12조"],
    ["2026-08-18", "12조"],
    ["2026-08-23", "12조"],
    ["2026-08-24", "9조"],
    ["2026-08-31", "10조"],
    ["2026-09-07", "11조"],
    ["2026-09-14", "12조"],
    ["2026-09-21", "9조"],
  ];
  for (const [ymd, team] of weeks) {
    assert(
      automaticThirdStartTeam(ymd) === team,
      `${ymd} (${mondayOfWeek(ymd)} 주) → ${team}`
    );
  }
  assert(
    rotateThirdTeamsFromStart("12조").join(",") === "12조,9조,10조,11조",
    "12조 스타트 queue 12→9→10→11"
  );
  assert(
    rotateThirdTeamsFromStart("9조").join(",") === "9조,10조,11조,12조",
    "9조 스타트 queue 9→10→11→12"
  );
  assert(
    THIRD_WEEKLY_CYCLE.join(",") === "12조,9조,10조,11조",
    "주 시작조 순환 12→9→10→11"
  );
}

section("수동 override는 그 주만, 다음 주는 자동값");
{
  const override = { weekStart: "2026-08-24", startTeam: "11조" };
  assert(
    effectiveThirdStartTeam("2026-08-24", override) === "11조",
    "08-24 주 override → 11조"
  );
  assert(
    effectiveThirdStartTeam("2026-08-30", override) === "11조",
    "같은 주 일요일도 override"
  );
  assert(
    effectiveThirdStartTeam("2026-08-31", override) === "10조",
    "다음 주 08-31은 자동 10조 (밀리지 않음)"
  );
  assert(
    effectiveThirdStartTeam("2026-08-17", override) === "12조",
    "이전 주는 자동 12조"
  );
  assert(
    effectiveThirdStartTeam("2026-08-24", {
      weekStart: "2026-08-17",
      startTeam: "10조",
    }) === "9조",
    "다른 주 override는 무시 → 08-24 자동 9조"
  );
  assert(
    effectiveThirdStartTeam("2026-08-17", {
      weekStart: "2026-08-17",
      startTeam: "10조",
    }) === "10조",
    "08-17 주만 10조로 바뀜"
  );
}

section("THIRD queue 정렬은 teamOrder 불변, 시작조만 반영");
{
  const third = [
    caddy(9, "9조", 2),
    caddy(12, "12조", 1),
    caddy(10, "10조", 1),
    caddy(11, "11조", 3),
    caddy(91, "9조", 1),
  ];
  const q12 = rotateThirdQueueFromStartTeam(third, "12조");
  assert(
    q12.map((c) => `${c.team}:${c.teamOrder}`).join(",") ===
      "12조:1,9조:1,9조:2,10조:1,11조:3",
    "12스타트: 12→9(teamOrder)→10→11"
  );
  const q9 = rotateThirdQueueFromStartTeam(third, "9조");
  assert(
    q9.map((c) => `${c.team}:${c.teamOrder}`).join(",") ===
      "9조:1,9조:2,10조:1,11조:3,12조:1",
    "9스타트: 9→10→11→12"
  );
  assert(
    third.every((c) => c.teamOrder === third.find((x) => x.id === c.id)?.teamOrder),
    "원본 teamOrder 유지"
  );
}

section("공휴일 판정 (로컬, 외부 API 없음)");
{
  assert(weekdaySun0("2026-08-15") === 6, "2026-08-15 토");
  assert(weekdaySun0("2026-08-17") === 1, "2026-08-17 월");
  assert(isKrPublicHoliday("2026-08-15"), "광복절");
  assert(isKrPublicHoliday("2026-08-17"), "광복절 대체(월)");
  assert(!isKrPublicHoliday("2026-08-18"), "08-18 평일 비공휴일");
  assert(isKrPublicHoliday("2026-03-01"), "삼일절");
  assert(isKrPublicHoliday("2026-05-05"), "어린이날");
  assert(isKrPublicHoliday("2026-09-24"), "추석 연휴 전날");
  assert(isKrPublicHoliday("2026-09-25"), "추석");
  assert(isKrPublicHoliday("2026-12-25"), "성탄절");
  assert(isWeekendBandPriorityDate("2026-08-22"), "토요일");
  assert(isWeekendBandPriorityDate("2026-08-23"), "일요일");
  assert(isWeekendBandPriorityDate("2026-08-17"), "월요 대체공휴일");
  assert(isWeekendBandPriorityDate("2026-12-25"), "금요 성탄절");
  assert(!isWeekendBandPriorityDate("2026-08-18"), "화요 평일 우선 없음");
  assert(!isWeekendBandPriorityDate("2026-08-19"), "수요 평일 우선 없음");
}

section("엔진: 주간 시작조가 3부 THIRD 순서에 반영");
{
  const third = [
    caddy(12, "12조", 1),
    caddy(9, "9조", 1),
    caddy(10, "10조", 1),
    caddy(11, "11조", 1),
  ];
  const run = (date: string, start?: string) => {
    const result = computeAutoAssignmentsV1({
      date,
      available: [...housePool(4), ...third],
      reservations: [
        ...res(date, "1부", 2, 6),
        ...res(date, "2부", 2, 10),
        ...res(date, "3부", 4, 14),
      ],
      ...(start ? { thirdStartTeam: start } : {}),
    });
    return result.regularAssignments
      .filter((a) => a.shift === "3부")
      .map((a) => a.caddy.team);
  };
  assert(
    run("2026-08-18").join(",") === "12조,9조,10조,11조",
    "08-18 자동 12스타트 12→9→10→11"
  );
  assert(
    run("2026-08-25").join(",") === "9조,10조,11조,12조",
    "08-25 자동 9스타트 9→10→11→12"
  );
  assert(
    run("2026-08-18", "10조").join(",") === "10조,11조,12조,9조",
    "같은 주 수동 10조 스타트"
  );
  const autoNext = computeAutoAssignmentsV1({
    date: "2026-08-25",
    available: [...housePool(4), ...third],
    reservations: [
      ...res("2026-08-25", "1부", 2, 6),
      ...res("2026-08-25", "2부", 2, 10),
      ...res("2026-08-25", "3부", 4, 14),
    ],
  });
  assert(
    autoNext.meta.thirdStartTeam === "9조" &&
      autoNext.meta.thirdStartTeamAutomatic === "9조",
    "다음 주 메타는 자동 9조"
  );
}

section("토/일/공휴일 WEEKEND 우선, 평일은 없음");
{
  const third = [
    caddy(12, "12조", 1, { name: "W12", thirdBandSubgroup: "WEEKEND" }),
    caddy(9, "9조", 1, { name: "W9", thirdBandSubgroup: "WEEKEND" }),
    caddy(10, "10조", 1, { name: "D10", thirdBandSubgroup: "WEEKDAY" }),
    caddy(11, "11조", 1, { name: "N11" }),
    caddy(92, "12조", 2, { name: "W12b", thirdBandSubgroup: "WEEKEND" }),
  ];

  const sat = "2026-08-22";
  const satResult = computeAutoAssignmentsV1({
    date: sat,
    available: [...housePool(6), ...third],
    reservations: [
      ...res(sat, "1부", 2, 6),
      ...res(sat, "2부", 2, 10),
      ...res(sat, "3부", 6, 14),
    ],
  });
  const satWeekend = satResult.weekendBandAssignments.map((a) => a.caddy.name);
  assert(
    satWeekend.join(",") === "W12,W12b,W9",
    "토: 12스타트 rotation에서 WEEKEND만 상대순서 추출"
  );
  assert(
    satWeekend.join(",") !== "W12,W9,W12b",
    "WEEKEND를 이름순/조순으로 재정렬하지 않음"
  );
  assert(
    satResult.weekendBandAssignments.every(
      (a) => a.reason === REASON.WEEKEND_BAND_PRIORITY && a.shift === "3부"
    ),
    "주말반 reason/3부"
  );

  const rotated = rotateThirdQueueFromStartTeam(third, "12조");
  assert(
    extractWeekendBandInRotationOrder(rotated)
      .map((c) => c.name)
      .join(",") === "W12,W12b,W9",
    "추출 헬퍼도 상대순서 유지"
  );

  const sun = "2026-08-23";
  const sunResult = computeAutoAssignmentsV1({
    date: sun,
    available: [...housePool(6), ...third],
    reservations: [
      ...res(sun, "1부", 2, 6),
      ...res(sun, "2부", 2, 10),
      ...res(sun, "3부", 4, 14),
    ],
  });
  assert(
    sunResult.weekendBandAssignments.map((a) => a.caddy.name).join(",") ===
      "W12,W12b,W9",
    "일: WEEKEND 우선"
  );

  const hol = "2026-08-17";
  const holResult = computeAutoAssignmentsV1({
    date: hol,
    available: [...housePool(6), ...third],
    reservations: [
      ...res(hol, "1부", 2, 6),
      ...res(hol, "2부", 2, 10),
      ...res(hol, "3부", 4, 14),
    ],
  });
  assert(
    holResult.weekendBandAssignments.map((a) => a.caddy.name).join(",") ===
      "W12,W12b,W9",
    "대체공휴일(월) WEEKEND 우선"
  );

  const weekday = "2026-08-18";
  const wdResult = computeAutoAssignmentsV1({
    date: weekday,
    available: [...housePool(6), ...third],
    reservations: [
      ...res(weekday, "1부", 2, 6),
      ...res(weekday, "2부", 2, 10),
      ...res(weekday, "3부", 6, 14),
    ],
  });
  assert(
    wdResult.weekendBandAssignments.length === 0,
    "평일 WEEKEND 우선 없음"
  );
  const wdThird = wdResult.regularAssignments
    .filter((a) => a.shift === "3부")
    .slice(2)
    .map((a) => a.caddy.name);
  assert(
    wdThird[0] === "W12" && wdThird.includes("D10"),
    "평일 WEEKEND는 일반 THIRD rotation에 참여"
  );
}

section("주말반 이후 1·3 신청자, WEEKDAY는 일반 참여");
{
  const date = "2026-08-22";
  const third = [
    caddy(12, "12조", 1, { name: "W12", thirdBandSubgroup: "WEEKEND" }),
    caddy(9, "9조", 1, { name: "W9", thirdBandSubgroup: "WEEKEND" }),
    caddy(10, "10조", 1, { name: "D10", thirdBandSubgroup: "WEEKDAY" }),
    caddy(11, "11조", 1, { name: "N11" }),
  ];
  const result = computeAutoAssignmentsV1({
    date,
    available: [...housePool(8), ...third],
    oneThreeCandidates: [
      {
        id: 51,
        name: "일삼B",
        team: "1조",
        teamOrder: 2,
        inputOrder: 2,
      },
      {
        id: 50,
        name: "일삼A",
        team: "8조",
        teamOrder: 9,
        inputOrder: 1,
      },
    ],
    oneThreeAnchor: { course: "VERTHILL", teeTime: "06:00" },
    reservations: [
      ...res(date, "1부", 8, 6),
      ...res(date, "2부", 2, 10),
      ...res(date, "3부", 6, 14),
    ],
  });
  const s3 = result.assignments
    .filter((a) => a.shift === "3부")
    .sort((a, b) => a.reservation.teeTime.localeCompare(b.reservation.teeTime));
  assert(
    s3[0].caddy.name === "W12" && s3[1].caddy.name === "W9",
    "3부 앞은 WEEKEND 상대순서"
  );
  assert(
    s3[2].caddy.name === "일삼A" && s3[3].caddy.name === "일삼B",
    "주말반 다음 1·3은 sortOrder"
  );
  assert(
    result.oneThreeAssignments.filter((a) => a.shift === "3부").length === 2,
    "1·3 3부 2명"
  );
  const after = s3.slice(4).map((a) => a.caddy.name);
  assert(after.includes("D10") && after.includes("N11"), "이후 WEEKDAY/일반 THIRD");
  assert(
    !result.weekendBandAssignments.some((a) => a.caddy.name === "D10"),
    "WEEKDAY는 주말반 우선 없음"
  );
}

section("1막/54/1·2 회귀: 주말반과 독립");
{
  const date = "2026-08-18";
  const result = computeAutoAssignmentsV1({
    date,
    available: housePool(8),
    fiftyFourHole: [{ id: 77, name: "오십", team: "3조", teamOrder: 1 }],
    oneTwoCandidates: [{ id: 78, name: "일이", team: "2조", teamOrder: 1 }],
    oneMakCandidates: [{ id: 79, name: "막", team: "4조", teamOrder: 1 }],
    oneMakAnchor: { course: "SKY", teeTime: "06:01" },
    reservations: [
      ...res(date, "1부", 8, 6),
      ...res(date, "2부", 4, 10),
      ...res(date, "3부", 2, 14),
    ],
  });
  assert(result.weekendBandAssignments.length === 0, "평일 주말반 0");
  assert(
    result.fiftyFourHoleAssignments.some((a) => a.shift === "1부"),
    "54홀 1부 유지"
  );
  assert(
    result.oneTwoAssignments.some((a) => a.shift === "2부"),
    "1·2 2부 유지"
  );
  assert(
    result.oneMakAssignments.some((a) => a.caddy.name === "막"),
    "1막 유지"
  );
}

section("3부 첫 캐디 thirdStartCaddyId");
{
  const date = "2026-08-17";
  const letters = [
    caddy(1, "12조", 1, { name: "A" }),
    caddy(2, "12조", 2, { name: "B" }),
    caddy(3, "12조", 3, { name: "C" }),
    caddy(4, "12조", 4, { name: "D" }),
    caddy(5, "12조", 5, { name: "E" }),
  ];
  const house = housePool(8);
  const reservations = [
    ...res(date, "1부", 4, 6),
    ...res(date, "2부", 4, 10),
    ...res(date, "3부", 5, 14),
  ];
  const available = [...house, ...letters];
  const base = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
  });
  const omitted = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
  });
  assert(
    JSON.stringify(base.regularAssignments.map((a) => a.caddy.id)) ===
      JSON.stringify(omitted.regularAssignments.map((a) => a.caddy.id)),
    "thirdStartCaddyId 미입력 → 기존 결과와 동일"
  );
  const thirdNames = (result: ReturnType<typeof computeAutoAssignmentsV1>) =>
    result.regularAssignments
      .filter((a) => a.shift === "3부" && a.caddy.caddyType === "THIRD")
      .map((a) => a.caddy.name);

  const fromC = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    thirdStartCaddyId: 3,
  });
  assert(
    fromC.regularAssignments
      .filter((a) => a.shift === "3부" && a.caddy.caddyType === "THIRD")
      .map((a) => a.caddy.name)
      .join("") === "CDEAB",
    "C 선택 → C D E A B"
  );
  assert(
    fromC.meta.thirdStartCaddyId === 3,
    "meta.thirdStartCaddyId 보존"
  );

  const withoutC = [...house, letters[0], letters[1], letters[3], letters[4]];
  const offC = computeAutoAssignmentsV1({
    date,
    available: withoutC,
    reservations,
    thirdStartCaddyId: 3,
    caddyDirectory: letters,
  });
  assert(
    thirdNames(offC).join("") === "DEAB",
    "선택 캐디 휴무 → 다음 가용 D부터"
  );

  const sickC = computeAutoAssignmentsV1({
    date,
    available: withoutC,
    reservations,
    thirdStartCaddyId: 3,
    caddyDirectory: [
      ...letters.filter((c) => c.id !== 3),
      { ...letters[2], employmentStatus: "ACTIVE" },
    ],
  });
  assert(
    thirdNames(sickC)[0] === "D",
    "선택 캐디 병가(풀 제외) → 다음 가용 D"
  );

  const dutyC = computeAutoAssignmentsV1({
    date,
    available: withoutC,
    reservations,
    thirdStartCaddyId: 3,
    caddyDirectory: letters,
  });
  assert(thirdNames(dutyC)[0] === "D", "선택 캐디 당번/마샬(풀 제외) → 다음 가용");

  const retiredC = computeAutoAssignmentsV1({
    date,
    available: withoutC,
    reservations,
    thirdStartCaddyId: 3,
    caddyDirectory: [{ ...letters[2], employmentStatus: "RETIRED" }, ...withoutC],
  });
  assert(
    thirdNames(retiredC)[0] === "D",
    "선택 캐디 RETIRED(9~12조) → 다음 가용 (에러 아님)"
  );

  try {
    computeAutoAssignmentsV1({
      date,
      available,
      reservations,
      thirdStartCaddyId: house[0].id,
    });
    assert(false, "HOUSE ID는 실패해야 함");
  } catch (e) {
    assert(
      e instanceof ThirdStartCaddyError &&
        /9~12조/.test((e as Error).message),
      "HOUSE ID → validation error"
    );
  }

  try {
    computeAutoAssignmentsV1({
      date,
      available,
      reservations,
      thirdStartCaddyId: 99999,
    });
    assert(false, "없는 ID는 실패해야 함");
  } catch (e) {
    assert(
      e instanceof ThirdStartCaddyError &&
        /찾을 수 없습니다/.test((e as Error).message),
      "존재하지 않는 ID → validation error"
    );
  }

  try {
    parseOptionalThirdStartCaddyId("abc");
    assert(false, "비정수 parse 실패해야 함");
  } catch (e) {
    assert(
      e instanceof ThirdStartCaddyError,
      "정수가 아닌 thirdStartCaddyId → 400"
    );
  }
  assert(parseOptionalThirdStartCaddyId("") === null, "빈 값 → null");
  assert(parseOptionalThirdStartCaddyId(undefined) === null, "undefined → null");

  const rotated = rotateThirdQueueFromStartCaddy(
    letters,
    3,
    letters,
    "12조"
  );
  assert(
    rotated.map((c) => c.name).join("") === "CDEAB",
    "rotateThirdQueueFromStartCaddy C → CDEAB wrap"
  );
}

section("thirdStartCaddyId는 특수 3부/Mode A HOUSE 선행을 바꾸지 않음");
{
  const sat = "2026-08-22";
  const third = [
    caddy(12, "12조", 1, { name: "W12", thirdBandSubgroup: "WEEKEND" }),
    caddy(9, "9조", 1, { name: "W9", thirdBandSubgroup: "WEEKEND" }),
    caddy(10, "10조", 1, { name: "D10", thirdBandSubgroup: "WEEKDAY" }),
    caddy(11, "11조", 1, { name: "N11" }),
  ];
  const reservations = [
    ...res(sat, "1부", 2, 6),
    ...res(sat, "2부", 2, 10),
    ...res(sat, "3부", 6, 14),
  ];
  const available = [...housePool(8), ...third];
  const without = computeAutoAssignmentsV1({
    date: sat,
    available,
    reservations,
  });
  const withStart = computeAutoAssignmentsV1({
    date: sat,
    available,
    reservations,
    thirdStartCaddyId: 10,
  });
  assert(
    without.weekendBandAssignments.map((a) => a.caddy.name).join(",") ===
      withStart.weekendBandAssignments.map((a) => a.caddy.name).join(","),
    "주말반 우선 순서는 thirdStartCaddyId와 무관"
  );
  const regularThird = withStart.regularAssignments.filter(
    (a) => a.shift === "3부" && a.caddy.caddyType === "THIRD"
  );
  assert(
    regularThird[0]?.caddy.name === "D10",
    "WEEKEND 빠진 뒤 regular는 선택 D10부터"
  );

  const weekendPicked = computeAutoAssignmentsV1({
    date: sat,
    available,
    reservations,
    thirdStartCaddyId: 12,
  });
  const regularAfterWeekend = weekendPicked.regularAssignments.filter(
    (a) => a.shift === "3부" && a.caddy.caddyType === "THIRD"
  );
  assert(
    weekendPicked.weekendBandAssignments.some((a) => a.caddy.id === 12),
    "선택 W12는 주말반 우선으로 소진"
  );
  assert(
    regularAfterWeekend[0]?.caddy.name === "D10",
    "WEEKEND 우선으로 빠진 선택자 → 다음 regular 가용 D10"
  );

  const weekday = "2026-08-18";
  const modeA = computeAutoAssignmentsV1({
    date: weekday,
    available: [...housePool(6), ...third],
    reservations: [
      ...res(weekday, "1부", 2, 6),
      ...res(weekday, "2부", 2, 10),
      ...res(weekday, "3부", 6, 14),
    ],
    thirdStartCaddyId: 10,
  });
  const s3 = modeA.regularAssignments.filter((a) => a.shift === "3부");
  assert(
    s3[0].caddy.caddyType === "HOUSE" && s3[1].caddy.caddyType === "HOUSE",
    "Mode A HOUSE 선행 유지"
  );
  const firstThird = s3.find((a) => a.caddy.caddyType === "THIRD");
  assert(firstThird?.caddy.name === "D10", "Mode A 이후 regular THIRD는 선택자부터");
}

section("LIVE reflow가 thirdStartCaddyId를 유지");
{
  const date = "2026-08-17";
  const letters = [
    caddy(1, "12조", 1, { name: "A" }),
    caddy(2, "12조", 2, { name: "B" }),
    caddy(3, "12조", 3, { name: "C" }),
    caddy(4, "12조", 4, { name: "D" }),
    caddy(5, "12조", 5, { name: "E" }),
  ];
  const reservations: AutoAssignReservation[] = [
    ...res(date, "1부", 4, 6),
    ...res(date, "2부", 4, 10),
    ...res(date, "3부", 5, 14),
  ].map((row, i) => ({ ...row, id: `R${i}` }));
  const available = [...housePool(8), ...letters];
  const previous = computeAutoAssignmentsV1({
    date,
    available,
    reservations,
    thirdStartCaddyId: 3,
  });
  const lastThird = [...previous.regularAssignments]
    .filter((a) => a.shift === "3부" && a.caddy.caddyType === "THIRD")
    .pop();
  const reflow = reflowRegularAssignments({
    previous,
    regularCaddyPool: available,
    events: [
      {
        type: "CANCEL_RESERVATION",
        reservationKey: reservationKey(lastThird!.reservation),
      },
    ],
  });
  assert(
    reflow.after.meta.thirdStartCaddyId === 3,
    "reflow after.meta.thirdStartCaddyId 유지"
  );
  const afterThird = reflow.after.regularAssignments
    .filter((a) => a.shift === "3부" && a.caddy.caddyType === "THIRD")
    .map((a) => a.caddy.name);
  assert(afterThird[0] === "C", "캔슬 reflow 후에도 C부터 시작");
}

section("UI: 3부 첫 캐디 선택 optional · 날짜 변경 시 초기화");
{
  const pageSrc = fs.readFileSync(
    path.join(process.cwd(), "src/app/manage/assignments/page.tsx"),
    "utf8"
  );
  assert(pageSrc.includes("3부 첫 캐디 (선택)"), "UI 라벨 3부 첫 캐디 (선택)");
  assert(
    pageSrc.includes("setThirdStartCaddyId(\"\")") ||
      pageSrc.includes("setThirdStartCaddyId('')"),
    "날짜 변경 시 thirdStartCaddyId 초기화"
  );
  assert(
    pageSrc.includes("선택 안 함 (주간 시작조 첫 가용)"),
    "미선택 시 자동배치 가능 안내"
  );
  const runBtn = pageSrc.slice(
    pageSrc.indexOf('className="btn primary"'),
    pageSrc.indexOf("자동배치 실행")
  );
  assert(
    runBtn.includes("houseStartCaddyId") && !runBtn.includes("thirdStartCaddyId"),
    "실행 버튼 필수는 1부만 (3부 미선택 허용)"
  );
}

if (failed > 0) {
  console.error(`\nFAILED ${failed} / ${passed + failed}`);
  process.exit(1);
}
console.log(`\nALL PASSED ${passed}`);
