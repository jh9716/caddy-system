/**
 * 1부 AUTO 앞쪽 특수/지원 · 3부 주중반/주말반 band · linked 회귀
 * 실행: npm run test:auto-assign-shift-order-unit
 * fixture/in-memory only. production DB 없음.
 */
import {
  compareReservationOrder,
  computeAutoAssignmentsV1,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "../src/lib/autoAssignEngine";
import {
  emptySpecialSupportByShift,
  oneTwoSupportPairId,
} from "../src/lib/dailySpecialSupport";

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

const COURSES = ["VERTHILL", "SKY", "OCEAN", "LAKE"] as const;

function board(
  date: string,
  shift: "1부" | "2부" | "3부",
  count: number,
  teeStart: string
): AutoAssignReservation[] {
  const [hh, mm] = teeStart.split(":").map(Number);
  const out: AutoAssignReservation[] = [];
  for (let i = 0; i < count; i++) {
    const wave = Math.floor(i / 4);
    const total = hh * 60 + mm + wave * 8;
    const h = String(Math.floor(total / 60)).padStart(2, "0");
    const m = String(total % 60).padStart(2, "0");
    out.push({
      date,
      id: `${shift}-${i + 1}`,
      course: COURSES[i % 4],
      shift,
      teeTime: `${h}:${m}`,
      teamName: `${shift}-${i + 1}`,
      rawRowIndex: i + 1,
    });
  }
  return out;
}

function house(id: number, order: number): AutoAssignCaddy {
  return {
    id,
    name: `H${id}`,
    team: `${((order - 1) % 8) + 1}조`,
    teamOrder: order,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  };
}

function third(
  id: number,
  team: string,
  extra?: Partial<AutoAssignCaddy>
): AutoAssignCaddy {
  return {
    id,
    name: extra?.name || `T${id}`,
    team,
    teamOrder: extra?.teamOrder ?? 1,
    caddyType: "THIRD",
    employmentStatus: "ACTIVE",
    ...extra,
  };
}

function support(
  id: number,
  name: string,
  kind: string,
  pattern: string,
  inputOrder: number
): AutoAssignCaddy {
  return {
    id,
    name,
    team: "7조",
    teamOrder: 1,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
    supportKind: kind,
    supportWorkPattern: pattern,
    inputOrder,
  };
}

function sortedShift(
  result: ReturnType<typeof computeAutoAssignmentsV1>,
  shift: "1부" | "2부" | "3부"
) {
  return result.assignments
    .filter((a) => a.shift === shift)
    .sort((a, b) => compareReservationOrder(a.reservation, b.reservation));
}

function pairIdsFor(
  result: ReturnType<typeof computeAutoAssignmentsV1>,
  prefix: string
) {
  const map = new Map<string, number[]>();
  for (const row of result.assignments) {
    const id = String(row.pairId || "");
    if (!id.startsWith(prefix)) continue;
    const list = map.get(id) || [];
    list.push(row.caddy.id);
    map.set(id, list);
  }
  return [...map.entries()].map(([pairId, ids]) => ({
    pairId,
    ids: [...new Set(ids)],
  }));
}

section("1부 AUTO: 특수/지원이 일반 HOUSE보다 앞");
{
  const date = "2026-09-16";
  const late = support(201, "후출", "MARSHAL_SUPPORT", "SHIFT_1", 1);
  const fifty: AutoAssignCaddy = {
    id: 301,
    name: "54홀",
    team: "2조",
    teamOrder: 1,
    caddyType: "HOUSE",
    inputOrder: 1,
  };
  const oneTwo: AutoAssignCaddy = {
    id: 401,
    name: "일이",
    team: "3조",
    teamOrder: 1,
    caddyType: "HOUSE",
    inputOrder: 1,
  };
  const oneThree: AutoAssignCaddy = {
    id: 501,
    name: "일삼",
    team: "4조",
    teamOrder: 1,
    caddyType: "HOUSE",
    inputOrder: 1,
  };
  const oneMak: AutoAssignCaddy = {
    id: 601,
    name: "1막",
    team: "5조",
    teamOrder: 1,
    caddyType: "HOUSE",
    inputOrder: 1,
  };
  const spec = support(701, "특지", "SPECIAL_SUPPORT", "SHIFT_1", 1);
  const sup12 = support(801, "원이투", "SPECIAL_SUPPORT", "ONE_TWO", 1);
  const result = computeAutoAssignmentsV1({
    date,
    available: Array.from({ length: 24 }, (_, i) => house(i + 1, i + 1)),
    fiftyFourHole: [fifty],
    oneTwoCandidates: [oneTwo],
    oneThreeCandidates: [oneThree],
    oneMakCandidates: [oneMak],
    placementMode: "AUTO",
    protectedTailCount: 4,
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "1부": [late, spec],
    },
    oneTwoSupport: [sup12],
    reservations: [
      ...board(date, "1부", 20, "05:00"),
      ...board(date, "2부", 12, "12:00"),
      ...board(date, "3부", 12, "16:00"),
    ],
  });
  const s1 = sortedShift(result, "1부");
  const kinds = s1.map((a) => a.kind);
  const houseIdx = kinds.findIndex((k) => k === "regular");
  const lastSpecial = Math.max(
    kinds.lastIndexOf("specialSupport"),
    kinds.lastIndexOf("fiftyFourHole"),
    kinds.lastIndexOf("oneTwo"),
    kinds.lastIndexOf("oneThree"),
    kinds.lastIndexOf("oneMak")
  );
  const firstHouseAfterProtect = kinds
    .map((k, i) => ({ k, i }))
    .filter((row) => row.k === "regular" && row.i >= 2)
    .map((row) => row.i)[0];
  assert(s1[0]?.kind === "regular" && s1[1]?.kind === "regular", "보호1·2 regular");
  assert(
    s1[2]?.kind === "specialSupport" &&
      s1[2]?.caddy.id === 201 &&
      s1[2]?.supportKind === "MARSHAL_SUPPORT",
    "3번째 후출마샬"
  );
  assert(s1[2]?.kind !== "oneMak", "후출마샬은 1막이 아님");
  assert(s1[3]?.kind === "fiftyFourHole" && s1[3]?.caddy.id === 301, "4번째 54홀");
  assert(s1[4]?.kind === "oneTwo" && s1[4]?.caddy.id === 401, "5번째 1·2");
  assert(s1[5]?.kind === "oneThree" && s1[5]?.caddy.id === 501, "6번째 1·3");
  assert(s1[6]?.kind === "oneMak" && s1[6]?.caddy.id === 601, "7번째 1막");
  const specIdx = s1.findIndex((a) => a.caddy.id === 701);
  const supIdx = s1.findIndex((a) => a.caddy.id === 801);
  assert(specIdx === 7 && s1[specIdx]?.kind === "specialSupport", "8번째 일반 특수지원");
  assert(
    supIdx === 8 &&
      s1[supIdx]?.pairId === oneTwoSupportPairId(801) &&
      s1[supIdx]?.supportWorkPattern === "ONE_TWO",
    "9번째 ONE_TWO 지원 SUP12"
  );
  assert(
    firstHouseAfterProtect === 9 && lastSpecial === 8,
    `모든 특수/지원이 일반 HOUSE보다 앞 (${firstHouseAfterProtect},${lastSpecial})`
  );
  assert(houseIdx === 0, "보호 regular가 맨 앞");
  const s2 = sortedShift(result, "2부");
  const oneTwo2 = s2.find((a) => a.caddy.id === 401);
  const sup122 = s2.find((a) => a.caddy.id === 801);
  assert(oneTwo2?.pairId === "12-401", "1·2 2부 pair 12-*");
  assert(sup122?.pairId === oneTwoSupportPairId(801), "ONE_TWO 2부 SUP12 유지");
  assert(sup122?.caddy.id === 801 && oneTwo2?.caddy.id === 401, "linked caddyId 동일");
  assert(
    s1.find((a) => a.caddy.id === 801)?.caddy.id === sup122?.caddy.id,
    "ONE_TWO 1부/2부 같은 캐디"
  );
}

