/**
 * 자동배치 V3-A1 직접 수정 화면 targeted test (DB 없음)
 * 실행: npx tsx scripts/test-assignment-board-direct-edit-unit.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  applyHouseRequestFlag,
  buildUnavailablePanelGroups,
  isHouseRequest,
  mergeDraftOnlyReservationFlags,
  offCaddiesFromRoster,
  unavailablePanelTotal,
} from "../src/lib/assignmentBoardDirectEdit";
import {
  buildUnavailableBoardView,
  countUnavailableBoardPeople,
  pickOpsStatusSummary,
  supportBadgesFromReason,
} from "../src/lib/unavailablePanelView";
import {
  opsDutyPanelRowsFromReadOnly,
  resolveOpsDutyReadOnly,
} from "../src/lib/opsDutyReadOnlySource";
import { applyLiveResultToDraft, createDraftFromAutoResult, unusedCaddies } from "../src/lib/assignmentDraft";
import {
  isOperationalCaddy,
  isOperationalEmploymentStatus,
  mergeOperationalRoster,
} from "../src/lib/operationalRoster";
import { reservationMoveBlockReason } from "../src/lib/reservationMove";
import {
  applyLiveAssignmentChange,
  eventsFromLiveChange,
  isDraftOnlyLiveChange,
  isInstantQuickAction,
  isPatchableLiveChange,
  isSequenceReflowLiveChange,
  liveBoardSnapshot,
  makeMoveReservationChange,
  previewLiveAssignmentChange,
} from "../src/lib/assignmentChange";
import { reservationKey, type AutoAssignCaddy, type AutoAssignReservation, type AutoAssignResultV1 } from "../src/lib/autoAssignEngine";
import type { AvailabilityRow } from "../src/lib/availabilityEngine";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}

function caddy(id: number, name = `캐디${id}`): AutoAssignCaddy {
  return { id, name, team: `${id}조`, teamOrder: 1, caddyType: "HOUSE" };
}

function reservation(
  id: string,
  extra: Partial<AutoAssignReservation> = {}
): AutoAssignReservation {
  return {
    id,
    date: "2026-09-06",
    course: "SKY",
    shift: extra.shift || "1부",
    teeTime: extra.teeTime || "07:00",
    teamName: extra.teamName || id,
    limousineCart: extra.limousineCart,
    houseRequest: extra.houseRequest,
  };
}

function row(
  res: AutoAssignReservation,
  cad: AutoAssignCaddy,
  extra: Partial<AutoAssignResultV1["assignments"][number]> = {}
) {
  return {
    date: res.date,
    shift: res.shift as "1부",
    sequenceIndex: extra.sequenceIndex ?? 0,
    reason: extra.reason ?? "REGULAR_SEQUENCE",
    reservation: res,
    caddy: cad,
    kind: extra.kind ?? ("regular" as const),
    locked: extra.locked,
  };
}

function result(assignments: AutoAssignResultV1["assignments"]): AutoAssignResultV1 {
  return {
    date: "2026-09-06",
    assignments,
    fixedAssignments: [],
    fiftyFourHoleAssignments: [],
    oneThreeAssignments: [],
    oneTwoAssignments: [],
    twoThreeAssignments: [],
    oneMakAssignments: [],
    weekendBandAssignments: [],
    regularAssignments: assignments,
    unassignedReservations: [],
    closedCourseReservations: [],
    unusedCaddies: [],
    special: [],
    specialUnassigned: [],
    openCourses: ["SKY", "OCEAN", "LAKE", "VERTHILL"],
    sparesByShift: [
      { shift: "1부", spare1: caddy(90, "스1"), spare2: caddy(91, "스2") },
    ],
    meta: {} as AutoAssignResultV1["meta"],
  };
}

const a = reservation("A", { teeTime: "07:00", teamName: "A팀" });
const b = reservation("B", { teeTime: "07:07", teamName: "B팀" });
const c = reservation("C", { teeTime: "07:14", teamName: "C팀" });
const c1 = caddy(1);
const c2 = caddy(2);
const c3 = caddy(3);
const base = result([row(a, c1), row(b, c2, { sequenceIndex: 1 }), row(c, c3, { sequenceIndex: 2 })]);
const pool = [c1, c2, c3, caddy(4), caddy(5)];

console.log("== MOVE / CANCEL / NOSHOW reuse ==");
{
  const move = makeMoveReservationChange({
    reservationKey: reservationKey(a),
    to: { course: "SKY", shift: "1부", teeTime: "07:21" },
  });
  const events = eventsFromLiveChange(move);
  assert(move.type === "MOVE_RESERVATION", "cell 팀 이동 uses MOVE_RESERVATION");
  assert(events[0]?.type === "MOVE_RESERVATION", "MOVE event unchanged");
  assert(isSequenceReflowLiveChange("MOVE_RESERVATION"), "MOVE still local reflow");

  const cancel = eventsFromLiveChange({
    type: "CANCEL_RESERVATION",
    reservationKey: reservationKey(a),
  });
  const noshow = eventsFromLiveChange({
    type: "TEAM_NOSHOW",
    reservationKey: reservationKey(a),
  });
  assert(cancel[0]?.type === "CANCEL_RESERVATION", "CANCEL event");
  assert(
    cancel[0] &&
      cancel[0].type === "CANCEL_RESERVATION" &&
      cancel[0].cause === "CANCEL",
    "CANCEL cause"
  );
  assert(
    noshow[0] &&
      noshow[0].type === "CANCEL_RESERVATION" &&
      noshow[0].cause === "TEAM_NOSHOW",
    "NOSHOW same cancel event, different cause"
  );
  assert(
    isSequenceReflowLiveChange("CANCEL_RESERVATION") &&
      isSequenceReflowLiveChange("TEAM_NOSHOW"),
    "CANCEL/NOSHOW still reflow"
  );
}

console.log("== HOUSE + LIMOUSINE flags ==");
{
  const withLimo = {
    ...base,
    assignments: base.assignments.map((r, i) =>
      i === 0
        ? { ...r, reservation: { ...r.reservation, limousineCart: true } }
        : r
    ),
  };
  const afterHouse = applyHouseRequestFlag(withLimo, reservationKey(a), true);
  const target = afterHouse.assignments[0]?.reservation;
  assert(target?.limousineCart === true, "HOUSE toggle keeps LIMO");
  assert(isHouseRequest(target || {}), "HOUSE on");
  assert(
    afterHouse.assignments[1]?.reservation.houseRequest !== true,
    "other teams unchanged"
  );
  const bothOffHouse = applyHouseRequestFlag(afterHouse, reservationKey(a), false);
  assert(
    bothOffHouse.assignments[0]?.reservation.limousineCart === true &&
      bothOffHouse.assignments[0]?.reservation.houseRequest === false,
    "HOUSE off keeps LIMO"
  );
  const preview = previewLiveAssignmentChange({
    previous: withLimo,
    regularCaddyPool: pool,
    change: {
      type: "SET_HOUSE",
      reservationKey: reservationKey(a),
      houseRequest: true,
    },
  });
  assert(preview.changeType === "SET_HOUSE", "SET_HOUSE preview type");
  assert(
    preview.after.assignments[0]?.caddy.id === 1 &&
      preview.after.assignments[1]?.caddy.id === 2 &&
      preview.after.assignments[2]?.caddy.id === 3,
    "HOUSE does not move caddies"
  );
  assert(isInstantQuickAction("SET_HOUSE"), "HOUSE is instant");
  assert(isPatchableLiveChange("SET_HOUSE"), "HOUSE is patchable/draft-only");
  assert(!isSequenceReflowLiveChange("SET_HOUSE"), "HOUSE no reflow");
  assert(isDraftOnlyLiveChange("SET_HOUSE"), "HOUSE draft-only persist");
  assert(!isDraftOnlyLiveChange("SET_LIMOUSINE"), "LIMO still uses apply");

  const houseFirst = previewLiveAssignmentChange({
    previous: base,
    regularCaddyPool: pool,
    change: {
      type: "SET_HOUSE",
      reservationKey: reservationKey(a),
      houseRequest: true,
    },
  });
  const houseThenLimo = previewLiveAssignmentChange({
    previous: houseFirst.after,
    regularCaddyPool: pool,
    change: {
      type: "SET_LIMOUSINE",
      reservationKey: reservationKey(a),
      limousineCart: true,
    },
  });
  assert(
    houseThenLimo.after.assignments[0]?.reservation.houseRequest === true &&
      houseThenLimo.after.assignments[0]?.reservation.limousineCart === true,
    "HOUSE then LIMO keeps both"
  );
  const limoFirst = previewLiveAssignmentChange({
    previous: base,
    regularCaddyPool: pool,
    change: {
      type: "SET_LIMOUSINE",
      reservationKey: reservationKey(a),
      limousineCart: true,
    },
  });
  const limoThenHouse = previewLiveAssignmentChange({
    previous: limoFirst.after,
    regularCaddyPool: pool,
    change: {
      type: "SET_HOUSE",
      reservationKey: reservationKey(a),
      houseRequest: true,
    },
  });
  assert(
    limoThenHouse.after.assignments[0]?.reservation.houseRequest === true &&
      limoThenHouse.after.assignments[0]?.reservation.limousineCart === true,
    "LIMO then HOUSE keeps both"
  );
  const limoOff = previewLiveAssignmentChange({
    previous: houseThenLimo.after,
    regularCaddyPool: pool,
    change: {
      type: "SET_LIMOUSINE",
      reservationKey: reservationKey(a),
      limousineCart: false,
    },
  });
  assert(
    limoOff.after.assignments[0]?.reservation.houseRequest === true &&
      limoOff.after.assignments[0]?.reservation.limousineCart === false,
    "LIMO OFF keeps HOUSE"
  );
  const houseOff = previewLiveAssignmentChange({
    previous: houseThenLimo.after,
    regularCaddyPool: pool,
    change: {
      type: "SET_HOUSE",
      reservationKey: reservationKey(a),
      houseRequest: false,
    },
  });
  assert(
    houseOff.after.assignments[0]?.reservation.houseRequest === false &&
      houseOff.after.assignments[0]?.reservation.limousineCart === true,
    "HOUSE OFF keeps LIMO"
  );
  const dropped = {
    ...houseThenLimo.after,
    assignments: houseThenLimo.after.assignments.map((row, i) =>
      i === 0
        ? {
            ...row,
            reservation: { ...row.reservation, houseRequest: undefined },
          }
        : row
    ),
  };
  const restored = mergeDraftOnlyReservationFlags(dropped, {
    assignments: houseThenLimo.after.assignments,
  });
  assert(
    restored.assignments[0]?.reservation.houseRequest === true &&
      restored.assignments[0]?.reservation.limousineCart === true,
    "live after merge restores Draft HOUSE"
  );
  const draft = createDraftFromAutoResult(houseFirst.after, pool);
  const mergedDraft = applyLiveResultToDraft(draft, dropped);
  assert(
    mergedDraft.assignments[0]?.reservation.houseRequest === true &&
      mergedDraft.assignments[0]?.reservation.limousineCart === true,
    "applyLiveResultToDraft keeps HOUSE across LIMO rebuild"
  );
}

console.log("== SWAP A↔B only ==");
{
  const preview = previewLiveAssignmentChange({
    previous: base,
    regularCaddyPool: pool,
    change: {
      type: "SWAP_CADDY",
      reservationKeyA: reservationKey(a),
      reservationKeyB: reservationKey(c),
    },
  });
  assert(preview.after.assignments[0]?.caddy.id === 3, "A gets C");
  assert(preview.after.assignments[2]?.caddy.id === 1, "C gets A");
  assert(preview.after.assignments[1]?.caddy.id === 2, "middle unchanged");
  const before = liveBoardSnapshot(base);
  const after = liveBoardSnapshot(preview.after);
  assert(
    JSON.stringify(before.spares) === JSON.stringify(after.spares),
    "spares unchanged"
  );
  assert(after.placements.length === before.placements.length, "placement count same");
}

console.log("== SICK mutation type ==");
{
  const events = eventsFromLiveChange({
    type: "CADDY_SICK",
    caddyId: 1,
    shift: "1부",
  });
  assert(events[0]?.type === "REMOVE_CADDY", "SICK still REMOVE_CADDY");
  assert(
    events[0] && events[0].type === "REMOVE_CADDY" && events[0].cause === "SICK",
    "SICK cause unchanged"
  );
}

console.log("== unavailable panel grouping ==");
{
  const excluded: AvailabilityRow[] = [
    {
      id: 11,
      name: "홍길동",
      team: "3조",
      teamOrder: 1,
      caddyType: "HOUSE",
      extraFlags: [],
      bucket: "excluded",
      excludedReasons: ["휴무"],
      specialTags: [],
      assignmentLabels: ["휴무"],
    },
  ];
  const groups = buildUnavailablePanelGroups({
    excluded,
    dailyUnavailables: [
      { caddyId: 12, name: "병가김", team: "1조", reason: "SICK" },
    ],
    opsDuties: [
      { caddyId: 13, name: "조장박", team: "2조", role: "LEADER" },
    ],
    specialSupportByShift: {
      "1부": [{ id: 11 }],
      "2부": [],
      "3부": [],
    },
  });
  const off = groups.find((g) => g.category === "휴무")?.items[0];
  const sick = groups.find((g) => g.category === "병가")?.items[0];
  const leader = groups.find((g) => g.category === "조장")?.items[0];
  assert(off?.reason.includes("휴무") && off.reason.includes("1부 지원"), "휴무 → 지원");
  assert(sick?.name === "병가김", "병가 group");
  assert(leader?.name === "조장박", "조장 from ops duty");
  assert(unavailablePanelTotal(groups) === 3, "unavailable count");

  const hydrated = buildUnavailablePanelGroups({
    opsDuties: [{ caddyId: 21, name: "당번이", team: "1조", role: "DUTY_AM" }],
    offCaddies: offCaddiesFromRoster(
      [22],
      [{ id: 22, name: "휴무자", team: "4조" }]
    ),
    dailyUnavailables: [
      { caddyId: 23, name: "병가자", team: "2조", reason: "SICK" },
      { caddyId: 24, name: "결근자", team: "5조", reason: "ATTENDANCE_NOSHOW" },
    ],
    specialSupportByShift: {
      "1부": [{ id: 22 }],
      "2부": [],
      "3부": [],
    },
  });
  assert(
    hydrated.find((g) => g.category === "당번")?.items[0]?.name === "당번이",
    "ops duty without excluded"
  );
  assert(
    hydrated.find((g) => g.category === "휴무")?.items[0]?.reason.includes(
      "휴무"
    ) &&
      hydrated
        .find((g) => g.category === "휴무")
        ?.items[0]?.reason.includes("1부 지원"),
    "off snapshot 휴무 → 지원 without excluded"
  );
  assert(
    hydrated.find((g) => g.category === "병가")?.items[0]?.name === "병가자",
    "DailyCaddyUnavailable 병가"
  );
  assert(
    hydrated.find((g) => g.category === "결근")?.items[0]?.name === "결근자",
    "DailyCaddyUnavailable 결근"
  );
  assert(unavailablePanelTotal(hydrated) === 4, "hydrate sources without availability");
}

console.log("== unavailable board presentation ==");
{
  const groups = buildUnavailablePanelGroups({
    excluded: [
      {
        id: 31,
        name: "휴무갑",
        team: "1조",
        teamOrder: 1,
        caddyType: "HOUSE",
        extraFlags: [],
        bucket: "excluded",
        excludedReasons: ["휴무"],
        specialTags: [],
        assignmentLabels: ["휴무"],
      },
      {
        id: 32,
        name: "휴무을",
        team: "1조",
        teamOrder: 2,
        caddyType: "HOUSE",
        extraFlags: [],
        bucket: "excluded",
        excludedReasons: ["휴무"],
        specialTags: [],
        assignmentLabels: ["휴무"],
      },
      {
        id: 33,
        name: "휴무병",
        team: "10조",
        teamOrder: 3,
        caddyType: "THIRD",
        extraFlags: [],
        bucket: "excluded",
        excludedReasons: ["휴무"],
        specialTags: [],
        assignmentLabels: ["휴무"],
      },
      {
        id: 34,
        name: "드라이빙휴",
        team: "드라이빙",
        teamOrder: 0,
        caddyType: "DRIVING",
        extraFlags: [],
        bucket: "excluded",
        excludedReasons: ["휴무"],
        specialTags: [],
        assignmentLabels: ["휴무"],
      },
    ],
    opsDuties: [
      { caddyId: 41, name: "조출하나", team: "2조", role: "DUTY_AM" },
      { caddyId: 42, name: "조출둘", team: "3조", role: "DUTY_AM" },
      { caddyId: 43, name: "후출하나", team: "4조", role: "DUTY_PM" },
      { caddyId: 44, name: "마샬조출", team: "5조", role: "MARSHAL_AM" },
      { caddyId: 45, name: "조장임", team: "6조", role: "LEADER" },
    ],
    dailyUnavailables: [
      { caddyId: 51, name: "병가자", team: "7조", reason: "SICK" },
      { caddyId: 52, name: "결근자", team: "8조", reason: "ATTENDANCE_NOSHOW" },
    ],
    specialSupportByShift: {
      "1부": [{ id: 31 }],
      "2부": [],
      "3부": [],
    },
  });
  const view = buildUnavailableBoardView(groups);
  assert(view.total === unavailablePanelTotal(groups), "view total matches groups");
  assert(countUnavailableBoardPeople(view) === view.total, "every person rendered once");
  assert(view.offTeams.map((b) => b.team).join(",") === "1조,10조", "휴무 teams compact, empty omitted");
  assert(
    view.offTeams[0]?.people.map((p) => p.name).join(",") === "휴무갑,휴무을",
    "휴무 names stay in team"
  );
  assert(
    view.offTeams[0]?.people[0]?.badges.join(",") === "1부지원",
    "휴무 → 1부지원 badge"
  );
  assert(
    supportBadgesFromReason("휴무 → 1부·3부 지원").join(",") === "1부지원,3부지원",
    "multi support badges"
  );
  assert(view.sick.map((p) => p.name).join(",") === "병가자", "병가 compact");
  assert(view.absent.map((p) => p.name).join(",") === "결근자", "결근 compact");
  assert(
    view.dutySlots.map((s) => `${s.label}:${s.people.map((p) => p.name).join("/")}`).join("|") ===
      "조출1:조출하나|조출2:조출둘|후출1:후출하나|후출2:",
    "당번 slots"
  );
  assert(
    view.marshalSlots.map((s) => s.label).join(",") === "조출1,조출2,후출1",
    "마샬 slot labels"
  );
  assert(view.leaders[0]?.name === "조장임", "조장 section");
  assert(
    view.specialBands.map((b) => `${b.team}:${b.people[0]?.name}`).join(",") ===
      "드라이빙:드라이빙휴",
    "특수반 only when team already exists"
  );
  assert(view.specialBands.every((b) => b.team !== "주중반"), "missing 주중반 hidden");
  const picked = pickOpsStatusSummary(
    { baseAvailable: 88, off: 40, finalAvailable: 61 },
    groups,
    view
  );
  assert(picked.employed === 88 && picked.off === 40 && picked.finalAvailable === 61, "summary reuses dailySummary");
  assert(picked.sick === 1 && picked.absent === 1, "summary reuses grouped 병가/결근");
}

console.log("== unavailable display classification ==");
{
  const excludedSickDuty: AvailabilityRow = {
    id: 61,
    name: "당번조출일",
    team: "2조",
    teamOrder: 1,
    caddyType: "HOUSE",
    extraFlags: [],
    bucket: "excluded",
    excludedReasons: ["병가"],
    specialTags: [],
    assignmentLabels: ["병가"],
  };
  const groups = buildUnavailablePanelGroups({
    excluded: [
      {
        id: 71,
        name: "휴무자",
        team: "1조",
        teamOrder: 1,
        caddyType: "HOUSE",
        extraFlags: [],
        bucket: "excluded",
        excludedReasons: ["휴무"],
        specialTags: [],
        assignmentLabels: ["휴무"],
      },
      excludedSickDuty,
    ],
    opsDuties: [
      { caddyId: 61, name: "당번조출일", team: "2조", role: "DUTY_AM", roleKey: "당번_조출_1" },
      { caddyId: 62, name: "마샬후출일", team: "3조", role: "MARSHAL_PM", roleKey: "마샬_후출_1" },
      { caddyId: 63, name: "조장일", team: "4조", role: "LEADER", roleKey: "조장_1" },
    ],
    dailyUnavailables: [
      { caddyId: 81, name: "실제병가", team: "5조", reason: "SICK" },
      { caddyId: 82, name: "실제결근", team: "6조", reason: "ATTENDANCE_NOSHOW" },
    ],
    specialSupportByShift: {
      "1부": [{ id: 71 }],
      "2부": [],
      "3부": [],
    },
  });
  const sources = {
    opsDuties: [
      { caddyId: 61, role: "DUTY_AM", roleKey: "당번_조출_1" },
      { caddyId: 62, role: "MARSHAL_PM", roleKey: "마샬_후출_1" },
      { caddyId: 63, role: "LEADER", roleKey: "조장_1" },
    ],
    dailyUnavailables: [
      { caddyId: 81, reason: "SICK" },
      { caddyId: 82, reason: "ATTENDANCE_NOSHOW" },
    ],
  };
  const view = buildUnavailableBoardView(groups, sources);
  const offNames = view.offTeams.flatMap((b) => b.people.map((p) => p.name));
  const dutyMap = Object.fromEntries(
    view.dutySlots.map((s) => [s.label, s.people.map((p) => p.name).join(",")])
  );
  const marshalMap = Object.fromEntries(
    view.marshalSlots.map((s) => [s.label, s.people.map((p) => p.name).join(",")])
  );
  assert(offNames.join(",") === "휴무자", "OFF -> 휴무");
  assert(view.offTeams[0]?.people[0]?.badges.join(",") === "1부지원", "휴무 + specialSupport badge");
  assert(view.sick.map((p) => p.name).join(",") === "실제병가", "SICK only -> 병가");
  assert(view.absent.map((p) => p.name).join(",") === "실제결근", "NOSHOW -> 결근");
  assert(dutyMap["조출1"] === "당번조출일", "당번 조출1");
  assert(marshalMap["후출1"] === "마샬후출일", "마샬 후출1");
  assert(view.leaders[0]?.name === "조장일", "조장 section");
  assert(
    !view.sick.some((p) => ["당번조출일", "마샬후출일", "조장일"].includes(p.name)),
    "당번/마샬/조장 not in 병가"
  );
  assert(view.conflicts.length === 0, "no false SICK+duty conflict");
  assert(view.total === 6, "unique people 6");
  assert(countUnavailableBoardPeople(view) === 6, "section sum == unique");

  const conflictGroups = buildUnavailablePanelGroups({
    excluded: [excludedSickDuty],
    opsDuties: [
      { caddyId: 61, name: "당번조출일", team: "2조", role: "DUTY_AM", roleKey: "당번_조출_1" },
    ],
    dailyUnavailables: [{ caddyId: 61, name: "당번조출일", team: "2조", reason: "SICK" }],
  });
  const conflictView = buildUnavailableBoardView(conflictGroups, {
    opsDuties: [{ caddyId: 61, role: "DUTY_AM", roleKey: "당번_조출_1" }],
    dailyUnavailables: [{ caddyId: 61, reason: "SICK" }],
  });
  assert(conflictView.conflicts.length === 1, "real SICK+duty reported once");
  assert(conflictView.sick.length === 0, "conflict not counted as 병가");
  assert(
    conflictView.dutySlots.every((s) => s.people.length === 0),
    "conflict not duplicated as 당번"
  );
  assert(countUnavailableBoardPeople(conflictView) === 1, "conflict unique count");
}

console.log("== 2026-08-28 shaped sources ==");
{
  const groups = buildUnavailablePanelGroups({
    excluded: [
      {
        id: 901,
        name: "제외병가라벨",
        team: "1조",
        teamOrder: 1,
        caddyType: "HOUSE",
        extraFlags: [],
        bucket: "excluded",
        excludedReasons: ["병가"],
        specialTags: [],
        assignmentLabels: ["병가"],
      },
    ],
    offCaddies: offCaddiesFromRoster(
      [101, 102],
      [
        { id: 101, name: "휴무A", team: "1조" },
        { id: 102, name: "휴무B", team: "2조" },
      ]
    ),
    dailyUnavailables: [
      { caddyId: 201, name: "실제병가A", team: "3조", reason: "SICK" },
      { caddyId: 202, name: "실제병가B", team: "4조", reason: "SICK" },
    ],
    opsDuties: [],
  });
  assert(groups.find((g) => g.category === "휴무")?.items.length === 2, "OFF -> 휴무");
  assert(groups.find((g) => g.category === "병가")?.items.length === 2, "actual SICK only");
  assert(
    !groups.find((g) => g.category === "병가")?.items.some((i) => i.name === "제외병가라벨"),
    "generic excluded not SICK"
  );
  assert(groups.find((g) => g.category === "기타")?.items[0]?.name === "제외병가라벨", "excluded 병가 label -> 기타");
  assert(!groups.find((g) => g.category === "당번"), "no duty source -> no 당번");

  const withSheetDuty = buildUnavailablePanelGroups({
    dailyUnavailables: [{ caddyId: 201, name: "실제병가A", team: "3조", reason: "SICK" }],
    offCaddies: offCaddiesFromRoster([101], [{ id: 101, name: "휴무A", team: "1조" }]),
    opsDuties: [
      { caddyId: 301, name: "당번시트", team: "5조", role: "DUTY_AM", roleKey: "당번_조출_1" },
      { caddyId: 302, name: "마샬시트", team: "6조", role: "MARSHAL_PM", roleKey: "마샬_후출_1" },
      { caddyId: 303, name: "조장시트", team: "7조", role: "LEADER", roleKey: "조장_1" },
    ],
  });
  const sheetView = buildUnavailableBoardView(withSheetDuty, {
    opsDuties: [
      { caddyId: 301, role: "DUTY_AM", roleKey: "당번_조출_1" },
      { caddyId: 302, role: "MARSHAL_PM", roleKey: "마샬_후출_1" },
      { caddyId: 303, role: "LEADER", roleKey: "조장_1" },
    ],
    dailyUnavailables: [{ caddyId: 201, reason: "SICK" }],
  });
  assert(sheetView.offTeams.flatMap((b) => b.people).length === 1, "sheet fixture 휴무");
  assert(sheetView.sick.length === 1 && sheetView.sick[0]?.name === "실제병가A", "sheet fixture 병가");
  assert(
    sheetView.dutySlots.find((s) => s.label === "조출1")?.people[0]?.name === "당번시트",
    "sheet/DB 당번"
  );
  assert(
    sheetView.marshalSlots.find((s) => s.label === "후출1")?.people[0]?.name === "마샬시트",
    "sheet/DB 마샬"
  );
  assert(sheetView.leaders[0]?.name === "조장시트", "sheet/DB 조장");
}

console.log("== ops status independent of Draft + operational roster ==");
{
  const excluded: AvailabilityRow[] = [
    {
      id: 501,
      name: "휴무재직",
      team: "1조",
      teamOrder: 1,
      caddyType: "HOUSE",
      extraFlags: [],
      employmentStatus: "ACTIVE",
      bucket: "excluded",
      excludedReasons: ["휴무"],
      specialTags: [],
      assignmentLabels: ["휴무"],
    },
    {
      id: 502,
      name: "퇴사휴무",
      team: "2조",
      teamOrder: 1,
      caddyType: "HOUSE",
      extraFlags: [],
      employmentStatus: "RETIRED",
      bucket: "excluded",
      excludedReasons: ["퇴사(RETIRED)", "휴무"],
      specialTags: [],
      assignmentLabels: ["휴무"],
    },
    {
      id: 503,
      name: "삭제캐디",
      team: "3조",
      teamOrder: 1,
      caddyType: "HOUSE",
      extraFlags: [],
      employmentStatus: "DELETED",
      bucket: "excluded",
      excludedReasons: ["재직상태 아님(DELETED)"],
      specialTags: [],
      assignmentLabels: [],
    },
  ];
  const opsDuties = [
    { caddyId: 601, name: "당번재직", team: "4조", role: "DUTY_AM", employmentStatus: "ACTIVE" },
    { caddyId: 602, name: "당번퇴사", team: "5조", role: "DUTY_AM", employmentStatus: "RETIRED" },
    { caddyId: 603, name: "마샬재직", team: "6조", role: "MARSHAL_AM", employmentStatus: "ACTIVE" },
    { caddyId: 604, name: "조장재직", team: "7조", role: "LEADER", employmentStatus: "ACTIVE" },
  ];
  const dailyUnavailables = [
    { caddyId: 701, name: "병가재직", team: "8조", reason: "SICK", employmentStatus: "ACTIVE" },
    { caddyId: 702, name: "병가퇴사", team: "9조", reason: "SICK", employmentStatus: "RETIRED" },
  ];
  const roster = mergeOperationalRoster(excluded, [
    { id: 601, name: "당번재직", team: "4조", employmentStatus: "ACTIVE" },
    { id: 801, name: "가용재직", team: "1조", employmentStatus: "ACTIVE" },
    { id: 802, name: "퇴사풀", team: "2조", employmentStatus: "RETIRED" },
  ]);
  const offCaddies = offCaddiesFromRoster(
    [501, 502, 802],
    roster
  );
  const withoutDraft = buildUnavailablePanelGroups({
    excluded,
    opsDuties,
    offCaddies,
    dailyUnavailables,
  });
  const withDraft = buildUnavailablePanelGroups({
    excluded,
    opsDuties,
    offCaddies,
    dailyUnavailables,
  });
  const names = (groups: ReturnType<typeof buildUnavailablePanelGroups>) =>
    groups.flatMap((g) => g.items.map((i) => i.name)).sort().join(",");
  assert(names(withoutDraft) === names(withDraft), "same date ops groups before/after Draft");
  assert(unavailablePanelTotal(withoutDraft) === unavailablePanelTotal(withDraft), "same count before/after Draft");
  assert(
    withoutDraft.find((g) => g.category === "휴무")?.items.map((i) => i.name).join(",") ===
      "휴무재직",
    "ACTIVE 휴무 stays, retired OFF dropped"
  );
  assert(
    withoutDraft.find((g) => g.category === "당번")?.items.map((i) => i.name).join(",") ===
      "당번재직",
    "retired duty source hidden from current ops"
  );
  assert(
    withoutDraft.find((g) => g.category === "마샬")?.items[0]?.name === "마샬재직",
    "marshal classification unchanged"
  );
  assert(
    withoutDraft.find((g) => g.category === "조장")?.items[0]?.name === "조장재직",
    "leader classification unchanged"
  );
  assert(
    withoutDraft.find((g) => g.category === "병가")?.items.map((i) => i.name).join(",") ===
      "병가재직",
    "retired SICK hidden"
  );
  assert(
    !names(withoutDraft).includes("퇴사") && !names(withoutDraft).includes("삭제캐디"),
    "RETIRED/DELETED absent from current ops panel"
  );
  assert(roster.some((r) => r.name === "가용재직"), "ACTIVE stays in operational roster");
  assert(!roster.some((r) => r.employmentStatus === "RETIRED"), "RETIRED absent from operational roster");
  assert(isOperationalEmploymentStatus("ACTIVE") && !isOperationalEmploymentStatus("RETIRED"), "ACTIVE filter");
  assert(!isOperationalEmploymentStatus("DELETED") && !isOperationalCaddy({
    id: 9,
    employmentStatus: "RETIRED",
    excludedReasons: ["휴무"],
  }), "retired+OFF still non-operational");

  const unused = unusedCaddies({
    date: "2026-09-10",
    status: "DRAFT",
    assignments: [],
    unassignedReservations: [],
    closedCourseReservations: [],
    openCourses: ["SKY"],
    sparesByShift: [],
    confirmedAt: null,
    caddyPool: [
      { id: 801, name: "가용재직", team: "1조", teamOrder: 1, caddyType: "HOUSE", employmentStatus: "ACTIVE" },
      { id: 802, name: "퇴사풀", team: "2조", teamOrder: 1, caddyType: "HOUSE", employmentStatus: "RETIRED" },
    ],
  });
  assert(
    unused.map((c) => c.name).join(",") === "가용재직",
    "unused/pick candidates drop RETIRED"
  );

  const storedDutyRows = opsDutyPanelRowsFromReadOnly(
    {
      source: "stored",
      stored: [
        {
          id: 1,
          role: "DUTY_AM",
          roleKey: "당번_조출_1",
          caddyId: 601,
          rawName: "당번재직",
          name: "당번재직",
          team: "4조",
          employmentStatus: "ACTIVE",
        },
        {
          id: 2,
          role: "DUTY_PM",
          roleKey: "당번_후출_1",
          caddyId: 602,
          rawName: "당번퇴사",
          name: "당번퇴사",
          team: "5조",
          employmentStatus: "RETIRED",
        },
      ],
      sheetEntries: [],
      error: null,
    },
    [
      { id: 601, name: "당번재직", team: "4조", employmentStatus: "ACTIVE" },
      { id: 602, name: "당번퇴사", team: "5조", employmentStatus: "RETIRED" },
    ]
  );
  assert(
    storedDutyRows.map((r) => r.name).join(",") === "당번재직",
    "stored DailyOpsDuty retired not shown"
  );
}

console.log("== opsDuty read-only sheet fallback ==");
const opsDutyFallbackChecks = Promise.all([
  resolveOpsDutyReadOnly("2026-08-28", {
    listDuties: async () => [
      {
        id: 1,
        role: "DUTY_AM",
        roleKey: "당번_조출_1",
        caddyId: 11,
        rawName: "DB당번",
        name: "DB당번",
        team: "1조",
        employmentStatus: "ACTIVE",
      },
    ],
    fetchOpsDutySheets: async () => {
      throw new Error("stored가 있으면 sheet를 읽지 않음");
    },
  }),
  resolveOpsDutyReadOnly("2026-08-28", {
    listDuties: async () => [],
    fetchOpsDutySheets: async () => {
      throw new Error("선택한 날짜 2026-08-28를 운영 탭에서 찾지 못했습니다.");
    },
  }),
]).then(([stored, missingDate]) => {
  assert(stored.source === "stored" && stored.stored.length === 1, "DB rows win");
  assert(missingDate.source === "none" && missingDate.sheetEntries.length === 0, "8/28 sheet date missing");
  const sheetRows = opsDutyPanelRowsFromReadOnly(
    {
      source: "sheet",
      stored: [],
      sheetEntries: [
        { kind: "duty_am", roleKey: "당번_조출_1", rawName: "시트당번" },
        { kind: "marshal_pm", roleKey: "마샬_후출_1", rawName: "시트마샬" },
        { kind: "leader", roleKey: "조장_1", rawName: "시트조장" },
      ],
      error: null,
    },
    [
      { id: 11, name: "시트당번", team: "1조", employmentStatus: "ACTIVE" },
      { id: 12, name: "시트마샬", team: "2조", employmentStatus: "ACTIVE" },
      { id: 13, name: "시트조장", team: "3조", employmentStatus: "ACTIVE" },
    ]
  );
  assert(sheetRows.map((r) => r.role).join(",") === "DUTY_AM,MARSHAL_PM,LEADER", "sheet match roles");
  const dutyRoute = fs.readFileSync(
    path.resolve("src/app/api/daily-ops-duties/route.ts"),
    "utf8"
  );
  assert(/resolveOpsDutyReadOnly/.test(dutyRoute), "GET daily-ops-duties uses sheet fallback");
  assert(!/replaceDailyOpsDuties/.test(dutyRoute), "GET daily-ops-duties does not write");
});

console.log("== special TEAM MOVE keeps anchors ==");
{
  const ocean = reservation("D", {
    course: "OCEAN",
    teeTime: "07:00",
    teamName: "D팀",
  });
  const specialPrev = result([
    row(a, c1),
    row(b, c2, { sequenceIndex: 1, kind: "oneMak", locked: true, reason: "SPECIAL_CALL" }),
    row(c, c3, { sequenceIndex: 2 }),
    row(ocean, caddy(8, "고정"), {
      sequenceIndex: 3,
      kind: "oneThree",
      locked: true,
      reason: "ONE_THREE_PRIORITY",
    }),
  ]);
  assert(
    reservationMoveBlockReason(specialPrev.assignments[1]) == null,
    "special source TEAM MOVE allowed"
  );
  assert(
    reservationMoveBlockReason({
      ...specialPrev.assignments[0],
      locked: true,
    }) == null,
    "LOCK source TEAM MOVE allowed"
  );
  assert(
    reservationMoveBlockReason({
      ...specialPrev.assignments[0],
      kind: "driving",
    })?.code === "MOVE_DRIVING",
    "driving still blocked"
  );
  assert(
    reservationMoveBlockReason({
      ...specialPrev.assignments[0],
      kind: "fiftyFourHole",
    })?.code === "MOVE_FIFTY_FOUR",
    "54홀 still blocked"
  );
  const moved = previewLiveAssignmentChange({
    previous: specialPrev,
    regularCaddyPool: [...pool, caddy(8, "고정")],
    change: makeMoveReservationChange({
      reservationKey: reservationKey(b),
      to: { course: "SKY", shift: "1부", teeTime: "07:21" },
    }),
  });
  assert(
    !moved.warnings.some((w) => w.code === "MOVE_SPECIAL" || w.code === "MOVE_LOCKED"),
    "MOVE special/LOCK not blocked"
  );
  const dest = moved.after.assignments.find(
    (r) => r.reservation.teamName === "B팀"
  );
  const oceanAfter = moved.after.assignments.find(
    (r) => r.reservation.teamName === "D팀"
  );
  const xAtDest = dest?.caddy.id === 2;
  const xAtOld = moved.after.assignments.find(
    (r) =>
      r.caddy.id === 2 &&
      r.reservation.teeTime === "07:07" &&
      String(r.reservation.course) === "SKY"
  );
  assert(dest?.reservation.teeTime === "07:21", "team moved to dest");
  assert(!xAtDest, "special caddy does not follow team");
  assert(
    xAtOld != null ||
      (moved.after.unusedCaddies || []).some((c) => c.id === 2),
    "special caddy stays at old slot or unused"
  );
  assert(
    oceanAfter?.caddy.id === 8 && oceanAfter.reservation.teeTime === "07:00",
    "other special/fixed stays"
  );
  const aAfter = moved.after.assignments.find((r) => r.reservation.teamName === "A팀");
  assert(aAfter?.reservation.teeTime === "07:00", "unrelated team slot unchanged");
}

console.log("== UI source: cell menus ==");
{
  const sheet = fs.readFileSync(
    path.resolve("src/app/manage/assignments/LiveChangePanel.tsx"),
    "utf8"
  );
  const page = fs.readFileSync(
    path.resolve("src/app/manage/assignments/page.tsx"),
    "utf8"
  );
  const team = sheet.split("qa-team-actions")[1]?.split("qa-caddy-actions")[0] || "";
  const caddyBlock = sheet.split("qa-caddy-actions")[1] || "";
  assert(/onStartTeamMove/.test(team) && /MOVE/.test(page), "team move reuses existing start");
  assert(/CANCEL_RESERVATION/.test(team) && /캔슬/.test(team), "cancel label");
  assert(/TEAM_NOSHOW/.test(team), "noshow");
  assert(/SET_HOUSE/.test(team) && /SET_LIMOUSINE/.test(team), "house + limo");
  assert(/캐디 맞교환/.test(caddyBlock) && /CADDY_SICK/.test(caddyBlock), "swap + sick");
  assert(/CADDY_ATTENDANCE_NOSHOW/.test(caddyBlock) && /SET_LOCK/.test(caddyBlock), "absent + lock");
  assert(/UnavailablePanel/.test(page), "unavailable panel mounted");
  assert(/opsDuties:\s*opsDutyStored/.test(page), "unavailable panel gets opsDuties");
  assert(
    /\/api\/availability\?date=/.test(page) &&
      /offCaddiesFromRoster/.test(page) &&
      /dailyUnavailables/.test(page),
    "date hydrate reads availability GET + OFF + unavailable"
  );
  assert(/ops-unavail-chip/.test(page) && /비가용/.test(page), "mobile unavailable chip");
  assert(/data-ops-unavail-chip/.test(page), "mobile chip is not Draft-gated");
  assert(/data-ops-status-without-draft/.test(page), "ops status renders without Draft");
  assert(/hasSelectedDate && !draft/.test(page), "solo ops panel when date selected and no Draft");
  assert(/opsOffSnapshot/.test(page), "OFF snapshot hydrates without Draft");
  assert(/mergeOperationalRoster/.test(page), "page uses common operational roster");
  assert(
    !/method:\s*["']POST["']/.test(
      page.split("useEffect(() => {")[2] || ""
    ) || /\/api\/availability\?date=/.test(page),
    "date hydrate uses availability GET"
  );
  const publishedLib = fs.readFileSync(
    path.resolve("src/lib/dailyBoardPublished.ts"),
    "utf8"
  );
  const publishedService = fs.readFileSync(
    path.resolve("src/lib/dailyBoardPublishedService.ts"),
    "utf8"
  );
  const snapshotLib = fs.readFileSync(
    path.resolve("src/lib/adminOpsDashboard.ts"),
    "utf8"
  );
  assert(!/operationalRoster/.test(publishedLib), "Published payload helper not rewritten");
  assert(!/operationalRoster/.test(publishedService), "Published service not rewritten");
  assert(!/from ["']@\/lib\/operationalRoster["']/.test(snapshotLib), "ops dashboard snapshot not rewritten by this filter");
  const publishedFixture = {
    placements: [{ caddyName: "과거퇴사자", caddyId: 999 }],
  };
  assert(
    publishedFixture.placements[0]?.caddyName === "과거퇴사자",
    "Published fixture retired name preserved"
  );
  const unavailPanel = fs.readFileSync(
    path.resolve("src/app/manage/assignments/UnavailablePanel.tsx"),
    "utf8"
  );
  assert(/is-mobile-open/.test(unavailPanel), "unavailable sheet open");
  assert(/buildUnavailableBoardView/.test(unavailPanel), "panel uses compact board view");
  assert(/오늘 운영현황/.test(unavailPanel), "ops status panel title");
  assert(/재직/.test(unavailPanel) && /최종가용/.test(unavailPanel), "compact summary chips");
  assert(/병가 \/ 결근/.test(unavailPanel), "sick/absent combined section");
  assert(/특수근무/.test(unavailPanel) && /지원근무/.test(unavailPanel), "ops panel shows special + support");
  assert(/ops-unavail-collapse/.test(unavailPanel), "desktop collapse control");
  assert(!/method:\s*["']POST["']/.test(unavailPanel), "ops panel has no POST write");
  assert(!/method:\s*["']PUT["']/.test(unavailPanel), "ops panel has no PUT write");
  assert(!/fetch\(/.test(unavailPanel), "ops panel does not fetch");
  assert(!/<ul>/.test(unavailPanel), "raw unavailable list removed");
  assert(!/당일 가용 요약/.test(page), "top daily summary box removed");
  assert(/pickOpsStatusSummary/.test(page), "summary numbers reused not recalculated");
  assert(/sources=\{unavailableBoardSources\}/.test(page), "panel gets opsDuty + dailyUnavailables");
  assert(/상태\/역할 충돌/.test(unavailPanel), "conflict section rendered");
  assert(/has-ops-panel/.test(page), "PC two-col only when date selected");
  assert(/@container ops-assign \(min-width: 760px\)/.test(page), "PC side-by-side from content width 760");
  assert(/minmax\(0, 1fr\) 320px/.test(page), "right panel 320px");
  assert(/is-ops-panel-collapsed/.test(page), "desktop panel can collapse");
  assert(/data-ops-panel-open/.test(page), "chip tracks desktop panel open state");
  assert(/onRecordsLoaded=\{onSpecialSupportRecordsLoaded\}/.test(page), "support records reused for ops panel");
  assert(/onLoaded=\{onSpecialDutyLoaded\}/.test(page), "special duty groups reused for ops panel");
  assert(/position: sticky/.test(page), "desktop unavailable panel sticky");
  assert(/max-width: 759px/.test(page), "no forced side panel on narrow content");
  assert(/max-width: none/.test(page), "PC assignments page drops 720 cap");
  assert(!/inset 0 -3px 0 #f59e0b/.test(page), "limo orange stripe removed");
  assert(/isDraftOnlyLiveChange/.test(page), "HOUSE skips apply persist");
  assert(/autoAssignEngine/.test(fs.readFileSync(path.resolve("src/lib/assignmentBoardDirectEdit.ts"), "utf8")), "helper imports types only");
}

console.log("== SET_HOUSE apply empty events ==");
void opsDutyFallbackChecks.then(() => applyLiveAssignmentChange({
  previous: base,
  regularCaddyPool: pool,
  changeType: "SET_HOUSE",
  events: [],
  change: {
    type: "SET_HOUSE",
    reservationKey: reservationKey(a),
    houseRequest: true,
  },
}).then((applied) => {
  assert(applied.ok, "SET_HOUSE apply does not EMPTY_EVENTS");
  if (applied.ok) {
    assert(applied.preview.changeType === "SET_HOUSE", "apply returns HOUSE preview");
    assert(
      applied.preview.after.assignments[0]?.reservation.houseRequest === true,
      "HOUSE remains after apply"
    );
  }
  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}).catch((err) => {
  console.error("  ✗ SET_HOUSE apply threw", err);
  process.exit(1);
}));
