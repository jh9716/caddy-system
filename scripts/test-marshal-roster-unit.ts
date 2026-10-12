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
  MARSHAL_EARLY_SLOTS_PER_DAY,
  MARSHAL_LATE_SLOTS_PER_DAY,
  MARSHAL_PROFILE_ENTITY,
  MARSHAL_ROLE_KEYS,
  MarshalRosterError,
  assertCaddyEligibleForMarshal,
  caddyTypeLabel,
  formatMarshalYmd,
  parseMarshalStartedOn,
  parseOptionalSeniorCaddyId,
  parsePositiveCaddyId,
  serializeMarshalProfile,
} from "../src/lib/marshalDomain";
import { GET as marshalsGET, POST as marshalsPOST } from "../src/app/api/marshals/route";
import { PATCH as marshalPATCH } from "../src/app/api/marshals/[id]/route";
import { OPS_DUTY_ROLE_KEYS } from "../src/lib/opsDutyRoleKeys";

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

section("daily slot contract (P2 constants only)");
assert(MARSHAL_EARLY_SLOTS_PER_DAY === 2, "조출 2");
assert(MARSHAL_LATE_SLOTS_PER_DAY === 1, "후출 1");
assert(
  MARSHAL_ROLE_KEYS.join(",") === "마샬_조출_1,마샬_조출_2,마샬_후출_1",
  "marshal roleKeys"
);
assert(!MARSHAL_ROLE_KEYS.includes("마샬_후출_2" as never), "후출2 없음");
assert(
  MARSHAL_ROLE_KEYS.every((key) => OPS_DUTY_ROLE_KEYS.includes(key)),
  "roleKeys ⊂ OPS_DUTY_ROLE_KEYS"
);

section("startedOn / eligibility");
assert(formatMarshalYmd(parseMarshalStartedOn("2026-11-01")) === "2026-11-01", "parse ymd");
throws(() => parseMarshalStartedOn("2026-02-30"), "invalid_started_on", "overflow 거부");
throws(() => parseMarshalStartedOn("11-01"), "invalid_started_on", "형식 거부");
assert(parsePositiveCaddyId(12) === 12, "caddyId");
throws(() => parsePositiveCaddyId(0), "caddyId_required", "caddyId 0 거부");
assert(parseOptionalSeniorCaddyId("", 1) === null, "senior empty");
throws(() => parseOptionalSeniorCaddyId(3, 3), "invalid_senior", "자기 선임 거부");
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
assert(caddyTypeLabel("HOUSE") === "하우스", "유형 라벨");
assert(CADDY_TYPE_LABELS.THIRD === "3부반", "3부반 라벨");

const serialized = serializeMarshalProfile({
  id: 9,
  caddyId: 4,
  active: true,
  startedOn: parseMarshalStartedOn("2026-03-01"),
  seniorCaddyId: null,
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
assert(serialized.caddy.team === "1조", "Caddy.team SoT 유지");

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
  const engine = read("src/lib/autoAssignEngine.ts");
  const assignmentsPage = read("src/app/manage/assignments/page.tsx");

  assert(getRoute.includes("requireAdmin"), "GET/POST requireAdmin");
  assert(patchRoute.includes("requireAdmin"), "PATCH requireAdmin");
  assert(!service.includes("dailyOpsDuty"), "service DailyOpsDuty write 없음");
  assert(!service.includes("MARSHAL_SUPPORT"), "service MARSHAL_SUPPORT 없음");
  assert(!service.includes("assignment.create"), "service Assignment write 없음");
  assert(!domain.includes("autoAssignEngine"), "domain 엔진 import 없음");
  assert(!service.includes("autoAssignEngine"), "service 엔진 import 없음");
  assert(!page.includes("generateMarshal"), "UI 월 생성 없음");
  assert(!page.includes("off-cal"), "UI 월 달력 없음");
  assert(schema.includes("model MarshalProfile"), "schema MarshalProfile");
  assert(schema.includes("model MarshalMonthWindow"), "schema month window 예약");
  assert(schema.includes("earlySlotsPerDay"), "default 조출 슬롯 필드");
  assert(/AssignmentType[\s\S]*MARSHAL/.test(schema), "Assignment.MARSHAL enum 유지");
  assert(schema.includes("MARSHAL_SUPPORT"), "MARSHAL_SUPPORT enum 유지");
  assert(schema.includes("enum DailyOpsDutyRole"), "DailyOpsDutyRole 유지");
  assert(engine.includes("computeAutoAssignmentsV1"), "autoAssignEngine 존재");
  assert(
    !assignmentsPage.includes("/manage/marshals"),
    "assignments 페이지 마샬 월표 연결 없음"
  );
  assert(service.includes("tx.audit.create"), "Audit write");
  assert(
    service.includes(MARSHAL_AUDIT_ACTIONS.CREATE) ||
      service.includes("MARSHAL_PROFILE_CREATE"),
    "create audit"
  );
  assert(service.includes("MARSHAL_PROFILE_DEACTIVATE"), "deactivate audit");
  assert(service.includes("MARSHAL_PROFILE_REACTIVATE"), "reactivate audit");
  assert(service.includes("MARSHAL_PROFILE_UPDATE_STARTED_ON"), "startedOn audit");
  assert(MARSHAL_PROFILE_ENTITY === "MarshalProfile", "audit entity");
  assert(!getRoute.includes("hard delete") && !patchRoute.includes(".delete("), "hard delete 없음");
}

section("git: autoAssignEngine / assignments page / existing marshal enums");
{
  const { spawnSync } = await import("node:child_process");
  const diff = spawnSync(
    "git",
    [
      "diff",
      "--name-only",
      "origin/main",
      "--",
      "src/lib/autoAssignEngine.ts",
      "src/app/manage/assignments/page.tsx",
      "src/lib/dailySpecialSupport.ts",
      "src/lib/opsDutyEffective.ts",
      "src/lib/availabilityEngine.ts",
    ],
    { encoding: "utf8" }
  );
  const names = String(diff.stdout || "").trim();
  assert(names === "", `기존 배치 파일 변경 0 (${names || "clean"})`);
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
      await prisma.marshalMonthUnavail.deleteMany({
        where: { caddyId: { in: [active.id, retired.id] } },
      });
      await prisma.marshalMonthOverride.deleteMany({
        where: { caddyId: { in: [active.id, retired.id] } },
      });
      await prisma.marshalMonthAssignment.deleteMany({
        where: { caddyId: { in: [active.id, retired.id] } },
      });
      await prisma.marshalProfile.deleteMany({
        where: { caddyId: { in: [active.id, retired.id] } },
      });
      await prisma.caddy.deleteMany({
        where: { id: { in: [active.id, retired.id] } },
      });
    }
  }
}

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
