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
import { applyLiveResultToDraft, createDraftFromAutoResult } from "../src/lib/assignmentDraft";
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
    {
      id: 12,
      name: "병가김",
      team: "1조",
      teamOrder: 2,
      caddyType: "HOUSE",
      extraFlags: [],
      bucket: "excluded",
      excludedReasons: ["병가"],
      specialTags: [],
      assignmentLabels: ["병가"],
    },
  ];
  const groups = buildUnavailablePanelGroups({
    excluded,
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
  assert(/is-mobile-open/.test(fs.readFileSync(path.resolve("src/app/manage/assignments/UnavailablePanel.tsx"), "utf8")), "unavailable sheet open");
  assert(!/inset 0 -3px 0 #f59e0b/.test(page), "limo orange stripe removed");
  assert(/isDraftOnlyLiveChange/.test(page), "HOUSE skips apply persist");
  assert(/autoAssignEngine/.test(fs.readFileSync(path.resolve("src/lib/assignmentBoardDirectEdit.ts"), "utf8")), "helper imports types only");
}

console.log("== SET_HOUSE apply empty events ==");
void applyLiveAssignmentChange({
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
});
