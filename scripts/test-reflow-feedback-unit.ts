/**
 * 배치 다시 맞추기 houseStart 복구 + silent return 회귀
 * 실행: npx tsx scripts/test-reflow-feedback-unit.ts
 */
import {
  resolveHouseStartCaddyIdForRecalc,
  RECALC_CONFIRM_MESSAGE,
  RECALC_RUNNING_LABEL,
  RECALC_SUCCESS_MESSAGE,
  type AssignmentDraft,
} from "../src/lib/assignmentDraft";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

function house(id: number, team = "1조"): AssignmentDraft["caddyPool"][number] {
  return {
    id,
    name: `C${id}`,
    team,
    teamOrder: 1,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  };
}

function row(
  id: number,
  kind: AssignmentDraft["assignments"][number]["kind"],
  shift: "1부" | "2부",
  teeTime: string,
  team = "1조"
): AssignmentDraft["assignments"][number] {
  const caddy = house(id, team);
  return {
    date: "2026-08-27",
    shift,
    sequenceIndex: 1,
    reason: kind,
    kind,
    reservation: {
      id: `${kind}-${id}`,
      date: "2026-08-27",
      course: "SKY",
      shift,
      teeTime,
      teamName: `t${id}`,
    },
    caddy,
  };
}

function draft(partial?: Partial<AssignmentDraft>): AssignmentDraft {
  return {
    date: "2026-08-27",
    status: "DRAFT",
    assignments: [
      row(10, "oneTwo", "1부", "07:00"),
      row(3, "regular", "1부", "07:08"),
      row(4, "regular", "2부", "13:00"),
    ],
    unassignedReservations: [],
    closedCourseReservations: [],
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    caddyPool: [house(1), house(3), house(4), house(10)],
    sparesByShift: [],
    confirmedAt: null,
    ...partial,
  };
}

console.log("== resolveHouseStartCaddyIdForRecalc ==");
{
  assert(
    resolveHouseStartCaddyIdForRecalc({ selectedId: 7, draft: draft() })?.caddyId ===
      7,
    "selected wins"
  );
  assert(
    resolveHouseStartCaddyIdForRecalc({
      selectedId: "",
      metaId: 9,
      draft: draft(),
    })?.caddyId === 9,
    "meta wins over draft"
  );
  const fromDraft = resolveHouseStartCaddyIdForRecalc({
    selectedId: "",
    draft: draft(),
  });
  assert(fromDraft?.caddyId === 3 && fromDraft.source === "draftRegular", "1부 첫 regular HOUSE");
  const poolOnly = resolveHouseStartCaddyIdForRecalc({
    selectedId: "",
    draft: draft({
      assignments: [row(10, "oneTwo", "1부", "07:00", "1조")],
      caddyPool: [house(21), house(22)],
    }),
  });
  assert(poolOnly?.caddyId === 21 && poolOnly.source === "pool", "regular 없으면 pool HOUSE");
  assert(
    resolveHouseStartCaddyIdForRecalc({ selectedId: "", draft: null }) === null,
    "draft 없으면 null"
  );
}

console.log("== UI wiring: no silent return ==");
{
  const page = readFileSync(join(process.cwd(), "src/app/manage/assignments/page.tsx"), "utf8");
  const panel = readFileSync(
    join(process.cwd(), "src/app/manage/assignments/LiveChangePanel.tsx"),
    "utf8"
  );
  const recalc = page.split("async function runRecalcDraft()")[1]?.split("function onReplace")[0] || "";
  assert(/window.confirm\(RECALC_CONFIRM_MESSAGE\)/.test(recalc), "confirm 호출");
  assert(
    recalc.trim().startsWith("{") &&
      recalc.includes("window.confirm") &&
      recalc.indexOf("window.confirm") < recalc.indexOf("if (!date)"),
    "confirm이 early return보다 앞"
  );
  assert(!/onClick=\{\(\) => void runAutoAssign\(\)\}/.test(page.split("ops-special-stale")[1] || ""), "배너가 runAutoAssign을 쓰지 않음");
  assert(/runRecalcDraft\(\)/.test(page), "runRecalcDraft 연결");
  assert(/RECALC_RUNNING_LABEL/.test(page) && /disabled=\{loadingRun\}/.test(page.split("ops-special-stale")[1] || ""), "배너 disabled+실행중");
  assert(/RECALC_SUCCESS_MESSAGE/.test(recalc), "성공 카피");
  assert(/failRecalc\(/.test(recalc), "실패 경로가 failRecalc");
  assert(/putAssignmentDraft\(/.test(recalc), "Draft PUT");
  assert(RECALC_CONFIRM_MESSAGE.includes("다시 만들까요"), "confirm copy");
  assert(RECALC_RUNNING_LABEL === "배치 맞추는 중...", "running copy");
  assert(RECALC_SUCCESS_MESSAGE === "배치를 다시 맞췄습니다.", "success copy");
  assert(/disabled=\{recalcBusy\}/.test(panel), "관리 도구 버튼 disabled");
  const autoAssign = page.split("async function runAutoAssign()")[1]?.split("async function runRecalcDraft()")[0] || "";
  assert(/window.confirm\(/.test(autoAssign), "자동배치 실행 confirm 유지");
}

console.log(`\nOK ${passed}/${passed + failed}`);
if (failed > 0) process.exit(1);
