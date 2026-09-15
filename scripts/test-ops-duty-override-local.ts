/**
 * LOCAL POSTGRESQL ONLY — override SET/CLEAR/RESTORE
 * DailyOpsDuty / production Neon 금지.
 *
 * DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local?schema=public \
 *   npm run test:ops-duty-override-local
 */
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import { parseYmd } from "../src/lib/availabilityEngine";
import { countByOpsRole } from "../src/lib/dailyOpsDuty";
import {
  opsDutyPanelRowsFromReadOnly,
  resolveOpsDutyReadOnly,
} from "../src/lib/opsDutyReadOnlySource";
import {
  resolveEffectiveOpsDuty,
  writeDailyOpsDutyOverride,
} from "../src/lib/opsDutyEffectiveService";

const DATE = "2099-12-28";
const TAG = "__OV146A__";
const prisma = new PrismaClient();

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

function legacyGetJson(
  date: string,
  resolved: Awaited<ReturnType<typeof resolveOpsDutyReadOnly>>,
  rows: ReturnType<typeof opsDutyPanelRowsFromReadOnly>
) {
  return {
    date,
    source: resolved.source,
    persisted: resolved.source === "stored",
    count: rows.length,
    byRole: countByOpsRole(rows),
    caddyIds: [...new Set(rows.map((r) => r.caddyId))],
    rows,
    error: resolved.error,
  };
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const { start } = parseYmd(DATE);
  const createdIds: number[] = [];

  try {
    const a = await prisma.caddy.create({
      data: {
        name: `${TAG}A`,
        team: "1조",
        teamOrder: 1,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    const b = await prisma.caddy.create({
      data: {
        name: `${TAG}B`,
        team: "2조",
        teamOrder: 1,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    createdIds.push(a.id, b.id);

    await prisma.dailyOpsDuty.create({
      data: {
        date: start,
        role: "DUTY_AM",
        roleKey: "당번_조출_1",
        caddyId: a.id,
        rawName: a.name,
      },
    });

    const dutyBefore = await prisma.dailyOpsDuty.count({ where: { date: start } });
    const caddies = await prisma.caddy.findMany({
      select: { id: true, name: true, team: true, employmentStatus: true },
    });
    const baseResolved = await resolveOpsDutyReadOnly(DATE);
    const baseRows = opsDutyPanelRowsFromReadOnly(baseResolved, caddies);
    const getBefore = legacyGetJson(DATE, baseResolved, baseRows);

    const effectiveZero = await resolveEffectiveOpsDuty(DATE);
    assert(effectiveZero.overrideCount === 0, "시작 override 0");
    assert(
      JSON.stringify(legacyGetJson(DATE, baseResolved, baseRows).rows) ===
        JSON.stringify(getBefore.rows),
      "override 0 GET rows 안정"
    );
    assert(
      effectiveZero.rows.find((row) => row.roleKey === "당번_조출_1")?.caddyId === a.id,
      "override 0 effective = stored"
    );

    const setResult = await writeDailyOpsDutyOverride({
      date: DATE,
      roleKey: "당번_조출_1",
      action: "SET",
      caddyId: b.id,
      username: "local-146a",
      userId: 0,
    });
    assert(setResult.rows.find((row) => row.roleKey === "당번_조출_1")?.caddyId === b.id, "4. local SET");
    const dutyAfterSet = await prisma.dailyOpsDuty.count({ where: { date: start } });
    assert(dutyAfterSet === dutyBefore, "7. SET 후 DailyOpsDuty count 불변");

    const getResolvedAfterSet = await resolveOpsDutyReadOnly(DATE);
    const getRowsAfterSet = opsDutyPanelRowsFromReadOnly(getResolvedAfterSet, caddies);
    const getAfterSet = legacyGetJson(DATE, getResolvedAfterSet, getRowsAfterSet);
    assert(
      JSON.stringify(getAfterSet) === JSON.stringify(getBefore),
      "GET는 overlay를 적용하지 않아 기존 contract/값 유지"
    );

    const auditSet = await prisma.audit.findFirst({
      where: { action: "DAILY_OPS_DUTY_OVERRIDE_SET" },
      orderBy: { createdAt: "desc" },
    });
    const setPayload = (auditSet?.payload || {}) as Record<string, unknown>;
    assert(auditSet != null && setPayload.date === DATE && setPayload.roleKey === "당번_조출_1", "Audit SET");
    assert("before" in setPayload && "after" in setPayload && "userId" in setPayload, "Audit payload 필드");
    assert(auditSet?.createdAt instanceof Date, "Audit timestamp");

    const clearResult = await writeDailyOpsDutyOverride({
      date: DATE,
      roleKey: "당번_조출_1",
      action: "CLEAR",
      username: "local-146a",
      userId: 0,
    });
    assert(
      !clearResult.rows.some((row) => row.roleKey === "당번_조출_1"),
      "5. local CLEAR"
    );
    assert(
      (await prisma.dailyOpsDuty.count({ where: { date: start } })) === dutyBefore,
      "CLEAR 후 DailyOpsDuty 불변"
    );

    const restoreResult = await writeDailyOpsDutyOverride({
      date: DATE,
      roleKey: "당번_조출_1",
      action: "RESTORE",
      username: "local-146a",
      userId: 0,
    });
    assert(
      restoreResult.rows.find((row) => row.roleKey === "당번_조출_1")?.caddyId === a.id,
      "6. local RESTORE → stored"
    );
    assert(restoreResult.overrideCount === 0, "RESTORE 후 override 0");
    assert(
      (await prisma.dailyOpsDuty.count({ where: { date: start } })) === dutyBefore,
      "RESTORE 후 DailyOpsDuty 불변"
    );
    assert(
      (await prisma.dailyOpsDutyOverride.count({ where: { date: start } })) === 0,
      "RESTORE 후 override row 0"
    );
  } finally {
    await prisma.dailyOpsDutyOverride.deleteMany({ where: { date: start } });
    await prisma.dailyOpsDuty.deleteMany({ where: { date: start } });
    if (createdIds.length) {
      await prisma.caddy.deleteMany({ where: { id: { in: createdIds } } });
    }
    await prisma.$disconnect();
  }

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
