/**
 * 현장 휴무 overlay + 병가/결근 운영현황 연결 (unit, DB write 없음)
 * 실행: npm run test:off-override-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  applyDailyExternalExclusions,
  applyDailyUnavailableExclusions,
} from "../src/lib/dailyAvailabilityOverlay";
import {
  resolveEffectiveOff,
  effectiveOffNamesFromBase,
} from "../src/lib/offEffective";
import { buildUnavailableBoardView } from "../src/lib/unavailablePanelView";
import { buildUnavailablePanelGroups } from "../src/lib/assignmentBoardDirectEdit";
import type { AvailabilityResult, AvailabilityRow } from "../src/lib/availabilityEngine";

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

function row(
  id: number,
  name: string,
  bucket: AvailabilityRow["bucket"] = "available"
): AvailabilityRow {
  return {
    id,
    name,
    team: "1조",
    teamOrder: id,
    employmentStatus: "ACTIVE",
    caddyType: "HOUSE",
    extraFlags: [],
    thirdBandSubgroup: null,
    bucket,
    assignmentLabels: [],
    specialTags: [],
    excludedReasons: bucket === "excluded" ? ["기타"] : [],
  };
}

function availabilityOf(rows: AvailabilityRow[]): AvailabilityResult {
  const available = rows.filter((r) => r.bucket === "available");
  const excluded = rows.filter((r) => r.bucket === "excluded");
  const special = rows.filter((r) => r.bucket === "special");
  return {
    date: "2099-12-27",
    available: {
      all: available,
      byType: { HOUSE: available, THIRD: [], DRIVING: [] },
      byTeam: [{ team: "1조", rows: available }],
    },
    special,
    excluded,
    counts: {
      available: available.length,
      special: special.length,
      excluded: excluded.length,
      byType: { HOUSE: available.length, THIRD: 0, DRIVING: 0 },
    },
  };
}

const caddies = [
  { id: 1, name: "출근A", employmentStatus: "ACTIVE" as const },
  { id: 2, name: "시트휴무B", employmentStatus: "ACTIVE" as const },
  { id: 3, name: "당번C", employmentStatus: "ACTIVE" as const },
  { id: 4, name: "시트병가D", employmentStatus: "ACTIVE" as const },
];

console.log("== resolveEffectiveOff priority ==");
{
  const base = [2, 4, 10];
  const none = resolveEffectiveOff({ baseOffCaddyIds: base, overrides: [] });
  assert(none.offCaddyIds.join(",") === "2,4,10", "override 0이면 원본 그대로");
  const forceOff = resolveEffectiveOff({
    baseOffCaddyIds: base,
    overrides: [{ caddyId: 1, action: "FORCE_OFF" }],
  });
  assert(forceOff.offCaddyIds.includes(1), "FORCE_OFF 추가");
  assert(forceOff.forceOffIds.join(",") === "1", "forceOff ids");
  const forceAvail = resolveEffectiveOff({
    baseOffCaddyIds: base,
    overrides: [{ caddyId: 2, action: "FORCE_AVAILABLE" }],
  });
  assert(!forceAvail.offCaddyIds.includes(2), "FORCE_AVAILABLE 은 휴무 집합에서 제거");
  assert(forceAvail.offCaddyIds.includes(4), "다른 원본 휴무 유지");
  const both = resolveEffectiveOff({
    baseOffCaddyIds: [2],
    overrides: [
      { caddyId: 2, action: "FORCE_AVAILABLE" },
      { caddyId: 2, action: "FORCE_OFF" },
    ],
  });
  assert(both.offCaddyIds.includes(2), "같은 캐디 last-write FORCE_OFF 우선");
}

console.log("== overlay names + duty exclusion stays ==");
{
  const baseAvail = availabilityOf([
    row(1, "출근A"),
    row(2, "시트휴무B"),
    row(3, "당번C"),
    row(4, "시트병가D"),
  ]);
  const names = effectiveOffNamesFromBase({
    caddies,
    offNames: ["시트휴무B", "시트병가D"],
    overrides: [
      { caddyId: 1, action: "FORCE_OFF" },
      { caddyId: 2, action: "FORCE_AVAILABLE" },
    ],
  });
  assert(
    names.names.includes("출근A") &&
      names.names.includes("시트병가D") &&
      !names.names.includes("시트휴무B") &&
      names.names.length === 2,
    "effective off names"
  );
  const overlaid = applyDailyExternalExclusions({
    availability: baseAvail,
    caddies,
    offNames: names.names,
    dutyEntries: [{ kind: "duty_am", roleKey: "당번_조출_1", rawName: "당번C" }],
  });
  const reasons = Object.fromEntries(
    [...overlaid.available.all, ...overlaid.excluded].map((r) => [
      r.id,
      r.excludedReasons.join("|") + ":" + r.bucket,
    ])
  );
  assert(String(reasons[1]).includes("휴무"), "FORCE_OFF → 휴무 제외");
  assert(overlaid.available.all.some((r) => r.id === 2), "FORCE_AVAILABLE → 가용 복귀");
  assert(String(reasons[3]).includes("조출당번") || String(reasons[3]).includes("당번"), "당번 exclusion 유지");
  const withSick = applyDailyUnavailableExclusions({
    availability: overlaid,
    unavailables: [{ caddyId: 2, reason: "SICK" }, { caddyId: 4, reason: "SICK" }],
  });
  assert(
    !withSick.available.all.some((r) => r.id === 2),
    "FORCE_AVAILABLE + 병가면 가용 후보 아님"
  );
  assert(!withSick.available.all.some((r) => r.id === 4), "시트휴무+병가 가용 아님");
  assert(!withSick.available.all.some((r) => r.id === 3), "당번은 휴무 overlay와 무관하게 제외");
}

console.log("== panel badges ==");
{
  const groups = buildUnavailablePanelGroups({
    offCaddies: [
      { id: 1, name: "수동휴무A", team: "1조" },
      { id: 2, name: "원본휴무B", team: "1조" },
    ],
    dailyUnavailables: [{ caddyId: 5, name: "병가E", team: "2조", reason: "SICK" }],
  });
  const view = buildUnavailableBoardView(groups, {
    offOverrides: [
      { caddyId: 1, action: "FORCE_OFF", name: "수동휴무A" },
      { caddyId: 8, action: "FORCE_AVAILABLE", name: "수동출근H" },
    ],
    dailyUnavailables: [{ caddyId: 5, reason: "SICK" }],
  });
  const names = view.offTeams.flatMap((b) => b.people);
  const a = names.find((p) => p.caddyId === 1);
  const b = names.find((p) => p.caddyId === 2);
  assert(a?.statusBadges?.includes("수동휴무"), "수동휴무 badge");
  assert(b?.statusBadges?.includes("시트"), "시트 badge");
  assert(
    view.forceAvailable.some((p) => p.caddyId === 8 && p.statusBadges?.includes("수동출근")),
    "수동출근 목록"
  );
  assert(view.sick.some((p) => p.caddyId === 5 && p.statusBadges?.includes("병가")), "병가 badge");
}

console.log("== source contracts ==");
{
  const avail = readSrc("src/lib/availabilityService.ts");
  const canonical = readSrc("src/lib/caddyPoolCanonicalService.ts");
  const overlay = readSrc("src/lib/dailyAvailabilityOverlay.ts");
  const service = readSrc("src/lib/offEffectiveService.ts");
  const page = readSrc("src/app/manage/assignments/page.tsx");
  const panel = readSrc("src/app/manage/assignments/UnavailablePanel.tsx");
  const schema = readSrc("prisma/schema.prisma");
  const migration = readSrc(
    "prisma/migrations/20260915120000_daily_off_override/migration.sql"
  );
  assert(/effectiveOffNamesFromBase/.test(avail), "availability는 effective off names");
  assert(/listDailyOffOverrides/.test(avail), "availability는 DailyOffOverride 조회");
  assert(/applyDailyUnavailableExclusions/.test(avail), "availability는 병가/결근 별도 적용");
  assert(/effectiveOffNamesFromBase/.test(canonical), "canonical도 같은 resolver");
  assert(/offSnapshot\.caddyIds/.test(canonical), "snapshot id를 base로 사용");
  assert(/offNames: offResolved\.names/.test(canonical), "snapshot 원본 배열을 덮어쓰지 않음");
  assert(/DailyCaddyUnavailable/.test(overlay) && /섞지 않는다/.test(overlay), "unavailable overlay 분리");
  assert(/DAILY_OFF_OVERRIDE_\$\{input\.action\}/.test(service), "audit overlay action prefix");
  assert(/FORCE_OFF/.test(service) && /FORCE_AVAILABLE/.test(service) && /RESTORE/.test(service), "write actions");
  assert(/snapshotCaddyIdsFromAvailability/.test(page), "snapshot은 base off ids");
  assert(/\/api\/daily-off-overrides/.test(page), "page POST overlay");
  assert(/\/api\/daily-unavailables/.test(page), "page 병가/결근 재사용 경로");
  assert(!/fetch\(/.test(panel), "panel does not fetch");
  assert(!/method:\s*["']POST["']/.test(panel), "panel no POST");
  assert(/\+ 휴무 추가/.test(panel) && /출근 처리/.test(panel) && /원본 복원/.test(panel), "휴무 UI");
  assert(/\+ 병가 추가/.test(panel) && /\+ 결근 추가/.test(panel), "병가/결근 UI");
  assert(/onOpsDutySet/.test(panel) && /SlotEditor/.test(panel), "당번/마샬/조장 편집 유지");
  assert(/enum DailyOffOverrideAction/.test(schema), "새 overlay enum");
  assert(/FORCE_OFF/.test(schema) && /FORCE_AVAILABLE/.test(schema), "schema actions");
  assert(/CREATE TABLE "DailyOffOverride"/.test(migration), "additive migration");
  assert(!/DROP TABLE "DailyOpsDuty"/.test(migration), "DailyOpsDuty 미변경");
  assert(!/ALTER TABLE "DailyCaddyUnavailable"/.test(migration), "unavailable 테이블 미변경");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
