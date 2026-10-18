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
  updatePenaltyDuty,
} from "../src/lib/marshalRotationService";

const TAG = "__MARSHAL_FD_P1__";
const YEAR = 2097;
const MONTH = 11;
const UNIQUE_MONTH = 12;
const DAY1 = `${YEAR}-11-01`;
const DAY2 = `${YEAR}-11-02`;

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

    section("shift-only POST keeps AM; explicit FULL_DAY; DRAFT coverage regenerate");
    {
      await upsertMonthPlanSettings({
        year: YEAR,
        month: MONTH,
        amSlotsPerDay: 2,
        pmSlotsPerDay: 1,
        startRotationOrder: 9101,
      });
      const shiftOnly = await createPenaltyDuty({
        year: YEAR,
        month: MONTH,
        date: DAY1,
        caddyId: A.caddy.id,
        shift: "AM",
        reason: "UI shift-only",
      });
      assert(shiftOnly.coverage === "AM", "UI omit coverage stores AM");
      await generateMonthPlan({
        year: YEAR,
        month: MONTH,
        amSlotsPerDay: 2,
        pmSlotsPerDay: 1,
        startRotationOrder: 9101,
        replace: true,
      });
      const afterShift = await getMonthPlan({ year: YEAR, month: MONTH });
      const day1Shift = afterShift.plan!.slots.filter((s) => s.date === DAY1);
      const aShiftSlots = day1Shift.filter((s) => s.caddyId === A.caddy.id);
      assert(aShiftSlots.length === 1 && aShiftSlots[0].shift === "AM", "shift-only occupies AM only");
      assert(
        aShiftSlots[0].source === "PENALTY",
        "shift-only slot is PENALTY"
      );
      assert(
        day1Shift.filter((s) => s.source === "ROTATION").length === 2,
        "shift-only leaves 2 rotation slots"
      );

      const explicit = await createPenaltyDuty({
        year: YEAR,
        month: MONTH,
        date: DAY2,
        caddyId: A.caddy.id,
        shift: "AM",
        coverage: "FULL_DAY",
        reason: "explicit FULL_DAY",
      });
      assert(explicit.coverage === "FULL_DAY", "explicit FULL_DAY POST stored");
      await generateMonthPlan({
        year: YEAR,
        month: MONTH,
        replace: true,
        startRotationOrder: 9101,
      });
      const afterExplicit = await getMonthPlan({ year: YEAR, month: MONTH });
      const day2 = afterExplicit.plan!.slots.filter((s) => s.date === DAY2);
      const aDay2 = day2.filter((s) => s.caddyId === A.caddy.id);
      assert(
        aDay2.length === 2 &&
          aDay2.every((s) => s.source === "PENALTY") &&
          aDay2.some((s) => s.shift === "AM") &&
          aDay2.some((s) => s.shift === "PM"),
        "explicit FULL_DAY occupies AM+PM"
      );
      const day1Still = afterExplicit.plan!.slots.filter((s) => s.date === DAY1);
      assert(
        day1Still.filter((s) => s.caddyId === A.caddy.id).length === 1,
        "DAY1 remains shift-only until coverage patch"
      );

      await updatePenaltyDuty({
        id: shiftOnly.id,
        coverage: "FULL_DAY",
      });
      await generateMonthPlan({
        year: YEAR,
        month: MONTH,
        replace: true,
        startRotationOrder: 9101,
      });
      const afterPatch = await getMonthPlan({ year: YEAR, month: MONTH });
      const day1Full = afterPatch.plan!.slots.filter((s) => s.date === DAY1);
      const aFull = day1Full.filter((s) => s.caddyId === A.caddy.id);
      assert(
        aFull.length === 2 &&
          aFull.every((s) => s.source === "PENALTY") &&
          aFull.some((s) => s.shift === "AM") &&
          aFull.some((s) => s.shift === "PM"),
        "DRAFT coverage FULL_DAY regenerate writes AM+PM pair"
      );
      assert(
        day1Full.filter((s) => s.source === "ROTATION").length === 1,
        "after FULL_DAY patch only 1 rotation slot"
      );
      assert(
        day1Full.some((s) => s.caddyId === B.caddy.id && s.source === "ROTATION"),
        "B is the normal rotation person"
      );

      let prismaOmitFailed = false;
      try {
        await prisma.marshalPenaltyDuty.create({
          data: {
            planId: afterPatch.plan!.id,
            date: new Date(`${YEAR}-11-03T00:00:00`),
            shift: "AM",
            caddyId: B.caddy.id,
            marshalProfileId: B.profile.id,
            reason: "omit-coverage",
          } as never,
        });
      } catch {
        prismaOmitFailed = true;
      }
      assert(prismaOmitFailed, "new Prisma client still requires coverage");

      await prisma.$executeRaw`
        INSERT INTO "MarshalPenaltyDuty"
          ("planId","date","shift","caddyId","marshalProfileId","reason","createdAt","updatedAt")
        VALUES
          (
            ${afterPatch.plan!.id},
            ${new Date(`${YEAR}-11-03T00:00:00`)},
            'AM'::"MarshalShift",
            ${B.caddy.id},
            ${B.profile.id},
            ${"legacy-omit-coverage"},
            NOW(),
            NOW()
          )
      `;
      const filled = await prisma.marshalPenaltyDuty.findFirst({
        where: { planId: afterPatch.plan!.id, caddyId: B.caddy.id },
      });
      assert(filled?.coverage === "AM", "legacy INSERT omit coverage fills AM from shift");
      await prisma.marshalPenaltyDuty.delete({ where: { id: filled!.id } });
    }

    section("PATCH shift/coverage stays consistent");
    {
      const D = roster[3];
      const E = roster[4];
      const single = await createPenaltyDuty({
        year: YEAR,
        month: MONTH,
        date: `${YEAR}-11-04`,
        caddyId: D.caddy.id,
        shift: "AM",
        reason: "patch-shift-only",
      });
      const shifted = await updatePenaltyDuty({ id: single.id, shift: "PM" });
      assert(
        shifted.shift === "PM" && shifted.coverage === "PM",
        "single-shift PATCH shift also updates coverage"
      );
      const full = await createPenaltyDuty({
        year: YEAR,
        month: MONTH,
        date: `${YEAR}-11-04`,
        caddyId: E.caddy.id,
        shift: "AM",
        coverage: "FULL_DAY",
        reason: "patch-full-day",
      });
      const fullShift = await updatePenaltyDuty({ id: full.id, shift: "PM" });
      assert(
        fullShift.shift === "PM" && fullShift.coverage === "FULL_DAY",
        "FULL_DAY PATCH shift keeps FULL_DAY"
      );
      const toAm = await updatePenaltyDuty({ id: full.id, coverage: "AM" });
      assert(
        toAm.shift === "AM" && toAm.coverage === "AM",
        "FULL_DAY → AM sets display shift"
      );
      await throwsCode(
        () => updatePenaltyDuty({ id: single.id, shift: "AM", coverage: "PM" }),
        "shift_coverage_mismatch",
        "contradictory PATCH rejected"
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
