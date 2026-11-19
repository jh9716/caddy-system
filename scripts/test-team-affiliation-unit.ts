/**
 * 조별 HOUSE/THIRD 설정 — DB 없는 단위 테스트
 * 실행: npx tsx scripts/test-team-affiliation-unit.ts
 *
 * 운영 명단·재직상태·확정 배치표는 이 테스트가 바꾸지 않는다.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  previewLiveAssignmentChange,
  previewLiveAssignmentEvents,
} from "../src/lib/assignmentChange";
import {
  autoResultFromDraft,
  createDraftFromAutoResult,
} from "../src/lib/assignmentDraft";
import {
  assignmentDraftToPayload,
  parseDailyBoardDraftPayload,
  payloadToAssignmentDraft,
} from "../src/lib/dailyBoardDraft";
import {
  computeAutoAssignmentsV1,
  isHouseStartCandidate,
  reservationKey,
  splitCaddyPools,
  ThirdStartCaddyError,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "../src/lib/autoAssignEngine";
import { computeAvailability } from "../src/lib/availabilityEngine";
import { planCaddyReassign, type ReassignCaddyRow } from "../src/lib/caddyReassign";
import { resolveCaddyTypeFromTeam } from "../src/lib/caddyManage";
import {
  automaticThirdStartTeam,
  effectiveThirdStartTeam,
  rotateThirdTeamsFromStart,
  THIRD_WEEKLY_CYCLE,
} from "../src/lib/thirdWeeklyRotation";
import {
  DEFAULT_TEAM_AFFILIATION_SNAPSHOT,
  TEAM_AFFILIATION_CHANGED_CODE,
  TEAM_AFFILIATION_TEAMS,
  defaultTeamAffiliationSnapshot,
  houseTenThirdOffSnapshot,
  isMissingTeamAffiliationTableError,
  houseTeamsInSnapshot,
  inactiveTeamsInSnapshot,
  isHouseAffiliatedTeam,
  isInactiveTeamCaddy,
  isThirdAffiliatedTeam,
  parseTeamAffiliationSnapshot,
  parseTeamAffiliationVersionInput,
  pickLatestAffiliationVersion,
  resolveAssignCaddyType,
  resolveReflowTeamAffiliation,
  rosterBandSpans,
  sameTeamAffiliationRules,
  snapshotFromRows,
  teamAffiliationUtcDate,
  teamAffiliationYmdFromDate,
  teamsWithAffiliation,
  thirdTeamsInSnapshot,
  type TeamAffiliationSnapshot,
} from "../src/lib/teamAffiliation";
import { buildRosterColumns } from "../src/lib/caddyRosterBoard";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed += 1;
    console.log("  ✓", msg);
  } else {
    failed += 1;
    console.error("  ✗", msg);
  }
}

function section(title: string) {
  console.log("\n==", title, "==");
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
    caddyType: extra?.caddyType,
    employmentStatus: extra?.employmentStatus ?? "ACTIVE",
    thirdBandSubgroup: extra?.thirdBandSubgroup ?? null,
    extraFlags: extra?.extraFlags,
  };
}

function reservations(
  date: string,
  specs: Array<{ shift: "1부" | "2부" | "3부"; count: number }>
): AutoAssignReservation[] {
  const out: AutoAssignReservation[] = [];
  let row = 2;
  for (const spec of specs) {
    for (let i = 0; i < spec.count; i++) {
      const total = 6 * 60 + i * 7;
      const h = String(Math.floor(total / 60)).padStart(2, "0");
      const m = String(total % 60).padStart(2, "0");
      out.push({
        date,
        course: "VERTHILL",
        courseLabel: "베르힐",
        shift: spec.shift,
        teeTime: `${h}:${m}`,
        teamName: `${spec.shift}-${i + 1}`,
        rawRowIndex: row++,
      });
    }
  }
  return out;
}

function thirdNineTenSnapshot(date = "2026-12-20"): TeamAffiliationSnapshot {
  return snapshotFromRows(
    date,
    TEAM_AFFILIATION_TEAMS.map((team) => {
      const n = Number(team.replace("조", ""));
      return {
        team,
        affiliation: n >= 9 ? ("THIRD" as const) : ("HOUSE" as const),
        operational: n <= 10,
      };
    }),
    { effectiveFrom: date, source: "version", versionId: 2 }
  );
}

section("1. 기본 1~8 HOUSE, 9~12 THIRD, 전원 운영");
{
  const snap = defaultTeamAffiliationSnapshot("2026-11-15");
  assert(snap.source === "default", "설정 없으면 default");
  assert(
    houseTeamsInSnapshot(snap).join(",") === "1조,2조,3조,4조,5조,6조,7조,8조",
    "1~8 HOUSE"
  );
  assert(
    thirdTeamsInSnapshot(snap).join(",") === "9조,10조,11조,12조",
    "9~12 THIRD"
  );
  assert(inactiveTeamsInSnapshot(snap).length === 0, "전원 운영");
  assert(resolveCaddyTypeFromTeam("9조") === "THIRD", "기본 9조 THIRD");
  assert(
    resolveAssignCaddyType({ team: "9조", caddyType: "HOUSE" }) === "THIRD",
    "조 번호가 아니라 default 스냅샷 소속"
  );
}

section("2·3. 1~10 HOUSE, 11~12 미운영");
{
  const snap = houseTenThirdOffSnapshot("2026-11-16");
  assert(
    houseTeamsInSnapshot(snap).join(",") ===
      "1조,2조,3조,4조,5조,6조,7조,8조,9조,10조",
    "1~10 HOUSE 운영"
  );
  assert(thirdTeamsInSnapshot(snap).length === 0, "운영 THIRD 없음");
  assert(
    inactiveTeamsInSnapshot(snap).join(",") === "11조,12조",
    "11~12 미운영"
  );
  assert(isHouseAffiliatedTeam("9조", snap), "9조 HOUSE");
  assert(isHouseAffiliatedTeam("10조", snap), "10조 HOUSE");
  assert(!isThirdAffiliatedTeam("9조", snap), "9조가 조 번호로 THIRD 되지 않음");
  assert(
    resolveAssignCaddyType({
      team: "9조",
      caddyType: "THIRD",
      snapshot: snap,
    }) === "HOUSE",
    "stale caddyType THIRD여도 9조 HOUSE"
  );
  assert(
    isInactiveTeamCaddy({ team: "11조", caddyType: "THIRD", snapshot: snap }),
    "11조 미운영"
  );
  const bands = rosterBandSpans(snap);
  assert(
    bands.some((b) => b.band === "HOUSE" && b.teams.includes("9조")),
    "현장표 밴드가 9조를 하우스에 넣음"
  );
  assert(
    bands.some((b) => b.band === "INACTIVE" && b.teams.join(",") === "11조,12조"),
    "미운영 밴드 11~12"
  );
}

section("4·5. 9조 HOUSE 1부, 10조 HOUSE 2부 자동배치");
{
  const date = "2026-11-16";
  const snap = houseTenThirdOffSnapshot(date);
  const available = [
    caddy(901, "9조", 1, { caddyType: "THIRD", name: "구삼" }),
    caddy(1001, "10조", 1, { caddyType: "THIRD", name: "십조" }),
    caddy(101, "1조", 1, { caddyType: "HOUSE", name: "일조" }),
    caddy(1101, "11조", 1, { caddyType: "THIRD", name: "십일" }),
    caddy(1201, "12조", 1, { caddyType: "THIRD", name: "십이" }),
    caddy(801, "드라이빙", 0, { caddyType: "DRIVING", name: "드라이브" }),
  ];
  assert(isHouseStartCandidate(available[0], snap), "9조가 1부 첫 캐디 후보");
  assert(isHouseStartCandidate(available[1], snap), "10조가 HOUSE 시작 후보");
  const pools = splitCaddyPools(available, snap);
  assert(
    pools.house.map((c) => c.id).join(",") === "101,901,1001",
    "HOUSE 풀에 1·9·10조"
  );
  assert(pools.third.length === 0, "THIRD 풀 비움");
  assert(pools.driving.map((c) => c.id).join(",") === "801", "DRIVING 독립");
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations: reservations(date, [
      { shift: "1부", count: 1 },
      { shift: "2부", count: 1 },
    ]),
    houseStartCaddyId: 901,
    teamAffiliation: snap,
  });
  const s1 = result.regularAssignments.filter((a) => a.shift === "1부");
  const s2 = result.regularAssignments.filter((a) => a.shift === "2부");
  assert(s1.length === 1 && s1[0].caddy.id === 901, "9조 HOUSE가 1부");
  assert(s2.length === 1 && s2[0].caddy.id === 1001, "10조 HOUSE가 2부");
  assert(
    !result.assignments.some((a) => a.caddy.id === 1101 || a.caddy.id === 1201),
    "미운영 11·12조 신규 배치 제외"
  );
  assert(
    !result.assignments.some((a) => a.caddy.id === 801),
    "DRIVING은 일반 순번 제외"
  );
  assert(result.sparesByShift.length >= 1, "스페어 계산 유지");
  assert(result.meta.teamAffiliation?.effectiveFrom === date, "meta에 스냅샷 보존");
}

section("6. 9~12조 THIRD 복귀");
{
  const snap = DEFAULT_TEAM_AFFILIATION_SNAPSHOT;
  const available = [
    caddy(1, "1조", 1, { caddyType: "HOUSE" }),
    caddy(9, "9조", 1, { caddyType: "HOUSE" }),
    caddy(12, "12조", 1, { caddyType: "HOUSE" }),
  ];
  const pools = splitCaddyPools(available, snap);
  assert(pools.house.map((c) => c.id).join(",") === "1", "1조만 HOUSE");
  assert(
    pools.third.map((c) => c.id).join(",") === "9,12",
    "stale HOUSE 태그여도 9·12는 THIRD"
  );
}

section("7. 3부반 주간 순환 + 미운영 skip");
{
  assert(THIRD_WEEKLY_CYCLE.join(",") === "12조,9조,10조,11조", "순환 12→9→10→11");
  assert(
    rotateThirdTeamsFromStart("12조").join(",") === "12조,9조,10조,11조",
    "기본 12스타트 순환"
  );
  const skip = thirdNineTenSnapshot();
  assert(
    rotateThirdTeamsFromStart("12조", skip).join(",") === "9조,10조",
    "미운영 11·12와 HOUSE가 된 조는 순환에서 제외"
  );
  assert(
    effectiveThirdStartTeam("2026-08-17", null, skip) === "9조",
    "앵커주 12조가 미운영이면 다음 운영 THIRD"
  );
  assert(automaticThirdStartTeam("2026-08-17") === "12조", "자동값 자체는 보존");
}

section("8. 휴직·퇴사자 배치 제외 유지");
{
  const date = "2026-11-16";
  const snap = houseTenThirdOffSnapshot(date);
  const available = [
    caddy(901, "9조", 1, { caddyType: "THIRD" }),
    caddy(902, "9조", 2, {
      caddyType: "THIRD",
      employmentStatus: "LEAVE",
      name: "휴직",
    }),
    caddy(903, "9조", 3, {
      caddyType: "THIRD",
      employmentStatus: "RETIRED",
      name: "퇴사",
    }),
    caddy(101, "1조", 1, { caddyType: "HOUSE" }),
  ];
  const avail = computeAvailability({
    date,
    caddies: available.map((c) => ({
      id: c.id,
      name: c.name,
      team: c.team,
      teamOrder: c.teamOrder,
      employmentStatus: String(c.employmentStatus),
      caddyType: c.caddyType ?? null,
    })),
    teamAffiliation: snap,
  });
  assert(
    avail.available.all.some((r) => r.id === 901) &&
      avail.available.byType.HOUSE.some((r) => r.id === 901),
    "재직 9조 HOUSE 가용"
  );
  assert(
    avail.excluded.some(
      (r) => r.id === 902 && r.excludedReasons.includes("휴직(LEAVE)")
    ),
    "휴직 제외"
  );
  assert(
    avail.excluded.some(
      (r) => r.id === 903 && r.excludedReasons.includes("퇴사(RETIRED)")
    ),
    "퇴사 제외"
  );
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations: reservations(date, [{ shift: "1부", count: 4 }]),
    houseStartCaddyId: 901,
    teamAffiliation: snap,
    employmentAuthority: available.map((c) => ({
      id: c.id,
      employmentStatus: c.employmentStatus,
    })),
  });
  assert(
    !result.assignments.some((a) => a.caddy.id === 902 || a.caddy.id === 903),
    "엔진도 LEAVE/RETIRED 배치 안 함"
  );
}

section("3부 첫 캐디 검증");
{
  const date = "2026-11-16";
  const snap = houseTenThirdOffSnapshot(date);
  let houseAsThird = false;
  try {
    computeAutoAssignmentsV1({
      date,
      available: [
        caddy(901, "9조", 1, { caddyType: "THIRD" }),
        caddy(101, "1조", 1, { caddyType: "HOUSE" }),
      ],
      reservations: reservations(date, [{ shift: "3부", count: 1 }]),
      thirdStartCaddyId: 901,
      teamAffiliation: snap,
    });
  } catch (e) {
    houseAsThird = e instanceof ThirdStartCaddyError;
  }
  assert(houseAsThird, "HOUSE가 된 9조는 3부 첫 캐디 불가");
  const ok = computeAutoAssignmentsV1({
    date: "2026-08-17",
    available: [
      caddy(1, "1조", 1, { caddyType: "HOUSE" }),
      caddy(9, "9조", 1, { caddyType: "THIRD" }),
    ],
    reservations: reservations("2026-08-17", [
      { shift: "1부", count: 1 },
      { shift: "3부", count: 1 },
    ]),
    houseStartCaddyId: 1,
    thirdStartCaddyId: 9,
    teamAffiliation: DEFAULT_TEAM_AFFILIATION_SNAPSHOT,
  });
  const s3 = ok.regularAssignments.filter((a) => a.shift === "3부");
  assert(
    s3[0]?.caddy.id === 9,
    "default에서 9조 THIRD 첫 캐디 검증 통과"
  );
}

section("9. 특수근무 passthrough + 지원근무 회귀 없음");
{
  const date = "2026-11-16";
  const snap = houseTenThirdOffSnapshot(date);
  const special = [caddy(501, "1조", 2, { name: "특수" })];
  const result = computeAutoAssignmentsV1({
    date,
    available: [caddy(101, "1조", 1), caddy(901, "9조", 1, { caddyType: "THIRD" })],
    special,
    reservations: reservations(date, [{ shift: "1부", count: 1 }]),
    houseStartCaddyId: 101,
    teamAffiliation: snap,
  });
  assert(
    result.special.length === 1 && result.special[0].id === 501,
    "특수근무 목록 보존"
  );
  assert(
    result.assignments.every((a) => a.caddy.id !== 501),
    "특수근무 캐디는 일반 순번 제외"
  );
}

section("10. 과거 날짜는 당시 스냅샷, 확정표 코드는 조 설정을 쓰지 않음");
{
  const versions = [
    { effectiveFrom: "2026-11-16", id: 2 },
    { effectiveFrom: "2027-03-01", id: 3 },
  ];
  assert(
    pickLatestAffiliationVersion(versions, "2026-11-15") === null,
    "적용일 전은 default"
  );
  assert(
    pickLatestAffiliationVersion(versions, "2026-11-16")?.id === 2,
    "당일 버전"
  );
  assert(
    pickLatestAffiliationVersion(versions, "2026-12-20")?.id === 2,
    "다음 버전 전까지 유지"
  );
  assert(
    pickLatestAffiliationVersion(versions, "2027-03-01")?.id === 3,
    "다음 적용일부터 새 버전"
  );
  const serviceSrc = fs.readFileSync(
    path.resolve("src/lib/teamAffiliationService.ts"),
    "utf8"
  );
  const apiSrc = fs.readFileSync(
    path.resolve("src/app/api/team-affiliations/route.ts"),
    "utf8"
  );
  assert(
    !/prisma\.caddy\./i.test(serviceSrc) &&
      !/DailyBoardPublished/.test(serviceSrc) &&
      /caddyRowsUnchanged: true/.test(serviceSrc),
    "조 설정 저장이 Caddy/확정표를 쓰지 않음"
  );
  assert(
    /publishedBoardsUnchanged: true/.test(apiSrc),
    "API가 확정표 불변을 명시"
  );
}

section("11. 조 설정 변경 전후 순번 충돌 방지");
{
  const snap = houseTenThirdOffSnapshot("2026-11-16");
  const rows: ReassignCaddyRow[] = [
    {
      id: 1,
      name: "A",
      team: "9조",
      teamOrder: 1,
      employmentStatus: "ACTIVE",
      caddyType: "THIRD",
      thirdBandSubgroup: null,
    },
    {
      id: 2,
      name: "B",
      team: "10조",
      teamOrder: 1,
      employmentStatus: "ACTIVE",
      caddyType: "THIRD",
      thirdBandSubgroup: null,
    },
  ];
  const conflict = planCaddyReassign(
    rows,
    [{ id: 2, team: "9조", teamOrder: 1 }],
    { teamAffiliation: snap }
  );
  assert(!conflict.ok, "같은 조·순번 점유는 거부");
  assert(
    conflict.issues.some((i) => i.code === "slot_conflict"),
    "slot_conflict"
  );
  const ok = planCaddyReassign(
    rows,
    [{ id: 2, team: "9조", teamOrder: 2 }],
    { teamAffiliation: snap }
  );
  assert(ok.ok, "빈 순번은 허용");
  assert(ok.changes[0]?.to.caddyType === "HOUSE", "9조 이동 시 HOUSE canonical");
  assert(ok.changes[0]?.to.thirdBandSubgroup == null, "HOUSE면 주중/주말 해제");
}

section("가용인원 overlay + 현장표 컬럼");
{
  const snap = houseTenThirdOffSnapshot("2026-11-16");
  const avail = computeAvailability({
    date: "2026-11-16",
    caddies: [
      {
        id: 11,
        name: "미운영",
        team: "11조",
        teamOrder: 1,
        employmentStatus: "ACTIVE",
        caddyType: "THIRD",
      },
    ],
    teamAffiliation: snap,
  });
  assert(
    avail.excluded.some(
      (r) => r.id === 11 && r.excludedReasons.includes("미운영 조")
    ),
    "미운영 조 가용 제외"
  );
  const cols = buildRosterColumns({
    rows: [
      {
        id: 9,
        name: "구",
        team: "9조",
        teamOrder: 1,
        employmentStatus: "ACTIVE",
        caddyType: "THIRD",
      },
    ],
    teamAffiliation: snap,
  });
  assert(cols.find((c) => c.key === "9조")?.band === "HOUSE", "현장표 9조 HOUSE");
  assert(cols.find((c) => c.key === "11조")?.operational === false, "11조 미운영 표시");
}

section("입력 검증 + 개별 조 선택에는 미운영 조도 포함");
{
  let threw = false;
  try {
    parseTeamAffiliationVersionInput({ effectiveFrom: "2026-11-16", teams: [] });
  } catch {
    threw = true;
  }
  assert(threw, "12조 누락 거부");
  const parsed = parseTeamAffiliationVersionInput({
    effectiveFrom: "2026-11-16",
    teams: TEAM_AFFILIATION_TEAMS.map((team) => ({
      team,
      affiliation: Number(team.replace("조", "")) <= 10 ? "HOUSE" : "THIRD",
      operational: Number(team.replace("조", "")) <= 10,
    })),
  });
  assert(parsed.teams.length === 12, "12개 조 저장");
  const snap = houseTenThirdOffSnapshot("2026-11-16");
  assert(
    teamsWithAffiliation("HOUSE", snap).join(",").includes("11조"),
    "미운영 HOUSE 조도 개별 이동 대상"
  );
  assert(teamsWithAffiliation("THIRD", snap).length === 0, "THIRD 조 없음");
}

section("조회 실패를 테이블 미생성으로 오인하지 않음");
{
  function prismaErr(code: string, message: string) {
    const err = new Error(message) as Error & { code: string };
    err.code = code;
    return err;
  }
  assert(
    isMissingTeamAffiliationTableError(
      prismaErr(
        "P2021",
        "The table `public.TeamAffiliationVersion` does not exist in the current database."
      )
    ),
    "P2021 테이블 없음만 폴백"
  );
  assert(
    !isMissingTeamAffiliationTableError(
      prismaErr(
        "P2002",
        "Invalid `prisma.teamAffiliationVersion.create()` Unique constraint failed"
      )
    ),
    "unique 충돌은 기본값 폴백 금지"
  );
  assert(
    !isMissingTeamAffiliationTableError(
      prismaErr(
        "P2022",
        "The column `note` does not exist in the current database. TeamAffiliationVersion"
      )
    ),
    "컬럼 없음은 기본값 폴백 금지"
  );
  assert(
    !isMissingTeamAffiliationTableError(
      new Error('relation "Caddy" does not exist')
    ),
    "다른 테이블 없음은 조 설정 기본값으로 숨기지 않음"
  );
  assert(
    !isMissingTeamAffiliationTableError(new Error("Can't reach database server")),
    "연결 실패는 기본값 폴백 금지"
  );
}

section("소스: 엔진/API가 조 번호 하드코딩으로 9조를 THIRD 고정하지 않음");
{
  const engine = fs.readFileSync(
    path.resolve("src/lib/autoAssignEngine.ts"),
    "utf8"
  );
  const manage = fs.readFileSync(path.resolve("src/lib/caddyManage.ts"), "utf8");
  assert(
    /resolveAssignCaddyType/.test(engine) &&
      /teamAffiliation/.test(engine) &&
      /resolveReflowTeamAffiliation/.test(engine),
    "엔진이 스냅샷 소속을 사용"
  );
  assert(
    /snapshot\?: TeamAffiliationSnapshot/.test(manage) &&
      /resolveTeamAffiliation/.test(manage),
    "resolveCaddyTypeFromTeam이 스냅샷을 받음"
  );
}

section("reflow 경로: 9·10조 HOUSE 작업본은 live default에 덮이지 않음");
{
  const date = "2026-11-16";
  const snap = houseTenThirdOffSnapshot(date);
  const available = [
    caddy(101, "1조", 1, { caddyType: "HOUSE", name: "일조" }),
    caddy(901, "9조", 1, { caddyType: "THIRD", name: "구조" }),
    caddy(1001, "10조", 1, { caddyType: "THIRD", name: "십조" }),
  ];
  const previous = computeAutoAssignmentsV1({
    date,
    available,
    reservations: reservations(date, [
      { shift: "1부", count: 2 },
      { shift: "2부", count: 1 },
    ]),
    houseStartCaddyId: 101,
    teamAffiliation: snap,
  });
  assert(
    previous.assignments.some((a) => a.caddy.id === 901),
    "초기 배치에 9조 HOUSE"
  );
  assert(
    previous.assignments.some((a) => a.caddy.id === 1001),
    "초기 배치에 10조 HOUSE"
  );
  const target = previous.assignments.find((a) => a.caddy.id === 901)!;
  const moved = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: available,
    change: {
      type: "MOVE_RESERVATION",
      reservationKey: reservationKey(target.reservation),
      to: { course: "VERTHILL", shift: "2부", teeTime: "12:07" },
    },
    teamAffiliation: DEFAULT_TEAM_AFFILIATION_SNAPSHOT,
  });
  assert(
    moved.after.assignments.some((a) => a.caddy.id === 901),
    "MOVE/change가 9조를 THIRD로 되돌리지 않음"
  );
  assert(
    moved.warnings.some((w) => w.code === TEAM_AFFILIATION_CHANGED_CODE),
    "MOVE 경로가 설정 변경을 안내"
  );
  const cancelled = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: available,
    change: {
      type: "CANCEL_RESERVATION",
      reservationKey: reservationKey(target.reservation),
    },
    teamAffiliation: DEFAULT_TEAM_AFFILIATION_SNAPSHOT,
  });
  assert(
    cancelled.after.meta.housePoolCount === 3 &&
      cancelled.after.meta.thirdPoolCount === 0,
    "예약 취소 재계산도 9·10조 HOUSE 풀 유지"
  );
  assert(
    isHouseAffiliatedTeam("10조", cancelled.after.meta.teamAffiliation),
    "취소 후 meta 스냅샷도 10조 HOUSE"
  );
  const sick = previewLiveAssignmentEvents({
    previous,
    regularCaddyPool: available,
    events: [{ type: "REMOVE_CADDY", caddyId: 101, cause: "SICK" }],
    teamAffiliation: DEFAULT_TEAM_AFFILIATION_SNAPSHOT,
  });
  assert(
    sick.after.assignments.some((a) => a.caddy.id === 901),
    "SICK/REMOVE도 9조 HOUSE 유지"
  );
  assert(
    sick.warnings.some((w) => w.code === TEAM_AFFILIATION_CHANGED_CODE),
    "SICK 경로도 설정 변경 안내"
  );
  const sameLive = previewLiveAssignmentChange({
    previous,
    regularCaddyPool: available,
    change: {
      type: "CANCEL_RESERVATION",
      reservationKey: reservationKey(target.reservation),
    },
    teamAffiliation: snap,
  });
  assert(
    !sameLive.warnings.some((w) => w.code === TEAM_AFFILIATION_CHANGED_CODE),
    "같은 설정이면 충돌 경고 없음"
  );
}

section("Draft 재로드 후 reflow는 작업본 스냅샷을 씀");
{
  const date = "2026-11-16";
  const snap = houseTenThirdOffSnapshot(date);
  const available = [
    caddy(101, "1조", 1, { caddyType: "HOUSE" }),
    caddy(901, "9조", 1, { caddyType: "THIRD" }),
  ];
  const computed = computeAutoAssignmentsV1({
    date,
    available,
    reservations: reservations(date, [{ shift: "1부", count: 2 }]),
    houseStartCaddyId: 101,
    teamAffiliation: snap,
  });
  const draft = createDraftFromAutoResult(computed, available);
  assert(
    draft.teamAffiliation != null &&
      sameTeamAffiliationRules(draft.teamAffiliation, snap),
    "Draft에 조 설정 보존"
  );
  const payload = assignmentDraftToPayload(draft);
  const parsed = parseDailyBoardDraftPayload(payload, date);
  const reloaded = payloadToAssignmentDraft(parsed);
  assert(
    reloaded.teamAffiliation != null &&
      sameTeamAffiliationRules(reloaded.teamAffiliation, snap),
    "payload 재로드 후 조 설정 유지"
  );
  const previous = autoResultFromDraft(reloaded, null);
  const after = previewLiveChangeFromDraftSafe(reloaded, previous, available);
  assert(
    after.after.meta.housePoolCount === 2 &&
      after.after.meta.thirdPoolCount === 0,
    "재로드 Draft reflow가 9조 HOUSE 풀 유지"
  );
  assert(
    isHouseAffiliatedTeam("9조", after.after.meta.teamAffiliation),
    "재로드 후 meta도 작업본 스냅샷"
  );
}

section("같은 날짜 버전 충돌 해석");
{
  const bound = houseTenThirdOffSnapshot("2026-11-16");
  const live = DEFAULT_TEAM_AFFILIATION_SNAPSHOT;
  const kept = resolveReflowTeamAffiliation({ live, bound });
  assert(kept.conflict && kept.usedBound, "충돌 시 작업본 유지");
  assert(
    isHouseAffiliatedTeam("9조", kept.snapshot),
    "충돌 시 9조는 작업본 HOUSE"
  );
  const refreshed = resolveReflowTeamAffiliation({
    live,
    bound,
    acceptRefresh: true,
  });
  assert(
    refreshed.conflict && !refreshed.usedBound,
    "명시적 새로고침만 live 사용"
  );
  assert(
    isThirdAffiliatedTeam("9조", refreshed.snapshot),
    "새로고침 후 9조 THIRD"
  );
  const unbound = resolveReflowTeamAffiliation({ live: bound, bound: null });
  assert(!unbound.conflict && !unbound.usedBound, "구 Draft는 live 사용");
}

section("적용일 UTC 정규화 — TZ와 무관");
{
  const utc = teamAffiliationUtcDate("2026-11-16");
  assert(
    utc.toISOString() === "2026-11-16T00:00:00.000Z",
    "저장 시각은 UTC midnight"
  );
  assert(
    teamAffiliationYmdFromDate(utc) === "2026-11-16",
    "UTC Date → YYYY-MM-DD"
  );
  assert(
    teamAffiliationYmdFromDate("2026-11-16T15:30:00.000Z") === "2026-11-16",
    "같은 UTC 날짜는 유지"
  );
  assert(
    teamAffiliationYmdFromDate(new Date("2026-11-16T00:00:00+09:00")) ===
      "2026-11-15",
    "서울 local midnight는 UTC 날짜로 읽지 않음(저장 경로 금지 이유)"
  );
  assert(
    parseTeamAffiliationSnapshot(houseTenThirdOffSnapshot("2026-11-16")) !=
      null,
    "스냅샷 JSON 파싱"
  );
  for (const tz of ["UTC", "Asia/Seoul", "America/New_York"]) {
    const script = `
      const ymd = "2026-11-16";
      const d = new Date(ymd + "T00:00:00.000Z");
      const out =
        d.getUTCFullYear() +
        "-" +
        String(d.getUTCMonth() + 1).padStart(2, "0") +
        "-" +
        String(d.getUTCDate()).padStart(2, "0");
      if (d.toISOString() !== "2026-11-16T00:00:00.000Z") process.exit(2);
      if (out !== ymd) process.exit(3);
    `;
    const ran = spawnSync(process.execPath, ["-e", script], {
      env: { ...process.env, TZ: tz },
      encoding: "utf8",
    });
    assert(ran.status === 0, `TZ=${tz} 에서도 적용일 유지`);
  }
}

section("소스: reflow 전 경로가 live 조 설정을 넘김");
{
  const reflow = fs.readFileSync(
    path.resolve("src/app/api/assignments/reflow/route.ts"),
    "utf8"
  );
  const apply = fs.readFileSync(
    path.resolve("src/app/api/assignments/reflow/apply/route.ts"),
    "utf8"
  );
  const quick = fs.readFileSync(
    path.resolve("src/app/api/assignments/reflow/quick-mutation/route.ts"),
    "utf8"
  );
  const move = fs.readFileSync(
    path.resolve("src/app/api/assignments/reflow/quick-move/route.ts"),
    "utf8"
  );
  const change = fs.readFileSync(
    path.resolve("src/lib/assignmentChange.ts"),
    "utf8"
  );
  const service = fs.readFileSync(
    path.resolve("src/lib/teamAffiliationService.ts"),
    "utf8"
  );
  const page = fs.readFileSync(
    path.resolve("src/app/manage/assignments/page.tsx"),
    "utf8"
  );
  assert(
    /previewLiveAssignmentChange\(\{[\s\S]*teamAffiliation/.test(reflow) &&
      /previewLiveAssignmentEvents\(\{[\s\S]*teamAffiliation/.test(reflow),
    "reflow preview 경로에 teamAffiliation"
  );
  assert(
    /loadTeamAffiliationSnapshot\(previous\.date\)/.test(apply) &&
      /teamAffiliation,/.test(apply),
    "reflow/apply가 live 스냅샷을 전달"
  );
  assert(
    /loadTeamAffiliationSnapshot\(previous\.date\)/.test(quick) &&
      /loadTeamAffiliationSnapshot\(previous\.date\)/.test(move),
    "quick-mutation/quick-move가 live 스냅샷을 전달"
  );
  assert(
    /function reflowWithTeamAffiliation/.test(change) &&
      /acceptTeamAffiliationRefresh/.test(change),
    "change preview가 teamAffiliation을 엔진에 전달"
  );
  assert(
    /teamAffiliationUtcDate/.test(service) && !/parseYmd\(/.test(service),
    "조 설정 저장/조회가 UTC 날짜만 사용"
  );
  assert(
    /setTeamAffiliation\(defaultTeamAffiliationSnapshot\(date\)\)/.test(page) &&
      /TEAM_AFFILIATION_CHANGED_MESSAGE/.test(page),
    "날짜 변경 시 이전 조 설정을 비우고 충돌을 안내"
  );
  const canonical = fs.readFileSync(
    path.resolve("src/lib/caddyPoolCanonicalService.ts"),
    "utf8"
  );
  const staffing = fs.readFileSync(
    path.resolve("src/lib/dailyStaffingSummary.ts"),
    "utf8"
  );
  const draftSrc = fs.readFileSync(
    path.resolve("src/lib/assignmentDraft.ts"),
    "utf8"
  );
  const caddiesPage = fs.readFileSync(
    path.resolve("src/app/manage/caddies/page.tsx"),
    "utf8"
  );
  const engine = fs.readFileSync(
    path.resolve("src/lib/autoAssignEngine.ts"),
    "utf8"
  );
  const apiSrc = fs.readFileSync(
    path.resolve("src/app/api/team-affiliations/route.ts"),
    "utf8"
  );
  assert(
    /loadTeamAffiliationSnapshot\(ymd\)/.test(canonical) &&
      /teamAffiliation,/.test(canonical),
    "canonical availability가 날짜별 조 설정을 넘김"
  );
  assert(
    /teamAffiliation: input.teamAffiliation/.test(staffing) &&
      /teamAffiliation,/.test(page),
    "staffing dry-run이 조 설정을 엔진에 전달"
  );
  assert(
    /isHouseStartCandidate\(row\.caddy, snapshot\)/.test(draftSrc) &&
      /isHouseStartCandidate\(c, snapshot\)/.test(draftSrc),
    "recalc fallback이 Draft 조 설정을 사용"
  );
  assert(
    /isHouseRegularCaddy\(picked\.caddy, snapshot\)/.test(engine),
    "3부 leftover HOUSE 소비가 stale caddyType을 쓰지 않음"
  );
  const saveTeamSettings =
    caddiesPage.split("async function saveTeamSettings()")[1]?.split(
      "async function createCaddy()"
    )[0] || "";
  assert(
    /currentSnapshot/.test(apiSrc) &&
      /setTeamAffiliation\(data.currentSnapshot\)/.test(saveTeamSettings) &&
      !/setTeamAffiliation\(data.snapshot\)/.test(saveTeamSettings),
    "미래 조 설정을 오늘 명단에 덮지 않음"
  );
  assert(
    /isMissingTeamAffiliationTableError/.test(service) &&
      !/\/does not exist\/i/.test(service),
    "조 설정 폴백이 광역 does not exist 를 쓰지 않음"
  );
}

function previewLiveChangeFromDraftSafe(
  draft: ReturnType<typeof createDraftFromAutoResult>,
  previous: ReturnType<typeof autoResultFromDraft>,
  pool: AutoAssignCaddy[]
) {
  return previewLiveAssignmentChange({
    previous,
    regularCaddyPool: pool,
    change: {
      type: "CANCEL_RESERVATION",
      reservationKey: reservationKey(previous.assignments[0].reservation),
    },
    teamAffiliation: DEFAULT_TEAM_AFFILIATION_SNAPSHOT,
  });
}

if (failed > 0) {
  console.error(`\nFAILED ${failed} / ${passed + failed}`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
