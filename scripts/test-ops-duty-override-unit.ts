/**
 * 당번·마샬·조장 override BACKEND (#146A). UI 없음.
 * 실행: npm run test:ops-duty-override-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  applyOpsDutyOverrides,
  buildOpsDutySlotStates,
  effectiveOpsDutyCaddyIds,
  publicOpsDutyRows,
  sameRoleCaddyConflict,
  type OpsDutyOverrideInput,
} from "../src/lib/opsDutyEffective";
import { isOpsDutyRoleKey } from "../src/lib/opsDutyRoleKeys";
import type { OpsDutyPanelRow } from "../src/lib/opsDutyReadOnlySource";

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

function readSrc(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function storedRow(
  roleKey: string,
  role: OpsDutyPanelRow["role"],
  caddyId: number,
  name: string
): OpsDutyPanelRow {
  return {
    caddyId,
    name,
    team: "1조",
    role,
    roleKey,
    rawName: name,
  };
}

const storedBase: OpsDutyPanelRow[] = [
  storedRow("당번_조출_1", "DUTY_AM", 11, "지선영"),
  storedRow("당번_조출_2", "DUTY_AM", 12, "하연화"),
  storedRow("당번_후출_1", "DUTY_PM", 13, "이인아"),
  storedRow("당번_후출_2", "DUTY_PM", 14, "서승희"),
  storedRow("마샬_조출_1", "MARSHAL_AM", 21, "이용근"),
  storedRow("마샬_조출_2", "MARSHAL_AM", 22, "마샬2"),
  storedRow("마샬_후출_1", "MARSHAL_PM", 23, "마샬후"),
  storedRow("조장_1", "LEADER", 31, "엄진순"),
];

const sheetBase: OpsDutyPanelRow[] = [
  storedRow("당번_조출_1", "DUTY_AM", 11, "시트당번"),
  storedRow("마샬_조출_1", "MARSHAL_AM", 21, "시트마샬"),
  storedRow("조장_1", "LEADER", 31, "시트조장"),
];

console.log("== stored + SET / CLEAR / RESTORE ==");
{
  const set: OpsDutyOverrideInput[] = [
    {
      roleKey: "당번_조출_1",
      role: "DUTY_AM",
      action: "SET",
      caddyId: 99,
      name: "현장당번",
      rawName: "현장당번",
      team: "2조",
    },
  ];
  const afterSet = applyOpsDutyOverrides(storedBase, set);
  assert(
    afterSet.find((row) => row.roleKey === "당번_조출_1")?.name === "현장당번",
    "1. stored + SET 교체"
  );
  assert(
    afterSet.find((row) => row.roleKey === "당번_조출_1")?.overridden === true,
    "SET 슬롯은 overridden"
  );
  assert(
    afterSet.find((row) => row.roleKey === "당번_조출_2")?.name === "하연화",
    "다른 슬롯은 stored 유지"
  );

  const clear: OpsDutyOverrideInput[] = [
    {
      roleKey: "당번_조출_1",
      role: "DUTY_AM",
      action: "CLEAR",
      caddyId: null,
    },
  ];
  const afterClear = applyOpsDutyOverrides(storedBase, clear);
  assert(
    !afterClear.some((row) => row.roleKey === "당번_조출_1"),
    "2. stored + CLEAR 는 슬롯 없음"
  );
  const clearSlots = buildOpsDutySlotStates(storedBase, clear);
  const cleared = clearSlots.find((slot) => slot.roleKey === "당번_조출_1");
  assert(cleared?.person == null && cleared?.overridden === true, "CLEAR는 빈 슬롯 + 수동");
  assert(
    clearSlots.find((slot) => slot.roleKey === "당번_조출_2")?.person?.name === "하연화",
    "CLEAR는 해당 roleKey만"
  );

  const restored = applyOpsDutyOverrides(storedBase, []);
  assert(
    restored.find((row) => row.roleKey === "당번_조출_1")?.name === "지선영",
    "3. override 삭제 → stored 원본 복원"
  );
  assert(
    restored.every((row) => row.overridden === false),
    "RESTORE 후 overridden 없음"
  );
  const publicZero = publicOpsDutyRows(applyOpsDutyOverrides(storedBase, []));
  assert(
    JSON.stringify(publicZero) === JSON.stringify(storedBase),
    "3b. override 0이면 public GET row 형태 = base"
  );
}

console.log("== stored 0 + sheet fallback + SET / CLEAR / RESTORE ==");
{
  const set: OpsDutyOverrideInput[] = [
    {
      roleKey: "당번_조출_1",
      role: "DUTY_AM",
      action: "SET",
      caddyId: 77,
      name: "현장시트당번",
      rawName: "현장시트당번",
    },
  ];
  const afterSet = applyOpsDutyOverrides(sheetBase, set);
  assert(
    afterSet.find((row) => row.roleKey === "당번_조출_1")?.name === "현장시트당번",
    "4. sheet fallback + SET"
  );
  const clear: OpsDutyOverrideInput[] = [
    {
      roleKey: "마샬_조출_1",
      role: "MARSHAL_AM",
      action: "CLEAR",
      caddyId: null,
    },
  ];
  const afterClear = applyOpsDutyOverrides(sheetBase, clear);
  assert(
    !afterClear.some((row) => row.roleKey === "마샬_조출_1"),
    "5. sheet fallback + CLEAR"
  );
  const restored = applyOpsDutyOverrides(sheetBase, []);
  assert(
    restored.find((row) => row.roleKey === "마샬_조출_1")?.name === "시트마샬",
    "6. restore → Spreadsheet 매칭값 복원"
  );
}

console.log("== 같은 roleKey 1명 / 같은 role 중복 금지 ==");
{
  assert(isOpsDutyRoleKey("당번_후출_2"), "당번 후출2 존재");
  assert(!isOpsDutyRoleKey("마샬_후출_2"), "마샬 후출2 없음");
  const rows = applyOpsDutyOverrides(storedBase, [
    {
      roleKey: "당번_조출_1",
      role: "DUTY_AM",
      action: "SET",
      caddyId: 12,
      name: "하연화",
      rawName: "하연화",
    },
  ]);
  const conflict = sameRoleCaddyConflict(rows, "DUTY_AM", "당번_조출_1", 12);
  assert(conflict?.roleKey === "당번_조출_2", "8. 같은 조출당번 슬롯에 동일 캐디 중복");
  assert(
    sameRoleCaddyConflict(applyOpsDutyOverrides(storedBase, []), "DUTY_AM", "당번_조출_1", 21) ==
      null,
    "당번과 마샬 동시 지정은 기존처럼 허용"
  );
}

console.log("== #146A source contracts ==");
{
  const service = readSrc("src/lib/opsDutyEffectiveService.ts");
  const merge = readSrc("src/lib/opsDutyEffective.ts");
  const keys = readSrc("src/lib/opsDutyRoleKeys.ts");
  const route = readSrc("src/app/api/daily-ops-duties/override/route.ts");
  const getRoute = readSrc("src/app/api/daily-ops-duties/route.ts");
  const avail = readSrc("src/lib/availabilityService.ts");
  const canonical = readSrc("src/lib/caddyPoolCanonicalService.ts");
  const live = readSrc("src/lib/opsDutyLivePool.ts");
  const dashboard = readSrc("src/lib/adminOpsDashboardSource.ts");
  const panel = readSrc("src/app/manage/assignments/UnavailablePanel.tsx");
  const page = readSrc("src/app/manage/assignments/page.tsx");
  const migration = readSrc(
    "prisma/migrations/20260914120000_daily_ops_duty_override/migration.sql"
  );
  const schema = readSrc("prisma/schema.prisma");
  const migrationDirs = fs
    .readdirSync(path.resolve("prisma/migrations"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  assert(!/replaceDailyOpsDuties/.test(service), "override service는 DailyOpsDuty replace 없음");
  assert(
    !/dailyOpsDuty\.(create|update|delete|createMany|updateMany|deleteMany)/.test(service),
    "10. DailyOpsDuty row 변경 없음"
  );
  assert(
    !/spreadsheets\.values\.(update|append|batchUpdate)/.test(service + route),
    "9. Google Spreadsheet write 없음"
  );
  assert(/resolveOpsDutyReadOnly/.test(service), "기존 sheet fallback 재사용");
  assert(/resolveOpsDutyReadOnly/.test(getRoute), "GET은 기존 read-only resolver 유지");
  assert(!/resolveEffectiveOpsDuty/.test(getRoute), "GET rows를 effective resolver로 교체하지 않음");
  assert(/buildOpsDutySlotStates/.test(getRoute), "GET slots는 overlay extra field");
  assert(
    /loadEffectiveOpsDutyEntries/.test(avail),
    "availability exclusion은 effective entries"
  );
  assert(!/loadStoredDutyEntries/.test(avail), "availability는 stored-only loader를 쓰지 않음");
  assert(
    /resolveEffectiveOpsDuty/.test(canonical),
    "canonical exclusion은 effective resolver"
  );
  assert(!/listDailyOpsDutyCaddyIds/.test(canonical), "canonical은 stored-only ids를 쓰지 않음");
  assert(
    /listEffectiveOpsDutyCaddyIds/.test(live),
    "reflow fallback은 effective ids"
  );
  assert(!/listDailyOpsDutyCaddyIds/.test(live), "reflow fallback은 stored-only ids를 쓰지 않음");
  assert(/resolveOpsDutyReadOnly/.test(dashboard), "Dashboard는 기존 resolver");
  assert(!/resolveEffectiveOpsDuty/.test(dashboard), "Dashboard에 overlay 미연결");
  assert(/DailyOpsDutyOverrideAction/.test(schema) && /SET/.test(schema) && /CLEAR/.test(schema), "SET/CLEAR enum");
  assert(/CREATE TABLE "DailyOpsDutyOverride"/.test(migration), "기존 additive override table 복구");
  assert(!/ALTER TABLE "DailyOpsDuty"/.test(migration), "DailyOpsDuty column 변경 없음");
  assert(!/DROP /.test(migration) && !/RENAME /.test(migration), "destructive DDL 없음");
  assert(
    migrationDirs.filter((name) => name.includes("duty_override")).length === 1,
    "새 override migration 없음"
  );
  assert(/parseOpsDutyEditorSlots/.test(panel), "panel이 slots payload 재검증");
  assert(/\/api\/daily-ops-duties\/override/.test(page), "page가 override POST");
  assert(!/from ["']@\/lib\/opsDutyEffective/.test(page + panel), "client가 opsDutyEffective import 없음");
  assert(!/dutyMarshalLeaderParser/.test(merge + keys), "effective/type 파일은 xlsx parser 미import");
  assert(!/from ["']xlsx["']/.test(merge + keys + service), "effective/service에 xlsx 없음");
  assert(!/마샬_후출_2/.test(merge + service + panel), "가짜 마샬 후출2 없음");
  assert(/override_table_missing|P2021/.test(service), "migrate 전 읽기는 빈 override로 호환");
  assert(/DAILY_OPS_DUTY_OVERRIDE_/.test(service), "기존 Audit action payload");
  assert(/userId/.test(service) && /createdAt/.test(readSrc("prisma/schema.prisma")), "Audit userId + timestamp");
  assert(effectiveOpsDutyCaddyIds(applyOpsDutyOverrides(storedBase, [])).includes(11), "base caddyIds");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
