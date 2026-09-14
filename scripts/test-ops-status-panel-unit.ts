/**
 * 자동배치 우측 운영현황 패널 V2 (표시 전용, DB 없음)
 * 실행: npx tsx scripts/test-ops-status-panel-unit.ts
 */
import fs from "node:fs";
import path from "node:path";
import { buildUnavailablePanelGroups } from "../src/lib/assignmentBoardDirectEdit";
import { buildUnavailableBoardView } from "../src/lib/unavailablePanelView";
import {
  compactPeopleNames,
  filledDutySlots,
  filledMarshalSlots,
  opsSpecialDutyChips,
  opsSpecialSupportBlocks,
  opsStatusCountChips,
  toOpsSpecialDutyGroups,
} from "../src/lib/opsStatusPanelView";
import type { SpecialSupportRecord } from "../src/lib/dailySpecialSupport";

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

console.log("== ops status chips / compact names ==");
{
  const groups = buildUnavailablePanelGroups({
    excluded: [
      { id: 1, name: "손지연", team: "1조", excludedReasons: ["휴무"] },
      { id: 2, name: "최란희", team: "1조", excludedReasons: ["휴무"] },
      { id: 3, name: "유지효", team: "2조", excludedReasons: ["휴무"] },
      { id: 4, name: "김병가", team: "3조", excludedReasons: ["병가"] },
      { id: 5, name: "이결근", team: "4조", excludedReasons: ["결근"] },
      { id: 6, name: "박기타", team: "5조", excludedReasons: ["교육"] },
    ],
  });
  const view = buildUnavailableBoardView(groups);
  const chips = opsStatusCountChips(view, 3);
  assert(
    chips.map((c) => `${c.label}${c.count}`).join(",") === "휴무3,병가1,결근1,기타1",
    "요약 칩은 실제 건수만"
  );
  assert(
    compactPeopleNames(view.offTeams[0]?.people || []) === "손지연 · 최란희",
    "휴무 조별 compact · 목록"
  );
  const emptyChips = opsStatusCountChips(
    buildUnavailableBoardView(buildUnavailablePanelGroups({})),
    0
  );
  assert(emptyChips.length === 0, "0건 항목은 칩을 만들지 않음");
}

console.log("== duty/marshal empty slots ==");
{
  const view = buildUnavailableBoardView(buildUnavailablePanelGroups({}));
  const duty = filledDutySlots(view.dutySlots);
  const marshal = filledMarshalSlots(view.marshalSlots);
  assert(
    duty.map((s) => s.label).join(",") === "조출1,조출2,후출1,후출2",
    "당번 슬롯 라벨 고정"
  );
  assert(duty.every((s) => s.people.length === 0), "데이터 없으면 당번 슬롯 비움");
  assert(
    marshal.map((s) => s.label).join(",") === "조출1,조출2,후출1",
    "마샬은 기존 3슬롯만 (후출2 없음)"
  );
}

console.log("== special duty / support summaries ==");
{
  const chips = opsSpecialDutyChips(
    toOpsSpecialDutyGroups([
      {
        kind: "ONE_TWO",
        label: "1·2부",
        count: 2,
        items: [{ name: "임형구" }, { name: "구본의" }],
      },
      { kind: "FIFTY_FOUR", label: "54홀", count: 0, items: [] },
    ])
  );
  assert(chips.length === 5, "특수근무 UI 5종");
  assert(chips[0]?.label === "1막" && chips[0]?.count === 0, "없는 1막은 0");
  assert(
    chips.find((c) => c.kind === "ONE_TWO")?.names.join("·") === "임형구·구본의",
    "1·2부 이름 재사용"
  );
  const items: SpecialSupportRecord[] = [
    {
      date: "2099-01-01",
      caddyId: 11,
      name: "손지연",
      shift: "1부",
      kind: "SPECIAL_SUPPORT",
      workPattern: "SHIFT_1",
    },
    {
      date: "2099-01-01",
      caddyId: 12,
      name: "유지효",
      shift: "3부",
      kind: "OFF_SUPPORT",
      workPattern: "SHIFT_3",
    },
  ];
  const blocks = opsSpecialSupportBlocks(items);
  assert(blocks.length === 6, "지원근무 6 kind");
  assert(blocks.find((b) => b.kind === "CHAGEUN")?.count === 0, "찾근 0은 숫자만");
  const special = blocks.find((b) => b.kind === "SPECIAL_SUPPORT");
  const off = blocks.find((b) => b.kind === "OFF_SUPPORT");
  assert(special?.people[0]?.kindBadge === "특수", "특수 kind badge");
  assert(special?.people[0]?.patternBadge === "1부", "특수 workPattern badge");
  assert(off?.people[0]?.kindBadge === "휴무" && off?.people[0]?.patternBadge === "3부", "휴무지원 3부");
}

console.log("== source contracts: read-only, reuse existing loads ==");
{
  const panel = readSrc("src/app/manage/assignments/UnavailablePanel.tsx");
  const page = readSrc("src/app/manage/assignments/page.tsx");
  const dutyPanel = readSrc("src/app/manage/assignments/SpecialDutyPanel.tsx");
  const supportPanel = readSrc("src/app/manage/assignments/SpecialSupportPanel.tsx");
  assert(/data-ops-status-panel/.test(panel), "ops status panel marker");
  assert(/오늘 운영현황/.test(panel), "title");
  assert(/특수근무/.test(panel) && /지원근무/.test(panel), "special + support sections");
  assert(/당번/.test(panel) && /마샬/.test(panel) && /조장/.test(panel), "duty sections always");
  assert(!/fetch\(/.test(panel), "panel does not fetch");
  assert(!/method:\s*["']POST["']/.test(panel), "no POST");
  assert(!/method:\s*["']PUT["']/.test(panel), "no PUT");
  assert(!/method:\s*["']DELETE["']/.test(panel), "no DELETE");
  assert(!/prisma\./.test(panel), "no prisma in panel");
  assert(!/<iframe/.test(page), "does not embed dashboard");
  assert(/opsDuties:\s*opsDutyStored/.test(page), "duty from availability stored rows");
  assert(/onLoaded=\{onSpecialDutyLoaded\}/.test(page), "special duty callback reuse");
  assert(
    /onRecordsLoaded=\{onSpecialSupportRecordsLoaded\}/.test(page),
    "support records callback reuse"
  );
  assert(/onLoaded=\{onSpecialSupportLoaded\}/.test(page), "engine support queues still wired");
  assert(/toOpsSpecialDutyGroups/.test(dutyPanel), "special duty slim groups for panel");
  assert(/onRecordsLoadedRef/.test(supportPanel), "support items forwarded without extra GET");
  assert(/minmax\(320px, 360px\)/.test(page), "desktop width 320-360");
  assert(/is-ops-panel-collapsed/.test(page), "collapsed layout class");
  assert(/ops-unavail-collapse/.test(page), "desktop collapse css");
  assert(/data-ops-panel-open/.test(page), "chip hidden while desktop panel open");
  assert(/max-width: 1279px/.test(page), "mobile breakpoint kept");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
