/**
 * 마샬 명단 P1 — 도메인/권한/불변 계약 (production write 없음)
 * 실행: npm run test:marshal-roster-unit
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  SESSION_COOKIE_NAME,
  buildSessionClaims,
  signSessionClaims,
} from "../src/lib/sessionCookies";
import { requireAdmin } from "../src/lib/auth";
import {
  CADDY_TYPE_LABELS,
  MARSHAL_AUDIT_ACTIONS,
  MARSHAL_PROFILE_ENTITY,
  MarshalRosterError,
  assertCaddyEligibleForMarshal,
  assertFinalActiveRotationOrder,
  caddyTypeLabel,
  formatMarshalYmd,
  parseMarshalStartedOn,
  parsePositiveCaddyId,
  resolveMarshalCreateStartedOn,
  serializeMarshalProfile,
} from "../src/lib/marshalDomain";
import { kstYmd } from "../src/lib/kstDate";
import { GET as marshalsGET, POST as marshalsPOST } from "../src/app/api/marshals/route";
import { PATCH as marshalPATCH } from "../src/app/api/marshals/[id]/route";
import { OPS_DUTY_ROLE_KEYS } from "../src/lib/opsDutyRoleKeys";

const MONTH_MODEL = ["Marshal", "Month"].join("");
const SENIOR_FIELD = ["senior", "CaddyId"].join("");
const JUNIOR_FIELD = ["marshal", "Juniors"].join("");

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

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function throws(fn: () => void, code: string, msg: string) {
  try {
    fn();
    assert(false, msg);
  } catch (e) {
    assert(e instanceof MarshalRosterError && e.code === code, msg);
  }
}

async function cookieReq(
  role: "admin" | "caddy" | "leader",
  url: string,
  init?: RequestInit
) {
  const token = await signSessionClaims(
    buildSessionClaims({
      userId: null,
      username: role,
      role,
      sessionVersion: 0,
    })
  );
  return new NextRequest(url, {
    ...init,
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      ...(init?.headers || {}),
    },
  });
}

async function main() {
section("existing DailyOpsDuty marshal keys unchanged");
assert(
  OPS_DUTY_ROLE_KEYS.includes("마샬_조출_1") &&
    OPS_DUTY_ROLE_KEYS.includes("마샬_조출_2") &&
    OPS_DUTY_ROLE_KEYS.includes("마샬_후출_1"),
  "기존 조출2+후출1 roleKeys 유지"
);
assert(!OPS_DUTY_ROLE_KEYS.includes("마샬_후출_2"), "후출2 없음");

section("startedOn / eligibility");
assert(formatMarshalYmd(parseMarshalStartedOn("2026-11-01")) === "2026-11-01", "parse ymd");
throws(() => parseMarshalStartedOn("2026-02-30"), "invalid_started_on", "overflow 거부");
throws(() => parseMarshalStartedOn("11-01"), "invalid_started_on", "형식 거부");
{
  const utcEvening = new Date("2026-10-15T15:30:00.000Z");
  const utcAfternoon = new Date("2026-10-15T14:59:00.000Z");
  assert(kstYmd(utcEvening) === "2026-10-16", "UTC 저녁은 KST 다음날");
  assert(kstYmd(utcAfternoon) === "2026-10-15", "UTC 오후는 같은 KST 날짜");
  assert(
    formatMarshalYmd(resolveMarshalCreateStartedOn(undefined, kstYmd(utcEvening))) ===
      "2026-10-16",
    "startedOn 생략 → KST 오늘"
  );
  assert(
    formatMarshalYmd(resolveMarshalCreateStartedOn(null, kstYmd(utcEvening))) ===
      "2026-10-16",
    "startedOn null → KST 오늘"
  );
  assert(
    formatMarshalYmd(resolveMarshalCreateStartedOn("", kstYmd(utcEvening))) ===
      "2026-10-16",
    "startedOn 빈값 → KST 오늘"
  );
  assert(
    formatMarshalYmd(
      resolveMarshalCreateStartedOn("2099-01-15", kstYmd(utcEvening))
    ) === "2099-01-15",
    "startedOn 명시 시 기존 동작 유지"
  );
  throws(
    () => resolveMarshalCreateStartedOn("11-01", kstYmd(utcEvening)),
    "invalid_started_on",
    "명시 invalid startedOn 거부"
  );
}
assert(parsePositiveCaddyId(12) === 12, "caddyId");
throws(() => parsePositiveCaddyId(0), "caddyId_required", "caddyId 0 거부");
assertCaddyEligibleForMarshal({
  id: 1,
  name: "홍",
  employmentStatus: "ACTIVE",
});
throws(
  () => assertCaddyEligibleForMarshal(null),
  "caddy_not_found",
  "미존재 fail closed"
);
throws(
  () =>
    assertCaddyEligibleForMarshal({
      id: 2,
      name: "퇴",
      employmentStatus: "RETIRED",
    }),
  "inactive_caddy",
  "RETIRED fail closed"
);
throws(
  () =>
    assertCaddyEligibleForMarshal({
      id: 3,
      name: "휴",
      employmentStatus: "LEAVE",
    }),
  "inactive_caddy",
  "LEAVE fail closed"
);
section("reactivate / simultaneous order guard");
{
  const otherActives = [{ id: 10, rotationOrder: 3 }];
  throws(
    () =>
      assertFinalActiveRotationOrder({
        profileId: 2,
        nextActive: true,
        nextOrder: 3,
        otherActives,
      }),
    "duplicate_rotation_order",
    "inactive order=3 reactivate-only 409"
  );
  assertFinalActiveRotationOrder({
    profileId: 2,
    nextActive: true,
    nextOrder: 4,
    otherActives,
  });
  assert(true, "inactive order=3 + active+order=4 성공");
  throws(
    () =>
      assertFinalActiveRotationOrder({
        profileId: 10,
        nextActive: true,
        nextOrder: 3,
        otherActives: [{ id: 11, rotationOrder: 3 }],
      }),
    "duplicate_rotation_order",
    "active marshal 순번 변경 중복 409"
  );
  throws(
    () =>
      assertFinalActiveRotationOrder({
        profileId: 2,
        nextActive: true,
        nextOrder: null,
        otherActives,
      }),
    "rotation_order_required",
    "reactivate without order 400"
  );
  assertFinalActiveRotationOrder({
    profileId: 2,
    nextActive: false,
    nextOrder: 3,
    otherActives,
  });
  assert(true, "deactivate keeps colliding stored order");
}

assert(caddyTypeLabel("HOUSE") === "하우스", "유형 라벨");
assert(CADDY_TYPE_LABELS.THIRD === "3부반", "3부반 라벨");

const serialized = serializeMarshalProfile({
  id: 9,
  caddyId: 4,
  active: true,
  startedOn: parseMarshalStartedOn("2026-03-01"),
  rotationOrder: 3,
  createdAt: new Date("2026-03-02T00:00:00.000Z"),
  updatedAt: new Date("2026-03-02T00:00:00.000Z"),
  caddy: {
    id: 4,
    name: "김",
    team: "1조",
    teamOrder: 2,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  },
});
assert(serialized.startedOn === "2026-03-01", "serialize startedOn");
assert(serialized.rotationOrder === 3, "serialize rotationOrder");
assert(serialized.caddy.team === "1조", "Caddy.team SoT 유지");
assert(
  !Object.prototype.hasOwnProperty.call(serialized, ["senior", "CaddyId"].join("")),
  "serialize에 senior 없음"
);

section("auth: 일반 사용자 write 거부");
{
  const unauthGet = await marshalsGET(new NextRequest("http://localhost/api/marshals"));
  assert(unauthGet.status === 401, "GET unauth 401");
  const caddyGet = await marshalsGET(await cookieReq("caddy", "http://localhost/api/marshals"));
  assert(caddyGet.status === 401, "GET caddy 401");
  const leaderPost = await marshalsPOST(
    await cookieReq("leader", "http://localhost/api/marshals", {
      method: "POST",
      body: JSON.stringify({ caddyId: 1, startedOn: "2026-11-01" }),
    })
  );
  assert(leaderPost.status === 401, "POST leader 401");
  const caddyPatch = await marshalPATCH(
    await cookieReq("caddy", "http://localhost/api/marshals/1", {
      method: "PATCH",
      body: JSON.stringify({ active: false }),
    }),
    { params: { id: "1" } }
  );
  assert(caddyPatch.status === 401, "PATCH caddy 401");
  const adminGuard = await requireAdmin(
    await cookieReq("admin", "http://localhost/api/marshals")
  );
  assert(adminGuard === undefined, "admin requireAdmin 통과");
}

section("source contracts");
{
  const domain = read("src/lib/marshalDomain.ts");
  const service = read("src/lib/marshalRosterService.ts");
  const getRoute = read("src/app/api/marshals/route.ts");
  const patchRoute = read("src/app/api/marshals/[id]/route.ts");
  const page = read("src/app/manage/marshals/page.tsx");
  const schema = read("prisma/schema.prisma");
  const migration = read("prisma/migrations/20261012120000_marshal_roster_p1/migration.sql");
  const engine = read("src/lib/autoAssignEngine.ts");
  const assignmentsPage = read("src/app/manage/assignments/page.tsx");

  assert(getRoute.includes("requireAdmin"), "GET/POST requireAdmin");
  assert(patchRoute.includes("requireAdmin"), "PATCH requireAdmin");
  assert(!/\bdailyOpsDuty\.(create|update|upsert)/.test(service), "service DailyOpsDuty write 없음");
  assert(!service.includes("dailySpecialSupport"), "service MARSHAL_SUPPORT write 없음");
  assert(!service.includes("assignment.create"), "service Assignment write 없음");
  assert(!domain.includes("autoAssignEngine"), "domain 엔진 import 없음");
  assert(!service.includes("autoAssignEngine"), "service 엔진 import 없음");
  assert(!page.includes("generateMarshal"), "UI 월 생성 없음");
  assert(!page.includes("off-cal"), "UI 월 달력 없음");
  assert(!page.includes("선임"), "UI 선임 없음");
  assert(!page.includes("후임"), "UI 후임 없음");
  assert(!page.includes('aria-label="마샬 시작일"'), "추가 UI startedOn 없음");
  assert(!page.includes("캐디와 시작일을 선택하세요"), "추가 UI 시작일 필수 문구 없음");
  assert(!page.includes(">시작일<") && !page.includes("<th>시작일</th>"), "목록 시작일 header 없음");
  assert(!/시작일/.test(page), "페이지에 시작일 UI 없음");
  assert(!page.includes('type="date"'), "startedOn date input 없음");
  assert(page.includes("colSpan={7}"), "empty row colSpan 7");
  assert(page.includes('aria-label="캐디"'), "추가 UI 캐디 선택");
  assert(page.includes('aria-label="마샬 순번"'), "추가 UI 순번");
  assert(page.includes("명단에 추가"), "추가 UI 버튼");
  assert(page.includes("MarshalCaddyPicker"), "검색 가능한 캐디 picker");
  assert(page.includes('data-marshal-roster="dense"'), "모바일 dense roster");
  assert(page.includes('data-marshal-roster="table"'), "PC table roster");
  assert(page.includes("비활성 포함"), "비활성 포함 유지");
  {
    const createFn = page.split("const createMarshal")[1]?.split("const patchMarshal")[0] || "";
    assert(createFn.includes("caddyId"), "create POST caddyId");
    assert(!createFn.includes("startedOn"), "create POST omits startedOn");
    const patchType = page.split("const patchMarshal")[1]?.split("return (")[0] || "";
    assert(!/startedOn\?:/.test(patchType), "patchMarshal UI type omits startedOn");
  }
  assert(patchRoute.includes("startedOn:"), "PATCH API still accepts startedOn");
  assert(service.includes("resolveMarshalCreateStartedOn"), "생략 startedOn 서버 기본값");
  assert(service.includes("kstYmd"), "startedOn 기본값은 KST");
  assert(domain.includes("resolveMarshalCreateStartedOn"), "create startedOn helper");
  assert(/startedOn\s+DateTime/.test(schema), "schema startedOn 컬럼 유지");
  assert(schema.includes("model MarshalProfile"), "schema MarshalProfile");
  assert(schema.includes(`model ${MONTH_MODEL}Plan`), "schema month plan");
  assert(!schema.includes(`model ${MONTH_MODEL}Window`), "schema month window 0");
  assert(!schema.includes(SENIOR_FIELD), "schema senior field 0");
  assert(!schema.includes(JUNIOR_FIELD), "schema junior back-relation 0");
  assert(!migration.includes(MONTH_MODEL), "migration month tables 0");
  assert(!migration.includes(SENIOR_FIELD), "migration senior field 0");
  assert(/AssignmentType[\s\S]*MARSHAL/.test(schema), "Assignment.MARSHAL enum 유지");
  assert(schema.includes("MARSHAL_SUPPORT"), "MARSHAL_SUPPORT enum 유지");
  assert(schema.includes("enum DailyOpsDutyRole"), "DailyOpsDutyRole 유지");
  assert(engine.includes("computeAutoAssignmentsV1"), "autoAssignEngine 존재");
  assert(
    !assignmentsPage.includes("/manage/marshals"),
    "assignments 페이지 마샬 월표 연결 없음"
  );
  assert(service.includes("tx.audit.create"), "Audit write");
  assert(service.includes("MARSHAL_AUDIT_ACTIONS.CREATE"), "create audit");
  assert(service.includes("MARSHAL_AUDIT_ACTIONS.DEACTIVATE"), "deactivate audit");
  assert(service.includes("MARSHAL_AUDIT_ACTIONS.REACTIVATE"), "reactivate audit");
  assert(service.includes("MARSHAL_AUDIT_ACTIONS.UPDATE_STARTED_ON"), "startedOn audit");
  assert(service.includes("assertFinalActiveRotationOrder"), "reactivate uses final-state order guard");
  assert(service.includes("nextActive"), "simultaneous active+order uses nextActive");
  assert(domain.includes("MARSHAL_PROFILE_CREATE"), "create audit action");
  assert(domain.includes("MARSHAL_PROFILE_DEACTIVATE"), "deactivate audit action");
  assert(domain.includes("MARSHAL_PROFILE_REACTIVATE"), "reactivate audit action");
  assert(domain.includes("MARSHAL_PROFILE_UPDATE_STARTED_ON"), "startedOn audit action");
  assert(!domain.includes("UPDATE_SENIOR"), "senior audit 없음");
  assert(!domain.includes("parseOptionalSenior"), "senior parse 없음");
  assert(!service.includes(SENIOR_FIELD), "service senior field 0");
  assert(!getRoute.includes(SENIOR_FIELD), "POST senior field 0");
  assert(!patchRoute.includes(SENIOR_FIELD), "PATCH senior field 0");
  assert(MARSHAL_PROFILE_ENTITY === "MarshalProfile", "audit entity");
  assert(!getRoute.includes("hard delete") && !patchRoute.includes(".delete("), "hard delete 없음");
}

section("git: P1 scope + existing ops files unchanged");
{
  const { spawnSync } = await import("node:child_process");
  const names = String(
    spawnSync(
      "git",
      [
        "diff",
        "--name-only",
        "origin/main",
        "--",
        "src/lib/autoAssignEngine.ts",
        "src/lib/caddyPoolCanonical.ts",
        "src/lib/assignmentDraft.ts",
        "src/lib/dailyBoardDraft.ts",
        "src/app/manage/assignments/page.tsx",
        "src/lib/dailySpecialSupport.ts",
        "src/lib/opsDutyEffective.ts",
        "src/lib/availabilityEngine.ts",
        "src/lib/marshalRotationService.ts",
        "src/lib/marshalRotationDomain.ts",
        "src/app/manage/marshals/schedule/page.tsx",
        "prisma/schema.prisma",
      ],
      { encoding: "utf8" }
    ).stdout || ""
  ).trim();
  assert(names === "", `기존 배치 파일 변경 0 (${names || "clean"})`);

  const fullDiff = String(
    spawnSync("git", ["diff", "origin/main"], { encoding: "utf8" }).stdout || ""
  );
  assert(
    read("prisma/schema.prisma").includes(`model ${MONTH_MODEL}Plan`),
    "schema month plan 유지"
  );
  assert(!fullDiff.includes(SENIOR_FIELD), "PR diff senior field 0");
  const dutyDiff = String(
    spawnSync(
      "git",
      ["diff", "origin/main", "--", "prisma/schema.prisma"],
      { encoding: "utf8" }
    ).stdout || ""
  );
  assert(
    !/^[+-]\s+(dailyOpsDut|enum DailyOpsDuty|model DailyOpsDuty)/m.test(dutyDiff),
    "schema DailyOpsDuty 필드/모델 변경 0"
  );
}

section("local DB (optional)");
{
  if (process.env.ALLOW_DB_TEST !== "1") {
    console.log("  (skip local DB — ALLOW_DB_TEST=1 + localhost DATABASE_URL)");
  } else {
    const { assertLocalDatabaseUrl } = await import("../src/lib/dbSafety");
    assertLocalDatabaseUrl(process.env.DATABASE_URL);
    const { prisma } = await import("../src/lib/prisma");
    const {
      createMarshalProfile,
      updateMarshalProfile,
    } = await import("../src/lib/marshalRosterService");
    const stamp = Date.now();
    const active = await prisma.caddy.create({
      data: {
        name: `마샬P1활성${stamp}`,
        team: "1조",
        teamOrder: 9800,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    const omitted = await prisma.caddy.create({
      data: {
        name: `마샬P1생략${stamp}`,
        team: "1조",
        teamOrder: 9802,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    const retired = await prisma.caddy.create({
      data: {
        name: `마샬P1퇴사${stamp}`,
        team: "1조",
        teamOrder: 9801,
        employmentStatus: "RETIRED",
        caddyType: "HOUSE",
      },
    });
    try {
      const created = await createMarshalProfile({
        caddyId: active.id,
        startedOn: "2099-01-15",
      });
      assert(created.caddyId === active.id, "ACTIVE 등록");
      assert(created.startedOn === "2099-01-15", "시작일 저장");
      const defaulted = await createMarshalProfile({
        caddyId: omitted.id,
        now: new Date("2026-10-15T15:30:00.000Z"),
      });
      assert(defaulted.startedOn === "2026-10-16", "생략 startedOn은 KST 오늘");
      const audit = await prisma.audit.findFirst({
        where: { entity: "MarshalProfile", entityId: created.id, action: "MARSHAL_PROFILE_CREATE" },
        orderBy: { id: "desc" },
      });
      assert(Boolean(audit), "create Audit");
      try {
        await createMarshalProfile({
          caddyId: active.id,
          startedOn: "2099-01-16",
        });
        assert(false, "중복 등록 거부");
      } catch (e) {
        assert(
          e instanceof MarshalRosterError && e.code === "already_registered",
          "중복 등록 409"
        );
      }
      try {
        await createMarshalProfile({
          caddyId: retired.id,
          startedOn: "2099-01-15",
        });
        assert(false, "RETIRED 등록 거부");
      } catch (e) {
        assert(
          e instanceof MarshalRosterError && e.code === "inactive_caddy",
          "RETIRED fail closed"
        );
      }
      try {
        await createMarshalProfile({
          caddyId: 9_999_991,
          startedOn: "2099-01-15",
        });
        assert(false, "미존재 등록 거부");
      } catch (e) {
        assert(
          e instanceof MarshalRosterError && e.code === "caddy_not_found",
          "미존재 fail closed"
        );
      }
      const deactivated = await updateMarshalProfile({
        id: created.id,
        active: false,
      });
      assert(deactivated.active === false, "비활성");
      await prisma.caddy.update({
        where: { id: active.id },
        data: { employmentStatus: "RETIRED" },
      });
      try {
        await updateMarshalProfile({ id: created.id, active: true });
        assert(false, "RETIRED 복구 거부");
      } catch (e) {
        assert(
          e instanceof MarshalRosterError && e.code === "inactive_caddy",
          "RETIRED 복구 fail closed"
        );
      }
    } finally {
      await prisma.marshalProfile.deleteMany({
        where: { caddyId: { in: [active.id, omitted.id, retired.id] } },
      });
      await prisma.caddy.deleteMany({
        where: { id: { in: [active.id, omitted.id, retired.id] } },
      });
    }
  }
}

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
