/**
 * 운영현황 editor payload guard (#146B).
 * 실행: npm run test:ops-duty-editor-unit
 */
import fs from "node:fs";
import path from "path";
import {
  parseOpsDutyEditorSlots,
  type OpsDutyEditorSlot,
} from "../src/lib/opsDutyEditorView";

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

function validSlot(
  roleKey: OpsDutyEditorSlot["roleKey"],
  extra: Partial<OpsDutyEditorSlot> = {}
): OpsDutyEditorSlot {
  const section =
    roleKey.startsWith("당번") ? "당번" : roleKey.startsWith("마샬") ? "마샬" : "조장";
  const role =
    roleKey.includes("당번_조출")
      ? "DUTY_AM"
      : roleKey.includes("당번_후출")
        ? "DUTY_PM"
        : roleKey.includes("마샬_조출")
          ? "MARSHAL_AM"
          : roleKey.includes("마샬_후출")
            ? "MARSHAL_PM"
            : "LEADER";
  const label =
    roleKey === "조장_1"
      ? "조장"
      : roleKey.endsWith("_1")
        ? roleKey.includes("후출")
          ? "후출1"
          : "조출1"
        : roleKey.endsWith("_2")
          ? roleKey.includes("후출")
            ? "후출2"
            : "조출2"
          : "조장";
  return {
    roleKey,
    role,
    label,
    section,
    person: { caddyId: 1, name: "테스트", team: "1조" },
    overridden: false,
    overrideAction: null,
    ...extra,
  };
}

function validPayload(slots: unknown) {
  return { date: "2099-12-27", rows: [], slots };
}

const ALL_KEYS = [
  "당번_조출_1",
  "당번_조출_2",
  "당번_후출_1",
  "당번_후출_2",
  "마샬_조출_1",
  "마샬_조출_2",
  "마샬_후출_1",
  "조장_1",
] as const;

const validSlots = ALL_KEYS.map((key) => validSlot(key));

console.log("== payload guard ==");
assert(parseOpsDutyEditorSlots(validPayload(validSlots))?.length === 8, "정상 8 slots → editor");
assert(parseOpsDutyEditorSlots(undefined) == null, "payload undefined");
assert(parseOpsDutyEditorSlots(null) == null, "payload null");
assert(parseOpsDutyEditorSlots({}) == null, "empty object (slots undefined)");
assert(parseOpsDutyEditorSlots({ slots: undefined }) == null, "slots undefined");
assert(parseOpsDutyEditorSlots({ slots: null }) == null, "slots null");
assert(parseOpsDutyEditorSlots({ slots: {} }) == null, "slots {}");
assert(parseOpsDutyEditorSlots({ slots: [] }) == null, "slots []");
assert(parseOpsDutyEditorSlots({ slots: [null] }) == null, "slots [null]");
assert(parseOpsDutyEditorSlots({ rows: undefined }) == null, "rows undefined, slots missing");
assert(parseOpsDutyEditorSlots({ rows: null }) == null, "rows null, slots missing");
assert(parseOpsDutyEditorSlots({ slots: [validSlots[0]] }) == null, "malformed incomplete slots");
assert(
  parseOpsDutyEditorSlots({
    slots: validSlots.map((slot, i) => (i === 0 ? { ...slot, person: { name: "x" } } : slot)),
  }) == null,
  "malformed person"
);
assert(
  parseOpsDutyEditorSlots({
    slots: [
      ...validSlots,
      validSlot("당번_조출_1", { roleKey: "마샬_후출_2" as never }),
    ],
  }) == null,
  "마샬 후출2 거부"
);
assert(parseOpsDutyEditorSlots({ slots: "oops" }) == null, "slots string");

const cleared = parseOpsDutyEditorSlots(
  validPayload(
    validSlots.map((slot) =>
      slot.roleKey === "당번_조출_1"
        ? {
            ...slot,
            person: null,
            overridden: true,
            overrideAction: "CLEAR" as const,
          }
        : slot
    )
  )
);
assert(cleared?.[0]?.person == null && cleared?.[0]?.overridden === true, "CLEAR 슬롯 파싱");

const setSlot = parseOpsDutyEditorSlots(
  validPayload(
    validSlots.map((slot) =>
      slot.roleKey === "당번_조출_1"
        ? {
            ...slot,
            person: { caddyId: 9, name: "현장", team: "2조" },
            overridden: true,
            overrideAction: "SET" as const,
          }
        : slot
    )
  )
);
assert(setSlot?.[0]?.person?.name === "현장" && setSlot?.[0]?.overridden === true, "SET 슬롯 파싱");

console.log("== source contracts ==");
{
  const page = fs.readFileSync(path.resolve("src/app/manage/assignments/page.tsx"), "utf8");
  const panel = fs.readFileSync(
    path.resolve("src/app/manage/assignments/UnavailablePanel.tsx"),
    "utf8"
  );
  const view = fs.readFileSync(path.resolve("src/lib/opsDutyEditorView.ts"), "utf8");
  const getRoute = fs.readFileSync(path.resolve("src/app/api/daily-ops-duties/route.ts"), "utf8");
  const avail = fs.readFileSync(path.resolve("src/lib/availabilityService.ts"), "utf8");
  const dashboard = fs.readFileSync(path.resolve("src/lib/adminOpsDashboardSource.ts"), "utf8");
  const canonical = fs.readFileSync(path.resolve("src/lib/caddyPoolCanonicalService.ts"), "utf8");
  assert(!/from ["']xlsx["']/.test(view + panel), "editor view/panel에 xlsx 없음");
  assert(!/dutyMarshalLeaderParser/.test(view + panel + page), "parser value import 없음");
  assert(!/from ["']@\/lib\/opsDutyEffective/.test(page + panel + view), "client가 opsDutyEffective 없음");
  assert(!/\bBuffer\b/.test(view.replace(/\/\*[\s\S]*?\*\//g, "")), "editor view에 Buffer 없음");
  assert(/parseOpsDutyEditorSlots/.test(panel), "panel이 payload 재검증");
  assert(/Array\.isArray/.test(view), "Array.isArray 가드");
  assert(/resolveOpsDutyReadOnly/.test(getRoute), "GET 기존 read-only rows 유지");
  assert(!/resolveEffectiveOpsDuty/.test(getRoute), "GET rows를 effective로 교체하지 않음");
  assert(/buildOpsDutySlotStates/.test(getRoute), "GET slots extra field");
  assert(!/resolveEffectiveOpsDuty/.test(avail + dashboard + canonical), "자동배치/Dashboard overlay 미연결");
  assert(!/prisma\/schema/.test(page + panel + view), "schema 경로 미수정");
  assert(!/마샬_후출_2/.test(panel + view), "가짜 마샬 후출2 UI 없음");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
