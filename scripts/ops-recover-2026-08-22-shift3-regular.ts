/**
 * 운영 1회 복구: 2026-08-22 보드 3부 regular 순번.
 *
 * DailyOpsDuty persist(PR #79) 이전에 들어간 이홍택(caddyId=233)
 * OCEAN 3부 17:33 placement를, 가짜 CADDY_SICK 없이
 * reflowRegularAssignments({ freezeShifts: ["1부","2부"] }) 공식 경로로 재계산한다.
 *
 * 공개 production API 아님. 일반 사용자는 호출할 수 없다.
 *
 * PREVIEW (기본, DB write 없음):
 *   npx tsx scripts/ops-recover-2026-08-22-shift3-regular.ts
 *
 * APPLY (preview gate 통과 시에만 transaction write):
 *   APPLY=1 CONFIRM_DATE=2026-08-22 ALLOW_PRODUCTION_WRITE=1 \
 *     npx tsx scripts/ops-recover-2026-08-22-shift3-regular.ts
 *
 * 금지: Reservation 수정, DailyCaddyUnavailable 생성, CADDY_SICK 이벤트,
 * User/Caddy/2026-06-10 기록 수정, 1부·2부 placement 수정.
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { parseYmd } from "../src/lib/availabilityEngine";
import { loadAvailabilityForDate } from "../src/lib/availabilityService";
import {
  autoResultFromDraft,
  type AssignmentDraft,
} from "../src/lib/assignmentDraft";
import {
  compareAssignmentOrder,
  compareReservationOrder,
  isActiveEmploymentStatus,
  isPlacementLocked,
  isWeekendBandRow,
  parseAssignShiftPart,
  regularCaddyPoolFromAvailabilityRows,
  reflowRegularAssignments,
  reservationKey,
  type AssignmentKind,
  type AutoAssignCaddy,
  type AutoAssignReservation,
  type AutoAssignResultV1,
  type AutoAssignmentRow,
  type SpareByShift,
} from "../src/lib/autoAssignEngine";
import { excludeCaddiesById } from "../src/lib/dailyOpsDuty";
import { listDailyOpsDuties } from "../src/lib/dailyOpsDutyService";
import { isThirdBandTeam } from "../src/lib/caddyManage";
import { COURSE_CODES, type ShiftPart } from "../src/lib/reservationParser";
import { resolveThirdWeeklyStart } from "../src/lib/thirdWeeklyStartService";

const DATE = String(process.env.DATE || "2026-08-22").trim();
const TARGET_CADDY_ID = 233;
const APPLY = process.env.APPLY === "1";
const CONFIRM_DATE = String(process.env.CONFIRM_DATE || "").trim();
const ALLOW_PRODUCTION_WRITE = process.env.ALLOW_PRODUCTION_WRITE === "1";
const AUDIT_ACTION = "OPS_DUTY_SHIFT3_RECOVERY";

const KINDS = new Set<AssignmentKind>([
  "regular",
  "fiftyFourHole",
  "oneThree",
  "oneTwo",
  "oneMak",
  "fixed",
  "driving",
]);

const silentPrisma = new PrismaClient({ log: ["error"] });

function dbHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isProductionHost(host: string): boolean {
  return (
    host.includes("neon.tech") ||
    host.includes("vercel-storage") ||
    host.includes("amazonaws.com") ||
    host.includes("verthill")
  );
}

function shiftFingerprint(
  assignments: AutoAssignmentRow[],
  shift: ShiftPart
): string {
  return assignments
    .filter((row) => row.shift === shift)
    .map(
      (row) =>
        `${reservationKey(row.reservation)}:${row.caddy.id}:${row.sequenceIndex}:${row.kind}:${row.locked === true ? 1 : 0}`
    )
    .sort()
    .join("|");
}

function parseKind(raw: string): AssignmentKind {
  return KINDS.has(raw as AssignmentKind) ? (raw as AssignmentKind) : "regular";
}

function reservationFromDaily(input: {
  ymd: string;
  identityKey: string;
  course: string;
  shift: string;
  teeTime: string;
  teamName: string | null;
  hole: number | null;
  source: string | null;
  rawRowIndex: number | null;
  limousineCart: boolean;
}): AutoAssignReservation {
  const shift = parseAssignShiftPart(input.shift);
  if (!shift) {
    throw new Error(`부 파싱 실패: ${input.shift} (${input.identityKey})`);
  }
  const base: AutoAssignReservation = {
    date: input.ymd,
    course: input.course,
    shift,
    teeTime: input.teeTime,
    teamName: input.teamName,
    hole: input.hole,
    startingHole: input.hole,
    sourceSheet: input.source ?? undefined,
    rawRowIndex: input.rawRowIndex ?? undefined,
    limousineCart: input.limousineCart === true,
  };
  const key = input.identityKey;
  if (key.startsWith("id:")) {
    base.id = key.slice(3);
  }
  const computed = reservationKey(base);
  if (computed === key) return base;

  const parts = key.split("|");
  if (parts.length >= 7) {
    const repaired: AutoAssignReservation = {
      date: parts[0] || input.ymd,
      course: parts[1] || input.course,
      shift: parseAssignShiftPart(parts[2]) || shift,
      teeTime: parts[3] || input.teeTime,
      rawRowIndex: parts[4] === "" ? undefined : Number(parts[4]),
      teamName: parts[5] === "" ? null : parts[5],
      sourceSheet: parts[6] === "" ? undefined : parts.slice(6).join("|"),
      hole: input.hole,
      startingHole: input.hole,
      limousineCart: input.limousineCart === true,
    };
    if (reservationKey(repaired) === key) return repaired;
  }
  throw new Error(
    `identityKey 재구성 실패 stored=${key} computed=${computed}`
  );
}

function caddyFromDb(row: {
  id: number;
  name: string;
  team: string;
  teamOrder: number | null;
  caddyType: string | null;
  extraFlags: string[] | null;
  employmentStatus: string;
  thirdBandSubgroup: string | null;
}): AutoAssignCaddy {
  return {
    id: row.id,
    name: row.name,
    team: row.team,
    teamOrder: Number(row.teamOrder) || 0,
    caddyType: row.caddyType ?? undefined,
    extraFlags: row.extraFlags ?? null,
    employmentStatus: row.employmentStatus,
    thirdBandSubgroup: row.thirdBandSubgroup ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function numberFromUnknown(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseSpares(raw: unknown): SpareByShift[] {
  if (!Array.isArray(raw)) return [];
  const out: SpareByShift[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const shift = parseAssignShiftPart(item.shift);
    if (!shift) continue;
    const spareOf = (value: unknown) => {
      if (!isRecord(value)) return null;
      const caddyId = numberFromUnknown(value.caddyId);
      if (!caddyId) return null;
      return {
        caddyId,
        name: String(value.name || ""),
        team: String(value.team || ""),
        teamOrder: Number(value.teamOrder) || 0,
      };
    };
    out.push({
      shift,
      spare1: spareOf(item.spare1),
      spare2: spareOf(item.spare2),
    });
  }
  return out;
}

function extractMetaFromPayload(payload: unknown): {
  sparesByShift: SpareByShift[];
  houseStartCaddyId: number | null;
  thirdStartCaddyId: number | null;
  thirdStartTeam: string | null;
} {
  const empty = {
    sparesByShift: [] as SpareByShift[],
    houseStartCaddyId: null as number | null,
    thirdStartCaddyId: null as number | null,
    thirdStartTeam: null as string | null,
  };
  if (!isRecord(payload)) return empty;
  const nested = isRecord(payload.meta) ? payload.meta : {};
  const after = isRecord(payload.after) ? payload.after : {};
  const afterMeta = isRecord(after.meta) ? after.meta : {};
  return {
    sparesByShift: parseSpares(
      payload.sparesByShift || after.sparesByShift || nested.sparesByShift
    ),
    houseStartCaddyId:
      numberFromUnknown(payload.houseStartCaddyId) ||
      numberFromUnknown(nested.houseStartCaddyId) ||
      numberFromUnknown(afterMeta.houseStartCaddyId),
    thirdStartCaddyId:
      numberFromUnknown(payload.thirdStartCaddyId) ||
      numberFromUnknown(nested.thirdStartCaddyId) ||
      numberFromUnknown(afterMeta.thirdStartCaddyId),
    thirdStartTeam:
      typeof payload.thirdStartTeam === "string"
        ? payload.thirdStartTeam
        : typeof nested.thirdStartTeam === "string"
          ? nested.thirdStartTeam
          : typeof afterMeta.thirdStartTeam === "string"
            ? afterMeta.thirdStartTeam
            : null,
  };
}

function inferHouseStart(assignments: AutoAssignmentRow[]): number | null {
  const row = [...assignments]
    .filter((a) => a.shift === "1부")
    .sort(compareAssignmentOrder)
    .find((a) => {
      const type = String(a.caddy.caddyType || "").toUpperCase();
      return type === "HOUSE" || (type !== "THIRD" && type !== "DRIVING");
    });
  return row?.caddy.id ?? null;
}

function inferThirdStart(assignments: AutoAssignmentRow[]): number | null {
  const row = [...assignments]
    .filter(
      (a) =>
        a.shift === "3부" &&
        a.kind === "regular" &&
        !isWeekendBandRow(a) &&
        !isPlacementLocked(a)
    )
    .sort(compareAssignmentOrder)
    .find(
      (a) =>
        String(a.caddy.caddyType || "").toUpperCase() === "THIRD" ||
        isThirdBandTeam(a.caddy.team)
    );
  return row?.caddy.id ?? null;
}

function fmtRow(row: AutoAssignmentRow): string {
  return [
    row.reservation.course,
    row.reservation.teeTime,
    row.kind,
    `seq=${row.sequenceIndex}`,
    row.locked ? "LOCK" : "unlock",
    `${row.caddy.name}(${row.caddy.id}/${row.caddy.team})`,
    row.reason,
  ].join(" ");
}

function isRegularUnlocked(row: AutoAssignmentRow): boolean {
  return row.kind === "regular" && !isPlacementLocked(row) && !isWeekendBandRow(row);
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  if (!url) throw new Error("DATABASE_URL 없음");
  parseYmd(DATE);
  const host = dbHost(url);
  const { start: dateObj } = parseYmd(DATE);

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "APPLY" : "PREVIEW",
        date: DATE,
        host,
        productionHost: isProductionHost(host),
      },
      null,
      2
    )
  );

  const [
    reservations,
    placements,
    unavailables,
    opsDuties,
    changes,
    weekly,
    availability,
  ] = await Promise.all([
    silentPrisma.dailyReservation.findMany({
      where: { date: dateObj },
      orderBy: [{ shift: "asc" }, { teeTime: "asc" }, { id: "asc" }],
    }),
    silentPrisma.dailyPlacement.findMany({
      where: { date: dateObj },
      include: {
        reservation: true,
        caddy: {
          select: {
            id: true,
            name: true,
            team: true,
            teamOrder: true,
            caddyType: true,
            extraFlags: true,
            employmentStatus: true,
            thirdBandSubgroup: true,
          },
        },
      },
    }),
    silentPrisma.dailyCaddyUnavailable.findMany({
      where: { date: dateObj },
      select: {
        id: true,
        caddyId: true,
        reason: true,
        effectiveFromShift: true,
        note: true,
      },
    }),
    listDailyOpsDuties(DATE, silentPrisma),
    silentPrisma.dailyAssignmentChange.findMany({
      where: { date: dateObj },
      orderBy: { appliedAt: "desc" },
      take: 20,
    }),
    resolveThirdWeeklyStart(DATE),
    loadAvailabilityForDate(DATE),
  ]);

  const activeReservations = reservations.filter((r) => r.status === "ACTIVE");
  const placementByResId = new Map(placements.map((p) => [p.reservationId, p]));
  const hong = placements.filter((p) => p.caddyId === TARGET_CADDY_ID);

  const assignmentRows: AutoAssignmentRow[] = placements.map((p) => {
    const reservation = reservationFromDaily({
      ymd: DATE,
      identityKey: p.reservation.identityKey,
      course: p.reservation.course,
      shift: p.reservation.shift,
      teeTime: p.reservation.teeTime,
      teamName: p.reservation.teamName,
      hole: p.reservation.hole,
      source: p.reservation.source,
      rawRowIndex: p.reservation.rawRowIndex,
      limousineCart: p.reservation.limousineCart,
    });
    const shift = parseAssignShiftPart(p.reservation.shift);
    if (!shift) throw new Error(`placement 부 파싱 실패 id=${p.id}`);
    return {
      date: DATE,
      shift,
      sequenceIndex: p.sequenceIndex,
      reason: p.reason || "",
      reservation,
      caddy: caddyFromDb(p.caddy),
      pairId: p.pairId,
      kind: parseKind(p.kind),
      locked: p.locked,
    };
  });
  assignmentRows.sort(compareAssignmentOrder);

  const unassignedReservations = activeReservations
    .filter((r) => !placementByResId.has(r.id))
    .map((r) => ({
      reservation: reservationFromDaily({
        ymd: DATE,
        identityKey: r.identityKey,
        course: r.course,
        shift: r.shift,
        teeTime: r.teeTime,
        teamName: r.teamName,
        hole: r.hole,
        source: r.source,
        rawRowIndex: r.rawRowIndex,
        limousineCart: r.limousineCart,
      }),
      reason: "UNASSIGNED",
    }));

  let payloadMeta = extractMetaFromPayload(null);
  let spareSource = "none";
  for (const change of changes) {
    const parsed = extractMetaFromPayload(change.payload);
    if (parsed.sparesByShift.length > 0 && payloadMeta.sparesByShift.length === 0) {
      payloadMeta = { ...payloadMeta, sparesByShift: parsed.sparesByShift };
      spareSource = `DailyAssignmentChange#${change.id}/${change.changeType}`;
    }
    if (parsed.houseStartCaddyId && !payloadMeta.houseStartCaddyId) {
      payloadMeta.houseStartCaddyId = parsed.houseStartCaddyId;
    }
    if (parsed.thirdStartCaddyId && !payloadMeta.thirdStartCaddyId) {
      payloadMeta.thirdStartCaddyId = parsed.thirdStartCaddyId;
    }
    if (parsed.thirdStartTeam && !payloadMeta.thirdStartTeam) {
      payloadMeta.thirdStartTeam = parsed.thirdStartTeam;
    }
  }

  const inferredHouse = inferHouseStart(assignmentRows);
  const inferredThird = inferThirdStart(assignmentRows);
  const houseStartCaddyId = payloadMeta.houseStartCaddyId || inferredHouse;
  const thirdStartCaddyId = payloadMeta.thirdStartCaddyId || inferredThird;
  const thirdStartTeam =
    payloadMeta.thirdStartTeam || weekly.startTeam || weekly.autoStartTeam;

  const availabilityPool = regularCaddyPoolFromAvailabilityRows(
    availability.available.all
  );
  const dutyIds = [...new Set(opsDuties.map((d) => d.caddyId))];
  const unavailableIds = [...new Set(unavailables.map((u) => u.caddyId))];
  const pool = excludeCaddiesById(
    excludeCaddiesById(availabilityPool, dutyIds),
    unavailableIds
  );

  const draft: AssignmentDraft = {
    date: DATE,
    status: "APPLIED",
    assignments: assignmentRows,
    unassignedReservations,
    closedCourseReservations: [],
    openCourses: [...COURSE_CODES],
    caddyPool: pool,
    sparesByShift: payloadMeta.sparesByShift,
    confirmedAt: null,
  };
  const previous: AutoAssignResultV1 = autoResultFromDraft(draft, {
    date: DATE,
    assignments: assignmentRows,
    fixedAssignments: [],
    fiftyFourHoleAssignments: [],
    oneThreeAssignments: [],
    oneTwoAssignments: [],
    oneMakAssignments: [],
    weekendBandAssignments: [],
    regularAssignments: [],
    unassignedReservations,
    closedCourseReservations: [],
    unusedCaddies: [],
    special: [],
    specialUnassigned: [],
    openCourses: [...COURSE_CODES],
    sparesByShift: payloadMeta.sparesByShift,
    meta: {
      availableCount: pool.length,
      reservationCount: activeReservations.length,
      assignedCount: assignmentRows.length,
      unassignedCount: unassignedReservations.length,
      closedCourseCount: 0,
      unusedCount: 0,
      specialCount: 0,
      fixedAssignedCount: 0,
      fixedUnassignedCount: 0,
      fiftyFourHoleCandidateCount: 0,
      fiftyFourHoleAssignedCaddyCount: 0,
      fiftyFourHoleUnassignedCount: 0,
      oneThreeCandidateCount: 0,
      oneThreeAssignedCaddyCount: 0,
      oneThreeUnassignedCount: 0,
      oneTwoCandidateCount: 0,
      oneTwoAssignedCaddyCount: 0,
      oneTwoUnassignedCount: 0,
      oneMakCandidateCount: 0,
      oneMakAssignedCaddyCount: 0,
      oneMakUnassignedCount: 0,
      housePoolCount: 0,
      thirdPoolCount: 0,
      drivingPoolCount: 0,
      byShift: {
        "1부": { reservations: 0, assigned: 0, unassigned: 0 },
        "2부": { reservations: 0, assigned: 0, unassigned: 0 },
        "3부": { reservations: 0, assigned: 0, unassigned: 0 },
      },
      finalPointer: 0,
      thirdStartTeam,
      thirdStartTeamAutomatic: weekly.autoStartTeam,
      ...(houseStartCaddyId ? { houseStartCaddyId } : {}),
      ...(thirdStartCaddyId ? { thirdStartCaddyId } : {}),
    },
  });

  const reflow = reflowRegularAssignments({
    previous,
    regularCaddyPool: pool,
    events: [],
    freezeShifts: ["1부", "2부"],
  });

  const before3 = previous.assignments.filter((a) => a.shift === "3부");
  const after3 = reflow.after.assignments.filter((a) => a.shift === "3부");
  const before3Regular = before3.filter(isRegularUnlocked);
  const after3Regular = after3.filter(isRegularUnlocked);

  const beforeByKey = new Map(
    previous.assignments.map((row) => [reservationKey(row.reservation), row])
  );
  const afterByKey = new Map(
    reflow.after.assignments.map((row) => [reservationKey(row.reservation), row])
  );

  const oceanKeyCandidates = after3.filter(
    (row) =>
      String(row.reservation.course).toUpperCase() === "OCEAN" &&
      row.reservation.teeTime === "17:33"
  );
  const oceanBefore = before3.find(
    (row) =>
      String(row.reservation.course).toUpperCase() === "OCEAN" &&
      row.reservation.teeTime === "17:33"
  );
  const oceanAfter = oceanKeyCandidates[0] || null;

  const changedRegular3 = after3Regular.filter((row) => {
    const before = beforeByKey.get(reservationKey(row.reservation));
    if (!before) return true;
    return (
      before.caddy.id !== row.caddy.id ||
      before.sequenceIndex !== row.sequenceIndex
    );
  });
  const caddyChangedRegular3 = changedRegular3.filter((row) => {
    const before = beforeByKey.get(reservationKey(row.reservation));
    return !before || before.caddy.id !== row.caddy.id;
  });
  const seqOnlyRegular3 = changedRegular3.filter((row) => {
    const before = beforeByKey.get(reservationKey(row.reservation));
    return !!before && before.caddy.id === row.caddy.id;
  });
  const earlyCaddyChanges = caddyChangedRegular3
    .filter((row) => {
      if (!oceanBefore) return true;
      return compareReservationOrder(row.reservation, oceanBefore.reservation) < 0;
    })
    .map((row) => {
      const before = beforeByKey.get(reservationKey(row.reservation))!;
      return {
        course: row.reservation.course,
        teeTime: row.reservation.teeTime,
        teamName: row.reservation.teamName,
        before: `${before.caddy.name}(${before.caddy.id}/${before.caddy.team})`,
        after: `${row.caddy.name}(${row.caddy.id}/${row.caddy.team})`,
      };
    });

  const fp1Before = shiftFingerprint(previous.assignments, "1부");
  const fp1After = shiftFingerprint(reflow.after.assignments, "1부");
  const fp2Before = shiftFingerprint(previous.assignments, "2부");
  const fp2After = shiftFingerprint(reflow.after.assignments, "2부");

  const dutyOnAfter = reflow.after.assignments.filter((row) =>
    dutyIds.includes(row.caddy.id)
  );
  const retiredAfter3 = after3.filter(
    (row) => !isActiveEmploymentStatus(row.caddy.employmentStatus)
  );
  const hongAfter = reflow.after.assignments.filter(
    (row) => row.caddy.id === TARGET_CADDY_ID
  );

  const afterPlacementCount = reflow.after.assignments.length;
  const afterUnassigned = (reflow.after.unassignedReservations || []).length;
  const activeResCount = activeReservations.length;
  const beforePlacementCount = placements.length;

  const locked3Changed = after3.filter((row) => {
    const before = beforeByKey.get(reservationKey(row.reservation));
    if (!before) return false;
    if (isRegularUnlocked(before)) return false;
    return (
      before.caddy.id !== row.caddy.id ||
      before.kind !== row.kind ||
      before.locked !== row.locked
    );
  });

  const missingAfterKeys = before3Regular.filter(
    (row) => !afterByKey.has(reservationKey(row.reservation))
  );
  const extraAfterKeys = after3Regular.filter(
    (row) => !beforeByKey.has(reservationKey(row.reservation))
  );

  const sequenceFromOcean = [...after3Regular]
    .sort(compareReservationOrder)
    .filter((row) => {
      if (!oceanBefore) return true;
      return (
        compareReservationOrder(row.reservation, oceanBefore.reservation) >= 0
      );
    })
    .map((row) => {
      const before = beforeByKey.get(reservationKey(row.reservation));
      const changed = !before || before.caddy.id !== row.caddy.id;
      return {
        course: row.reservation.course,
        teeTime: row.reservation.teeTime,
        teamName: row.reservation.teamName,
        before: before
          ? `${before.caddy.name}(${before.caddy.id}/${before.caddy.team})`
          : null,
        after: `${row.caddy.name}(${row.caddy.id}/${row.caddy.team})`,
        changed,
      };
    });

  const gates = {
    fingerprint1: fp1Before === fp1After,
    fingerprint2: fp2Before === fp2After,
    oceanExists: !!oceanBefore && !!oceanAfter,
    oceanWasHong: oceanBefore?.caddy.id === TARGET_CADDY_ID,
    oceanLeavesHong: oceanAfter?.caddy.id !== TARGET_CADDY_ID,
    hongAfterZero: hongAfter.length === 0,
    dutyAfterZero: dutyOnAfter.length === 0,
    retiredAfter3Zero: retiredAfter3.length === 0,
    reservationPlacementMatch:
      activeResCount === beforePlacementCount &&
      activeResCount === afterPlacementCount &&
      afterUnassigned === 0,
    locked3Unchanged: locked3Changed.length === 0,
    regular3KeyStable:
      missingAfterKeys.length === 0 && extraAfterKeys.length === 0,
    noUnavailableCreate: true,
    noFakeSick: true,
    opsDutyRowsKept: opsDuties.length === 8,
    poolExcludesHong: pool.every((c) => c.id !== TARGET_CADDY_ID),
    poolExcludesDuty: pool.every((c) => !dutyIds.includes(c.id)),
    hasShift2Spare: payloadMeta.sparesByShift.some((s) => s.shift === "2부"),
    identityOk: assignmentRows.length === placements.length,
  };
  const blocking = Object.entries(gates)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  const preview = {
    date: DATE,
    spareSource,
    houseStartCaddyId,
    houseStartSource: payloadMeta.houseStartCaddyId
      ? "payload"
      : inferredHouse
        ? "inferred-first-1부"
        : "none",
    thirdStartCaddyId,
    thirdStartSource: payloadMeta.thirdStartCaddyId
      ? "payload"
      : inferredThird
        ? "inferred-first-3부-regular-THIRD"
        : "none",
    thirdStartTeam,
    weekly,
    dutySource: availability.dutySource,
    availabilityFinal: availability.dailySummary.finalAvailable,
    poolSize: pool.length,
    dutyIds,
    opsDuties: opsDuties.map((d) => ({
      roleKey: d.roleKey,
      caddyId: d.caddyId,
      name: d.rawName,
    })),
    unavailableCount: unavailables.length,
    hongPlacementsNow: hong.map((p) => ({
      placementId: p.id,
      reservationId: p.reservationId,
      identityKey: p.reservation.identityKey,
      course: p.reservation.course,
      shift: p.reservation.shift,
      teeTime: p.reservation.teeTime,
      kind: p.kind,
      locked: p.locked,
      teamName: p.reservation.teamName,
    })),
    counts: {
      reservationsAll: reservations.length,
      reservationsActive: activeResCount,
      placements: beforePlacementCount,
      shift3Placements: before3.length,
      shift3RegularUnlocked: before3Regular.length,
      shift3RegularWouldChange: changedRegular3.length,
      shift3RegularCaddyChange: caddyChangedRegular3.length,
      shift3RegularSeqOnly: seqOnlyRegular3.length,
      afterPlacements: afterPlacementCount,
      afterUnassigned,
    },
    earlyCaddyChangesBeforeOcean: earlyCaddyChanges,
    ocean1733: oceanBefore
      ? {
          identityKey: reservationKey(oceanBefore.reservation),
          before: `${oceanBefore.caddy.name}(${oceanBefore.caddy.id}/${oceanBefore.caddy.team})`,
          after: oceanAfter
            ? `${oceanAfter.caddy.name}(${oceanAfter.caddy.id}/${oceanAfter.caddy.team})`
            : null,
        }
      : null,
    sequenceFromOceanToLastRegular: sequenceFromOcean,
    fingerprint1Equal: gates.fingerprint1,
    fingerprint2Equal: gates.fingerprint2,
    dutyOnAfter: dutyOnAfter.map((r) => ({
      shift: r.shift,
      name: r.caddy.name,
      id: r.caddy.id,
      course: r.reservation.course,
      teeTime: r.reservation.teeTime,
    })),
    retiredAfter3: retiredAfter3.map((r) => ({
      id: r.caddy.id,
      name: r.caddy.name,
      status: r.caddy.employmentStatus,
    })),
    locked3Changed: locked3Changed.map(fmtRow),
    warnings: reflow.warnings,
    gates,
    blocking,
  };

  console.log("\n=== PREVIEW ===");
  console.log(JSON.stringify(preview, null, 2));

  if (!APPLY) {
    console.log("\nPREVIEW only. APPLY=1 CONFIRM_DATE=2026-08-22 ALLOW_PRODUCTION_WRITE=1 로 적용.");
    return;
  }

  if (DATE !== "2026-08-22" || CONFIRM_DATE !== "2026-08-22") {
    throw new Error("APPLY는 CONFIRM_DATE=2026-08-22 와 DATE=2026-08-22 만 허용");
  }
  if (isProductionHost(host) && !ALLOW_PRODUCTION_WRITE) {
    throw new Error("운영 DB APPLY는 ALLOW_PRODUCTION_WRITE=1 필요");
  }
  if (blocking.length > 0) {
    throw new Error(`PREVIEW gate 실패: ${blocking.join(", ")}`);
  }

  const placementByKey = new Map(
    placements.map((p) => [p.reservation.identityKey, p])
  );
  const oceanPlacementId =
    placements.find(
      (p) =>
        p.reservation.shift === "3부" &&
        p.reservation.teeTime === "17:33" &&
        p.reservation.course.toUpperCase() === "OCEAN"
    )?.id ?? 0;

  const updates = changedRegular3.map((row) => {
    const key = reservationKey(row.reservation);
    const before = beforeByKey.get(key);
    const placement = placementByKey.get(key);
    if (!placement || !before) {
      throw new Error(`placement 매칭 실패 ${key}`);
    }
    if (placement.reservation.shift !== "3부") {
      throw new Error(`3부가 아닌 placement 갱신 시도 ${placement.id}`);
    }
    if (placement.locked) {
      throw new Error(`locked placement 갱신 시도 ${placement.id}`);
    }
    if (placement.kind !== "regular") {
      throw new Error(`regular가 아닌 placement 갱신 시도 ${placement.id}`);
    }
    return {
      placementId: placement.id,
      reservationId: placement.reservationId,
      identityKey: key,
      fromCaddyId: placement.caddyId,
      toCaddyId: row.caddy.id,
      fromSeq: placement.sequenceIndex,
      toSeq: row.sequenceIndex,
      reason: row.reason,
      kind: row.kind,
      pairId: row.pairId ?? null,
    };
  });

  const result = await silentPrisma.$transaction(
    async (tx) => {
      for (const u of updates) {
        const touched = await tx.dailyPlacement.updateMany({
          where: {
            id: u.placementId,
            date: dateObj,
            locked: false,
            kind: "regular",
            caddyId: u.fromCaddyId,
          },
          data: {
            caddyId: u.toCaddyId,
            kind: u.kind,
            reason: u.reason,
            sequenceIndex: u.toSeq,
            pairId: u.pairId,
          },
        });
        if (touched.count !== 1) {
          throw new Error(
            `placement ${u.placementId} update count=${touched.count}`
          );
        }
      }

      const [afterHong, afterDuty, afterUnavail, afterDutyRows, resCount, placeCount, allPlacements] =
        await Promise.all([
          tx.dailyPlacement.findMany({
            where: { date: dateObj, caddyId: TARGET_CADDY_ID },
            select: { id: true },
          }),
          tx.dailyPlacement.findMany({
            where: { date: dateObj, caddyId: { in: dutyIds } },
            select: { caddyId: true, id: true },
          }),
          tx.dailyCaddyUnavailable.findMany({
            where: { date: dateObj, caddyId: TARGET_CADDY_ID },
          }),
          tx.dailyOpsDuty.findMany({
            where: { date: dateObj },
            select: { id: true, caddyId: true, roleKey: true },
            orderBy: { id: "asc" },
          }),
          tx.dailyReservation.count({
            where: { date: dateObj, status: "ACTIVE" },
          }),
          tx.dailyPlacement.count({ where: { date: dateObj } }),
          tx.dailyPlacement.findMany({
            where: { date: dateObj },
            include: {
              reservation: true,
              caddy: { select: { id: true, employmentStatus: true } },
            },
          }),
        ]);

      const fp1 = allPlacements
        .filter((p) => p.reservation.shift === "1부")
        .map(
          (p) =>
            `${p.reservation.identityKey}:${p.caddyId}:${p.sequenceIndex}`
        )
        .sort()
        .join("|");
      const fp2 = allPlacements
        .filter((p) => p.reservation.shift === "2부")
        .map(
          (p) =>
            `${p.reservation.identityKey}:${p.caddyId}:${p.sequenceIndex}`
        )
        .sort()
        .join("|");
      const fp1BeforeSimple = previous.assignments
        .filter((a) => a.shift === "1부")
        .map(
          (a) =>
            `${reservationKey(a.reservation)}:${a.caddy.id}:${a.sequenceIndex}`
        )
        .sort()
        .join("|");
      const fp2BeforeSimple = previous.assignments
        .filter((a) => a.shift === "2부")
        .map(
          (a) =>
            `${reservationKey(a.reservation)}:${a.caddy.id}:${a.sequenceIndex}`
        )
        .sort()
        .join("|");

      const retired3 = allPlacements.filter(
        (p) =>
          p.reservation.shift === "3부" &&
          !isActiveEmploymentStatus(p.caddy.employmentStatus)
      );

      if (afterHong.length !== 0) throw new Error("apply 후 이홍택 placement 잔존");
      if (afterUnavail.length !== 0) {
        throw new Error("apply 후 이홍택 DailyCaddyUnavailable 존재");
      }
      if (afterDuty.length !== 0) {
        throw new Error("apply 후 DailyOpsDuty 대상 placement 잔존");
      }
      if (fp1 !== fp1BeforeSimple) throw new Error("apply 후 1부 fingerprint 변경");
      if (fp2 !== fp2BeforeSimple) throw new Error("apply 후 2부 fingerprint 변경");
      if (retired3.length !== 0) throw new Error("apply 후 3부 RETIRED/LEAVE 잔존");
      if (resCount !== placeCount) {
        throw new Error(`apply 후 예약 ${resCount} != 배치 ${placeCount}`);
      }
      if (afterDutyRows.length !== 8) {
        throw new Error(`DailyOpsDuty ${afterDutyRows.length} != 8`);
      }

      const audit = await tx.audit.create({
        data: {
          action: AUDIT_ACTION,
          entity: "DailyPlacement",
          entityId: oceanPlacementId,
          payload: {
            date: DATE,
            reason:
              "ops recovery: reflow 3부 regular with freezeShifts 1부/2부; no CADDY_SICK; no DailyCaddyUnavailable",
            engine: "reflowRegularAssignments",
            freezeShifts: ["1부", "2부"],
            targetCaddyId: TARGET_CADDY_ID,
            ocean1733: preview.ocean1733,
            updatedPlacementIds: updates.map((u) => u.placementId),
            changedCount: updates.length,
            spareSource,
            houseStartCaddyId,
            thirdStartCaddyId,
            thirdStartTeam,
          } as Prisma.InputJsonValue,
        },
      });

      return {
        auditId: audit.id,
        updated: updates,
        afterHong: afterHong.length,
        afterUnavail: afterUnavail.length,
        afterDutyPlacements: afterDuty.length,
        opsDutyRows: afterDutyRows.length,
        fingerprint1Equal: fp1 === fp1BeforeSimple,
        fingerprint2Equal: fp2 === fp2BeforeSimple,
        retired3: retired3.length,
        activeReservations: resCount,
        placements: placeCount,
      };
    },
    { maxWait: 10_000, timeout: 20_000 }
  );

  console.log("\n=== APPLY ===");
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await silentPrisma.$disconnect();
  });
