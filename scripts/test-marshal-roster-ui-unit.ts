/**
 * 마샬 명단 UI/UX 계약 (production write 없음)
 * 실행: npm run test:marshal-roster-ui-unit
 */
import fs from "node:fs";
import path from "node:path";
import { employmentStatusLabel } from "../src/lib/caddyManage";
import { caddyTypeLabel, type MarshalRosterRow } from "../src/lib/marshalDomain";
import {
  MARSHAL_ROSTER_TABLE_COLUMNS,
  buildMarshalActivePatch,
  buildMarshalCreateBody,
  buildMarshalRotationPatch,
  filterMarshalPickerOptions,
  firstMarshalPickerMatch,
  formatMarshalCaddyOptionLabel,
  listMarshalAddableCaddies,
  marshalRosterSaveErrorMessage,
  matchesMarshalCaddyQuery,
  toMarshalRosterCardView,
  toMarshalRosterDenseView,
  visibleMarshalRoster,
  type MarshalPickerCaddy,
} from "../src/lib/marshalRosterUi";

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

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function row(
  partial: Partial<MarshalRosterRow> & {
    id: number;
    caddyId: number;
    name: string;
    team?: string;
    caddyType?: string;
    active?: boolean;
    rotationOrder?: number | null;
    employmentStatus?: string;
  }
): MarshalRosterRow {
  return {
    id: partial.id,
    caddyId: partial.caddyId,
    active: partial.active ?? true,
    startedOn: partial.startedOn ?? "2026-10-01",
    rotationOrder: partial.rotationOrder ?? null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    caddy: {
      id: partial.caddyId,
      name: partial.name,
      team: partial.team ?? "8조",
      teamOrder: 1,
      caddyType: partial.caddyType ?? "HOUSE",
      employmentStatus: partial.employmentStatus ?? "ACTIVE",
    },
  };
}

const yang: MarshalPickerCaddy = {
  id: 11,
  name: "양현철",
  team: "8조",
  teamOrder: 2,
  caddyType: "HOUSE",
};
const kwak: MarshalPickerCaddy = {
  id: 12,
  name: "곽승현",
  team: "10조",
  teamOrder: 1,
  caddyType: "THIRD",
};
const drive: MarshalPickerCaddy = {
  id: 13,
  name: "박드라이빙",
  team: "드라이빙",
  teamOrder: 0,
  caddyType: "DRIVING",
};
const addable = [yang, kwak, drive];

section("caddy picker search");
assert(
  formatMarshalCaddyOptionLabel(yang) === "8조 양현철 · 하우스",
  "옵션 라벨 하우스"
);
assert(
  formatMarshalCaddyOptionLabel(kwak) === "10조 곽승현 · 3부반",
  "옵션 라벨 3부반"
);
assert(matchesMarshalCaddyQuery(yang, "양현철"), "이름 검색");
assert(matchesMarshalCaddyQuery(yang, "8조"), "조 검색");
assert(matchesMarshalCaddyQuery(yang, "하우스"), "유형 검색");
assert(matchesMarshalCaddyQuery(yang, "8조 양현철"), "조+이름 검색");
assert(!matchesMarshalCaddyQuery(kwak, "양현철"), "다른 이름 제외");
assert(matchesMarshalCaddyQuery(kwak, "3부반"), "3부반 유형 검색");
{
  const nameHits = filterMarshalPickerOptions(addable, "양현철");
  assert(nameHits.length === 1 && nameHits[0].id === 11, "이름 필터 1건");
  const teamHits = filterMarshalPickerOptions(addable, "8조");
  assert(teamHits.length === 1 && teamHits[0].id === 11, "조 필터 1건");
  const typeHits = filterMarshalPickerOptions(addable, "하우스");
  assert(typeHits.length === 1 && typeHits[0].id === 11, "유형 필터 1건");
  const picked = firstMarshalPickerMatch(addable, "8조 양현철");
  assert(picked?.id === 11, "검색 결과 선택");
  assert(
    formatMarshalCaddyOptionLabel(picked!) === "8조 양현철 · 하우스",
    "선택 라벨"
  );
}
{
  const registered = listMarshalAddableCaddies(addable, [11]);
  assert(
    registered.every((caddy) => caddy.id !== 11),
    "등록된 캐디는 신규 목록에서 제외"
  );
  assert(registered.some((caddy) => caddy.id === 12), "미등록 캐디는 유지");
}
assert(
  filterMarshalPickerOptions(addable, "").length === addable.length,
  "빈 검색은 전체 노출"
);

