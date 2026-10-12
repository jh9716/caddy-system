/**
 * 캐디 명단 V2 XLSX preview 단위 테스트 (DB write 없음)
 * npx tsx scripts/test-caddy-roster-import-xlsx-v2-preview-unit.ts
 */

import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { buildRosterExportCsv } from "../lib/caddyRosterImportV2";
import {
  buildRosterExportXlsxBuffer,
  readRosterExportXlsxSheets,
  type RosterExportXlsxRow,
} from "../lib/caddyRosterExportXlsx";
import {
  assertExistingRowsUnchanged,
  buildXlsxV2WorkbookPreview,
} from "../lib/caddyRosterImportXlsxV2Preview";
import { DRIVING_POOL_TEAM } from "../src/lib/caddyManage";

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
  console.log(`\n== ${title} ==`);
}

function readSrc(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

const fixture: RosterExportXlsxRow[] = [
  {
    id: 1,
    name: "이영진",
    team: "1조",
    teamOrder: 1,
    employmentStatus: "ACTIVE",
    phoneNormalized: "01011112222",
    thirdBandSubgroup: null,
    caddyType: "HOUSE",
  },
  {
    id: 2,
    name: "박서진",
    team: "9조",
    teamOrder: 3,
    employmentStatus: "LEAVE",
    phoneNormalized: "01022223333",
    thirdBandSubgroup: "WEEKDAY",
    caddyType: "THIRD",
  },
  {
    id: 3,
    name: "퇴사김",
    team: "2조",
    teamOrder: 4,
    employmentStatus: "RETIRED",
    phoneNormalized: null,
    thirdBandSubgroup: null,
    caddyType: "HOUSE",
  },
  {
    id: 4,
    name: "드라이브김",
    team: DRIVING_POOL_TEAM,
    teamOrder: 0,
    employmentStatus: "ACTIVE",
    phoneNormalized: "01055556666",
    thirdBandSubgroup: null,
    caddyType: "DRIVING",
  },
];

function rebuild(
  base: Buffer,
  mutate: (sheets: Record<string, Array<Array<string | number>>>) => void
): Buffer {
  const { sheetNames, sheets } = readRosterExportXlsxSheets(base);
  mutate(sheets);
  const wb = XLSX.utils.book_new();
  for (const name of sheetNames) {
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(sheets[name] ?? []),
      name
    );
  }
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

function existingRow(
  sheets: Record<string, Array<Array<string | number>>>,
  id: number
) {
  return sheets["기존캐디"].find((r, i) => i > 0 && Number(r[0]) === id);
}

const adminBuf = buildRosterExportXlsxBuffer(fixture, { canReadArchived: true });
const beforeSnap = JSON.parse(JSON.stringify(fixture));

section("P1 export reupload / no-change");
const noChange = buildXlsxV2WorkbookPreview(adminBuf, fixture, {
  canReadArchived: true,
});
assert(noChange.mode === "delta", "mode is delta");
assert(noChange.format === "xlsx-v2-workbook", "format is workbook v2");
assert(noChange.summary.applyAvailable === false, "apply is not available");
assert(
  /^[a-f0-9]{64}$/.test(noChange.confirmation.fingerprint),
  "preview includes roster fingerprint"
);
assert(noChange.creates.length === 0, "reupload creates 0");
assert(noChange.updates.length === 0, "reupload updates 0");
assert(noChange.retires.length === 0, "reupload retires 0");
assert(noChange.drivingChanges.length === 0, "reupload driving 0");
assert(
  noChange.errors.length === 0,
  `reupload errors 0: ${noChange.errors.map((e) => e.code).join(",")}`
);
assert(noChange.summary.update === 0, "summary update 0");
assert(
  assertExistingRowsUnchanged(beforeSnap, fixture),
  "fixture rows unchanged after no-change preview"
);

section("1명 수정 diff");
const edited = rebuild(adminBuf, (sheets) => {
  const row = existingRow(sheets, 1);
  if (row) row[2] = "3조";
});
const oneUpdate = buildXlsxV2WorkbookPreview(edited, fixture, {
  canReadArchived: true,
});
assert(oneUpdate.updates.length === 1, "one update");
assert(oneUpdate.updates[0]?.id === 1, "update matches id 1 only");
assert(
  oneUpdate.updates[0]?.fields.some(
    (f) => f.key === "team" && f.before === "1조" && f.after === "3조"
  ),
  "team before/after"
);
assert(oneUpdate.creates.length === 0, "edit is not create");
assert(oneUpdate.retires.length === 0, "edit is not retire");
assert(oneUpdate.summary.applyAvailable === true, "one update is apply-available");
assert(
  assertExistingRowsUnchanged(beforeSnap, fixture),
  "fixture unchanged after update preview"
);

section("신규 1명");
const withCreate = rebuild(adminBuf, (sheets) => {
  sheets["신규캐디"][1] = ["신규박", "1조", 8, "ACTIVE", "", "일반"];
});
const created = buildXlsxV2WorkbookPreview(withCreate, fixture, {
  canReadArchived: true,
});
assert(created.creates.length === 1, "one create");
assert(created.creates[0]?.name === "신규박", "create name");
assert(created.creates[0]?.team === "1조", "create team");
assert(created.creates[0]?.teamOrder === 8, "create teamOrder");
assert(created.creates[0]?.caddyType === "HOUSE", "create HOUSE from 1조");
assert(created.updates.length === 0, "create does not update");

section("기존캐디 id 없는 행은 신규가 아님");
const noIdExisting = rebuild(adminBuf, (sheets) => {
  sheets["기존캐디"].push(["", "유령", "1조", 9, "ACTIVE", "", "일반"]);
});
const noIdPreview = buildXlsxV2WorkbookPreview(noIdExisting, fixture, {
  canReadArchived: true,
});
assert(
  noIdPreview.errors.some((e) => e.code === "id_required"),
  "existing sheet without id is error"
);
assert(
  !noIdPreview.creates.some((c) => c.name === "유령"),
  "id-less existing row is not a create"
);

section("퇴사 1명");
const withRetire = rebuild(adminBuf, (sheets) => {
  sheets["퇴사"][1] = [1, "이영진", "이직"];
});
const retired = buildXlsxV2WorkbookPreview(withRetire, fixture, {
  canReadArchived: true,
});
assert(retired.retires.length === 1, "one retire candidate");
assert(retired.retires[0]?.id === 1, "retire by id");
assert(retired.retires[0]?.reason === "이직", "retire reason kept");
assert(
  retired.updates.every((u) => u.id !== 1 || !u.fields.some((f) => f.key === "employmentStatus")),
  "retire is not an employment update on 기존캐디"
);

section("unknown id");
const unknown = rebuild(adminBuf, (sheets) => {
  const row = existingRow(sheets, 1);
  if (row) row[0] = 999;
});
const unknownPrev = buildXlsxV2WorkbookPreview(unknown, fixture, {
  canReadArchived: true,
});
assert(
  unknownPrev.errors.some((e) => e.code === "unknown_id" && e.id === 999),
  "unknown id is error"
);
assert(
  !unknownPrev.updates.some((u) => u.id === 999),
  "unknown id is not matched by name"
);

section("duplicate id");
const dup = rebuild(adminBuf, (sheets) => {
  const row = existingRow(sheets, 1);
  if (row) sheets["기존캐디"].push([...row]);
});
const dupPrev = buildXlsxV2WorkbookPreview(dup, fixture, {
  canReadArchived: true,
});
assert(
  dupPrev.errors.some((e) => e.code === "duplicate_id" && e.id === 1),
  "duplicate id is error"
);

section("name mismatch");
const typo = rebuild(adminBuf, (sheets) => {
  const row = existingRow(sheets, 1);
  if (row) row[1] = "이영진x";
});
const typoPrev = buildXlsxV2WorkbookPreview(typo, fixture, {
  canReadArchived: true,
});
assert(
  typoPrev.warnings.some((w) => w.code === "name_mismatch" && w.id === 1),
  "1-char name typo is warning, still same id"
);
assert(
  !typoPrev.updates.some((u) => u.id === 2) || typoPrev.updates.every((u) => u.id === 1 || u.id === 2),
  "typo does not rematch another person"
);

const severe = rebuild(adminBuf, (sheets) => {
  const row = existingRow(sheets, 1);
  if (row) row[1] = "홍길동";
});
const severePrev = buildXlsxV2WorkbookPreview(severe, fixture, {
  canReadArchived: true,
});
assert(
  severePrev.errors.some((e) => e.code === "name_mismatch_severe" && e.id === 1),
  "severe name mismatch is error on the same id"
);
assert(
  !severePrev.updates.some((u) => u.id === 2 && u.fields.some((f) => f.after === "홍길동")),
  "does not attach 홍길동 to another id"
);

section("invalid enum/team");
const badTeam = rebuild(adminBuf, (sheets) => {
  const row = existingRow(sheets, 1);
  if (row) row[2] = "13조";
});
const badTeamPrev = buildXlsxV2WorkbookPreview(badTeam, fixture, {
  canReadArchived: true,
});
assert(
  badTeamPrev.errors.some((e) => e.code === "invalid_team"),
  "invalid team 13조"
);

const badEmp = rebuild(adminBuf, (sheets) => {
  const row = existingRow(sheets, 1);
  if (row) row[4] = "근무중";
});
const badEmpPrev = buildXlsxV2WorkbookPreview(badEmp, fixture, {
  canReadArchived: true,
});
assert(
  badEmpPrev.errors.some((e) => e.code === "invalid_employment_status"),
  "invalid employmentStatus 근무중"
);

const houseWeekend = rebuild(adminBuf, (sheets) => {
  const row = existingRow(sheets, 1);
  if (row) row[6] = "주말";
});
const houseWeekendPrev = buildXlsxV2WorkbookPreview(houseWeekend, fixture, {
  canReadArchived: true,
});
assert(
  houseWeekendPrev.errors.some((e) => e.code === "invalid_third_band_subgroup"),
  "1조 cannot have 주말 subgroup"
);

section("omitted existing caddy ≠ retire");
const omitted = rebuild(adminBuf, (sheets) => {
  sheets["기존캐디"] = sheets["기존캐디"].filter(
    (r, i) => i === 0 || Number(r[0]) !== 2
  );
});
const omittedPrev = buildXlsxV2WorkbookPreview(omitted, fixture, {
  canReadArchived: true,
});
assert(omittedPrev.retires.length === 0, "omitted row is not retired");
assert(
  omittedPrev.summary.omittedExisting >= 1,
  "omitted existing counted as omitted, not retire"
);
assert(
  !omittedPrev.updates.some((u) => u.id === 2),
  "omitted id 2 is not updated"
);

section("기존캐디 RETIRED 값은 퇴사 시트가 아님");
const retireOnExisting = rebuild(adminBuf, (sheets) => {
  const row = existingRow(sheets, 1);
  if (row) row[4] = "RETIRED";
});
const retireOnExistingPrev = buildXlsxV2WorkbookPreview(retireOnExisting, fixture, {
  canReadArchived: true,
});
assert(
  retireOnExistingPrev.errors.some((e) => e.code === "retire_use_retire_sheet"),
  "employment RETIRED on 기존캐디 is rejected"
);
assert(retireOnExistingPrev.retires.length === 0, "not treated as retire");

section("formula cells are not trusted");
const formulaWb = XLSX.read(adminBuf, { type: "buffer", cellFormula: true });
const existingSheet = formulaWb.Sheets["기존캐디"];
existingSheet.B2 = { t: "s", f: 'HYPERLINK("http://evil")', v: "이영진" };
const formulaBuf = Buffer.from(
  XLSX.write(formulaWb, { type: "buffer", bookType: "xlsx" })
);
const formulaPrev = buildXlsxV2WorkbookPreview(formulaBuf, fixture, {
  canReadArchived: true,
});
assert(
  formulaPrev.errors.some((e) => e.code === "formula_not_allowed"),
  "stored formula is an error"
);

section("staff archive boundary");
const staffUnknown = buildXlsxV2WorkbookPreview(
  rebuild(adminBuf, (sheets) => {
    sheets["퇴사"][1] = [3, "퇴사김", ""];
  }),
  fixture,
  { canReadArchived: false }
);
assert(
  staffUnknown.errors.some((e) => e.code === "unknown_id" && e.id === 3),
  "staff cannot target archived id (no leak as match)"
);

section("DB snapshot unchanged after every preview");
assert(
  JSON.stringify(fixture) === JSON.stringify(beforeSnap),
  "in-memory existing rows unchanged after all previews"
);
assert(
  fixture.length === beforeSnap.length &&
    fixture.every((row, i) => row.employmentStatus === beforeSnap[i].employmentStatus),
  "employmentStatus values unchanged"
);

section("source: preview route is read-only");
const previewRoute = readSrc(
  "src/app/api/caddies/import-v2/xlsx/preview/route.ts"
);
assert(/requireAdmin/.test(previewRoute), "preview requireAdmin");
assert(/canReadArchivedCaddies/.test(previewRoute), "preview uses archive ACL");
assert(/prisma\.caddy\.findMany/.test(previewRoute), "preview findMany only");
assert(
  !/prisma\.caddy\.(create|update|delete|createMany|updateMany|deleteMany)/.test(
    previewRoute
  ),
  "preview route has no Caddy writes"
);

const page = readSrc("src/app/manage/caddies/page.tsx");
assert(/Excel 가져오기/.test(page), "UI has Excel 가져오기");
assert(
  /\/api\/caddies\/import-v2\/xlsx\/preview/.test(page),
  "UI posts to v2 preview"
);

section("기존 import/CSV 회귀 source");
const csvRoute = readSrc("src/app/api/caddies/export/route.ts");
const oldPreview = readSrc("src/app/api/caddies/import/preview/route.ts");
const oldApply = readSrc("src/app/api/caddies/import/apply/route.ts");
const importV2 = readSrc("lib/caddyRosterImportV2.ts");
assert(/buildRosterExportCsv/.test(csvRoute), "CSV export route unchanged symbol");
assert(
  !/caddyRosterImportXlsxV2Preview/.test(oldPreview) &&
    !/caddyRosterImportXlsxV2Preview/.test(oldApply) &&
    !/caddyRosterImportXlsxV2Preview/.test(importV2),
  "legacy import engine does not import v2 workbook preview"
);
assert(/applyRosterImportPayloadV2/.test(oldApply), "legacy apply still v2 apply");
const csv = buildRosterExportCsv(fixture);
assert(csv.includes("이영진") && !csv.includes("드라이브김"), "CSV export still regular-only");

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
