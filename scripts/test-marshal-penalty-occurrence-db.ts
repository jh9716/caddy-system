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
      await throwsCode(
        () =>
          createPenaltyOccurrence(
            {
              caddyId: A.caddy.id,
              occurredOn: OCT1,
              reason: "중복",
            },
            prisma
          ),
        "duplicate_occurrence",
        "same caddy+occurredOn 409"
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

    section("동시 등록은 unique 충돌만 통과");
    {
      const occurredOn = `${YEAR}-10-18`;
      const results = await Promise.allSettled([
        createPenaltyOccurrence(
          { caddyId: C.caddy.id, occurredOn, reason: "concurrent-a" },
          prisma
        ),
        createPenaltyOccurrence(
          { caddyId: C.caddy.id, occurredOn, reason: "concurrent-b" },
          prisma
        ),
      ]);
      const ok = results.filter((row) => row.status === "fulfilled");
      const dup = results.filter(
        (row) =>
          row.status === "rejected" &&
          row.reason instanceof MarshalRosterError &&
          row.reason.code === "duplicate_occurrence"
      );
      assert(ok.length === 1, "one concurrent create succeeds");
      assert(dup.length === 1, "other concurrent create is 409");
      const count = await prisma.marshalPenaltyOccurrence.count({
        where: { caddyId: C.caddy.id, occurredOn: new Date(`${occurredOn}T00:00:00`) },
      });
      assert(count === 1, "only one occurrence row");
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
