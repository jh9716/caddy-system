/**
 * LOCAL POSTGRESQL ONLY — P3 벌당 수동 지정일 Preview/Apply
 *
 * DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local \
 *   npm run test:marshal-penalty-schedule-db
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import { MarshalRosterError, formatMarshalYmd } from "../src/lib/marshalDomain";
import {
  createPenaltyOccurrence,
} from "../src/lib/marshalPenaltyOccurrenceService";
import {
  applyPenaltyOccurrenceSchedule,
  previewPenaltyOccurrenceSchedule,
} from "../src/lib/marshalPenaltyScheduleService";
import {
  finalizeMonthPlan,
  generateMonthPlan,
  getMonthPlan,
  replaceMonthSlot,
} from "../src/lib/marshalRotationService";

const TAG = "__MARSHAL_OCC_P3__";
const YEAR = 2095;
const TARGET_MONTH = 11;
const NOV1 = `${YEAR}-11-01`;
const NOV2 = `${YEAR}-11-02`;
const NOV3 = `${YEAR}-11-03`;
const NOV6 = `${YEAR}-11-06`;
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
    where: { year: YEAR, month: { in: [10, 11, 12] } },
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
  const people = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const created = [];
  for (let i = 0; i < people.length; i += 1) {
    const caddy = await prisma.caddy.create({
      data: {
        name: `${TAG}${people[i]}`,
        team: "97조",
        teamOrder: i + 1,
        employeeCode: `OCC_P3_${YEAR}_${i + 1}`,
        phoneNormalized: `0102095${String(1000 + i).slice(-4)}`,
        employmentStatus: "ACTIVE",
        caddyType: "HOUSE",
      },
    });
    const profile = await prisma.marshalProfile.create({
      data: {
        caddyId: caddy.id,
        active: true,
        startedOn: new Date(`${YEAR}-01-01T00:00:00`),
        rotationOrder: 9101 + i,
      },
    });
    created.push({ name: people[i], caddy, profile });
  }
  return created;
}

async function generateTarget(replace = true) {
  return generateMonthPlan({
    year: YEAR,
    month: TARGET_MONTH,
    amSlotsPerDay: 2,
    pmSlotsPerDay: 1,
    startRotationOrder: 9101,
    replace,
  });
}

function penaltyDays(
  plan: NonNullable<Awaited<ReturnType<typeof getMonthPlan>>["plan"]>,
  caddyId: number
) {
  return [...new Set(
    plan.slots
      .filter((s) => s.caddyId === caddyId && s.source === "PENALTY")
      .map((s) => s.date)
  )].sort();
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
    const occA = await createPenaltyOccurrence(
      { caddyId: A.caddy.id, occurredOn: OCT1, reason: "p3-A" },
      prisma
    );
    const occB = await createPenaltyOccurrence(
      { caddyId: B.caddy.id, occurredOn: OCT2, reason: "p3-B" },
      prisma
    );
    const occC = await createPenaltyOccurrence(
      { caddyId: C.caddy.id, occurredOn: OCT3, reason: "p3-C" },
      prisma
    );
    await generateTarget();

    section("벌당 날짜 A 방식 이동 + 다른 벌당 유지");
    {
      const before = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      assert(
        before.penaltyOccurrences
          .filter((row) => row.status === "SCHEDULED")
          .sort((a, b) => a.occurredOn.localeCompare(b.occurredOn))
          .map((row) => row.scheduledOn)
          .join(",") === `${NOV1},${NOV2},${NOV3}`,
        "initial A Nov1 B Nov2 C Nov3"
      );
      const preview = await previewPenaltyOccurrenceSchedule(
        { id: occB.id, date: NOV6 },
        prisma
      );
      assert(preview.fromDate === NOV2 && preview.toDate === NOV6, "preview from/to");
      assert(
        preview.otherOccurrences.every((row) => row.unchanged),
        "preview keeps other occurrence dates"
      );
      const applied = await applyPenaltyOccurrenceSchedule(
        { id: occB.id, date: NOV6, previewToken: preview.previewToken },
        prisma
      );
      assert(applied.occurrence.scheduleSource === "MANUAL", "B is MANUAL");
      assert(applied.occurrence.pinnedOn === NOV6, "B pinned Nov 6");
      assert(applied.occurrence.scheduledOn === NOV6, "B scheduled Nov 6");
      const after = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      const byId = new Map(after.penaltyOccurrences.map((row) => [row.id, row]));
      assert(byId.get(occA.id)?.scheduledOn === NOV1, "A stays Nov 1");
      assert(byId.get(occC.id)?.scheduledOn === NOV3, "C stays Nov 3");
      assert(byId.get(occB.id)?.scheduledOn === NOV6, "B is Nov 6");
      assert(
        penaltyDays(after.plan!, A.caddy.id).join(",") === NOV1 &&
          penaltyDays(after.plan!, C.caddy.id).join(",") === NOV3 &&
          penaltyDays(after.plan!, B.caddy.id).join(",") === NOV6,
        "FULL_DAY pairs follow occurrence dates"
      );
      assert(
        after.plan!.slots.filter(
          (s) => s.date === NOV2 && s.caddyId === B.caddy.id && s.source === "PENALTY"
        ).length === 0,
        "B penalty pair left Nov 2"
      );
    }

    section("Audit 전후 기록");
    {
      const audits = await prisma.audit.findMany({
        where: {
          action: "MARSHAL_PENALTY_OCCURRENCE_SCHEDULE",
          entityId: occB.id,
        },
        orderBy: { id: "desc" },
        take: 1,
      });
      const payload = (audits[0]?.payload || {}) as Record<string, unknown>;
      assert(audits.length === 1, "schedule audit row");
      assert(
        payload.fromDate === NOV2 && payload.toDate === NOV6,
        "audit stores from/to"
      );
    }

    section("동일 날짜 충돌 409");
    {
      await throwsCode(
        () => previewPenaltyOccurrenceSchedule({ id: occC.id, date: NOV6 }, prisma),
        "date_taken",
        "cannot move C onto B's pinned day"
      );
    }

    section("대타 보존");
    {
      const view = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      const rotation = view.plan!.slots.find(
        (s) => s.date === NOV3 && s.source === "ROTATION" && s.caddyId !== C.caddy.id
      );
      const busy = new Set(
        view.plan!.slots.filter((s) => s.date === rotation!.date).map((s) => s.caddyId)
      );
      const subCaddy = roster.find((row) => !busy.has(row.caddy.id))!.caddy.id;
      const sub = await replaceMonthSlot({
        planId: view.plan!.id,
        slotId: rotation!.id,
        caddyId: subCaddy,
        asSubstitute: true,
      });
      const preview = await previewPenaltyOccurrenceSchedule(
        { id: occA.id, date: `${YEAR}-11-10` },
        prisma
      );
      await applyPenaltyOccurrenceSchedule(
        { id: occA.id, date: `${YEAR}-11-10`, previewToken: preview.previewToken },
        prisma
      );
      const after = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      assert(
        after.plan!.slots.some(
          (s) => s.id === sub.id && s.source === "SUBSTITUTE" && s.caddyId === subCaddy
        ),
        "substitute on untouched day survives B/A date apply"
      );
      const stillC = after.penaltyOccurrences.find((row) => row.id === occC.id);
      assert(stillC?.scheduledOn === NOV3, "C still Nov 3 after A move");
    }

    section("수동 지정 후 재생성");
    {
      await generateTarget();
      const view = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      const b = view.penaltyOccurrences.find((row) => row.id === occB.id);
      assert(b?.pinnedOn === NOV6 && b.scheduledOn === NOV6, "pin survives regenerate");
      assert(b?.scheduleSource === "MANUAL", "source stays MANUAL");
    }

    section("병가 날짜 거부");
    {
      await prisma.assignment.create({
        data: {
          caddyId: C.caddy.id,
          type: "SICK",
          startDate: new Date(`${YEAR}-11-12T00:00:00`),
          endDate: new Date(`${YEAR}-11-12T00:00:00`),
          comment: TAG,
        },
      });
      await throwsCode(
        () =>
          previewPenaltyOccurrenceSchedule(
            { id: occC.id, date: `${YEAR}-11-12` },
            prisma
          ),
        "sick_date",
        "sick date rejected"
      );
    }

    section("휴무 경고 후 승인");
    {
      await prisma.assignment.create({
        data: {
          caddyId: C.caddy.id,
          type: "OFF",
          startDate: new Date(`${YEAR}-11-13T00:00:00`),
          endDate: new Date(`${YEAR}-11-13T00:00:00`),
          comment: TAG,
        },
      });
      const preview = await previewPenaltyOccurrenceSchedule(
        { id: occC.id, date: `${YEAR}-11-13` },
        prisma
      );
      assert(preview.requiresOffConfirm === true, "preview warns OFF");
      await throwsCode(
        () =>
          applyPenaltyOccurrenceSchedule(
            { id: occC.id, date: `${YEAR}-11-13`, previewToken: preview.previewToken },
            prisma
          ),
        "off_confirm_required",
        "apply without confirmOff"
      );
      const preview2 = await previewPenaltyOccurrenceSchedule(
        { id: occC.id, date: `${YEAR}-11-13` },
        prisma
      );
      await applyPenaltyOccurrenceSchedule(
        {
          id: occC.id,
          date: `${YEAR}-11-13`,
          confirmOff: true,
          previewToken: preview2.previewToken,
        },
        prisma
      );
      const after = await prisma.marshalPenaltyOccurrence.findUnique({
        where: { id: occC.id },
      });
      assert(
        after && formatMarshalYmd(after.scheduledOn!) === `${YEAR}-11-13`,
        "OFF allowed after confirm"
      );
    }

    section("대상 월 범위 거부");
    {
      await throwsCode(
        () =>
          previewPenaltyOccurrenceSchedule(
            { id: occB.id, date: `${YEAR}-12-01` },
            prisma
          ),
        "date_out_of_month",
        "December rejected for November target"
      );
    }

    section("동시 수정 409");
    {
      const preview = await previewPenaltyOccurrenceSchedule(
        { id: occB.id, date: `${YEAR}-11-20` },
        prisma
      );
      await applyPenaltyOccurrenceSchedule(
        { id: occB.id, date: `${YEAR}-11-20`, previewToken: preview.previewToken },
        prisma
      );
      await throwsCode(
        () =>
          applyPenaltyOccurrenceSchedule(
            { id: occB.id, date: `${YEAR}-11-20`, previewToken: preview.previewToken },
            prisma
          ),
        "stale_preview",
        "reusing token after apply is 409"
      );
    }

    section("트랜잭션 롤백");
    {
      const before = await prisma.marshalPenaltyOccurrence.findUnique({
        where: { id: occA.id },
      });
      await throwsCode(
        () =>
          applyPenaltyOccurrenceSchedule(
            { id: occA.id, date: `${YEAR}-11-12`, previewToken: "nope" },
            prisma
          ),
        "stale_preview",
        "bad token rolls back"
      );
      const after = await prisma.marshalPenaltyOccurrence.findUnique({
        where: { id: occA.id },
      });
      assert(
        before &&
          after &&
          formatMarshalYmd(before.pinnedOn!) === formatMarshalYmd(after.pinnedOn!) &&
          formatMarshalYmd(before.scheduledOn!) === formatMarshalYmd(after.scheduledOn!),
        "failed apply does not change dates"
      );
    }

    section("일반 순번 영향은 Preview에 표시, 다른 날은 고정");
    {
      const preview = await previewPenaltyOccurrenceSchedule(
        { id: occA.id, date: `${YEAR}-11-21` },
        prisma
      );
      assert(
        preview.rotationImpact.displaced.length === 2 &&
          preview.rotationImpact.fillers.length === 2,
        "preview shows displaced rotation and fillers"
      );
      const untouchedDate = NOV3;
      const before = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      const beforeDay = before.plan!.slots
        .filter((s) => s.date === untouchedDate)
        .map((s) => `${s.id}:${s.caddyId}:${s.source}`)
        .sort();
      await applyPenaltyOccurrenceSchedule(
        {
          id: occA.id,
          date: `${YEAR}-11-21`,
          previewToken: preview.previewToken,
        },
        prisma
      );
      const after = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      const afterDay = after.plan!.slots
        .filter((s) => s.date === untouchedDate)
        .map((s) => `${s.id}:${s.caddyId}:${s.source}`)
        .sort();
      assert(
        beforeDay.join("|") === afterDay.join("|"),
        "untouched day slots identical"
      );
    }

    section("FINALIZED 보호");
    {
      const view = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      await finalizeMonthPlan({ id: view.plan!.id });
      await throwsCode(
        () => previewPenaltyOccurrenceSchedule({ id: occB.id, date: NOV6 }, prisma),
        "finalized_locked",
        "cannot preview on FINALIZED"
      );
    }

    section("생성 전 수동 지정 후 첫 생성");
    {
      await prisma.marshalMonthPlan.updateMany({
        where: { year: YEAR, month: TARGET_MONTH },
        data: { status: "DRAFT" },
      });
      const oldPlans = await prisma.marshalMonthPlan.findMany({
        where: { year: YEAR, month: TARGET_MONTH },
        select: { id: true },
      });
      const oldIds = oldPlans.map((row) => row.id);
      await prisma.marshalRotationCredit.updateMany({
        where: { consumedPlanId: { in: oldIds } },
        data: { status: "OPEN", consumedPlanId: null, consumedDate: null },
      });
      await prisma.marshalPenaltyOccurrence.deleteMany({
        where: { caddyId: { in: ids } },
      });
      if (oldIds.length) {
        await prisma.marshalMonthSlot.deleteMany({ where: { planId: { in: oldIds } } });
        await prisma.marshalPenaltyDuty.deleteMany({ where: { planId: { in: oldIds } } });
        await prisma.marshalMonthPlan.deleteMany({ where: { id: { in: oldIds } } });
      }
      const earlyA = await createPenaltyOccurrence(
        { caddyId: A.caddy.id, occurredOn: OCT1, reason: "pre-A" },
        prisma
      );
      const earlyB = await createPenaltyOccurrence(
        { caddyId: B.caddy.id, occurredOn: OCT2, reason: "pre-B" },
        prisma
      );
      const preview = await previewPenaltyOccurrenceSchedule(
        { id: earlyB.id, date: NOV6 },
        prisma
      );
      await applyPenaltyOccurrenceSchedule(
        { id: earlyB.id, date: NOV6, previewToken: preview.previewToken },
        prisma
      );
      const pinned = await prisma.marshalPenaltyOccurrence.findUnique({
        where: { id: earlyB.id },
      });
      assert(
        pinned?.status === "OPEN" &&
          pinned.pinnedOn &&
          formatMarshalYmd(pinned.pinnedOn) === NOV6,
        "pin stored before first generate"
      );
      await generateTarget();
      const view = await getMonthPlan({ year: YEAR, month: TARGET_MONTH });
      const a = view.penaltyOccurrences.find((row) => row.id === earlyA.id);
      const b = view.penaltyOccurrences.find((row) => row.id === earlyB.id);
      assert(a?.scheduledOn === NOV1, "A auto Nov 1");
      assert(b?.scheduledOn === NOV6 && b.scheduleSource === "MANUAL", "B pin Nov 6");
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