section("create / patch payload");
{
  const body = buildMarshalCreateBody({ caddyId: "11", rotationOrder: "3" });
  assert(body.caddyId === 11, "create caddyId");
  assert(body.rotationOrder === 3, "create rotationOrder");
  assert(
    !Object.prototype.hasOwnProperty.call(body, "startedOn"),
    "create payload startedOn 없음"
  );
  const omitted = buildMarshalCreateBody({ caddyId: 11, rotationOrder: "" });
  assert(omitted.rotationOrder === undefined, "빈 순번은 omit");
  assert(
    JSON.stringify(buildMarshalActivePatch(false)) ===
      JSON.stringify({ active: false }),
    "비활성 patch"
  );
  assert(
    JSON.stringify(buildMarshalActivePatch(true)) ===
      JSON.stringify({ active: true }),
    "복구 patch"
  );
  assert(
    JSON.stringify(buildMarshalRotationPatch(4)) ===
      JSON.stringify({ rotationOrder: 4 }),
    "순번 patch"
  );
  assert(
    !("startedOn" in buildMarshalActivePatch(false)) &&
      !("startedOn" in buildMarshalRotationPatch(4)),
    "patch payload startedOn 없음"
  );
}

section("roster rendering contracts");
{
  const active = row({
    id: 1,
    caddyId: 11,
    name: "양현철",
    team: "8조",
    caddyType: "HOUSE",
    rotationOrder: 3,
    active: true,
  });
  const inactive = row({
    id: 2,
    caddyId: 12,
    name: "곽승현",
    team: "10조",
    caddyType: "THIRD",
    rotationOrder: 1,
    active: false,
  });
  const card = toMarshalRosterCardView(active);
  assert(card.name === "양현철", "card 이름");
  assert(card.summary === "순번 3 · 8조 · 하우스", "card 요약");
  assert(
    card.employmentLabel === employmentStatusLabel("ACTIVE"),
    "card 재직"
  );
  assert(card.statusLabel === "ACTIVE", "card ACTIVE");
  assert(card.actionLabel === "비활성", "card 활성→비활성");
  const off = toMarshalRosterCardView(inactive);
  assert(off.statusLabel === "비활성", "card 비활성 상태");
  assert(off.actionLabel === "복구", "card 비활성→복구");
  const dense = toMarshalRosterDenseView(active);
  assert(dense.orderText === "3", "dense 순번");
  assert(dense.name === "양현철", "dense 이름");
  assert(dense.team === "8조", "dense 조");
  assert(dense.statusLabel === "활성", "dense 활성");
  assert(dense.typeLabel === "하우스", "dense 유형");
  assert(
    dense.employmentLabel === employmentStatusLabel("ACTIVE"),
    "dense 재직"
  );
  assert(dense.actionLabel === "비활성", "dense 활성→비활성");
  const denseOff = toMarshalRosterDenseView(inactive);
  assert(denseOff.statusLabel === "비활성", "dense 비활성 상태");
  assert(denseOff.actionLabel === "복구", "dense 비활성→복구");
  assert(
    marshalRosterSaveErrorMessage({
      status: 409,
      code: "duplicate_rotation_order",
      error: "활성 마샬 순번 3이(가) 중복됩니다.",
    }).includes("중복"),
    "409 순번 중복 안내"
  );
  assert(
    marshalRosterSaveErrorMessage({
      status: 409,
      code: "duplicate_rotation_order",
    }) === "활성 마샬 순번이 중복됩니다. 다른 순번을 입력하세요.",
    "409 fallback 안내"
  );
  const shown = visibleMarshalRoster([active, inactive], false);
  assert(shown.length === 1 && shown[0].id === 1, "비활성 제외");
  const all = visibleMarshalRoster([active, inactive], true);
  assert(all.map((r) => r.id).join(",") === "2,1", "순번 정렬 + 비활성 포함");
  assert(
    MARSHAL_ROSTER_TABLE_COLUMNS.join(",") ===
      "순번,이름,조,유형,재직,상태,액션",
    "PC table columns"
  );
  assert(caddyTypeLabel("HOUSE") === "하우스", "유형 라벨 유지");
}

