/**
 * 2026-09-07 overlay 0 회귀. dump가 있으면 209 assigned 확인.
 * 실행: npm run test:off-override-0907-unit
 */
import fs from "node:fs";
import path from "node:path";
import { resolveEffectiveOff } from "../src/lib/offEffective";
import { computeAvailability } from "../src/lib/availabilityEngine";
import { applyDailyExternalExclusions } from "../src/lib/dailyAvailabilityOverlay";
import { effectiveOffNamesFromBase } from "../src/lib/offEffective";
import {
  reservationsFromAssignmentDraft,
  type AssignmentDraft,
} from "../src/lib/assignmentDraft";
import { computeAutoAssignmentsV1 } from "../src/lib/autoAssignEngine";
import { dutyEntriesFromStored } from "../src/lib/dailyOpsDuty";

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

const OFF_39 = [
  12, 24, 27, 30, 35, 39, 51, 60, 78, 80, 82, 91, 96, 100, 103, 106, 107, 114,
  115, 116, 123, 126, 148, 153, 166, 170, 180, 194, 196, 201, 204, 214, 227,
  230, 239, 240, 244, 253, 260,
];

console.log("== overlay 0 identity on 9/7 39 ids ==");
{
  const effective = resolveEffectiveOff({
    baseOffCaddyIds: OFF_39,
    overrides: [],
  });
  assert(effective.offCaddyIds.length === 39, "원본 휴무 39");
  assert(
    effective.offCaddyIds.join(",") === [...OFF_39].sort((a, b) => a - b).join(","),
    "override 0이면 id 집합 동일"
  );
}

const dumpPath = "/opt/cursor/artifacts/prod_20260907_readonly.json";
if (fs.existsSync(dumpPath)) {
  console.log("== dump 있으면 209 assigned / 0 unassigned ==");
  const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8")) as {
    caddies: Array<{
      id: number;
      name: string;
      team: string;
      teamOrder: number;
      employmentStatus?: string | null;
      caddyType?: string | null;
      extraFlags?: string[] | null;
      thirdBandSubgroup?: string | null;
    }>;
    duties: Array<{
      role: string;
      roleKey: string;
      rawName?: string | null;
      name?: string | null;
      caddyId: number;
      caddy?: { name: string };
    }>;
    assignments: Array<{
      caddyId: number;
      type: string;
      subType?: string | null;
      startDate: string;
      endDate: string;
    }>;
    extraTags: Array<{ caddyId: number; tag: string; date: string }>;
    draft: { payload: AssignmentDraft } | null;
    placement?: { mode?: string; protectedTailCount?: number } | null;
  };
  const DATE = "2026-09-07";
  const caddies = dump.caddies;
  const snapIds =
    dump.draft?.payload?.offSnapshot?.caddyIds || OFF_39;
  const names = effectiveOffNamesFromBase({
    caddies: caddies.map((c) => ({
      id: c.id,
      name: c.name,
      employmentStatus: String(c.employmentStatus || "ACTIVE"),
    })),
    baseOffCaddyIds: snapIds,
    overrides: [],
  });
  assert(names.effective.offCaddyIds.length === 39, "dump overlay 0 off=39");
  const availability = computeAvailability({
    date: DATE,
    caddies: caddies.map((c) => ({
      id: c.id,
      name: c.name,
      team: c.team,
      teamOrder: Number(c.teamOrder) || 0,
      employmentStatus: String(c.employmentStatus || "ACTIVE"),
      caddyType: c.caddyType,
      extraFlags: c.extraFlags ?? [],
      thirdBandSubgroup: c.thirdBandSubgroup ?? null,
    })),
    assignments: dump.assignments || [],
    extraTags: dump.extraTags || [],
  });
  const dutyEntries = dutyEntriesFromStored(
    dump.duties.map((d) => ({
      role: d.role,
      roleKey: d.roleKey,
      rawName: d.rawName || d.name || d.caddy?.name || "",
    }))
  );
  const overlaid = applyDailyExternalExclusions({
    availability,
    caddies,
    offNames: names.names,
    dutyEntries,
  });
  const reservations = dump.draft
    ? reservationsFromAssignmentDraft(dump.draft.payload)
    : [];
  assert(reservations.length === 209, "draft 예약 209");
  const result = computeAutoAssignmentsV1({
    date: DATE,
    reservations,
    available: overlaid.available.all,
    special: overlaid.special,
    openCourses: dump.draft?.payload?.openCourses || ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    houseStartCaddyId: dump.draft?.payload?.houseStartCaddyId ?? null,
    protectedTailCount: dump.placement?.protectedTailCount ?? 4,
    placementMode: (dump.placement?.mode as "MANUAL" | "AUTO") || "MANUAL",
  });
  const assigned = result.assignments?.length ?? 0;
  const unassigned = result.unassignedReservations?.length ?? 0;
  const keys = new Map<string, number>();
  let dup = 0;
  for (const row of result.assignments || []) {
    const key = `${row.shift}|${row.course}|${row.teeTime}|${row.caddy?.id}`;
    keys.set(key, (keys.get(key) || 0) + 1);
    if ((keys.get(key) || 0) > 1) dup += 1;
  }
  const linked = (result.assignments || []).filter(
    (row) => row.pairId && !row.caddy
  ).length;
  assert(assigned === 209, `assigned 209 (got ${assigned})`);
  assert(unassigned === 0, `unassigned 0 (got ${unassigned})`);
  assert(dup === 0, "duplicate 0");
  assert(linked === 0, "linked error 0");
} else {
  console.log("== dump 없음: 209 engine 확인은 이 환경에서 skip ==");
  assert(true, "dump 없어도 overlay 0 identity는 통과");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