section("3부 평일: 1·3 → WEEKDAY → 휴무지원 → THIRD → 2·3 → 찾근 → HOUSE");
{
  const date = "2026-09-16";
  const oneThree: AutoAssignCaddy = {
    id: 51,
    name: "일삼",
    team: "1조",
    teamOrder: 1,
    caddyType: "HOUSE",
    inputOrder: 1,
  };
  const twoThree: AutoAssignCaddy = {
    id: 52,
    name: "이삼",
    team: "2조",
    teamOrder: 1,
    caddyType: "HOUSE",
    inputOrder: 1,
  };
  const weekday = third(1010, "10조", {
    name: "주중",
    thirdBandSubgroup: "WEEKDAY",
  });
  const regularThird = third(1011, "11조", { name: "원번" });
  const off = support(91, "휴지", "OFF_SUPPORT", "SHIFT_3", 1);
  const chageun: AutoAssignCaddy = {
    id: 61,
    name: "찾근",
    team: "6조",
    teamOrder: 1,
    caddyType: "HOUSE",
  };
  const houses = Array.from({ length: 16 }, (_, i) => house(i + 1, i + 1));
  const result = computeAutoAssignmentsV1({
    date,
    available: [...houses, weekday, regularThird, oneThree, twoThree, chageun],
    oneThreeCandidates: [oneThree],
    twoThreeCandidates: [twoThree],
    placementMode: "AUTO",
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "3부": [off],
    },
    reservations: [
      ...board(date, "1부", 14, "05:00"),
      ...board(date, "2부", 14, "12:00"),
      ...board(date, "3부", 10, "16:00"),
    ],
    fixedAssignments: [
      {
        caddyId: 61,
        type: "SPECIAL_CALL",
        reservationMatch: {
          date,
          course: "VERTHILL",
          shift: "3부",
          teeTime: "16:08",
        },
      },
    ],
  });
  const s3 = sortedShift(result, "3부");
  const names = s3.map((a) => a.caddy.name);
  const idx = (name: string) => names.indexOf(name);
  assert(idx("일삼") >= 0 && idx("주중") > idx("일삼"), "1·3 다음 주중반");
  assert(
    String(s3[idx("주중")]?.reason || "").startsWith("WEEKDAY_BAND_PRIORITY"),
    "평일 WEEKDAY dedicated band"
  );
  assert(idx("휴지") > idx("주중"), "주중반 다음 휴무지원");
  assert(idx("원번") > idx("휴지"), "휴무지원 다음 3부반 원번");
  assert(idx("이삼") > idx("원번"), "원번 다음 2·3");
  assert(idx("찾근") > idx("이삼"), "2·3 다음 찾근");
  const houseAfter = s3.findIndex(
    (a, i) => i > idx("찾근") && a.caddy.caddyType === "HOUSE" && a.kind === "regular"
  );
  assert(houseAfter > idx("찾근"), "찾근 다음 HOUSE");
  assert(
    s3[idx("휴지")]?.kind === "specialSupport" &&
      s3[idx("휴지")]?.supportKind === "OFF_SUPPORT",
    "휴무지원 kind 유지"
  );
  assert(s3[idx("일삼")]?.pairId === "13-51", "13-* pair");
  assert(s3[idx("이삼")]?.pairId === "23-52", "23-* pair");
}

