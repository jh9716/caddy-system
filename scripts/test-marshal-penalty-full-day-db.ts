/**
 * LOCAL POSTGRESQL ONLY — 마샬 전일 벌당 P1 저장/유니크/대타 잠금
 *
 * DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local \
 *   npm run test:marshal-penalty-full-day-db
 */
import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import { MarshalRosterError, formatMarshalYmd } from "../src/lib/marshalDomain";
import { loadFinalizedMarshalMonthDuty } from "../src/lib/marshalMonthDutySource";
import {
  createPenaltyDuty,
  generateMonthPlan,
  getMonthPlan,
  replaceMonthSlot,
  upsertMonthPlanSettings,
  finalizeMonthPlan,
  changeRotationCredit,
} from "../src/lib/marshalRotationService";

const TAG = "__MARSHAL_FD_P1__";
const YEAR = 2097;
const MONTH = 11;
const UNIQUE_MONTH = 12;
const DAY1 = `${YEAR}-11-01`;

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
    where: { year: YEAR, month: { in: [MONTH, UNIQUE_MONTH] } },
    select: { id: true },
  });
  const planIds = plans.map((row) => row.id);
  if (planIds.length) {
    await prisma.marshalMonthSlot.deleteMany({ where: { planId: { in: planIds } } });
    await prisma.marshalPenaltyDuty.deleteMany({ where: { planId: { in: planIds } } });
    await prisma.marshalMonthPlan.deleteMany({ where: { id: { in: planIds } } });
  }
  if (profileIds.length) {
    await prisma.marshalRotationCredit.deleteMany({
      where: { marshalProfileId: { in: profileIds } },
    });
  }
  if (caddyIds.length) {
    await prisma.assignment.deleteMany({ where: { caddyId: { in: caddyIds } } });
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
        team: "99조",
        teamOrder: i + 1,
        employeeCode: `FD_P1_${YEAR}_${i + 1}`,
        phoneNormalized: `0101997${String(1000 + i).slice(-4)}`,
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

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL, "caddy_local only");
  await cleanup();
  const roster = await seedRoster();
  const A = roster[0];
  const B = roster[1];
  const C = roster[2];

  try {
    section("unique: AM+PM allowed, AM+AM forbidden");
    {
      const plan = await prisma.marshalMonthPlan.create({
        data: {
          year: YEAR,
          month: UNIQUE_MONTH,
          amSlotsPerDay: 2,
          pmSlotsPerDay: 1,
          startRotationOrder: 9101,
          nextRotationOrder: 9101,
        },
      });
      const date = new Date(`${YEAR}-12-01T00:00:00`);
      await prisma.marshalMonthSlot.create({
        data: {
          planId: plan.id,
          date,
          shift: "AM",
          slotIndex: 0,
          caddyId: A.caddy.id,
          marshalProfileId: A.profile.id,
          source: "PENALTY",
        },
      });
      await prisma.marshalMonthSlot.create({
        data: {
          planId: plan.id,
          date,
          shift: "PM",
          slotIndex: 0,
          caddyId: A.caddy.id,
          marshalProfileId: A.profile.id,
          source: "PENALTY",
        },
      });
      const pair = await prisma.marshalMonthSlot.count({
        where: { planId: plan.id, caddyId: A.caddy.id },
      });
      assert(pair === 2, "DB allows same caddy AM+PM");
      let amDup = false;
      try {
        await prisma.marshalMonthSlot.create({
          data: {
            planId: plan.id,
            date,
            shift: "AM",
            slotIndex: 1,
            caddyId: A.caddy.id,
            marshalProfileId: A.profile.id,
            source: "ROTATION",
          },
        });
      } catch (e) {
        amDup =
          e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
      }
      assert(amDup, "DB rejects same caddy AM+AM");
    }

    section("createPenaltyDuty defaults FULL_DAY + generate mixed day");
    {
      await upsertMonthPlanSettings({
        year: YEAR,
        month: MONTH,
        amSlotsPerDay: 2,
        pmSlotsPerDay: 1,
        startRotationOrder: 9101,
      });
      const penalty = await createPenaltyDuty({
        year: YEAR,
        month: MONTH,
        date: DAY1,
        caddyId: A.caddy.id,
        shift: "AM",
        reason: "전일 벌당 P1",
      });
      assert(penalty.coverage === "FULL_DAY", "create defaults coverage FULL_DAY");
      await generateMonthPlan({
        year: YEAR,
        month: MONTH,
        amSlotsPerDay: 2,
        pmSlotsPerDay: 1,
        startRotationOrder: 9101,
        replace: true,
      });
      const generated = await getMonthPlan({ year: YEAR, month: MONTH });
      const day1 = generated.plan!.slots.filter((s) => s.date === DAY1);
      assert(day1.length === 3, "generated day keeps 3 slots");
      const aSlots = day1.filter((s) => s.caddyId === A.caddy.id);
      assert(
        aSlots.length === 2 &&
          aSlots.every((s) => s.source === "PENALTY") &&
          aSlots.some((s) => s.shift === "AM") &&
          aSlots.some((s) => s.shift === "PM"),
        "A stored as AM+PM PENALTY"
      );
      assert(
        day1.filter((s) => s.source === "ROTATION").length === 1,
        "only 1 rotation slot stored"
      );
      assert(
        day1.some((s) => s.caddyId === B.caddy.id && s.source === "ROTATION"),
        "B is the normal rotation person"
      );
    }

    section("7. FULL_DAY pair replace locked; normal sub allowed");
    {
      const plan = await prisma.marshalMonthPlan.findUnique({
        where: { year_month: { year: YEAR, month: MONTH } },
        include: { slots: true },
      });
      const aAm = plan!.slots.find(
        (s) =>
          formatMarshalYmd(s.date) === DAY1 &&
          s.caddyId === A.caddy.id &&
          s.shift === "AM"
      );
      const bSlot = plan!.slots.find(
        (s) => formatMarshalYmd(s.date) === DAY1 && s.caddyId === B.caddy.id
      );
      await throwsCode(
        () =>
          replaceMonthSlot({
            planId: plan!.id,
            slotId: aAm!.id,
            caddyId: C.caddy.id,
            asSubstitute: true,
          }),
        "full_day_penalty_locked",
        "one-sided FULL_DAY replace 409"
      );
      const sub = await replaceMonthSlot({
        planId: plan!.id,
        slotId: bSlot!.id,
        caddyId: C.caddy.id,
        asSubstitute: true,
      });
      assert(sub.caddyId === C.caddy.id && sub.source === "SUBSTITUTE", "normal sub still works");
    }

    section("14. 트랜잭션 전체 롤백 (penalty overflow)");
    {
      await createPenaltyDuty({
        year: YEAR,
        month: MONTH,
        date: DAY1,
        caddyId: B.caddy.id,
        shift: "PM",
        coverage: "FULL_DAY",
        reason: "overflow pair",
      });
      const before = await prisma.marshalMonthSlot.findMany({
        where: {
          plan: { year: YEAR, month: MONTH },
        },
        orderBy: [{ date: "asc" }, { id: "asc" }],
      });
      await throwsCode(
        () =>
          generateMonthPlan({
            year: YEAR,
            month: MONTH,
            replace: true,
            startRotationOrder: 9101,
          }),
        "penalty_overflow",
        "two FULL_DAY + PM=1 overflow"
      );
      const after = await prisma.marshalMonthSlot.findMany({
        where: { plan: { year: YEAR, month: MONTH } },
        orderBy: [{ date: "asc" }, { id: "asc" }],
      });
      assert(
        before.length === after.length &&
          before.every((row, i) => row.id === after[i].id && row.caddyId === after[i].caddyId),
        "overflow generate rolls back slots"
      );
      await prisma.marshalPenaltyDuty.deleteMany({
        where: { caddyId: B.caddy.id, plan: { year: YEAR, month: MONTH } },
      });
    }

    section("9-11. sick / off / credit with FULL_DAY");
    {
      await prisma.assignment.create({
        data: {
          caddyId: B.caddy.id,
          type: "SICK",
          startDate: new Date(`${DAY1}T00:00:00`),
          endDate: new Date(`${DAY1}T00:00:00`),
          comment: TAG,
        },
      });
      await generateMonthPlan({
        year: YEAR,
        month: MONTH,
        replace: true,
        startRotationOrder: 9101,
      });
      const sickGen = await getMonthPlan({ year: YEAR, month: MONTH });
      const sickDay = sickGen.plan!.slots.filter((s) => s.date === DAY1);
      assert(
        !sickDay.some((s) => s.caddyId === B.caddy.id),
        "SICK B skipped"
      );
      assert(
        sickDay.some((s) => s.caddyId === C.caddy.id && s.source === "ROTATION"),
        "C fills after sick skip"
      );
      await prisma.assignment.deleteMany({
        where: { caddyId: B.caddy.id, comment: TAG },
      });

      await prisma.assignment.create({
        data: {
          caddyId: B.caddy.id,
          type: "OFF",
          startDate: new Date(`${DAY1}T00:00:00`),
          endDate: new Date(`${DAY1}T00:00:00`),
          comment: TAG,
        },
      });
      await generateMonthPlan({
        year: YEAR,
        month: MONTH,
        replace: true,
        startRotationOrder: 9101,
      });
      const offGen = await getMonthPlan({ year: YEAR, month: MONTH });
      const offB = offGen.plan!.slots.find(
        (s) => s.date === DAY1 && s.caddyId === B.caddy.id
      );
      assert(offB?.warning === "휴무 충돌", "OFF keeps B with warning");
      await prisma.assignment.deleteMany({
        where: { caddyId: B.caddy.id, comment: TAG },
      });

      await changeRotationCredit({
        marshalProfileId: B.profile.id,
        delta: 1,
        reason: TAG,
      });
      await generateMonthPlan({
        year: YEAR,
        month: MONTH,
        replace: true,
        startRotationOrder: 9101,
      });
      const creditGen = await getMonthPlan({ year: YEAR, month: MONTH });
      const creditDay = creditGen.plan!.slots.filter((s) => s.date === DAY1);
      assert(
        !creditDay.some((s) => s.caddyId === B.caddy.id),
        "credit skips B"
      );
      assert(
        creditDay.some((s) => s.caddyId === C.caddy.id),
        "C fills after credit skip"
      );
    }

    section("12. FINALIZED Daily Ops read");
    {
      await prisma.marshalRotationCredit.deleteMany({
        where: { marshalProfileId: { in: roster.map((row) => row.profile.id) } },
      });
      const plan = await prisma.marshalMonthPlan.findUnique({
        where: { year_month: { year: YEAR, month: MONTH } },
      });
      await prisma.marshalMonthPlan.update({
        where: { id: plan!.id },
        data: { status: "DRAFT" },
      });
      const generated = await generateMonthPlan({
        year: YEAR,
        month: MONTH,
        replace: true,
        startRotationOrder: 9101,
      });
      await finalizeMonthPlan({ id: generated.planId });
      const duty = await loadFinalizedMarshalMonthDuty(DAY1, { prisma });
      assert(duty.source === "monthly", "FINALIZED overlay source monthly");
      assert(duty.rows.length === 3, "Daily Ops sees 3 marshal keys");
      const aKeys = duty.rows.filter((r) => r.caddyId === A.caddy.id).map((r) => r.roleKey);
      assert(aKeys.includes("마샬_조출_1") && aKeys.includes("마샬_후출_1"), "A on 조출1+후출1");
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
