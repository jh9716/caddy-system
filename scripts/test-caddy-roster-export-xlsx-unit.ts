/**
 * 캐디 명단 V2 XLSX export/template 단위 테스트 (DB 없음)
 * npx tsx scripts/test-caddy-roster-export-xlsx-unit.ts
 */

import fs from "node:fs";
import path from "node:path";
import {
  CADDY_ROSTER_XLSX_GUIDE_LINES,
  CADDY_ROSTER_XLSX_SHEET_NAMES,
  CADDY_ROSTER_XLSX_TEMPLATE_EMPTY_ROWS,
  DRIVING_CADDY_XLSX_HEADERS,
  EMPLOYMENT_STATUS_CODE_TABLE,
  EXISTING_CADDY_XLSX_HEADERS,
  NEW_CADDY_XLSX_HEADERS,
  RETIRE_CADDY_XLSX_HEADERS,
  THIRD_BAND_SUBGROUP_CODE_TABLE,
  buildRosterExportXlsxBuffer,
  partitionRosterExportXlsxRows,
  readRosterExportXlsxSheets,
  rosterExportXlsxHasStoredFormula,
  visibleRosterExportXlsxRows,
  type RosterExportXlsxRow,
} from "../lib/caddyRosterExportXlsx";
import { buildRosterExportCsv } from "../lib/caddyRosterImportV2";
import {
  DRIVING_POOL_TEAM,
  EMPLOYMENT_STATUSES,
  PRIMARY_TEAMS,
  THIRD_BAND_SUBGROUPS,
} from "../src/lib/caddyManage";
import { parseImportEmploymentStatus } from "../lib/caddyImportRules";
import { parseImportThirdBandSubgroup } from "../src/lib/caddyManage";

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
    phoneNormalized: null,
    thirdBandSubgroup: "WEEKDAY",
    caddyType: "THIRD",
  },
  {
    id: 3,
    name: "퇴사김",
    team: "2조",
    teamOrder: 4,
    employmentStatus: "RETIRED",
    phoneNormalized: "01033334444",
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
  {
    id: 5,
    name: "드라이브퇴사",
    team: DRIVING_POOL_TEAM,
    teamOrder: 0,
    employmentStatus: "RETIRED",
    phoneNormalized: null,
    thirdBandSubgroup: null,
    caddyType: "DRIVING",
  },
  {
    id: 101,
    name: '=HYPERLINK("http://x")',
    team: "3조",
    teamOrder: 2,
    employmentStatus: "ACTIVE",
    phoneNormalized: "+cmd",
    thirdBandSubgroup: null,
    caddyType: "HOUSE",
  },
];

section("sheet names + headers");
const staffBuf = buildRosterExportXlsxBuffer(fixture, { canReadArchived: false });
const staffWb = readRosterExportXlsxSheets(staffBuf);
assert(Buffer.isBuffer(staffBuf) && staffBuf.length > 0, "xlsx buffer generated");
assert(
  staffWb.sheetNames.join(",") === CADDY_ROSTER_XLSX_SHEET_NAMES.join(","),
  "sheet order and names"
);
assert(
  JSON.stringify(staffWb.sheets["기존캐디"][0]) ===
    JSON.stringify([...EXISTING_CADDY_XLSX_HEADERS]),
  "기존캐디 headers"
);
assert(
  JSON.stringify(staffWb.sheets["신규캐디"][0]) ===
    JSON.stringify([...NEW_CADDY_XLSX_HEADERS]),
  "신규캐디 headers"
);
assert(
  JSON.stringify(staffWb.sheets["퇴사"][0]) ===
    JSON.stringify([...RETIRE_CADDY_XLSX_HEADERS]),
  "퇴사 headers"
);
assert(
  JSON.stringify(staffWb.sheets["드라이빙"][0]) ===
    JSON.stringify([...DRIVING_CADDY_XLSX_HEADERS]),
  "드라이빙 headers"
);
assert(
  staffWb.sheets["신규캐디"].length === 1 + CADDY_ROSTER_XLSX_TEMPLATE_EMPTY_ROWS,
  "신규캐디 header + empty template rows"
);
assert(
  staffWb.sheets["퇴사"].length === 1 + CADDY_ROSTER_XLSX_TEMPLATE_EMPTY_ROWS,
  "퇴사 header + empty template rows"
);