section("3부 주말: 1·3 → WEEKEND → 휴무지원 → THIRD → 2·3 → 찾근 → HOUSE");
{
  const date = "2026-09-19";
  const oneThree: AutoAssignCaddy = {
    id: 51,
    name: "일삼",
    team: "1조",
    teamOrder: 1,
    caddyType: "HOUSE",
    inputOrder: 1,
  };
  const twoThree: AutoAssignCaddy = {
    id: 52,
    name: "이삼",
    team: "2조",
    teamOrder: 1,
    caddyType: "HOUSE",
    inputOrder: 1,
  };
  const weekend = third(1012, "12조", {
    name: "주말",
    thirdBandSubgroup: "WEEKEND",
  });
  const regularThird = third(1011, "11조", { name: "원번" });
  const weekday = third(1010, "10조", {
    name: "주중",
    thirdBandSubgroup: "WEEKDAY",
  });
  const off = support(91, "휴지", "OFF_SUPPORT", "SHIFT_3", 1);
  const chageun: AutoAssignCaddy = {
    id: 61,
    name: "찾근",
    team: "6조",
    teamOrder: 1,
    caddyType: "HOUSE",
  };
  const houses = Array.from({ length: 16 }, (_, i) => house(i + 1, i + 1));
  const result = computeAutoAssignmentsV1({
    date,
    available: [...houses, weekend, weekday, regularThird, oneThree, twoThree, chageun],
    oneThreeCandidates: [oneThree],
    twoThreeCandidates: [twoThree],
    placementMode: "AUTO",
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "3부": [off],
    },
    reservations: [
      ...board(date, "1부", 14, "05:00"),
      ...board(date, "2부", 14, "12:00"),
      ...board(date, "3부", 10, "16:00"),
    ],
    fixedAssignments: [
      {
        caddyId: 61,
        type: "SPECIAL_CALL",
        reservationMatch: {
          date,
          course: "VERTHILL",
          shift: "3부",
          teeTime: "16:08",
        },
      },
    ],
  });
  const s3 = sortedShift(result, "3부");
  const names = s3.map((a) => a.caddy.name);
  const idx = (name: string) => names.indexOf(name);
  assert(idx("일삼") >= 0 && idx("주말") > idx("일삼"), "1·3 다음 주말반");
  assert(idx("휴지") > idx("주말"), "주말반 다음 휴무지원");
  assert(idx("주중") > idx("휴지"), "주말 WEEKDAY는 휴무지원 다음 regular THIRD");
  assert(
    !String(s3[idx("주중")]?.reason || "").startsWith("WEEKDAY_BAND_PRIORITY"),
    "주말에 WEEKDAY band 없음"
  );
  assert(idx("원번") > idx("휴지"), "휴무지원 다음 원번");
  assert(idx("이삼") > idx("원번"), "원번 다음 2·3");
  assert(idx("찾근") > idx("이삼"), "2·3 다음 찾근");
  assert(result.weekendBandAssignments.some((a) => a.caddy.name === "주말"), "WEEKEND band");
  assert(
    !result.weekendBandAssignments.some((a) => a.caddy.name === "주중"),
    "주말 WEEKDAY는 주말반이 아님"
  );
}

