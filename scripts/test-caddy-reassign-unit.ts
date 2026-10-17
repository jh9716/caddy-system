/**
 * 캐디관리 V2 일괄 재배치 — DB 없는 단위 테스트
 * npx tsx scripts/test-caddy-reassign-unit.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  assertReassignBase,
  CaddyReassignError,
  planCaddyReassign,
  serializeReassignUpdatedAt,
  type ReassignCaddyRow,
} from "../src/lib/caddyReassign";

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
    caddyType: partial.team === "9조" || partial.team === "10조" || partial.team === "11조" || partial.team === "12조"
      ? "THIRD"
      : "HOUSE",
    thirdBandSubgroup: null,
    updatedAt: new Date("2026-10-17T00:00:00.000Z"),
    ...partial,
  };
}

const roster: ReassignCaddyRow[] = [
  row({ id: 1, name: "A", team: "1조", teamOrder: 1 }),
  row({ id: 2, name: "B", team: "1조", teamOrder: 2 }),
  row({ id: 3, name: "C", team: "1조", teamOrder: 3 }),
  row({ id: 4, name: "D", team: "1조", teamOrder: 4 }),
  row({ id: 5, name: "E", team: "1조", teamOrder: 5 }),
  row({
    id: 9,
    name: "T1",
    team: "9조",
    teamOrder: 1,
    caddyType: "THIRD",
    thirdBandSubgroup: "WEEKDAY",
  }),
  row({
    id: 10,
    name: "T2",
    team: "9조",
    teamOrder: 2,
    caddyType: "THIRD",
    thirdBandSubgroup: "WEEKEND",
  }),
  row({
    id: 11,
    name: "Leave",
    team: "1조",
    teamOrder: 8,
    employmentStatus: "LEAVE",
  }),
  row({
    id: 12,
    name: "Retired",
    team: "1조",
    teamOrder: 9,
    employmentStatus: "RETIRED",
  }),
  row({
    id: 13,
    name: "Zero",
    team: "2조",
    teamOrder: 0,
  }),
  row({
    id: 14,
    name: "Drive",
    team: "드라이빙",
    teamOrder: 0,
    caddyType: "DRIVING",
  }),
  row({ id: 21, name: "H3", team: "3조", teamOrder: 1 }),
  row({ id: 22, name: "H3b", team: "3조", teamOrder: 2 }),
];

section("같은 조 순번 맞교환 (explicit)");
{
  const plan = planCaddyReassign(roster, [
    { id: 1, team: "1조", teamOrder: 3 },
    { id: 3, team: "1조", teamOrder: 1 },
  ]);
  assert(plan.ok, "swap in same team ok");
  const a = plan.changes.find((c) => c.id === 1);
  const c = plan.changes.find((c) => c.id === 3);
  assert(a?.to.teamOrder === 3 && c?.to.teamOrder === 1, "A↔C orders");
  assert(plan.affectedIds.sort().join(",") === "1,3", "only swapped ids affected");
  assert(!plan.changes.some((ch) => ch.id === 2), "middle slot not compacted");
}

section("같은 조 insert 회전 — 전체를 1번부터 재번호하지 않음");
{
  const plan = planCaddyReassign(
    roster,
    [{ id: 5, team: "1조", teamOrder: 2 }],
    { mode: "insert" }
  );
  assert(plan.ok, "insert reorder ok");
  const byId = new Map(plan.changes.map((c) => [c.id, c]));
  assert(byId.get(5)?.to.teamOrder === 2, "E → 2");
  assert(byId.get(2)?.to.teamOrder === 3, "B 2→3");
  assert(byId.get(3)?.to.teamOrder === 4, "C 3→4");
  assert(byId.get(4)?.to.teamOrder === 5, "D 4→5");
  assert(!byId.has(1), "slot 1 untouched");
  assert(!byId.has(11), "LEAVE slot 8 untouched");
}

section("3부반 → 하우스 이동");
{
  const plan = planCaddyReassign(roster, [
    { id: 9, team: "1조", teamOrder: 6 },
  ]);
  assert(plan.ok, "third to house empty slot ok");
  const t = plan.changes.find((c) => c.id === 9);
  assert(t?.from.team === "9조" && t?.to.team === "1조", "team 9→1");
  assert(t?.to.caddyType === "HOUSE", "caddyType HOUSE");
  assert(t?.to.thirdBandSubgroup == null, "thirdBandSubgroup cleared");
  assert(t?.to.teamOrder === 6, "placed at 6");
  assert(!plan.changes.some((c) => c.id === 10), "other third not moved");
}

section("조 사이 캐디 맞교환");
{
  const plan = planCaddyReassign(roster, [
    { id: 1, team: "9조", teamOrder: 1 },
    { id: 9, team: "1조", teamOrder: 1 },
  ]);
  assert(plan.ok, "cross-team swap ok even though destinations occupied");
  const a = plan.changes.find((c) => c.id === 1);
  const t = plan.changes.find((c) => c.id === 9);
  assert(a?.to.team === "9조" && a?.to.teamOrder === 1, "A to 9조 1");
  assert(t?.to.team === "1조" && t?.to.teamOrder === 1, "T1 to 1조 1");
  assert(a?.to.caddyType === "THIRD" && t?.to.caddyType === "HOUSE", "types follow team");
}

section("여러 명 동시 이동");
{
  const plan = planCaddyReassign(roster, [
    { id: 1, team: "5조", teamOrder: 1 },
    { id: 2, team: "5조", teamOrder: 2 },
    { id: 9, team: "1조", teamOrder: 1 },
  ]);
  assert(plan.ok, "multi move ok");
  assert(plan.requestedIds.join(",") === "1,2,9", "requested ids reported");
  assert(
    plan.affectedTeams.includes("1조") &&
      plan.affectedTeams.includes("5조") &&
      plan.affectedTeams.includes("9조"),
    "affected teams"
  );
}

section("휴직자 슬롯 점유");
{
  const blocked = planCaddyReassign(roster, [
    { id: 1, team: "1조", teamOrder: 8 },
  ]);
  assert(!blocked.ok, "cannot land on LEAVE slot without moving LEAVE");
  assert(blocked.issues.some((i) => i.code === "slot_conflict"), "slot_conflict");

  const swapped = planCaddyReassign(roster, [
    { id: 1, team: "1조", teamOrder: 8 },
    { id: 11, team: "1조", teamOrder: 1 },
  ]);
  assert(swapped.ok, "explicit swap with LEAVE ok");

  const inserted = planCaddyReassign(
    roster,
    [{ id: 21, team: "1조", teamOrder: 8 }],
    { mode: "insert" }
  );
  assert(inserted.ok, "insert onto LEAVE shifts LEAVE");
  assert(
    inserted.changes.find((c) => c.id === 11)?.to.teamOrder === 9,
    "LEAVE 8→9"
  );
  assert(
    !inserted.changes.some((c) => c.id === 12),
    "RETIRED not shifted"
  );
}

section("RETIRED 재배치 금지 / 슬롯 비점유");
{
  const retired = planCaddyReassign(roster, [
    { id: 12, team: "1조", teamOrder: 6 },
  ]);
  assert(!retired.ok, "RETIRED cannot be placed");
  assert(retired.issues.some((i) => i.code === "retired_forbidden"), "retired_forbidden");

  const ontoRetiredNumber = planCaddyReassign(roster, [
    { id: 1, team: "1조", teamOrder: 9 },
  ]);
  assert(ontoRetiredNumber.ok, "RETIRED number is vacant for ACTIVE");
}

section("teamOrder=0 미지정은 임의 재번호하지 않고 보고");
{
  const leftover = planCaddyReassign(roster, [
    { id: 21, team: "2조", teamOrder: 3 },
  ]);
  assert(leftover.ok, "unmoved teamOrder=0 does not block other placements");
  assert(
    leftover.existingAnomalies.some((i) => i.code === "existing_unspecified_order"),
    "preview reports unspecified Zero"
  );
  assert(
    !leftover.changes.some((c) => c.id === 13),
    "Zero is not auto-numbered"
  );

  const fix = planCaddyReassign(roster, [
    { id: 13, team: "2조", teamOrder: 3 },
  ]);
  assert(fix.ok, "placing the unspecified caddy into a free slot is allowed");
  assert(fix.changes.find((c) => c.id === 13)?.to.teamOrder === 3, "Zero → 3");
}

section("기존 순번 중복은 수정하지 않고 보고");
{
  const dup = [
    ...roster,
    row({ id: 31, name: "DupA", team: "6조", teamOrder: 1 }),
    row({ id: 32, name: "DupB", team: "6조", teamOrder: 1 }),
    row({ id: 33, name: "DupC", team: "6조", teamOrder: 2 }),
  ];
  const plan = planCaddyReassign(dup, [
    { id: 33, team: "6조", teamOrder: 3 },
  ]);
  assert(!plan.ok, "existing duplicate blocks");
  assert(
    plan.issues.some((i) => i.code === "slot_conflict") &&
      plan.existingAnomalies.some((i) => i.code === "existing_slot_conflict"),
    "duplicate reported, not rewritten"
  );

  const resolve = planCaddyReassign(dup, [
    { id: 32, team: "6조", teamOrder: 4 },
  ]);
  assert(resolve.ok, "moving one duplicate occupant away resolves");
}

section("점유 슬롯 이동 — 최종만 유효하면 저장 가능");
{
  const blocked = planCaddyReassign(roster, [
    { id: 1, team: "1조", teamOrder: 2 },
  ]);
  assert(!blocked.ok && blocked.issues[0]?.code === "slot_conflict", "single landing on B fails");
  const ok = planCaddyReassign(roster, [
    { id: 1, team: "1조", teamOrder: 2 },
    { id: 2, team: "1조", teamOrder: 1 },
  ]);
  assert(ok.ok, "final swap occupancy valid");
}

section("정원 초과 / 드라이빙");
{
  const cap = planCaddyReassign(roster, [{ id: 1, team: "1조", teamOrder: 25 }]);
  assert(!cap.ok && cap.issues.some((i) => i.code === "capacity_exceeded"), "slot 25 blocked");

  const insertOverflow = planCaddyReassign(
    [
      row({
        id: 9,
        name: "T1",
        team: "9조",
        teamOrder: 1,
        caddyType: "THIRD",
      }),
      ...Array.from({ length: 24 }, (_, i) =>
        row({ id: 100 + i, name: `F${i + 1}`, team: "4조", teamOrder: i + 1 })
      ),
    ],
    [{ id: 9, team: "4조", teamOrder: 24 }],
    { mode: "insert" }
  );
  assert(
    !insertOverflow.ok && insertOverflow.issues.some((i) => i.code === "capacity_exceeded"),
    "insert that pushes 24→25 blocked"
  );

  const driving = planCaddyReassign(roster, [
    { id: 14, team: "1조", teamOrder: 6 },
  ]);
  assert(!driving.ok && driving.issues.some((i) => i.code === "driving_forbidden"), "driving forbidden");
}

section("다른 조 insert — 출발 구멍 유지, 도착만 조정");
{
  const plan = planCaddyReassign(
    roster,
    [{ id: 9, team: "1조", teamOrder: 2 }],
    { mode: "insert" }
  );
  assert(plan.ok, "cross-team insert ok");
  assert(plan.changes.find((c) => c.id === 9)?.to.teamOrder === 2, "T1 at 1조 2");
  assert(plan.changes.find((c) => c.id === 2)?.to.teamOrder === 3, "B shifted");
  assert(plan.changes.find((c) => c.id === 5)?.to.teamOrder === 6, "E shifted");
  assert(!plan.changes.some((c) => c.id === 10), "9조 remainder not compacted");
}

section("동시 수정 스냅샷 409");
{
  const plan = planCaddyReassign(roster, [
    { id: 1, team: "1조", teamOrder: 6 },
  ]);
  assert(plan.ok && plan.base.length > 0, "preview base present");
  try {
    assertReassignBase(
      roster.map((r) =>
        r.id === 1 ? { ...r, updatedAt: new Date("2026-10-17T01:00:00.000Z") } : r
      ),
      plan.base,
      plan.affectedTeams,
      plan.requestedIds
    );
    assert(false, "stale should throw");
  } catch (e) {
    assert(
      e instanceof CaddyReassignError && e.status === 409 && e.code === "stale_roster",
      "stale_roster 409"
    );
  }
  assertReassignBase(roster, plan.base, plan.affectedTeams, plan.requestedIds);
  assert(true, "matching base accepted");
  assert(
    serializeReassignUpdatedAt(new Date("2026-10-17T00:00:00.000Z")) ===
      "2026-10-17T00:00:00.000Z",
    "updatedAt iso"
  );
}

section("소스 가드 — 기존 엔진/연관 데이터 손대지 않음");
{
  const root = path.join(__dirname, "..");
  const reassign = fs.readFileSync(path.join(root, "src/lib/caddyReassign.ts"), "utf8");
  const apply = fs.readFileSync(path.join(root, "src/lib/caddyReassignApply.ts"), "utf8");
  const preview = fs.readFileSync(
    path.join(root, "src/app/api/caddies/reassign/preview/route.ts"),
    "utf8"
  );
  const applyRoute = fs.readFileSync(
    path.join(root, "src/app/api/caddies/reassign/apply/route.ts"),
    "utf8"
  );
  const patch = fs.readFileSync(path.join(root, "src/app/api/caddies/[id]/route.ts"), "utf8");
  const engine = fs.readFileSync(path.join(root, "src/lib/autoAssignEngine.ts"), "utf8");
  const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
  const all = reassign + apply + preview + applyRoute;
  assert(!all.includes("autoAssignEngine"), "reassign does not import auto-assign engine");
  assert(!all.includes("marshalRotationService"), "reassign does not import marshal engine");
  assert(!all.includes("marshalRosterService"), "reassign does not import marshal roster");
  assert(!all.includes("prisma.user") && !all.includes("user.update"), "does not write User");
  assert(!all.includes("prisma.cart") && !all.includes("cart.update"), "does not write Cart");
  assert(
    !all.includes("prisma.assignment") &&
      !all.includes("prisma.offRequest") &&
      !all.includes("prisma.schedule"),
    "does not write duty/off/schedule"
  );
  assert(!all.includes("caddy.delete"), "does not delete caddies");
  assert(patch.includes("swapWithId"), "existing PATCH swap remains");
  assert(engine.includes("if (a.teamOrder !== b.teamOrder)"), "auto-assign still reads teamOrder");
  assert(schema.includes("teamOrder         Int              @default(0)"), "no schema teamOrder change");
  assert(preview.includes("DB 쓰기 없음"), "preview is read-only");
  assert(applyRoute.includes("$transaction") || apply.includes("$transaction"), "apply uses transaction");
  assert(all.includes("FOR UPDATE"), "apply locks rows");
  assert(all.includes("REASSIGN_CADDY_SLOTS"), "audit action recorded");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