section("기존캐디 includes id and current values");
const staffExisting = staffWb.sheets["기존캐디"].slice(1).filter((r) => r[0] !== "");
const staffExistingIds = staffExisting.map((r) => Number(r[0]));
assert(staffExistingIds.includes(1), "기존캐디 has id 1");
assert(staffExistingIds.includes(2), "기존캐디 has id 2");
assert(staffExistingIds.includes(101), "기존캐디 has formula-name id");
const row1 = staffExisting.find((r) => Number(r[0]) === 1);
assert(row1?.[1] === "이영진", "기존캐디 name");
assert(row1?.[2] === "1조", "기존캐디 team");
assert(Number(row1?.[3]) === 1, "기존캐디 teamOrder");
assert(row1?.[4] === "ACTIVE", "기존캐디 employmentStatus");
assert(row1?.[5] === "01011112222", "기존캐디 full phone");
assert(row1?.[6] === "일반", "기존캐디 thirdBand 일반");
const row2 = staffExisting.find((r) => Number(r[0]) === 2);
assert(row2?.[4] === "LEAVE", "LEAVE exported as LEAVE");
assert(row2?.[6] === "주중", "WEEKDAY exported as 주중");

section("staff vs account-manager archive boundary");
assert(!staffExistingIds.includes(3), "staff 기존캐디 omits RETIRED");
const staffDriving = staffWb.sheets["드라이빙"].slice(1).filter((r) => r[0] !== "");
const staffDrivingIds = staffDriving.map((r) => Number(r[0]));
assert(staffDrivingIds.includes(4), "staff 드라이빙 keeps ACTIVE");
assert(!staffDrivingIds.includes(5), "staff 드라이빙 omits RETIRED");
assert(
  staffWb.sheets["기존캐디"].flat().every((v) => !String(v).includes("퇴사김")),
  "staff workbook has no 퇴사김"
);
assert(
  staffWb.sheets["드라이빙"].flat().every((v) => !String(v).includes("드라이브퇴사")),
  "staff workbook has no 드라이브퇴사"
);

const adminBuf = buildRosterExportXlsxBuffer(fixture, { canReadArchived: true });
const adminWb = readRosterExportXlsxSheets(adminBuf);
const adminExistingIds = adminWb.sheets["기존캐디"]
  .slice(1)
  .filter((r) => r[0] !== "")
  .map((r) => Number(r[0]));
const adminDrivingIds = adminWb.sheets["드라이빙"]
  .slice(1)
  .filter((r) => r[0] !== "")
  .map((r) => Number(r[0]));
assert(adminExistingIds.includes(3), "account manager 기존캐디 includes RETIRED");
assert(adminDrivingIds.includes(5), "account manager 드라이빙 includes RETIRED");
assert(
  visibleRosterExportXlsxRows(fixture, false).every(
    (r) => r.employmentStatus !== "RETIRED"
  ),
  "visible rows helper drops RETIRED for staff"
);
assert(
  visibleRosterExportXlsxRows(fixture, true).some((r) => r.id === 3),
  "visible rows helper keeps RETIRED for archive reader"
);

section("partition regular vs driving");
const parts = partitionRosterExportXlsxRows(fixture);
assert(
  parts.existing.every((r) => r.id !== 4 && r.id !== 5),
  "기존 partition excludes driving"
);
assert(
  parts.driving.every((r) => r.id === 4 || r.id === 5),
  "driving partition only driving"
);
assert(
  !staffExistingIds.includes(4) && !adminExistingIds.includes(4),
  "드라이빙 김 is not on 기존캐디"
);

section("guide + code table from real constants");
const guideText = staffWb.sheets["_안내"].map((r) => String(r[0] ?? "")).join("\n");
assert(guideText.includes("id 기준"), "guide mentions id matching");
assert(guideText.includes("이름만으로 매칭하지 않을"), "guide forbids name-only match");
assert(guideText.includes("자동 퇴사되지 않습니다"), "guide no auto retire");
assert(guideText.includes("import preview"), "guide defers apply");
assert(guideText.includes("DB가 변경되지 않습니다"), "guide export is read-only");
assert(
  CADDY_ROSTER_XLSX_GUIDE_LINES.some((l) => l.includes("DB가 변경되지 않습니다")),
  "guide constant includes read-only line"
);