section("Mode A: spare HOUSE prefix 유지");
{
  const date = "2026-09-16";
  const weekday = third(1010, "10조", {
    name: "주중",
    thirdBandSubgroup: "WEEKDAY",
  });
  const oneThree: AutoAssignCaddy = {
    id: 51,
    name: "일삼",
    team: "8조",
    teamOrder: 1,
    caddyType: "HOUSE",
    inputOrder: 1,
  };
  const result = computeAutoAssignmentsV1({
    date,
    available: [
      ...Array.from({ length: 12 }, (_, i) => house(i + 1, i + 1)),
      weekday,
      third(1011, "11조", { name: "원번" }),
      oneThree,
    ],
    oneThreeCandidates: [oneThree],
    placementMode: "AUTO",
    protectedTailCount: 2,
    reservations: [
      ...board(date, "1부", 6, "05:00"),
      ...board(date, "2부", 2, "12:00"),
      ...board(date, "3부", 8, "16:00"),
    ],
  });
  const s3 = sortedShift(result, "3부");
  const spare = result.sparesByShift.find((s) => s.shift === "2부");
  assert(!!spare?.spare1 && !!spare.spare2, "2부 spare 존재");
  assert(
    s3[0]?.caddy.id === spare!.spare1!.caddyId &&
      s3[1]?.caddy.id === spare!.spare2!.caddyId,
    "Mode A 3부 앞이 2부 spare HOUSE"
  );
  assert(s3[2]?.caddy.id === 51, "spare 다음 1·3");
  assert(s3[3]?.caddy.name === "주중", "1·3 다음 주중반");
  assert(
    String(s3[3]?.reason || "").startsWith("WEEKDAY_BAND_PRIORITY"),
    "Mode A 본체도 WEEKDAY band"
  );
}

