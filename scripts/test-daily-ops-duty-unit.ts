/**
 * 당번·마샬·조장 일정 매칭/제외 단위 테스트 (DB 없음)
 * 실행: npx tsx scripts/test-daily-ops-duty-unit.ts
 */

import {
  countByOpsRole,
  dutyEntriesFromMatched,
  dutyEntriesFromStored,
  excludeCaddiesById,
  matchDutyEntriesToCaddies,
  opsDutyRoleFromKind,
  parseMatchedOpsDutyRows,
} from "../src/lib/dailyOpsDuty";
import { applyDailyExternalExclusions } from "../src/lib/dailyAvailabilityOverlay";
import { computeAvailability } from "../src/lib/availabilityEngine";
import { regularCaddyPoolFromAvailabilityRows } from "../src/lib/autoAssignEngine";

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

function section(title: string) {
  console.log("\n==", title, "==");
}

section("역할 매핑은 기존 parser kind를 재사용");
{
  assert(opsDutyRoleFromKind("duty_am") === "DUTY_AM", "조출당번");
  assert(opsDutyRoleFromKind("duty_pm") === "DUTY_PM", "후출당번");
  assert(opsDutyRoleFromKind("marshal_am") === "MARSHAL_AM", "조출마샬");
  assert(opsDutyRoleFromKind("marshal_pm") === "MARSHAL_PM", "후출마샬");
  assert(opsDutyRoleFromKind("leader") === "LEADER", "조장");
}

section("exact ACTIVE만 저장, RETIRED/LEAVE/미매칭은 확인 필요");
{
  const caddies = [
    { id: 109, name: "우지연", employmentStatus: "ACTIVE" },
    { id: 178, name: "이제이", employmentStatus: "ACTIVE" },
    { id: 4, name: "박서진2", employmentStatus: "ACTIVE" },
    { id: 233, name: "이홍택", employmentStatus: "ACTIVE" },
    { id: 98, name: "최정묵", employmentStatus: "ACTIVE" },
    { id: 46, name: "원진성", employmentStatus: "ACTIVE" },
    { id: 137, name: "박재영", employmentStatus: "ACTIVE" },
    { id: 18, name: "엄진순", employmentStatus: "ACTIVE" },
    { id: 900, name: "퇴사당번", employmentStatus: "RETIRED" },
    { id: 901, name: "휴직마샬", employmentStatus: "LEAVE" },
  ];
  const { matched, reviews } = matchDutyEntriesToCaddies(
    [
      { kind: "duty_am", roleKey: "당번_조출_1", rawName: "우지연" },
      { kind: "duty_am", roleKey: "당번_조출_2", rawName: "이제이" },
      { kind: "duty_pm", roleKey: "당번_후출_1", rawName: "박서진2" },
      { kind: "duty_pm", roleKey: "당번_후출_2", rawName: "이홍택" },
      { kind: "marshal_am", roleKey: "마샬_조출_1", rawName: "최정묵" },
      { kind: "marshal_am", roleKey: "마샬_조출_2", rawName: "원진성" },
      { kind: "marshal_pm", roleKey: "마샬_후출_1", rawName: "박재영" },
      { kind: "leader", roleKey: "조장_1", rawName: "엄진순" },
      { kind: "duty_am", roleKey: "당번_조출_3", rawName: "퇴사당번" },
      { kind: "marshal_am", roleKey: "마샬_조출_3", rawName: "휴직마샬" },
      { kind: "leader", roleKey: "조장_2", rawName: "없는사람" },
    ],
    caddies
  );
  assert(matched.length === 8, "8명 exact ACTIVE 매칭");
  assert(
    matched.map((m) => m.caddyId).sort((a, b) => a - b).join(",") ===
      "4,18,46,98,109,137,178,233",
    "8/22 원본 8명 id"
  );
  assert(
    reviews.some((r) => r.rawName === "퇴사당번" && r.reason.includes("퇴사")),
    "RETIRED는 확인 필요"
  );
  assert(
    reviews.some((r) => r.rawName === "휴직마샬" && r.reason.includes("휴직")),
    "LEAVE는 확인 필요"
  );
  assert(
    reviews.some((r) => r.rawName === "없는사람"),
    "미매칭은 확인 필요"
  );
  const byRole = countByOpsRole(matched);
  assert(byRole.DUTY_AM === 2, "조출당번 2");
  assert(byRole.DUTY_PM === 2, "후출당번 2");
  assert(byRole.MARSHAL_AM === 2, "조출마샬 2");
  assert(byRole.MARSHAL_PM === 1, "후출마샬 1");
  assert(byRole.LEADER === 1, "조장 1");
}

