/**
 * CONFIRMED 배치 운영 반영 — 단위 + 로컬 DB 통합 테스트
 *
 * ⛔ Production/Neon write 금지. localhost PostgreSQL 만 사용.
 *
 * 실행:
 *   ALLOW_DB_TEST=1 DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local?schema=public \
 *     npx tsx scripts/test-assignment-confirm-unit.ts
 */
import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import {
  buildConfirmPersistPlan,
  hashConfirmPayload,
  isConfirmableStatus,
  validateConfirmRequest,
} from "../src/lib/assignmentConfirm";
import { applyConfirmedAssignments } from "../src/lib/assignmentConfirmApply";
import type { AutoAssignmentRow } from "../src/lib/autoAssignEngine";
import { POST as confirmPOST } from "../src/app/api/assignments/confirm/route";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";

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

function sampleRow(
  overrides: Partial<AutoAssignmentRow> & {
    caddyId: number;
    teeTime?: string;
    shift?: "1부" | "2부" | "3부";
  }
): AutoAssignmentRow {
  const shift = overrides.shift || "1부";
  const teeTime = overrides.teeTime || "07:00";
  const caddyId = overrides.caddyId;
  return {
    date: overrides.date || "2026-08-20",
    shift,
    sequenceIndex: overrides.sequenceIndex ?? 1,
    reason: overrides.reason || "TEST",
    kind: overrides.kind || "regular",
    note: overrides.note ?? null,
    pairId: overrides.pairId ?? null,
    reservation: {
      id: overrides.reservation?.id ?? `r-${caddyId}-${teeTime}`,
      date: overrides.date || "2026-08-20",
      course: "SKY",
      shift,
      teeTime,
      teamName: "t",
      rawRowIndex: overrides.reservation?.rawRowIndex ?? caddyId,
    },
    caddy: {
      id: caddyId,
      name: `C${caddyId}`,
      team: "1조",
      teamOrder: 1,
    },
  };
}

// ─── Pure unit (DB 없음) ───────────────────────────────────────────
section("status gate");
assert(isConfirmableStatus("CONFIRMED") === true, "CONFIRMED ok");
assert(isConfirmableStatus("DRAFT") === false, "DRAFT rejected");
assert(isConfirmableStatus("EDITED") === false, "EDITED rejected");
assert(isConfirmableStatus("APPLIED") === false, "APPLIED rejected for re-save");

section("validateConfirmRequest — 미확정 거부");
{
  const r = validateConfirmRequest({
    status: "DRAFT",
    date: "2026-08-20",
    assignments: [sampleRow({ caddyId: 1 })],
  });
  assert(r.ok === false, "DRAFT validate fails");
  if (!r.ok) {
    assert(
      r.issues.some((i) => i.code === "STATUS_NOT_CONFIRMED"),
      "STATUS_NOT_CONFIRMED code"
    );
  }
}
{
  const r = validateConfirmRequest({
    status: "EDITED",
    date: "2026-08-20",
    assignments: [sampleRow({ caddyId: 1 })],
  });
  assert(r.ok === false, "EDITED validate fails");
}

section("hash + persist plan");
{
  const rows = [
    sampleRow({ caddyId: 2, teeTime: "07:08", kind: "fiftyFourHole" }),
    sampleRow({ caddyId: 1, teeTime: "07:00", kind: "regular" }),
  ];
  const h1 = hashConfirmPayload("2026-08-20", rows);
  const h2 = hashConfirmPayload("2026-08-20", [...rows].reverse());
  assert(h1 === h2, "hash stable under reorder");
  assert(h1.length === 64, "sha256 hex length");

  const plan = buildConfirmPersistPlan({
    status: "CONFIRMED",
    date: "2026-08-20",
    assignments: rows,
  });
  assert(plan.schedules.length === 2, "unique schedules");
  assert(plan.shiftDuties.length === 2, "shiftDuties rows");
  assert(plan.shiftDuties[0].orderNo === 1, "order by teeTime");
  assert(plan.shiftDuties[0].caddyId === 1, "earlier tee first");
  assert(
    plan.extraTags.some((t) => t.tag === "54홀" && t.caddyId === 2),
    "54홀 extra tag"
  );
}