section("source contracts");
{
  const page = read("src/app/manage/marshals/page.tsx");
  const picker = read("src/components/manage/MarshalCaddyPicker.tsx");
  const css = read("src/app/globals.css");
  const ui = read("src/lib/marshalRosterUi.ts");

  assert(page.includes("MarshalCaddyPicker"), "page uses picker");
  assert(page.includes('aria-label="캐디"'), "추가 UI 캐디 선택");
  assert(page.includes('aria-label="마샬 순번"'), "추가 UI 순번");
  assert(page.includes("명단에 추가"), "추가 UI 버튼");
  assert(page.includes("비활성 포함"), "비활성 포함 유지");
  assert(page.includes('data-marshal-roster="dense"'), "mobile dense list");
  assert(page.includes('data-marshal-roster="table"'), "desktop table");
  assert(page.includes("colSpan={7}"), "empty row colSpan 7");
  assert(page.includes("toMarshalRosterDenseView"), "dense contract 사용");
  assert(page.includes("aria-expanded"), "dense 펼침 상태");
  assert(page.includes("data-marshal-panel"), "dense 관리 패널");
  assert(page.includes("marshalRosterSaveErrorMessage"), "409 안내 helper");
  assert(page.includes("MARSHAL_ROSTER_TABLE_COLUMNS"), "table contract 사용");
  assert(!page.includes('data-marshal-roster="cards"'), "대형 카드 목록 제거");
  assert(!page.includes("mr-roster-card-name"), "대형 카드 이름 제거");
  assert(page.includes("buildMarshalCreateBody"), "create payload helper");
  assert(page.includes("buildMarshalActivePatch"), "active patch helper");
  assert(page.includes("buildMarshalRotationPatch"), "rotation patch helper");
  assert(!/시작일/.test(page), "페이지에 시작일 UI 없음");
  assert(!page.includes('type="date"'), "startedOn date input 없음");
  {
    const createFn =
      page.split("const createMarshal")[1]?.split("const patchMarshal")[0] || "";
    assert(createFn.includes("caddyId"), "create POST caddyId");
    assert(!createFn.includes("startedOn"), "create POST omits startedOn");
    const patchType = page.split("const patchMarshal")[1]?.split("return (")[0] || "";
    assert(!/startedOn\?:/.test(patchType), "patchMarshal UI type omits startedOn");
  }
  assert(picker.includes('role="combobox"'), "picker combobox");
  assert(picker.includes('role="listbox"'), "picker listbox");
  assert(picker.includes("onKeyDown"), "picker keyboard");
  assert(css.includes("@media (max-width: 719px)"), "mobile breakpoint");
  assert(css.includes(".mr-roster-dense"), "dense css");
  assert(css.includes(".mr-dense-main"), "dense row css");
  assert(css.includes(".mr-roster-table"), "table css");
  assert(!css.includes(".mr-roster-cards"), "card list css 제거");
  assert(
    /@media \(max-width: 719px\)[\s\S]*\.mr-roster-table\s*\{\s*display:\s*none/m.test(
      css
    ),
    "모바일에서 table 숨김"
  );
  assert(
    /@media \(max-width: 719px\)[\s\S]*\.mr-roster-dense\s*\{\s*display:\s*block/m.test(
      css
    ),
    "모바일에서 dense 표시"
  );
  assert(!ui.includes("autoAssignEngine"), "ui helper 엔진 없음");
  assert(!page.includes("generateMarshal"), "UI 월 생성 없음");
}

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