section("같은 날짜 교체는 슬롯 단위이며 matched JSON도 검증");
{
  const rows = parseMatchedOpsDutyRows([
    {
      role: "DUTY_PM",
      roleKey: "당번_후출_2",
      caddyId: 233,
      rawName: "이홍택",
      name: "이홍택",
    },
  ]);
  assert(rows.length === 1 && rows[0].caddyId === 233, "JSON matched 파싱");
  let threw = false;
  try {
    parseMatchedOpsDutyRows([
      { role: "DUTY_PM", roleKey: "당번_후출_2", caddyId: 233, rawName: "이홍택" },
      { role: "DUTY_PM", roleKey: "당번_후출_2", caddyId: 4, rawName: "박서진2" },
    ]);
  } catch {
    threw = true;
  }
  assert(threw, "같은 roleKey 중복은 거부");
  const stored = dutyEntriesFromStored([
    { role: "DUTY_PM", roleKey: "당번_후출_2", rawName: "이홍택" },
  ]);
  assert(stored[0]?.kind === "duty_pm" && stored[0].rawName === "이홍택", "저장 → overlay entry");
  const roundtrip = dutyEntriesFromMatched(rows);
  assert(roundtrip[0]?.roleKey === "당번_후출_2", "matched → entry");
}

section("excludeCaddiesById는 auto assignment / reflow 풀에서 제거");
{
  const pool = [
    { id: 1, name: "A" },
    { id: 233, name: "이홍택" },
    { id: 3, name: "C" },
  ];
  const filtered = excludeCaddiesById(pool, [233, 109]);
  assert(filtered.map((c) => c.id).join(",") === "1,3", "당번 id 제외");
  assert(excludeCaddiesById(pool, []).length === 3, "빈 제외는 원본 유지");
}

section("8/22 공식: 원본 역할 수 + 중복 1회만 차감");
{
  const caddies = [
    { id: 1, name: "기본1", team: "1조", teamOrder: 1, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
    { id: 109, name: "우지연", team: "8조", teamOrder: 1, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
    { id: 178, name: "이제이", team: "1조", teamOrder: 2, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
    { id: 4, name: "박서진2", team: "1조", teamOrder: 3, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
    { id: 233, name: "이홍택", team: "10조", teamOrder: 1, employmentStatus: "ACTIVE", caddyType: "THIRD" },
    { id: 98, name: "최정묵", team: "7조", teamOrder: 1, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
    { id: 46, name: "원진성", team: "2조", teamOrder: 1, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
    { id: 137, name: "박재영", team: "4조", teamOrder: 1, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
    { id: 18, name: "엄진순", team: "8조", teamOrder: 2, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
    { id: 20, name: "휴무만", team: "3조", teamOrder: 1, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
  ];
  const base = computeAvailability({ date: "2026-08-22", caddies });
  const over = applyDailyExternalExclusions({
    availability: base,
    caddies,
    offNames: ["이제이", "박재영", "휴무만"],
    dutyEntries: [
      { kind: "duty_am", roleKey: "당번_조출_1", rawName: "우지연" },
      { kind: "duty_am", roleKey: "당번_조출_2", rawName: "이제이" },
      { kind: "duty_pm", roleKey: "당번_후출_1", rawName: "박서진2" },
      { kind: "duty_pm", roleKey: "당번_후출_2", rawName: "이홍택" },
      { kind: "marshal_am", roleKey: "마샬_조출_1", rawName: "최정묵" },
      { kind: "marshal_am", roleKey: "마샬_조출_2", rawName: "원진성" },
      { kind: "marshal_pm", roleKey: "마샬_후출_1", rawName: "박재영" },
      { kind: "leader", roleKey: "조장_1", rawName: "엄진순" },
    ],
  });
  assert(over.dailySummary.baseAvailable === 10, "기본 가용 10");
  assert(over.dailySummary.off === 3, "휴무 3");
  assert(over.dailySummary.dutyAm === 2, "조출당번 원본 2");
  assert(over.dailySummary.dutyPm === 2, "후출당번 원본 2");
  assert(over.dailySummary.marshalAm === 2, "조출마샬 원본 2");
  assert(over.dailySummary.marshalPm === 1, "후출마샬 원본 1");
  assert(over.dailySummary.leader === 1, "조장 원본 1");
  assert(over.dailySummary.duplicateExcluded === 2, "휴무 중복 2 (이제이·박재영)");
  assert(over.dailySummary.dutyAdditionalExcluded === 6, "실제 추가 제외 6");
  assert(over.dailySummary.finalAvailable === 1, "최종 가용 1 (휴무만 제외 + 6명 당번)");
  assert(
    over.dailySummary.duplicates.map((d) => d.name).sort().join(",") ===
      "박재영,이제이",
    "중복 상세 이름"
  );
  const pool = regularCaddyPoolFromAvailabilityRows(over.available.all);
  const blocked = new Set(over.opsDutyCaddyIds);
  assert(
    [109, 178, 4, 233, 98, 46, 137, 18].every((id) => blocked.has(id)),
    "8명 모두 opsDutyCaddyIds"
  );
  assert(
    pool.every((c) => !blocked.has(c.id)),
    "auto assignment regular pool에 8명 없음"
  );
  assert(
    !over.available.all.some((r) => r.id === 233),
    "이홍택은 최종 가용에서 제외"
  );
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
