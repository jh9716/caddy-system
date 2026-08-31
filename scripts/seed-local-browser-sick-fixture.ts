/**
 * Local-only browser fixture for 2026-09-15 1/2/3부 SICK gate.
 * caddy_local only. Leaves Draft for /manage/assignments.
 */
import { assertLocalFixtureDatabase } from "../src/lib/dbSafety";
assertLocalFixtureDatabase(process.env.DATABASE_URL);

import { prisma } from "../src/lib/prisma";
import { parseYmd } from "../src/lib/availabilityEngine";
import { computeAutoAssignmentsV1, type AutoAssignCaddy } from "../src/lib/autoAssignEngine";
import { createDraftFromAutoResult } from "../src/lib/assignmentDraft";
import { assignmentDraftToPayload } from "../src/lib/dailyBoardDraft";
import { saveDailyBoardDraft } from "../src/lib/dailyBoardDraftService";
import { reservationKey } from "../src/lib/autoAssignEngine";
import type { ShiftPart } from "../src/lib/reservationParser";

const DATE = "2026-09-15";
const day = parseYmd(DATE).start;
const OFF_ID = 25;
const HOUSE_START = 13;

function shiftRows(shift: ShiftPart, count: number, hour: number, prefix: string) {
  const courses = ["VERTHILL", "SKY", "OCEAN", "LAKE"] as const;
  return Array.from({ length: count }, (_, i) => ({
    date: DATE,
    course: courses[i % 4],
    shift,
    teeTime: `${String(hour).padStart(2, "0")}:${String((i % 4) * 8).padStart(2, "0")}`,
    teamName: `${prefix}${i + 1}`,
    rawRowIndex: i + 1,
    sourceSheet: `예약${shift}`,
  }));
}

async function main() {
  const rows = await prisma.caddy.findMany({
    where: { employmentStatus: "ACTIVE", caddyType: "HOUSE" },
    orderBy: [{ team: "asc" }, { teamOrder: "asc" }, { id: "asc" }],
  });
  const pool: AutoAssignCaddy[] = rows
    .filter((c) => c.id !== OFF_ID)
    .map((c) => ({
      id: c.id,
      name: c.name,
      team: String(c.team),
      teamOrder: Number(c.teamOrder) || 0,
      caddyType: "HOUSE",
      employmentStatus: "ACTIVE",
    }));
  const offRow = rows.find((c) => c.id === OFF_ID);
  const result = computeAutoAssignmentsV1({
    date: DATE,
    available: pool,
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    houseStartCaddyId: HOUSE_START,
    reservations: [
      ...shiftRows("1부", 4, 7, "A"),
      ...shiftRows("2부", 4, 12, "B"),
      ...shiftRows("3부", 4, 17, "C"),
    ],
  });
  const off = offRow;
  const draft = createDraftFromAutoResult(result, [
    ...pool,
    ...(off
      ? [{
          id: off.id,
          name: off.name,
          team: String(off.team),
          teamOrder: 99,
          caddyType: "HOUSE" as const,
          employmentStatus: "ACTIVE",
        }]
      : []),
  ]);
  await prisma.dailyPlacement.deleteMany({ where: { date: day } });
  await prisma.dailyReservation.deleteMany({ where: { date: day } });
  await prisma.dailyCaddyUnavailable.deleteMany({ where: { date: day } });
  await prisma.dailyAssignmentChange.deleteMany({ where: { date: day } });
  await prisma.dailyBoardDraft.deleteMany({ where: { date: day } });
  for (const row of draft.assignments) {
    const created = await prisma.dailyReservation.create({
      data: {
        date: day,
        course: row.reservation.course,
        shift: String(row.shift || row.reservation.shift),
        teeTime: row.reservation.teeTime,
        teamName: row.reservation.teamName ?? null,
        identityKey: reservationKey(row.reservation),
        source: row.reservation.sourceSheet ?? null,
        rawRowIndex: row.reservation.rawRowIndex ?? null,
        status: "ACTIVE",
      },
    });
    await prisma.dailyPlacement.create({
      data: {
        date: day,
        reservationId: created.id,
        caddyId: row.caddy.id,
        kind: row.kind,
        sequenceIndex: row.sequenceIndex,
        pairId: row.pairId ?? null,
        locked: false,
      },
    });
  }
  await saveDailyBoardDraft({
    date: DATE,
    expectedVersion: 0,
    payload: assignmentDraftToPayload(draft),
    updatedByUserId: null,
  });
  const names = (shift: ShiftPart) =>
    draft.assignments
      .filter((a) => a.shift === shift && a.kind === "regular")
      .sort((a, b) => a.sequenceIndex - b.sequenceIndex)
      .map((a) => a.caddy.name);
  console.log("seeded", DATE, {
    "1부": names("1부"),
    "2부": names("2부"),
    "3부": names("3부"),
    off: off?.name,
  });
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