const codeValues = staffWb.sheets["_코드표"].slice(1).map((r) => String(r[1]));
for (const team of PRIMARY_TEAMS) {
  assert(codeValues.includes(team), `_코드표 team ${team}`);
}
assert(codeValues.includes(DRIVING_POOL_TEAM), "_코드표 includes 드라이빙");
for (const emp of EMPLOYMENT_STATUSES) {
  assert(codeValues.includes(emp), `_코드표 employment ${emp}`);
}
for (const emp of ["재직", "휴직", "퇴사"] as const) {
  assert(codeValues.includes(emp), `_코드표 employment alias ${emp}`);
  assert(parseImportEmploymentStatus(emp) != null, `alias ${emp} is real import value`);
}
for (const sub of THIRD_BAND_SUBGROUPS) {
  assert(codeValues.includes(sub), `_코드표 subgroup enum ${sub}`);
}
assert(codeValues.includes("일반"), "_코드표 일반");
assert(codeValues.includes("주중"), "_코드표 주중");
assert(codeValues.includes("주말"), "_코드표 주말");
assert(
  EMPLOYMENT_STATUS_CODE_TABLE.map((r) => r.value).join(",") ===
    "ACTIVE,LEAVE,RETIRED,재직,휴직,퇴사",
  "employment code table is enum + real aliases only"
);
assert(
  THIRD_BAND_SUBGROUP_CODE_TABLE.some((r) => r.value === "주중반"),
  "subgroup table includes parser alias 주중반"
);
assert(parseImportThirdBandSubgroup("주중반") === "WEEKDAY", "주중반 is real parser alias");
assert(parseImportThirdBandSubgroup("NONE") === null, "NONE is real parser alias");

section("formula injection");
assert(!rosterExportXlsxHasStoredFormula(staffBuf), "no stored Excel formulas");
const formulaRow = staffExisting.find((r) => Number(r[0]) === 101);
assert(
  String(formulaRow?.[1]).startsWith("'="),
  "formula name escaped with leading quote"
);
assert(String(formulaRow?.[5]).startsWith("'+"), "phone + prefix escaped");

section("CSV export regression");
const csv = buildRosterExportCsv(fixture);
assert(csv.charCodeAt(0) === 0xfeff, "CSV still has UTF-8 BOM");
assert(
  csv.slice(1).startsWith(
    "id,name,team,teamOrder,employmentStatus,phone,thirdBandSubgroup\n"
  ),
  "CSV header unchanged"
);
assert(csv.includes("이영진"), "CSV still exports regular name");
assert(csv.includes("01011112222"), "CSV still exports full phone");
assert(!csv.includes("드라이브김"), "CSV still omits driving");
assert(csv.includes("'=HYPERLINK"), "CSV still escapes formula name");

const csvRoute = readSrc("src/app/api/caddies/export/route.ts");
assert(/buildRosterExportCsv/.test(csvRoute), "CSV route still uses buildRosterExportCsv");
assert(/filterArchivedCaddies/.test(csvRoute), "CSV route still filters archive");
assert(
  !/caddyRosterExportXlsx/.test(csvRoute),
  "CSV route does not depend on xlsx builder"
);
assert(
  /caddy-roster-\$\{stamp\}\.csv/.test(csvRoute),
  "CSV filename pattern unchanged"
);

const applyRoute = readSrc("src/app/api/caddies/import/apply/route.ts");
const previewRoute = readSrc("src/app/api/caddies/import/preview/route.ts");
const importV2 = readSrc("lib/caddyRosterImportV2.ts");
assert(
  !/caddyRosterExportXlsx/.test(applyRoute) &&
    !/caddyRosterExportXlsx/.test(previewRoute) &&
    !/caddyRosterExportXlsx/.test(importV2),
  "import/apply engine does not import xlsx export"
);
assert(
  /applyRosterImportPayloadV2/.test(applyRoute),
  "apply route still uses v2 apply"
);

section("xlsx route auth / no write");
const xlsxRoute = readSrc("src/app/api/caddies/export.xlsx/route.ts");
assert(/requireAdmin/.test(xlsxRoute), "xlsx route requireAdmin");
assert(/canReadArchivedCaddies/.test(xlsxRoute), "xlsx route uses archive ACL");
assert(
  /buildRosterExportXlsxBuffer/.test(xlsxRoute),
  "xlsx route uses xlsx builder"
);
assert(
  !/prisma\.caddy\.(create|update|delete|createMany|updateMany|deleteMany)/.test(
    xlsxRoute
  ),
  "xlsx route has no Caddy writes"
);
assert(/prisma\.caddy\.findMany/.test(xlsxRoute), "xlsx route is findMany only");
assert(
  /export\.xlsx/.test(xlsxRoute) && /filename="caddy-roster-/.test(xlsxRoute),
  "xlsx content-disposition filename"
);

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
