/**
 * 3부반 주간 시작조 순환 + 주말반 우선 + 공휴일 판정 (DB 없음)
 * 실행: npx tsx scripts/test-third-weekly-rotation-unit.ts
 */

import {
  computeAutoAssignmentsV1,
  REASON,
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
  rotateThirdQueueFromStartTeam,
  rotateThirdTeamsFromStart,
  THIRD_WEEKLY_CYCLE,
} from "../src/lib/thirdWeeklyRotation";

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

if (failed > 0) {
  console.error(`\nFAILED ${failed} / ${passed + failed}`);
  process.exit(1);
}
console.log(`\nALL PASSED ${passed}`);
