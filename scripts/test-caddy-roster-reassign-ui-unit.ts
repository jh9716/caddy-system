/**
 * 캐디 현장표 배치 편집 — 로컬 insert 초안 + mock Preview/Apply
 * 실행: npx tsx scripts/test-caddy-roster-reassign-ui-unit.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  planCaddyReassign,
  type ReassignBaseRow,
  type ReassignCaddyRow,
  type ReassignChange,
  type ReassignPlacement,
} from "../src/lib/caddyReassign";
import {
  applyRosterInsertMove,
  canRosterReassignCaddy,
  changedRosterPlacementIds,
  explicitPlacementsFromDraft,
  formatReassignTypeNote,
  formatRosterSlotLabel,
  isRosterSearchLocked,
  listRosterEditSlots,
  listRosterMoveTargets,
  pushRosterUndoSnapshot,
  ROSTER_REASSIGN_MODE,
  ROSTER_REASSIGN_SEARCH_LOCK_MESSAGE,
} from "../src/lib/caddyRosterReassignDraft";
import {
  isStaleRosterError,
  postCaddyReassignApply,
  postCaddyReassignPreview,
  type CaddyReassignFetch,
} from "../src/lib/caddyReassignClient";

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

function row(
  partial: Partial<ReassignCaddyRow> & {
    id: number;
    name: string;
    team: string;
    teamOrder: number;
  }
): ReassignCaddyRow {
  return {
    employmentStatus: "ACTIVE",
    caddyType:
      partial.team === "9조" ||
      partial.team === "10조" ||
      partial.team === "11조" ||
      partial.team === "12조"
        ? "THIRD"
        : "HOUSE",
    thirdBandSubgroup: null,
    updatedAt: new Date("2026-10-17T00:00:00.000Z"),
    ...partial,
  };
}

const fixture: ReassignCaddyRow[] = [
  row({ id: 101, name: "김철수", team: "7조", teamOrder: 3 }),
  row({ id: 102, name: "박영수", team: "7조", teamOrder: 4 }),
  row({ id: 103, name: "이민호", team: "7조", teamOrder: 5 }),
  row({ id: 201, name: "최10-4", team: "10조", teamOrder: 4 }),
  row({ id: 202, name: "정10-5", team: "10조", teamOrder: 5 }),
  row({ id: 203, name: "한10-6", team: "10조", teamOrder: 6 }),
  row({ id: 301, name: "휴직자", team: "7조", teamOrder: 8, employmentStatus: "LEAVE" }),
  row({ id: 401, name: "삭제됨", team: "7조", teamOrder: 9, employmentStatus: "RETIRED" }),
  row({
    id: 501,
    name: "드라이브",
    team: "드라이빙",
    teamOrder: 0,
    caddyType: "DRIVING",
  }),
  row({ id: 601, name: "미지정", team: "2조", teamOrder: 0 }),
  row({
    id: 701,
    name: "주중3부",
    team: "9조",
    teamOrder: 1,
    caddyType: "THIRD",
    thirdBandSubgroup: "WEEKDAY",
  }),
];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createMemoryReassignFetch(
  initial: ReassignCaddyRow[],
  options?: { staleOnApply?: boolean; mutateBeforeApply?: boolean }
): CaddyReassignFetch {
  let rows = initial.map((item) => ({ ...item }));
  return async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      placements: ReassignPlacement[];
      mode?: "explicit" | "insert";
      base?: ReassignBaseRow[];
    };
    if (String(url).includes("/preview")) {
      const plan = planCaddyReassign(rows, body.placements, { mode: body.mode });
      return jsonResponse(plan.ok ? 200 : 400, {
        ok: plan.ok,
        mode: plan.mode,
        requestedIds: plan.requestedIds,
        affectedIds: plan.affectedIds,
        affectedTeams: plan.affectedTeams,
        changes: plan.changes,
        issues: plan.issues,
        existingAnomalies: plan.existingAnomalies,
        base: plan.base,
      });
    }
    if (options?.mutateBeforeApply) {
      const victim = rows.find((item) => item.id === 101);
      if (victim) victim.teamOrder = 99;
    }
    if (options?.staleOnApply) {
      return jsonResponse(409, {
        error: "명단이 다른 관리자에 의해 변경되었습니다. 다시 불러온 뒤 저장하세요.",
        code: "stale_roster",
        issues: [
          {
            code: "stale_roster",
            message: "명단이 다른 관리자에 의해 변경되었습니다. 다시 불러온 뒤 저장하세요.",
          },
        ],
      });
    }
    const plan = planCaddyReassign(rows, body.placements, { mode: body.mode });
    if (!plan.ok) {
      return jsonResponse(400, {
        error: plan.issues[0]?.message ?? "apply failed",
        code: plan.issues[0]?.code,
        issues: plan.issues,
      });
    }
    const patchById = new Map(plan.patches.map((patch) => [patch.id, patch]));
    rows = rows.map((item) => {
      const patch = patchById.get(item.id);
      if (!patch) return item;
      return {
        ...item,
        team: patch.team,
        teamOrder: patch.teamOrder,
        caddyType: patch.caddyType,
        thirdBandSubgroup: patch.thirdBandSubgroup,
      };
    });
    return jsonResponse(200, {
      ok: true,
      updated: plan.patches.length,
      requestedIds: plan.requestedIds,
      affectedIds: plan.affectedIds,
      affectedTeams: plan.affectedTeams,
      changes: plan.changes,
      auditId: 77,
    });
  };
}

section("local insert matches server insert");
{
  const local = applyRosterInsertMove(fixture, {
    id: 101,
    team: "10조",
    teamOrder: 5,
  });
  const server = planCaddyReassign(
    fixture,
    [{ id: 101, team: "10조", teamOrder: 5 }],
    { mode: "insert" }
  );
  assert(local.ok && server.ok, "cross-team insert ok");
  const localKim = local.ok
    ? local.rows.find((item) => item.id === 101)
    : null;
  const park = local.ok ? local.rows.find((item) => item.id === 102) : null;
  const lee = local.ok ? local.rows.find((item) => item.id === 103) : null;
  const shifted = local.ok
    ? local.rows.find((item) => item.id === 202)
    : null;
  assert(localKim?.team === "10조" && localKim.teamOrder === 5, "김 → 10조 5");
  assert(park?.team === "7조" && park.teamOrder === 4, "출발 조 구멍을 메우지 않음");
  assert(lee?.team === "7조" && lee.teamOrder === 5, "7조 5 유지");
  assert(shifted?.teamOrder === 6, "도착 점유자 5→6");
  assert(
    local.ok &&
      local.changes.map((change) => change.id).sort().join(",") ===
        server.changes.map((change) => change.id).sort().join(","),
    "local insert change ids == server insert"
  );
}

section("same-team rotate / undo / cancel");
{
  const moved = applyRosterInsertMove(fixture, {
    id: 103,
    team: "7조",
    teamOrder: 3,
  });
  assert(moved.ok, "same-team insert ok");
  const byId = new Map(moved.ok ? moved.rows.map((item) => [item.id, item]) : []);
  assert(byId.get(103)?.teamOrder === 3, "이 → 3");
  assert(byId.get(101)?.teamOrder === 4, "김 3→4");
  assert(byId.get(102)?.teamOrder === 5, "박 4→5");
  assert(byId.get(301)?.teamOrder === 8, "휴직 8 유지");
  let stack: ReassignCaddyRow[][] = [];
  stack = pushRosterUndoSnapshot(stack, fixture);
  const undone = stack[stack.length - 1];
  assert(
    undone.find((item) => item.id === 103)?.teamOrder === 5,
    "되돌리기 restores last snapshot"
  );
  assert(
    changedRosterPlacementIds(fixture, fixture).length === 0,
    "cancel/reset has no dirty ids"
  );
}

section("explicit placements include shifted neighbors");
{
  const moved = applyRosterInsertMove(fixture, {
    id: 101,
    team: "10조",
    teamOrder: 5,
  });
  assert(moved.ok, "move ok");
  const placements = explicitPlacementsFromDraft(
    fixture,
    moved.ok ? moved.rows : []
  );
  assert(
    placements.some((item) => item.id === 101 && item.team === "10조" && item.teamOrder === 5),
    "requested mover included"
  );
  assert(
    placements.some((item) => item.id === 202 && item.teamOrder === 6),
    "shifted neighbor included"
  );
  assert(
    !placements.some((item) => item.id === 102 || item.id === 103),
    "unmoved 7조 neighbors not sent"
  );
  const explicit = planCaddyReassign(fixture, placements, {
    mode: ROSTER_REASSIGN_MODE,
  });
  const insert = planCaddyReassign(
    fixture,
    [{ id: 101, team: "10조", teamOrder: 5 }],
    { mode: "insert" }
  );
  const key = (change: ReassignChange) =>
    `${change.id}:${change.to.team}:${change.to.teamOrder}:${change.to.caddyType}`;
  assert(explicit.ok && insert.ok, "both modes ok");
  assert(
    explicit.changes.map(key).sort().join("|") ===
      insert.changes.map(key).sort().join("|"),
    "explicit final snapshot == insert result"
  );
}

section("guards");
{
  assert(!canRosterReassignCaddy(fixture.find((item) => item.id === 501)!), "DRIVING excluded");
  assert(!canRosterReassignCaddy(fixture.find((item) => item.id === 401)!), "RETIRED excluded");
  assert(canRosterReassignCaddy(fixture.find((item) => item.id === 301)!), "LEAVE can move");
  assert(canRosterReassignCaddy(fixture.find((item) => item.id === 601)!), "teamOrder=0 can be assigned");
  const retired = applyRosterInsertMove(fixture, {
    id: 401,
    team: "1조",
    teamOrder: 1,
  });
  const driving = applyRosterInsertMove(fixture, {
    id: 501,
    team: "1조",
    teamOrder: 1,
  });
  assert(!retired.ok && retired.issues[0]?.code === "retired_forbidden", "retired blocked");
  assert(!driving.ok && driving.issues[0]?.code === "driving_forbidden", "driving blocked");
  assert(isRosterSearchLocked("김"), "search locks moves");
  assert(!isRosterSearchLocked("  "), "blank search is unlocked");
  assert(
    ROSTER_REASSIGN_SEARCH_LOCK_MESSAGE.includes("검색"),
    "search lock copy mentions 검색"
  );
  const zeroAfter = applyRosterInsertMove(fixture, {
    id: 101,
    team: "10조",
    teamOrder: 5,
  });
  const zero = zeroAfter.ok
    ? zeroAfter.rows.find((item) => item.id === 601)
    : null;
  assert(zero?.team === "2조" && zero.teamOrder === 0, "teamOrder=0 not renumbered");
  const over = applyRosterInsertMove(fixture, {
    id: 101,
    team: "7조",
    teamOrder: 25,
  });
  assert(!over.ok && over.issues.some((issue) => issue.code === "capacity_exceeded"), "capacity 24");
}

section("edit slots / mobile targets / labels");
{
  const seven = fixture.filter((item) => item.team === "7조" && item.employmentStatus !== "RETIRED");
  const { slots, unset } = listRosterEditSlots(seven, "7조");
  assert(
    slots.some((slot) => slot.teamOrder === 3 && slot.caddy?.id === 101),
    "occupied 3 shown"
  );
  assert(
    slots.some((slot) => slot.teamOrder === 6 && slot.caddy == null),
    "trailing empty after max"
  );
  assert(
    slots.some((slot) => slot.teamOrder === 7 && slot.caddy == null),
    "empty gap before LEAVE slot 8 is visible"
  );
  assert(unset.length === 0, "no unset in 7조 fixture members passed");
  const { unset: unsetTwo } = listRosterEditSlots(
    fixture.filter((item) => item.team === "2조"),
    "2조"
  );
  assert(unsetTwo.some((item) => item.id === 601), "unset stays unset at bottom");
  const targets = listRosterMoveTargets(fixture, "10조", 101);
  assert(targets[4]?.label.includes("정10-5"), "mobile target shows occupant");
  assert(targets[0]?.label.includes("빈자리"), "empty target labeled");
  assert(formatRosterSlotLabel("7조", 3) === "7조 3번", "slot label");
  assert(formatRosterSlotLabel("7조", 0) === "7조 · 순번 없음", "unset label");
  const typeNote = formatReassignTypeNote({
    id: 701,
    name: "주중3부",
    from: {
      team: "9조",
      teamOrder: 1,
      caddyType: "THIRD",
      thirdBandSubgroup: "WEEKDAY",
    },
    to: {
      team: "1조",
      teamOrder: 2,
      caddyType: "HOUSE",
      thirdBandSubgroup: null,
    },
  });
  assert(
    typeNote != null && typeNote.includes("HOUSE") && typeNote.includes("일반"),
    "type/subgroup note"
  );
}

void (async () => {
section("mock preview / apply / stale");
  const fetchOk = createMemoryReassignFetch(fixture);
  const moved = applyRosterInsertMove(fixture, {
    id: 101,
    team: "10조",
    teamOrder: 5,
  });
  const placements = explicitPlacementsFromDraft(
    fixture,
    moved.ok ? moved.rows : []
  );
  const preview = await postCaddyReassignPreview(
    { placements, mode: ROSTER_REASSIGN_MODE },
    { fetch: fetchOk }
  );
  assert(preview.ok === true, "mock preview ok");
  if (preview.ok) {
    assert(preview.changes.some((change) => change.name === "김철수"), "preview lists 김철수");
    assert(
      preview.changes.some((change) => change.id === 202),
      "preview lists automatically shifted caddy"
    );
    const apply = await postCaddyReassignApply(
      { placements, mode: ROSTER_REASSIGN_MODE, base: preview.base },
      { fetch: fetchOk }
    );
    assert(apply.ok === true && apply.auditId === 77, "mock apply uses preview.base");
  }

  const fetchStale = createMemoryReassignFetch(fixture, { staleOnApply: true });
  const preview2 = await postCaddyReassignPreview(
    { placements, mode: ROSTER_REASSIGN_MODE },
    { fetch: fetchStale }
  );
  assert(preview2.ok === true, "stale fixture preview still ok");
  if (preview2.ok) {
    const apply2 = await postCaddyReassignApply(
      { placements, mode: ROSTER_REASSIGN_MODE, base: preview2.base },
      { fetch: fetchStale }
    );
    assert(apply2.ok === false && isStaleRosterError(apply2), "409 stale_roster, no auto retry");
  }

section("page wiring");
{
  const page = fs.readFileSync(
    path.resolve("src/app/manage/caddies/page.tsx"),
    "utf8"
  );
  const draftLib = fs.readFileSync(
    path.resolve("src/lib/caddyRosterReassignDraft.ts"),
    "utf8"
  );
  const client = fs.readFileSync(
    path.resolve("src/lib/caddyReassignClient.ts"),
    "utf8"
  );
  assert(/배치 편집/.test(page) && /data-placement-edit/.test(page), "edit mode toggle");
  assert(/onDragStart/.test(page) && /draggable=\{canDrag\}/.test(page), "PC drag only in edit");
  assert(/조·순번 이동/.test(page) && /이동 반영/.test(page), "mobile move sheet");
  assert(/변경사항 확인/.test(page) && /되돌리기/.test(page), "confirm + undo");
  assert(
    /postCaddyReassignPreview/.test(page) &&
      /postCaddyReassignApply/.test(page) &&
      /base: previewResult\.base/.test(page),
    "apply uses preview.base"
  );
  assert(
    /자동 재시도하지 않습니다/.test(page) && /명단 다시 불러오기/.test(page),
    "stale requires reload, no auto save"
  );
  assert(
    /placementEdit/.test(page) && /setMenuCaddyId\(c\.id\)/.test(page),
    "normal click menu remains outside edit"
  );
  assert(
    !/autoAssignEngine/.test(page) &&
      !/marshalRotationService/.test(page) &&
      !/marshalRosterService/.test(draftLib),
    "no engine imports"
  );
  assert(
    client.includes("/api/caddies/reassign/preview") &&
      client.includes("/api/caddies/reassign/apply"),
    "client hits existing APIs only"
  );
  assert(
    /mode: "insert"/.test(draftLib) && /explicitPlacementsFromDraft/.test(draftLib),
    "local insert then explicit save"
  );
  assert(
    !draftLib.includes("@prisma/client") &&
      !client.includes("@prisma/client") &&
      !/@prisma\/client/.test(page),
    "client roster edit path does not import Prisma"
  );
  const plan = fs.readFileSync(path.resolve("src/lib/caddyReassign.ts"), "utf8");
  const sql = fs.readFileSync(path.resolve("src/lib/caddyReassignSql.ts"), "utf8");
  assert(
    !plan.includes("@prisma/client") &&
      sql.includes("@prisma/client") &&
      sql.includes("buildCaddyReassignUpdateSql"),
    "Prisma SQL stays in server-only module"
  );
}

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
})();
