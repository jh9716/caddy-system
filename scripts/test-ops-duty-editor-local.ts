/**
 * LOCAL POSTGRESQL ONLY — GET slots after SET/CLEAR/RESTORE (#146B)
 *
 * DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local?schema=public \
 *   npm run test:ops-duty-editor-local
 */
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import { parseYmd } from "../src/lib/availabilityEngine";
import { countByOpsRole } from "../src/lib/dailyOpsDuty";
import { buildOpsDutySlotStates } from "../src/lib/opsDutyEffective";
import {
  listDailyOpsDutyOverrides,
  writeDailyOpsDutyOverride,
} from "../src/lib/opsDutyEffectiveService";
import { parseOpsDutyEditorSlots } from "../src/lib/opsDutyEditorView";
import {
  opsDutyPanelRowsFromReadOnly,
  resolveOpsDutyReadOnly,
} from "../src/lib/opsDutyReadOnlySource";

const DATE = "2099-12-27";
const TAG = "__OV146B__";
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

async function getLikePayload() {
  const caddies = await prisma.caddy.findMany({
    select: { id: true, name: true, team: true, employmentStatus: true },
  });
  const resolved = await resolveOpsDutyReadOnly(DATE);
  const rows = opsDutyPanelRowsFromReadOnly(resolved, caddies);
  const overrides = await listDailyOpsDutyOverrides(DATE);
  return {
    date: DATE,
    source: resolved.source,
    persisted: resolved.source === "stored",
    count: rows.length,
    byRole: countByOpsRole(rows),
    caddyIds: [...new Set(rows.map((r) => r.caddyId))],
    rows,
    error: resolved.error,
    slots: buildOpsDutySlotStates(rows, overrides),
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

    const before = await getLikePayload();
    const beforeSlots = parseOpsDutyEditorSlots(before);
    assert(beforeSlots != null, "override 0 GET slots 검증 통과");
    assert(
      beforeSlots?.find((slot) => slot.roleKey === "당번_조출_1")?.person?.caddyId === a.id,
      "초기 슬롯 = stored"
    );
    assert(
      beforeSlots?.every((slot) => slot.overridden === false),
      "초기 [수동] 없음"
    );
    assert(before.rows.find((row) => row.roleKey === "당번_조출_1")?.caddyId === a.id, "GET rows 기존 contract");

    await writeDailyOpsDutyOverride({
      date: DATE,
      roleKey: "당번_조출_1",
      action: "SET",
      caddyId: b.id,
      username: "local-146b",
      userId: 0,
    });
    const afterSet = await getLikePayload();
    const setSlots = parseOpsDutyEditorSlots(afterSet);
    const setSlot = setSlots?.find((slot) => slot.roleKey === "당번_조출_1");
    assert(setSlot?.person?.caddyId === b.id, "SET 후 슬롯 교체");
    assert(setSlot?.overridden === true && setSlot.overrideAction === "SET", "SET 후 [수동]");
    assert(
      afterSet.rows.find((row) => row.roleKey === "당번_조출_1")?.caddyId === a.id,
      "GET rows는 stored 유지"
    );
    assert(
      (await prisma.dailyOpsDuty.count({ where: { date: start } })) === dutyBefore,
      "DailyOpsDuty 불변"
    );

    await writeDailyOpsDutyOverride({
      date: DATE,
      roleKey: "당번_조출_1",
      action: "CLEAR",
      username: "local-146b",
      userId: 0,
    });
    const afterClear = await getLikePayload();
    const clearSlot = parseOpsDutyEditorSlots(afterClear)?.find(
      (slot) => slot.roleKey === "당번_조출_1"
    );
    assert(clearSlot?.person == null, "CLEAR 후 없음");
    assert(clearSlot?.overridden === true, "CLEAR 후 [수동]");

    await writeDailyOpsDutyOverride({
      date: DATE,
      roleKey: "당번_조출_1",
      action: "RESTORE",
      username: "local-146b",
      userId: 0,
    });
    const afterRestore = await getLikePayload();
    const restoreSlot = parseOpsDutyEditorSlots(afterRestore)?.find(
      (slot) => slot.roleKey === "당번_조출_1"
    );
    assert(restoreSlot?.person?.caddyId === a.id, "RESTORE 후 원본");
    assert(restoreSlot?.overridden === false, "RESTORE 후 [수동] 제거");
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
