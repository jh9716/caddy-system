/**
 * LOCAL POSTGRESQL ONLY — 마샬 벌당 발생 P2 저장/배정/재생성
 *
 * DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local \
 *   npm run test:marshal-penalty-occurrence-db
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import { MarshalRosterError, formatMarshalYmd } from "../src/lib/marshalDomain";
import {
  cancelPenaltyOccurrence,
  createPenaltyOccurrence,
  listPenaltyOccurrences,
} from "../src/lib/marshalPenaltyOccurrenceService";
import {
  createPenaltyDuty,
  finalizeMonthPlan,
  generateMonthPlan,
  getMonthPlan,
  replaceMonthSlot,
  upsertMonthPlanSettings,
} from "../src/lib/marshalRotationService";

const TAG = "__MARSHAL_OCC_P2__";
const YEAR = 2096;
const OCCURRED_MONTH = 10;
const TARGET_MONTH = 11;
const FINAL_MONTH = 12;
const NOV1 = `${YEAR}-11-01`;
const NOV2 = `${YEAR}-11-02`;
const NOV3 = `${YEAR}-11-03`;
const OCT1 = `${YEAR}-10-01`;
const OCT2 = `${YEAR}-10-02`;
const OCT3 = `${YEAR}-10-03`;

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

function section(title: string) {
  console.log("\n==", title, "==");
}

async function throwsCode(
  fn: () => Promise<unknown>,
  code: string,
  msg: string
) {
  try {
    await fn();
    assert(false, msg);
  } catch (e) {
    assert(e instanceof MarshalRosterError && e.code === code, msg);
  }
}

async function cleanup() {
  const caddies = await prisma.caddy.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const caddyIds = caddies.map((row) => row.id);
  const profiles = caddyIds.length
    ? await prisma.marshalProfile.findMany({
        where: { caddyId: { in: caddyIds } },
        select: { id: true },
      })
    : [];
  const profileIds = profiles.map((row) => row.id);
  const plans = await prisma.marshalMonthPlan.findMany({
    where: { year: YEAR, month: { in: [OCCURRED_MONTH, TARGET_MONTH, FINAL_MONTH] } },
    select: { id: true },
  });
  const planIds = plans.map((row) => row.id);
  if (caddyIds.length) {
    await prisma.marshalPenaltyOccurrence.deleteMany({
      where: { caddyId: { in: caddyIds } },
    });
    await prisma.assignment.deleteMany({ where: { caddyId: { in: caddyIds } } });
  }
  if (planIds.length) {
    await prisma.marshalMonthSlot.deleteMany({ where: { planId: { in: planIds } } });
    await prisma.marshalPenaltyDuty.deleteMany({ where: { planId: { in: planIds } } });
    await prisma.marshalPenaltyOccurrence.deleteMany({
      where: { scheduledPlanId: { in: planIds } },
    });
    await prisma.marshalMonthPlan.deleteMany({ where: { id: { in: planIds } } });
  }
  if (profileIds.length) {
    await prisma.marshalRotationCredit.deleteMany({
      where: { marshalProfileId: { in: profileIds } },
    });
  }
  if (caddyIds.length) {
    await prisma.marshalProfile.deleteMany({ where: { caddyId: { in: caddyIds } } });
    await prisma.caddy.deleteMany({ where: { id: { in: caddyIds } } });
  }
}

async function seedRoster() {
  const people = ["A", "B", "C", "D", "E", "F"];
  const created = [];
  for (let i = 0; i < people.length; i += 1) {
    const caddy = await prisma.caddy.create({
      data: {
        name: `${TAG}${people[i]}`,
        team: "98조",
        teamOrder: i + 1,
        employeeCode: `OCC_P2_${YEAR}_${i + 1}`,
        phoneNormalized: `0102096${String(1000 + i).slice(-4)}`,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    const profile = await prisma.marshalProfile.create({
      data: {
        caddyId: caddy.id,
        active: true,
        startedOn: new Date(`${YEAR}-01-01T00:00:00`),
        rotationOrder: 9201 + i,
      },
    });
    created.push({ name: people[i], caddy, profile });
  }
  return created;
}

async function wipeOccurrences(caddyIds: number[]) {
  await prisma.marshalPenaltyOccurrence.deleteMany({
    where: { caddyId: { in: caddyIds } },
  });
}

async function generateTarget(replace = true) {
  return generateMonthPlan({
    year: YEAR,
    month: TARGET_MONTH,
    amSlotsPerDay: 2,
    pmSlotsPerDay: 1,
    startRotationOrder: 9201,
    replace,
  });
}

function penaltySlotsOn(
  plan: NonNullable<Awaited<ReturnType<typeof getMonthPlan>>["plan"]>,
  date: string,
  caddyId: number
) {
  return plan.slots.filter(
    (s) => s.date === date && s.caddyId === caddyId && s.source === "PENALTY"
  );
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL, "caddy_local only");
  await cleanup();
  const roster = await seedRoster();
  const A = roster[0];
  const B = roster[1];
  const C = roster[2];
  const D = roster[3];
  const ids = roster.map((row) => row.caddy.id);

  try {
    section("월표 없이 벌당 발생 기록");
    {
      const beforePlans = await prisma.marshalMonthPlan.count({
        where: { year: YEAR, month: TARGET_MONTH },
      });
      const row = await createPenaltyOccurrence(
        {
          caddyId: A.caddy.id,
          occurredOn: OCT1,
          reason: "월표 없이 기록",
        },
        prisma
      );
      assert(row.status === "OPEN" && row.scheduledOn == null, "OPEN, no scheduledOn");
      assert(
        row.targetYear === YEAR && row.targetMonth === TARGET_MONTH,
        "target is next month"
      );
      assert(
        (await prisma.marshalMonthPlan.count({
          where: { year: YEAR, month: TARGET_MONTH },
        })) === beforePlans,
        "did not create a month plan"
      );
    }

    section("다음 달 월표 생성 시 1일부터 FULL_DAY 배정");
    {
      const generated = await generateTarget();
      assert(generated.assignedOccurrences === 1, "one occurrence scheduled");
      const view = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      const aSlots = penaltySlotsOn(view.plan!, NOV1, A.caddy.id);
      assert(
        aSlots.length === 2 &&
          aSlots.some((s) => s.shift === "AM") &&
          aSlots.some((s) => s.shift === "PM"),
        "A FULL_DAY AM+PM on Nov 1"
      );
      assert(
        view.plan!.slots.filter((s) => s.date === NOV1 && s.source === "ROTATION")
          .length === 1,
        "remaining slot is rotation"
      );
      assert(
        !view.plan!.slots.some(
          (s) => s.date === NOV1 && s.source === "ROTATION" && s.caddyId === A.caddy.id
        ),
        "A rotation turn is not consumed"
      );
      const dutyCount = await prisma.marshalPenaltyDuty.count({
        where: { planId: view.plan!.id },
      });
      assert(dutyCount === 0, "no MarshalPenaltyDuty materialized");
      const occ = view.penaltyOccurrences.find((row) => row.caddyId === A.caddy.id);
      assert(
        occ?.status === "SCHEDULED" && occ.scheduledOn === NOV1,
        "occurrence SCHEDULED on Nov 1"
      );
    }

    section("동일 캐디 여러 건은 연속 날짜");
    {
      await createPenaltyOccurrence(
        { caddyId: A.caddy.id, occurredOn: OCT2, reason: "두번째" },
        prisma
      );
      await createPenaltyOccurrence(
        { caddyId: A.caddy.id, occurredOn: OCT3, reason: "세번째" },
        prisma
      );
      await generateTarget();
      const view = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      const scheduled = view.penaltyOccurrences
        .filter((row) => row.caddyId === A.caddy.id && row.status === "SCHEDULED")
        .map((row) => row.scheduledOn)
        .sort();
      assert(
        scheduled.join(",") === `${NOV1},${NOV2},${NOV3}`,
        "A three occurrences → Nov 1-3"
      );
      assert(
        penaltySlotsOn(view.plan!, NOV2, A.caddy.id).length === 2,
        "Nov 2 also FULL_DAY"
      );
    }

    section("병가 날짜는 건너뛴다");
    {
      await wipeOccurrences(ids);
      await createPenaltyOccurrence(
        { caddyId: A.caddy.id, occurredOn: OCT1, reason: "병가-skip" },
        prisma
      );
      await prisma.assignment.create({
        data: {
          caddyId: A.caddy.id,
          type: "SICK",
          startDate: new Date(`${NOV1}T00:00:00`),
          endDate: new Date(`${NOV1}T00:00:00`),
          comment: TAG,
        },
      });
      await generateTarget();
      const view = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      const occ = view.penaltyOccurrences.find((row) => row.caddyId === A.caddy.id);
      assert(occ?.scheduledOn === NOV2, "skip sick Nov 1 → Nov 2");
      assert(
        penaltySlotsOn(view.plan!, NOV1, A.caddy.id).length === 0,
        "no A penalty on sick day"
      );
      await prisma.assignment.deleteMany({
        where: { caddyId: A.caddy.id, comment: TAG },
      });
    }

    section("일반 휴무는 배정하고 경고만");
    {
      await wipeOccurrences(ids);
      await createPenaltyOccurrence(
        { caddyId: A.caddy.id, occurredOn: OCT1, reason: "휴무" },
        prisma
      );
      await prisma.assignment.create({
        data: {
          caddyId: A.caddy.id,
          type: "OFF",
          startDate: new Date(`${NOV1}T00:00:00`),
          endDate: new Date(`${NOV1}T00:00:00`),
          comment: TAG,
        },
      });
      await generateTarget();
      const view = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      const occ = view.penaltyOccurrences.find((row) => row.caddyId === A.caddy.id);
      const aSlots = penaltySlotsOn(view.plan!, NOV1, A.caddy.id);
      assert(occ?.scheduledOn === NOV1, "OFF day still assigned");
      assert(
        aSlots.length === 2 && aSlots.every((s) => s.warning === "휴무 충돌"),
        "OFF keeps P1 warning"
      );
      await prisma.assignment.deleteMany({
        where: { caddyId: A.caddy.id, comment: TAG },
      });
    }

    section("기존 전일 벌당이 있으면 다음 날, 정원 초과는 대기");
    {
      await wipeOccurrences(ids);
      await prisma.marshalPenaltyDuty.deleteMany({
        where: { plan: { year: YEAR, month: TARGET_MONTH } },
      });
      await createPenaltyDuty({
        year: YEAR,
        month: TARGET_MONTH,
        date: NOV1,
        caddyId: C.caddy.id,
        shift: "AM",
        coverage: "FULL_DAY",
        reason: "기존 전일",
      });
      await createPenaltyOccurrence(
        { caddyId: A.caddy.id, occurredOn: OCT1, reason: "정원" },
        prisma
      );
      await generateTarget();
      const view = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      const occA = view.penaltyOccurrences.find((row) => row.caddyId === A.caddy.id);
      assert(occA?.scheduledOn === NOV2, "existing FULL_DAY pushes A to Nov 2");
      await prisma.marshalPenaltyDuty.deleteMany({
        where: { plan: { year: YEAR, month: TARGET_MONTH } },
      });

      await wipeOccurrences(ids);
      for (let day = 1; day <= 31; day += 1) {
        const ymd = `${YEAR}-10-${String(day).padStart(2, "0")}`;
        await createPenaltyOccurrence(
          {
            caddyId: A.caddy.id,
            occurredOn: ymd,
            reason: `초과-${day}`,
          },
          prisma
        );
      }
      const packed = await generateTarget();
      assert(packed.assignedOccurrences === 30, "Nov has 30 FULL_DAY days");
      assert(packed.leftoverOccurrences === 1, "31st stays leftover");
      const leftover = await prisma.marshalPenaltyOccurrence.findFirst({
        where: {
          caddyId: A.caddy.id,
          status: "OPEN",
          targetYear: YEAR,
          targetMonth: TARGET_MONTH,
        },
      });
      assert(
        leftover != null && Boolean(leftover.deferReason),
        "leftover OPEN with deferReason"
      );
      const scheduledCount = await prisma.marshalPenaltyOccurrence.count({
        where: {
          caddyId: A.caddy.id,
          status: "SCHEDULED",
          targetYear: YEAR,
          targetMonth: TARGET_MONTH,
        },
      });
      assert(scheduledCount === 30, "did not delete unassigned");
    }

    section("재생성해도 중복 배정되지 않는다");
    {
      const before = await prisma.marshalPenaltyOccurrence.findMany({
        where: { caddyId: A.caddy.id, status: "SCHEDULED" },
        orderBy: { id: "asc" },
      });
      await generateTarget();
      await generateTarget();
      const after = await prisma.marshalPenaltyOccurrence.findMany({
        where: { caddyId: A.caddy.id, status: "SCHEDULED" },
        orderBy: { id: "asc" },
      });
      assert(before.length === after.length, "scheduled count stable");
      assert(
        before.every(
          (row, i) =>
            row.id === after[i].id &&
            formatMarshalYmd(row.scheduledOn!) === formatMarshalYmd(after[i].scheduledOn!)
        ),
        "same ids and scheduledOn after regenerate"
      );
      const view = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      const aPenaltyDays = new Set(
        view.plan!.slots
          .filter((s) => s.caddyId === A.caddy.id && s.source === "PENALTY")
          .map((s) => s.date)
      );
      assert(aPenaltyDays.size === 30, "still 30 penalty days, not 60");
    }

    section("SCHEDULED 취소 후 FINALIZE 차단·재생성·다른 벌당·대타 보존");
    {
      await wipeOccurrences(ids);
      await prisma.marshalPenaltyDuty.deleteMany({
        where: { plan: { year: YEAR, month: TARGET_MONTH } },
      });
      const occA = await createPenaltyOccurrence(
        { caddyId: A.caddy.id, occurredOn: OCT1, reason: "cancel-A" },
        prisma
      );
      const occB = await createPenaltyOccurrence(
        { caddyId: B.caddy.id, occurredOn: OCT2, reason: "keep-B" },
        prisma
      );
      await generateTarget();
      const beforeCancel = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      const rotationSlot = beforeCancel.plan!.slots.find(
        (s) => s.date === NOV1 && s.source === "ROTATION"
      );
      const subCaddyId =
        rotationSlot!.caddyId === C.caddy.id ? D.caddy.id : C.caddy.id;
      const sub = await replaceMonthSlot({
        planId: beforeCancel.plan!.id,
        slotId: rotationSlot!.id,
        caddyId: subCaddyId,
        asSubstitute: true,
      });
      assert(sub.source === "SUBSTITUTE" && sub.caddyId === subCaddyId, "manual sub placed");
      await cancelPenaltyOccurrence({ id: occA.id }, prisma);
      const stale = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      assert(stale.plan!.needsRegeneration === true, "cancel marks needsRegeneration");
      assert(stale.plan!.status === "DRAFT", "plan stays DRAFT");
      const stillB = stale.penaltyOccurrences.find((row) => row.id === occB.id);
      assert(stillB?.status === "SCHEDULED", "other occurrence stays SCHEDULED");
      assert(
        penaltySlotsOn(stale.plan!, stillB!.scheduledOn!, B.caddy.id).length === 2,
        "B FULL_DAY pair still present"
      );
      assert(
        penaltySlotsOn(stale.plan!, NOV1, A.caddy.id).length === 2,
        "cancelled A slots remain until regenerate"
      );
      assert(
        stale.plan!.slots.some(
          (s) => s.id === sub.id && s.source === "SUBSTITUTE" && s.caddyId === subCaddyId
        ),
        "substitute not silently deleted on cancel"
      );
      await throwsCode(
        () => finalizeMonthPlan({ id: stale.plan!.id }),
        "regeneration_required",
        "stale DRAFT cannot FINALIZE"
      );
      assert(
        (await prisma.marshalMonthPlan.findUnique({ where: { id: stale.plan!.id } }))
          ?.status === "DRAFT",
        "failed finalize stays DRAFT"
      );
      await generateTarget();
      const refreshed = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      assert(refreshed.plan!.needsRegeneration === false, "regenerate clears stale flag");
      assert(
        penaltySlotsOn(refreshed.plan!, NOV1, A.caddy.id).length === 0,
        "cancelled A not rescheduled"
      );
      const bAfter = refreshed.penaltyOccurrences.find((row) => row.id === occB.id);
      assert(bAfter?.status === "SCHEDULED", "B still scheduled after regenerate");
      assert(
        penaltySlotsOn(refreshed.plan!, bAfter!.scheduledOn!, B.caddy.id).length === 2,
        "B FULL_DAY pair preserved through regenerate"
      );
    }

    section("후출 2명이어도 벌당 하루 1명");
    {
      await wipeOccurrences(ids);
      await createPenaltyOccurrence(
        { caddyId: A.caddy.id, occurredOn: OCT1, reason: "pm2-A" },
        prisma
      );
      await createPenaltyOccurrence(
        { caddyId: B.caddy.id, occurredOn: OCT2, reason: "pm2-B" },
        prisma
      );
      await createPenaltyOccurrence(
        { caddyId: C.caddy.id, occurredOn: OCT3, reason: "pm2-C" },
        prisma
      );
      await generateMonthPlan({
        year: YEAR,
        month: TARGET_MONTH,
        amSlotsPerDay: 2,
        pmSlotsPerDay: 2,
        startRotationOrder: 9201,
        replace: true,
      });
      const view = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      const scheduled = view.penaltyOccurrences
        .filter((row) => row.status === "SCHEDULED")
        .sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));
      assert(
        scheduled.map((row) => `${row.caddyId}:${row.scheduledOn}`).join(",") ===
          `${A.caddy.id}:${NOV1},${B.caddy.id}:${NOV2},${C.caddy.id}:${NOV3}`,
        "A Nov1, B Nov2, C Nov3 even when PM=2"
      );
      const nov1PenaltyPeople = new Set(
        view.plan!.slots
          .filter((s) => s.date === NOV1 && s.source === "PENALTY")
          .map((s) => s.caddyId)
      );
      assert(nov1PenaltyPeople.size === 1, "Nov 1 has one penalty person");
    }

    section("같은 캐디 같은 날 벌당 2건 + idempotency");
    {
      await wipeOccurrences(ids);
      const first = await createPenaltyOccurrence(
        {
          caddyId: A.caddy.id,
          occurredOn: OCT1,
          reason: "twin-1",
          idempotencyKey: "occ-a-oct1-1",
        },
        prisma
      );
      const second = await createPenaltyOccurrence(
        {
          caddyId: A.caddy.id,
          occurredOn: OCT1,
          reason: "twin-2",
          idempotencyKey: "occ-a-oct1-2",
        },
        prisma
      );
      assert(first.id !== second.id, "two occurrence ids");
      const replay = await createPenaltyOccurrence(
        {
          caddyId: A.caddy.id,
          occurredOn: OCT1,
          reason: "twin-1",
          idempotencyKey: "occ-a-oct1-1",
        },
        prisma
      );
      assert(replay.replayed === true && replay.id === first.id, "replay returns same id");
      await throwsCode(
        () =>
          createPenaltyOccurrence(
            {
              caddyId: B.caddy.id,
              occurredOn: OCT2,
              reason: "clash",
              idempotencyKey: "occ-a-oct1-1",
            },
            prisma
          ),
        "idempotency_conflict",
        "same key different payload 409"
      );
      await generateMonthPlan({
        year: YEAR,
        month: TARGET_MONTH,
        amSlotsPerDay: 2,
        pmSlotsPerDay: 1,
        startRotationOrder: 9201,
        replace: true,
      });
      const view = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      const days = view.penaltyOccurrences
        .filter((row) => row.caddyId === A.caddy.id && row.status === "SCHEDULED")
        .map((row) => row.scheduledOn)
        .sort();
      assert(days.join(",") === `${NOV1},${NOV2}`, "two duties on consecutive days");
    }

    section("병가 건너뛰기 후에도 발생 순서 보존");
    {
      await wipeOccurrences(ids);
      await prisma.assignment.deleteMany({ where: { comment: TAG } });
      await createPenaltyOccurrence(
        { caddyId: A.caddy.id, occurredOn: OCT1, reason: "order-A" },
        prisma
      );
      await createPenaltyOccurrence(
        { caddyId: B.caddy.id, occurredOn: OCT2, reason: "order-B" },
        prisma
      );
      await prisma.assignment.create({
        data: {
          caddyId: A.caddy.id,
          type: "SICK",
          startDate: new Date(`${NOV1}T00:00:00`),
          endDate: new Date(`${NOV1}T00:00:00`),
          comment: TAG,
        },
      });
      await generateTarget();
      const view = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      const a = view.penaltyOccurrences.find((row) => row.caddyId === A.caddy.id);
      const b = view.penaltyOccurrences.find((row) => row.caddyId === B.caddy.id);
      assert(a?.scheduledOn === NOV2, "A skips Nov 1 → Nov 2");
      assert(b?.scheduledOn === NOV3, "B does not take Nov 1 ahead of A");
      await prisma.assignment.deleteMany({ where: { comment: TAG } });
    }

    section("트랜잭션 롤백: duty overflow 시 occurrence 미적용");
    {
      await wipeOccurrences(ids);
      await prisma.marshalPenaltyDuty.deleteMany({
        where: { plan: { year: YEAR, month: TARGET_MONTH } },
      });
      const openOcc = await createPenaltyOccurrence(
        { caddyId: A.caddy.id, occurredOn: OCT1, reason: "rollback" },
        prisma
      );
      await createPenaltyDuty({
        year: YEAR,
        month: TARGET_MONTH,
        date: NOV1,
        caddyId: B.caddy.id,
        shift: "AM",
        coverage: "FULL_DAY",
        reason: "overflow-b",
      });
      await createPenaltyDuty({
        year: YEAR,
        month: TARGET_MONTH,
        date: NOV1,
        caddyId: C.caddy.id,
        shift: "AM",
        coverage: "FULL_DAY",
        reason: "overflow-c",
      });
      const before = await prisma.marshalMonthSlot.findMany({
        where: { plan: { year: YEAR, month: TARGET_MONTH } },
        orderBy: [{ date: "asc" }, { id: "asc" }],
      });
      await throwsCode(
        () => generateTarget(),
        "penalty_overflow",
        "two FULL_DAY duties overflow generate"
      );
      const afterOcc = await prisma.marshalPenaltyOccurrence.findUnique({
        where: { id: openOcc.id },
      });
      assert(afterOcc?.status === "OPEN", "overflow rolls back occurrence schedule");
      const afterSlots = await prisma.marshalMonthSlot.findMany({
        where: { plan: { year: YEAR, month: TARGET_MONTH } },
        orderBy: [{ date: "asc" }, { id: "asc" }],
      });
      assert(
        before.length === afterSlots.length &&
          before.every((row, i) => row.id === afterSlots[i].id),
        "overflow generate rolls back slots"
      );
      await prisma.marshalPenaltyDuty.deleteMany({
        where: { plan: { year: YEAR, month: TARGET_MONTH } },
      });
    }

    section("취소 및 FINALIZED 보호");
    {
      await wipeOccurrences(ids);
      const openRow = await createPenaltyOccurrence(
        { caddyId: B.caddy.id, occurredOn: OCT1, reason: "취소대상" },
        prisma
      );
      const cancelled = await cancelPenaltyOccurrence({ id: openRow.id }, prisma);
      assert(cancelled.status === "CANCELLED", "OPEN cancel → CANCELLED");
      await generateTarget();
      const afterGen = await listPenaltyOccurrences(
        { year: YEAR, month: TARGET_MONTH },
        prisma
      );
      assert(
        afterGen.find((row) => row.id === openRow.id)?.status === "CANCELLED",
        "cancelled stays cancelled through generate"
      );

      const live = await createPenaltyOccurrence(
        { caddyId: A.caddy.id, occurredOn: `${YEAR}-11-01`, reason: "12월 대상" },
        prisma
      );
      assert(live.targetMonth === FINAL_MONTH, "Nov occurredOn → Dec target");
      await generateMonthPlan({
        year: YEAR,
        month: FINAL_MONTH,
        amSlotsPerDay: 2,
        pmSlotsPerDay: 1,
        startRotationOrder: 9201,
        replace: true,
      });
      const dec = await getMonthPlan({ year: YEAR, month: FINAL_MONTH });
      await finalizeMonthPlan({ id: dec.plan!.id });
      await throwsCode(
        () =>
          createPenaltyOccurrence(
            {
              caddyId: B.caddy.id,
              occurredOn: `${YEAR}-11-02`,
              reason: "finalized-block",
            },
            prisma
          ),
        "finalized_locked",
        "cannot register targeting FINALIZED month"
      );
      await throwsCode(
        () => cancelPenaltyOccurrence({ id: live.id }, prisma),
        "finalized_locked",
        "cannot cancel SCHEDULED on FINALIZED"
      );
      await throwsCode(
        () =>
          generateMonthPlan({
            year: YEAR,
            month: FINAL_MONTH,
            startRotationOrder: 9201,
            replace: true,
          }),
        "finalized_locked",
        "cannot regenerate FINALIZED"
      );
    }

    section("동시 등록: 별건 2건 vs 같은 idempotency key");
    {
      const occurredOn = `${YEAR}-10-18`;
      const distinct = await Promise.allSettled([
        createPenaltyOccurrence(
          { caddyId: C.caddy.id, occurredOn, reason: "concurrent-a" },
          prisma
        ),
        createPenaltyOccurrence(
          { caddyId: C.caddy.id, occurredOn, reason: "concurrent-b" },
          prisma
        ),
      ]);
      const distinctOk = distinct.filter((row) => row.status === "fulfilled");
      assert(distinctOk.length === 2, "no-key concurrent creates two genuine rows");
      const count = await prisma.marshalPenaltyOccurrence.count({
        where: { caddyId: C.caddy.id, occurredOn: new Date(`${occurredOn}T00:00:00`) },
      });
      assert(count === 2, "same day two occurrence rows");

      const key = "concurrent-same-key";
      const keyed = await Promise.allSettled([
        createPenaltyOccurrence(
          {
            caddyId: B.caddy.id,
            occurredOn: `${YEAR}-10-19`,
            reason: "keyed",
            idempotencyKey: key,
          },
          prisma
        ),
        createPenaltyOccurrence(
          {
            caddyId: B.caddy.id,
            occurredOn: `${YEAR}-10-19`,
            reason: "keyed",
            idempotencyKey: key,
          },
          prisma
        ),
      ]);
      const keyedOk = keyed.filter((row) => row.status === "fulfilled");
      assert(keyedOk.length === 2, "same-key concurrent both return");
      const keyedIds = new Set(
        keyedOk.map(
          (row) =>
            (row as PromiseFulfilledResult<{ id: number }>).value.id
        )
      );
      assert(keyedIds.size === 1, "same-key concurrent is one occurrence");
    }

    section("동시 월표 생성도 중복 배정하지 않는다");
    {
      await wipeOccurrences([A.caddy.id]);
      await createPenaltyOccurrence(
        { caddyId: A.caddy.id, occurredOn: `${YEAR}-10-20`, reason: "concurrent-gen" },
        prisma
      );
      const results = await Promise.allSettled([
        generateTarget(),
        generateTarget(),
      ]);
      const ok = results.filter((row) => row.status === "fulfilled");
      assert(ok.length === 2, "both generates complete");
      const scheduled = await prisma.marshalPenaltyOccurrence.findMany({
        where: {
          caddyId: A.caddy.id,
          occurredOn: new Date(`${YEAR}-10-20T00:00:00`),
        },
      });
      assert(scheduled.length === 1, "one occurrence row after concurrent generate");
      assert(scheduled[0].status === "SCHEDULED", "it is scheduled once");
      const view = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      const days = new Set(
        view.plan!.slots
          .filter((s) => s.caddyId === A.caddy.id && s.source === "PENALTY")
          .map((s) => s.date)
      );
      assert(days.size === 1, "A has exactly one penalty day");
    }
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  if (failed > 0) {
    console.error(`\nFAIL ${failed} (passed ${passed})`);
    process.exit(1);
  }
  console.log(`\nOK ${passed}`);
}

main().catch(async (error) => {
  console.error(error);
  try {
    await cleanup();
  } catch {
    // ignore
  }
  await prisma.$disconnect();
  process.exit(1);
});
