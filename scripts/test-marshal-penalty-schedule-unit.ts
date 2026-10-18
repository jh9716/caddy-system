/**
 * P3 벌당 수동 지정일 — 순수 규칙 (production write 없음)
 * 실행: npm run test:marshal-penalty-schedule-unit
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MarshalRosterError } from "../src/lib/marshalDomain";
import { scheduleOccurrencesForMonth } from "../src/lib/marshalPenaltyOccurrenceDomain";
import {
  assertPinnedDateInTargetMonth,
  assertPinnedDateStatus,
  assertOccurrenceDayFree,
  assertPreviewToken,
  assertScheduleTargetMutable,
  makeSchedulePreviewToken,
  parsePinnedOn,
  planLocalFullDayMove,
  type ScheduleSlotSnapshot,
} from "../src/lib/marshalPenaltyScheduleDomain";
import type { RotationMember } from "../src/lib/marshalRotationDomain";

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

function throws(fn: () => void, code: string, msg: string) {
  try {
    fn();
    assert(false, msg);
  } catch (e) {
    assert(e instanceof MarshalRosterError && e.code === code, msg);
  }
}

function member(order: number, name: string, id = order): RotationMember {
  return {
    profileId: id,
    caddyId: id * 10,
    rotationOrder: order,
    name,
    employmentStatus: "ACTIVE",
  };
}

function occ(
  id: number,
  caddyId: number,
  occurredOn: string,
  pinnedOn?: string | null
) {
  return {
    id,
    caddyId,
    profileId: Math.floor(caddyId / 10),
    occurredOn,
    pinnedOn,
  };
}

function slot(input: Partial<ScheduleSlotSnapshot> & Pick<
  ScheduleSlotSnapshot,
  "id" | "date" | "shift" | "caddyId" | "source"
>): ScheduleSlotSnapshot {
  return {
    slotIndex: 0,
    profileId: Math.floor(input.caddyId / 10) || input.caddyId,
    originalCaddyId: null,
    note: null,
    ...input,
  };
}

section("source contracts — P1 engine / autoAssign untouched");
{
  const names = String(
    spawnSync(
      "git",
      ["diff", "--name-only", "origin/cursor/marshal-penalty-carry-d968", "--",
        "src/lib/autoAssignEngine.ts",
        "src/lib/marshalRotationDomain.ts",
      ],
      { encoding: "utf8" }
    ).stdout || ""
  ).trim();
  assert(names === "", `P1 engine files untouched (${names || "clean"})`);
  const domain = fs.readFileSync(
    path.join(process.cwd(), "src/lib/marshalPenaltyScheduleDomain.ts"),
    "utf8"
  );
  assert(
    domain.includes("월 전체 generateMonthRotation 을 돌리지 않는다"),
    "local two-day repair, not full regenerate"
  );
}

section("pinned date guards");
{
  assert(parsePinnedOn("2095-11-06") === "2095-11-06", "parse pinned date");
  throws(() => parsePinnedOn("nope"), "invalid_pinned_on", "bad date rejected");
  throws(
    () => assertPinnedDateInTargetMonth({ date: "2095-12-01", year: 2095, month: 11 }),
    "date_out_of_month",
    "outside target month"
  );
  throws(
    () => assertScheduleTargetMutable("FINALIZED"),
    "finalized_locked",
    "FINALIZED locked"
  );
  throws(
    () => assertPinnedDateStatus({ kind: "hard_skip", message: "병가" }),
    "sick_date",
    "sick rejected"
  );
  throws(
    () => assertPinnedDateStatus({ kind: "off_conflict" }),
    "off_confirm_required",
    "off needs confirm"
  );
  assert(
    assertPinnedDateStatus({ kind: "off_conflict", confirmOff: true }).offWarning,
    "off allowed after confirm"
  );
  throws(
    () =>
      assertOccurrenceDayFree({
        date: "2095-11-02",
        movingId: 2,
        occupied: [
          { id: 1, date: "2095-11-01" },
          { id: 3, date: "2095-11-02" },
        ],
      }),
    "date_taken",
    "another occurrence on that day"
  );
}

section("policy A: pin B, auto A/C fill remaining from day 1");
{
  const packed = scheduleOccurrencesForMonth({
    dates: ["2095-11-01", "2095-11-02", "2095-11-03", "2095-11-06"],
    amSlots: 2,
    pmSlots: 1,
    occurrences: [
      occ(1, 10, "2095-10-01"),
      occ(2, 20, "2095-10-02", "2095-11-06"),
      occ(3, 30, "2095-10-03"),
    ],
    existingByDate: new Map(),
    statusByDateCaddy: new Map(),
  });
  assert(
    packed.assignments
      .sort((a, b) => a.id - b.id)
      .map((row) => `${row.id}@${row.date}${row.pinned ? "P" : ""}`)
      .join(",") === "1@2095-11-01,2@2095-11-06P,3@2095-11-02",
    "regenerate keeps B pin; A/C pack into remaining days"
  );
}

section("apply-style freeze is not packer's job — local move keeps C");
{
  const fromSlots = [
    slot({ id: 1, date: "2095-11-02", shift: "AM", slotIndex: 0, caddyId: 20, source: "PENALTY" }),
    slot({ id: 2, date: "2095-11-02", shift: "AM", slotIndex: 1, caddyId: 40, source: "ROTATION" }),
    slot({ id: 3, date: "2095-11-02", shift: "PM", slotIndex: 0, caddyId: 20, source: "PENALTY" }),
  ];
  const toSlots = [
    slot({ id: 4, date: "2095-11-06", shift: "AM", slotIndex: 0, caddyId: 50, source: "ROTATION" }),
    slot({ id: 5, date: "2095-11-06", shift: "AM", slotIndex: 1, caddyId: 60, source: "ROTATION" }),
    slot({ id: 6, date: "2095-11-06", shift: "PM", slotIndex: 0, caddyId: 70, source: "ROTATION" }),
  ];
  const move = planLocalFullDayMove({
    fromDate: "2095-11-02",
    toDate: "2095-11-06",
    moving: { caddyId: 20, profileId: 2 },
    fromSlots,
    toSlots,
    members: [member(1, "A"), member(2, "B"), member(3, "C"), member(4, "D"), member(5, "E"), member(6, "F"), member(7, "G")],
    monthCounts: new Map(),
  });
  assert(
    move.toUpdates.every((row) => row.caddyId === 20 && row.source === "PENALTY") &&
      move.toUpdates.length === 2,
    "B FULL_DAY pair moves to Nov 6"
  );
  assert(
    move.fromUpdates.length === 2 &&
      move.fromUpdates.every((row) => row.source === "ROTATION" && row.caddyId !== 20),
    "Nov 2 penalty pair becomes rotation fillers"
  );
  assert(
    move.displacedRotation.map((row) => row.caddyId).join(",") === "50,70",
    "displaces Nov 6 AM0 and PM rotation, keeps extra AM rotation"
  );
}

section("local move does not touch substitutes");
{
  const toSlots = [
    slot({ id: 4, date: "2095-11-06", shift: "AM", slotIndex: 0, caddyId: 50, source: "SUBSTITUTE" }),
    slot({ id: 5, date: "2095-11-06", shift: "AM", slotIndex: 1, caddyId: 60, source: "ROTATION" }),
    slot({ id: 6, date: "2095-11-06", shift: "PM", slotIndex: 0, caddyId: 70, source: "SUBSTITUTE" }),
  ];
  throws(
    () =>
      planLocalFullDayMove({
        fromDate: null,
        toDate: "2095-11-06",
        moving: { caddyId: 20, profileId: 2 },
        fromSlots: [],
        toSlots,
        members: [member(1, "A"), member(2, "B")],
        monthCounts: new Map(),
      }),
    "override_conflict",
    "cannot displace substitute to place FULL_DAY"
  );
}

section("same-day penalty conflict");
{
  throws(
    () =>
      planLocalFullDayMove({
        fromDate: "2095-11-02",
        toDate: "2095-11-06",
        moving: { caddyId: 20, profileId: 2 },
        fromSlots: [
          slot({ id: 1, date: "2095-11-02", shift: "AM", caddyId: 20, source: "PENALTY" }),
          slot({ id: 3, date: "2095-11-02", shift: "PM", caddyId: 20, source: "PENALTY" }),
        ],
        toSlots: [
          slot({ id: 4, date: "2095-11-06", shift: "AM", caddyId: 10, source: "PENALTY" }),
          slot({ id: 5, date: "2095-11-06", shift: "PM", caddyId: 10, source: "PENALTY" }),
          slot({ id: 6, date: "2095-11-06", shift: "AM", slotIndex: 1, caddyId: 60, source: "ROTATION" }),
        ],
        members: [member(1, "A"), member(2, "B"), member(3, "C")],
        monthCounts: new Map(),
      }),
    "date_taken",
    "cannot land on another penalty day"
  );
}

section("preview token stale");
{
  const token = makeSchedulePreviewToken({ a: 1, b: 2 });
  assert(token === makeSchedulePreviewToken({ b: 2, a: 1 }), "key order stable");
  throws(
    () => assertPreviewToken("deadbeef", token),
    "stale_preview",
    "mismatch 409"
  );
  throws(
    () => assertPreviewToken("", token),
    "preview_token_required",
    "missing token"
  );
}

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