section("linked 5종 caddyId 일치");
{
  const date = "2026-09-16";
  const fifty: AutoAssignCaddy = {
    id: 301,
    name: "54홀",
    team: "2조",
    teamOrder: 1,
    inputOrder: 1,
  };
  const oneTwo: AutoAssignCaddy = {
    id: 401,
    name: "일이",
    team: "3조",
    teamOrder: 1,
    inputOrder: 1,
  };
  const oneThree: AutoAssignCaddy = {
    id: 501,
    name: "일삼",
    team: "4조",
    teamOrder: 1,
    inputOrder: 1,
  };
  const twoThree: AutoAssignCaddy = {
    id: 521,
    name: "이삼",
    team: "5조",
    teamOrder: 1,
    inputOrder: 1,
  };
  const sup12 = support(801, "원이투", "SPECIAL_SUPPORT", "ONE_TWO", 1);
  const result = computeAutoAssignmentsV1({
    date,
    available: Array.from({ length: 20 }, (_, i) => house(i + 1, i + 1)),
    fiftyFourHole: [fifty],
    oneTwoCandidates: [oneTwo],
    oneThreeCandidates: [oneThree],
    twoThreeCandidates: [twoThree],
    placementMode: "AUTO",
    oneTwoSupport: [sup12],
    reservations: [
      ...board(date, "1부", 12, "05:00"),
      ...board(date, "2부", 12, "12:00"),
      ...board(date, "3부", 12, "16:00"),
    ],
  });
  for (const prefix of ["12-", "23-", "13-", "54H-", "SUP12-"]) {
    const pairs = pairIdsFor(result, prefix);
    assert(pairs.length >= 1, `${prefix} pair 존재`);
    assert(
      pairs.every((p) => p.ids.length === 1),
      `${prefix} 같은 pair의 caddyId 1명`
    );
  }
}

section("지원근무 회귀: 조출/조장 2부 막, 찾근 2부, 휴무 kind");
{
  const date = "2026-09-16";
  const twoThree: AutoAssignCaddy = {
    id: 52,
    name: "이삼",
    team: "5조",
    teamOrder: 1,
    caddyType: "HOUSE",
    inputOrder: 1,
  };
  const chageun: AutoAssignCaddy = {
    id: 61,
    name: "찾근2",
    team: "6조",
    teamOrder: 1,
    caddyType: "HOUSE",
  };
  const early = support(41, "조출", "MARSHAL_SUPPORT", "SHIFT_2", 1);
  const leader = support(42, "조장", "LEADER_SUPPORT", "SHIFT_2", 2);
  const off = support(91, "휴지", "OFF_SUPPORT", "SHIFT_3", 1);
  const houses = Array.from({ length: 12 }, (_, i) => house(i + 1, i + 1));
  const reservations = [
    ...board(date, "1부", 8, "05:00"),
    ...board(date, "2부", 10, "12:00"),
    ...board(date, "3부", 8, "16:00"),
  ];
  const late2 = reservations.filter((r) => r.shift === "2부").at(-1)!;
  const result = computeAutoAssignmentsV1({
    date,
    available: [...houses, twoThree, chageun],
    twoThreeCandidates: [twoThree],
    placementMode: "AUTO",
    specialSupportByShift: {
      ...emptySpecialSupportByShift(),
      "2부": [early, leader],
      "3부": [off],
    },
    reservations,
    fixedAssignments: [
      {
        caddyId: 61,
        type: "SPECIAL_CALL",
        reservationMatch: {
          date,
          course: late2.course,
          shift: "2부",
          teeTime: late2.teeTime,
        },
      },
    ],
  });
  const s2 = sortedShift(result, "2부");
  assert(s2[0]?.kind === "regular" && s2[1]?.kind === "regular", "2부 보호 유지");
  assert(
    s2[2]?.caddy.id === 61 && s2[2]?.reason === "SPECIAL_CALL",
    "2부 찾근은 보호 다음"
  );
  assert(s2[2]?.reservation.teeTime !== late2.teeTime, "2부 찾근은 지정 예약을 쓰지 않음");
  const twoThreeIdx = s2.findIndex((a) => a.kind === "twoThree");
  assert(twoThreeIdx === 3, "2·3은 찾근 다음");
  assert(s2[twoThreeIdx]?.pairId === "23-52", "23-* pair 유지");
  assert(s2.at(-2)?.caddy.id === 41 && s2.at(-1)?.caddy.id === 42, "조출·조장 2부 막");
  assert(
    s2.at(-2)?.supportKind === "MARSHAL_SUPPORT" &&
      s2.at(-1)?.supportKind === "LEADER_SUPPORT",
    "조출 마샬 / 조장 kind 유지"
  );
  const s3 = sortedShift(result, "3부");
  const offRow = s3.find((a) => a.caddy.id === 91);
  assert(
    offRow?.kind === "specialSupport" && offRow.supportKind === "OFF_SUPPORT",
    "휴무지원을 SPECIAL_SUPPORT로 변환하지 않음"
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