// ─── Local DB integration ──────────────────────────────────────────
async function runDbTests() {
  if (process.env.ALLOW_DB_TEST !== "1") {
    console.error("\n⛔ ALLOW_DB_TEST=1 필요 (로컬 DB 통합 테스트 스킵하지 않음 — 실패 처리)");
    process.exit(1);
  }
  const url = process.env.DATABASE_URL || "";
  assertLocalDatabaseUrl(url);
  console.log("\n[DB]", new URL(url).hostname + new URL(url).pathname);

  const prisma = new PrismaClient();
  const date = "2099-01-15"; // 테스트 전용 먼 미래 날짜
  const dateObj = new Date(`${date}T00:00:00.000Z`);

  try {
    // cleanup leftover
    await prisma.shiftDuty.deleteMany({ where: { date: dateObj } });
    await prisma.schedule.deleteMany({ where: { date: dateObj } });
    await prisma.scheduleExtraTag.deleteMany({ where: { date: dateObj } });
    await prisma.audit.deleteMany({
      where: { action: "ASSIGNMENTS_CONFIRM", entity: "AssignmentConfirm" },
    });
    await prisma.caddy.deleteMany({
      where: { employeeCode: { startsWith: "TEST-CONFIRM-" } },
    });

    const c1 = await prisma.caddy.create({
      data: {
        name: "__TEST_CONFIRM_1__",
        team: "1조",
        teamOrder: 1,
        employeeCode: "TEST-CONFIRM-1",
        employmentStatus: "ACTIVE",
      },
    });
    const c2 = await prisma.caddy.create({
      data: {
        name: "__TEST_CONFIRM_2__",
        team: "1조",
        teamOrder: 2,
        employeeCode: "TEST-CONFIRM-2",
        employmentStatus: "ACTIVE",
      },
    });

    const assignments: AutoAssignmentRow[] = [
      sampleRow({
        caddyId: c1.id,
        date,
        teeTime: "07:00",
        shift: "1부",
        kind: "regular",
      }),
      sampleRow({
        caddyId: c2.id,
        date,
        teeTime: "13:00",
        shift: "2부",
        kind: "oneTwo",
      }),
    ];

    section("미확정 저장 거부 (apply)");
    {
      const r = await applyConfirmedAssignments(
        { status: "DRAFT", date, assignments },
        { prisma }
      );
      assert(r.ok === false && r.code === "STATUS_NOT_CONFIRMED", "DRAFT apply rejected");
    }

    section("비관리자 거부 (API)");
    {
      const req = new NextRequest("http://localhost/api/assignments/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "CONFIRMED",
          date,
          assignments,
        }),
      });
      // no admin cookie
      const res = await confirmPOST(req);
      assert(res.status === 401, "non-admin → 401");
      const body = await res.json();
      assert(body.error === "unauthorized", "unauthorized body");
    }

    section("없는 caddyId 거부");
    {
      const bad = [
        sampleRow({ caddyId: c1.id, date, teeTime: "07:00" }),
        sampleRow({ caddyId: 999999001, date, teeTime: "07:08" }),
      ];
      const r = await applyConfirmedAssignments(
        { status: "CONFIRMED", date, assignments: bad },
        { prisma }
      );
      assert(r.ok === false && r.code === "UNKNOWN_CADDY", "unknown caddy rejected");
    }

    section("정상 저장");
    {
      const r = await applyConfirmedAssignments(
        { status: "CONFIRMED", date, assignments },
        { prisma, ip: "127.0.0.1" }
      );
      assert(r.ok === true && r.status === "APPLIED", "applied ok");
      if (r.ok) {
        assert(r.duplicate === false, "not duplicate");
        assert(r.counts.schedules === 2, "2 schedules");
        assert(r.counts.shiftDuties === 2, "2 shiftDuties");
        assert(r.counts.extraTags === 1, "1·2부 tag");
      }
      const schedules = await prisma.schedule.count({ where: { date: dateObj } });
      const duties = await prisma.shiftDuty.count({ where: { date: dateObj } });
      const audits = await prisma.audit.count({
        where: { action: "ASSIGNMENTS_CONFIRM" },
      });
      assert(schedules === 2, "DB schedules=2");
      assert(duties === 2, "DB duties=2");
      assert(audits >= 1, "Audit written");
    }

    section("기존 날짜 충돌 (replace 없이)");
    {
      const alt: AutoAssignmentRow[] = [
        sampleRow({
          caddyId: c1.id,
          date,
          teeTime: "08:00",
          shift: "1부",
          kind: "fixed",
        }),
      ];
      const r = await applyConfirmedAssignments(
        { status: "CONFIRMED", date, assignments: alt },
        { prisma }
      );
      assert(r.ok === false && r.code === "EXISTING_PLACEMENTS", "conflict 409 logic");
      assert(r.ok === false && r.requireReplace === true, "requireReplace");
    }

    section("replace 승인");
    {
      const alt: AutoAssignmentRow[] = [
        sampleRow({
          caddyId: c1.id,
          date,
          teeTime: "08:00",
          shift: "1부",
          kind: "fixed",
        }),
      ];
      const r = await applyConfirmedAssignments(
        { status: "CONFIRMED", date, assignments: alt, replace: true },
        { prisma }
      );
      assert(r.ok === true && r.status === "APPLIED", "replace applied");
      if (r.ok) assert(r.replaced === true, "replaced flag");
      const schedules = await prisma.schedule.count({ where: { date: dateObj } });
      const duties = await prisma.shiftDuty.count({ where: { date: dateObj } });
      const tags = await prisma.scheduleExtraTag.count({ where: { date: dateObj } });
      assert(schedules === 1, "after replace schedules=1");
      assert(duties === 1, "after replace duties=1");
      assert(tags === 1, "fixed tag");
    }

    section("중복 요청 방지");
    {
      const same: AutoAssignmentRow[] = [
        sampleRow({
          caddyId: c1.id,
          date,
          teeTime: "08:00",
          shift: "1부",
          kind: "fixed",
        }),
      ];
      const beforeDuty = await prisma.shiftDuty.count({ where: { date: dateObj } });
      const beforeAudit = await prisma.audit.count({
        where: { action: "ASSIGNMENTS_CONFIRM" },
      });
      const r = await applyConfirmedAssignments(
        { status: "CONFIRMED", date, assignments: same, replace: true },
        { prisma }
      );
      assert(r.ok === true && r.duplicate === true, "duplicate detected");
      const afterDuty = await prisma.shiftDuty.count({ where: { date: dateObj } });
      const afterAudit = await prisma.audit.count({
        where: { action: "ASSIGNMENTS_CONFIRM" },
      });
      assert(afterDuty === beforeDuty, "no extra duty rows");
      assert(afterAudit === beforeAudit, "no extra audit rows");
    }

    section("transaction rollback");
    {
      // 새 날짜로 깨끗이
      const date2 = "2099-01-16";
      const date2Obj = new Date(`${date2}T00:00:00.000Z`);
      await prisma.shiftDuty.deleteMany({ where: { date: date2Obj } });
      await prisma.schedule.deleteMany({ where: { date: date2Obj } });
      await prisma.scheduleExtraTag.deleteMany({ where: { date: date2Obj } });

      // seed existing to trigger replace delete path
      await prisma.schedule.create({
        data: { date: date2Obj, caddyId: c1.id, memo: "seed" },
      });

      const rows: AutoAssignmentRow[] = [
        sampleRow({
          caddyId: c1.id,
          date: date2,
          teeTime: "07:00",
          kind: "regular",
        }),
        sampleRow({
          caddyId: c2.id,
          date: date2,
          teeTime: "07:08",
          kind: "regular",
        }),
      ];

      const r = await applyConfirmedAssignments(
        { status: "CONFIRMED", date: date2, assignments: rows, replace: true },
        { prisma, testThrowAfterDelete: true }
      );
      assert(r.ok === false && r.code === "TEST_FORCE_ROLLBACK", "forced fail");

      const schedules = await prisma.schedule.count({ where: { date: date2Obj } });
      const duties = await prisma.shiftDuty.count({ where: { date: date2Obj } });
      // seed schedule should be restored by rollback
      assert(schedules === 1, "rollback restored seed schedule");
      assert(duties === 0, "no partial duties after rollback");

      const seed = await prisma.schedule.findFirst({ where: { date: date2Obj } });
      assert(seed?.memo === "seed", "seed memo intact after rollback");
    }

    section("관리자 API 정상 저장");
    {
      const date3 = "2099-01-17";
      const date3Obj = new Date(`${date3}T00:00:00.000Z`);
      await prisma.shiftDuty.deleteMany({ where: { date: date3Obj } });
      await prisma.schedule.deleteMany({ where: { date: date3Obj } });
      await prisma.scheduleExtraTag.deleteMany({ where: { date: date3Obj } });

      const rows: AutoAssignmentRow[] = [
        sampleRow({ caddyId: c1.id, date: date3, teeTime: "07:00" }),
      ];
      const req = new NextRequest("http://localhost/api/assignments/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "role=admin; session_role=admin",
        },
        body: JSON.stringify({
          status: "CONFIRMED",
          date: date3,
          assignments: rows,
        }),
      });
      const res = await confirmPOST(req);
      const body = await res.json();
      assert(res.status === 200, "admin confirm 200");
      assert(body.status === "APPLIED", "API APPLIED");
      const n = await prisma.schedule.count({ where: { date: date3Obj } });
      assert(n === 1, "API wrote schedule");
    }

    // final cleanup
    await prisma.shiftDuty.deleteMany({
      where: { date: { in: [dateObj, new Date("2099-01-16T00:00:00.000Z"), new Date("2099-01-17T00:00:00.000Z")] } },
    });
    await prisma.schedule.deleteMany({
      where: { date: { in: [dateObj, new Date("2099-01-16T00:00:00.000Z"), new Date("2099-01-17T00:00:00.000Z")] } },
    });
    await prisma.scheduleExtraTag.deleteMany({
      where: { date: { in: [dateObj, new Date("2099-01-16T00:00:00.000Z"), new Date("2099-01-17T00:00:00.000Z")] } },
    });
    await prisma.audit.deleteMany({
      where: { action: "ASSIGNMENTS_CONFIRM", entity: "AssignmentConfirm" },
    });
    await prisma.caddy.deleteMany({
      where: { employeeCode: { startsWith: "TEST-CONFIRM-" } },
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  // hash sanity (unused createHash import guard via assert)
  assert(
    createHash("sha256").update("x").digest("hex").length === 64,
    "crypto available"
  );

  await runDbTests();

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
