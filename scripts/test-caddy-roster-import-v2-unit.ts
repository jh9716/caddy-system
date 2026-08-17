/**
 * Import v2 단위 테스트 (DB 없음)
 * npx tsx scripts/test-caddy-roster-import-v2-unit.ts
 */

import {
  applyRosterImportPayloadV2,
  buildRosterExportCsv,
  buildRosterImportPreviewV2,
  escapeCsvFormulaCell,
  parseRosterCsvV2,
  unescapeCsvFormulaCell,
  RosterImportApplyError,
  ROSTER_IMPORT_APPLY_FAILED_USER_MESSAGE,
  ROSTER_IMPORT_APPLY_ROUTE_MAX_DURATION_SECONDS,
  ROSTER_IMPORT_APPLY_TX_MAX_WAIT_MS,
  ROSTER_IMPORT_APPLY_TX_OPTIONS,
  ROSTER_IMPORT_APPLY_TX_TIMEOUT_MS,
  rosterImportApplySuccessMessage,
  type RosterExisting,
} from "../lib/caddyRosterImportV2";
import {
  parseImportEmploymentStatus,
  parseImportTeamOrder,
} from "../lib/caddyImportRules";
import fs from "fs";
import path from "path";

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

async function main() {
  section("parsers");
  assert(parseImportTeamOrder("3") === 3, "teamOrder 3");
  assert(parseImportTeamOrder("") === null, "teamOrder blank keep");
  try {
    parseImportTeamOrder("0");
    assert(false, "teamOrder 0 should throw");
  } catch {
    assert(true, "teamOrder 0 rejected");
  }
  assert(parseImportEmploymentStatus("재직") === "ACTIVE", "재직→ACTIVE");
  assert(parseImportEmploymentStatus("LEAVE") === "LEAVE", "LEAVE");
  assert(parseImportEmploymentStatus("") === null, "emp blank keep");

  section("parse csv v2");
  const rows = parseRosterCsvV2(
    [
      "id,name,team,teamOrder,employmentStatus,phone",
      "1,이영진,1조,1,ACTIVE,010-1111-2222",
      ",신규,2조,1,재직,",
      "9,이름불일치,1조,2,ACTIVE,",
    ].join("\n")
  );
  assert(rows.length === 3, "3 rows");
  assert(rows[0].id === 1 && rows[0].teamOrder === 1, "id+order");
  assert(rows[1].id === null && rows[1].employmentStatus === "ACTIVE", "create row");
  assert(rows[0].phoneRaw === "010-1111-2222", "phone raw");

  const existing: RosterExisting[] = [
    {
      id: 1,
      name: "이영진",
      team: "1조",
      teamOrder: 1,
      employmentStatus: "ACTIVE",
      phoneNormalized: null,
    },
    {
      id: 2,
      name: "박서진",
      team: "1조",
      teamOrder: 2,
      employmentStatus: "ACTIVE",
      phoneNormalized: "01099998888",
    },
    {
      id: 9,
      name: "실제이름",
      team: "1조",
      teamOrder: 3,
      employmentStatus: "ACTIVE",
      phoneNormalized: null,
    },
    {
      id: 30,
      name: "DB만존재",
      team: "8조",
      teamOrder: 1,
      employmentStatus: "ACTIVE",
      phoneNormalized: null,
    },
  ];

  section("id match + name mismatch needsReview");
  const p1 = buildRosterImportPreviewV2(rows, existing);
  assert(p1.summary.needsReview >= 1, "has needsReview");
  assert(
    p1.needsReview.some((l) => l.id === 9 && l.reason?.includes("불일치")),
    "id/name mismatch reviewed"
  );
  assert(p1.summary.applyBlocked === true, "blocked by review");

  section("happy path update/create/unchanged/missing");
  const happyRows = parseRosterCsvV2(
    [
      "id,name,team,teamOrder,employmentStatus,phone",
      "1,이영진,1조,1,ACTIVE,01011112222", // phone only
      "2,박서진,2조,1,LEAVE,", // team+order+emp, phone blank keep
      ",신규자,3조,1,ACTIVE,01033334444",
    ].join("\n")
  );
  const happy = buildRosterImportPreviewV2(happyRows, existing);
  assert(happy.summary.needsReview === 0, "no review");
  assert(happy.summary.phoneIssues === 0, "no phone issues");
  assert(happy.summary.teamOrderConflicts === 0, "no order conflict");
  assert(happy.summary.update === 2, "2 updates");
  assert(happy.summary.create === 1, "1 create");
  assert(happy.summary.missingInImport === 2, "2 missing warn (9,30)");
  assert(happy.summary.applyBlocked === false, "apply allowed");
  assert(
    happy.applyPayload.updates.some((u) => u.id === 1 && u.phone === "01011112222"),
    "phone update in payload"
  );
  assert(
    happy.applyPayload.updates.some(
      (u) =>
        u.id === 2 &&
        u.team === "2조" &&
        u.teamOrder === 1 &&
        u.employmentStatus === "LEAVE" &&
        u.phone === undefined
    ),
    "team/order/emp update, phone omitted"
  );
  assert(
    !JSON.stringify(happy.applyPayload).includes("missingFromImport"),
    "never missingFromImport"
  );
  assert(
    !JSON.stringify(happy.applyPayload).includes("extraFlags"),
    "never extraFlags"
  );

  section("ACTIVE teamOrder conflict blocks");
  const conflictRows = parseRosterCsvV2(
    [
      "id,name,team,teamOrder,employmentStatus,phone",
      "1,이영진,1조,2,ACTIVE,", // move to order 2 where 박서진 is
      "2,박서진,1조,2,ACTIVE,",
    ].join("\n")
  );
  const conflict = buildRosterImportPreviewV2(conflictRows, existing);
  assert(conflict.summary.teamOrderConflicts >= 1, "conflict detected");
  assert(conflict.summary.applyBlocked === true, "apply blocked");
  assert(conflict.applyPayload.updates.length === 0, "empty payload when blocked");

  section("LEAVE holds slot — conflicts with ACTIVE");
  const leaveConflictRows = parseRosterCsvV2(
    [
      "id,name,team,teamOrder,employmentStatus,phone",
      "1,이영진,1조,2,ACTIVE,",
      "2,박서진,1조,2,LEAVE,",
    ].join("\n")
  );
  const leaveConflict = buildRosterImportPreviewV2(leaveConflictRows, existing);
  assert(leaveConflict.summary.teamOrderConflicts >= 1, "LEAVE+ACTIVE conflict");
  assert(leaveConflict.summary.applyBlocked === true, "LEAVE conflict blocks apply");

  section("RETIRED excluded from order conflict");
  const retireRows = parseRosterCsvV2(
    [
      "id,name,team,teamOrder,employmentStatus,phone",
      "1,이영진,1조,2,ACTIVE,",
      "2,박서진,1조,2,RETIRED,",
    ].join("\n")
  );
  const retire = buildRosterImportPreviewV2(retireRows, existing);
  assert(retire.summary.teamOrderConflicts === 0, "retired not in conflict");
  assert(retire.summary.applyBlocked === false, "apply ok");

  section("slot capacity range validation");
  const overCap = buildRosterImportPreviewV2(
    parseRosterCsvV2(
      [
        "name,team,teamOrder,employmentStatus,phone",
        "초과자,1조,25,ACTIVE,",
      ].join("\n")
    ),
    existing
  );
  assert(
    overCap.lines.some(
      (l) =>
        l.action === "needsReview" &&
        String(l.reason ?? "").includes("1~24")
    ),
    "create teamOrder 25 needsReview"
  );
  assert(overCap.summary.applyBlocked === true, "over capacity blocks apply");

  section("duplicate phone in file blocks");
  const dupPhone = buildRosterImportPreviewV2(
    parseRosterCsvV2(
      [
        "name,team,teamOrder,employmentStatus,phone",
        "갑,1조,1,ACTIVE,01011112222",
        "을,2조,1,ACTIVE,010-1111-2222",
      ].join("\n")
    ),
    existing
  );
  assert(dupPhone.summary.phoneIssues >= 2, "dup phone issues");
  assert(dupPhone.summary.applyBlocked === true, "blocked by phone");

  section("apply mock prisma — id preserved, no relation writes");
  const store = new Map(existing.map((e) => [e.id, { ...e }]));
  let happyTxOptions: { maxWait?: number; timeout?: number } | undefined;
  const happyMetrics = { executeRaw: 0, createManyAndReturn: 0 };
  const prisma = createTransactionalPrisma(store, {
    nextCreateId: 100,
    metrics: happyMetrics,
    onTransaction: (options) => {
      happyTxOptions = options;
    },
  });

  const result = await applyRosterImportPayloadV2(happy.applyPayload, prisma, {
    existingForGuard: existing,
  });
  assert(result.updated === 2, "updated 2");
  assert(result.created === 1, "created 1");
  assert(happyMetrics.executeRaw === 1, "updates use one batch SQL call");
  assert(
    happyMetrics.createManyAndReturn === 1,
    "creates use one createManyAndReturn call"
  );
  assert(store.get(1)?.phoneNormalized === "01011112222", "id1 phone set");
  assert(store.get(2)?.team === "2조", "id2 team moved");
  assert(store.get(2)?.employmentStatus === "LEAVE", "id2 leave");
  assert(store.get(2)?.phoneNormalized === "01099998888", "id2 phone kept");
  assert(store.has(30), "missing id30 still present");
  assert(store.get(30)?.employmentStatus === "ACTIVE", "missing not retired");
  assert(
    happyTxOptions?.timeout === ROSTER_IMPORT_APPLY_TX_TIMEOUT_MS &&
      happyTxOptions?.maxWait === ROSTER_IMPORT_APPLY_TX_MAX_WAIT_MS,
    "apply uses explicit transaction timeout/maxWait"
  );

  section("export csv");
  const csv = buildRosterExportCsv(existing);
  assert(csv.charCodeAt(0) === 0xfeff, "UTF-8 BOM at start");
  assert(
    csv.slice(1).startsWith(
      "id,name,team,teamOrder,employmentStatus,phone,thirdBandSubgroup\n"
    ),
    "header after BOM"
  );
  assert(csv.includes("01099998888"), "full phone in admin export");

  section("formula injection escape/unescape");
  assert(escapeCsvFormulaCell("=1+1") === "'=1+1", "escape =");
  assert(escapeCsvFormulaCell("+cmd") === "'+cmd", "escape +");
  assert(escapeCsvFormulaCell("-1") === "'-1", "escape -");
  assert(escapeCsvFormulaCell("@sum") === "'@sum", "escape @");
  assert(escapeCsvFormulaCell("김철수") === "김철수", "normal name no escape");
  assert(escapeCsvFormulaCell("1조") === "1조", "normal team no escape");
  assert(escapeCsvFormulaCell("'이미따옴") === "'이미따옴", "leading quote alone no escape");
  assert(unescapeCsvFormulaCell("'=1+1") === "=1+1", "unescape =");
  assert(unescapeCsvFormulaCell("'+cmd") === "+cmd", "unescape +");
  assert(unescapeCsvFormulaCell("김철수") === "김철수", "normal name no unescape");
  assert(unescapeCsvFormulaCell("'김철수") === "'김철수", "apostrophe+letter kept");

  section("export formula + BOM → import round-trip");
  const risky: RosterExisting[] = [
    {
      id: 101,
      name: "=HYPERLINK(\"http://x\")",
      team: "+evil",
      teamOrder: 1,
      employmentStatus: "ACTIVE",
      phoneNormalized: "01012345678",
      extraFlags: null,
    },
    {
      id: 102,
      name: "정상이름",
      team: "3조",
      teamOrder: 2,
      employmentStatus: "ACTIVE",
      phoneNormalized: null,
      extraFlags: null,
    },
  ];
  const exported = buildRosterExportCsv(risky);
  assert(exported.startsWith("\uFEFF"), "round-trip export has BOM");
  assert(exported.includes("'=HYPERLINK"), "export prefixes formula name");
  assert(exported.includes("'+evil"), "export prefixes formula team");
  assert(exported.includes("정상이름"), "normal name unescaped in export");
  assert(exported.includes(",3조,"), "normal team unescaped in export");

  const reparsed = parseRosterCsvV2(exported);
  assert(reparsed.length === 2, "round-trip parse 2 rows");
  assert(reparsed[0].name === '=HYPERLINK("http://x")', "formula name restored");
  assert(reparsed[0].team === "+evil", "formula team restored");
  assert(reparsed[1].name === "정상이름", "normal name unchanged after round-trip");
  assert(reparsed[1].team === "3조", "normal team unchanged after round-trip");
  assert(reparsed[0].id === 101, "id preserved");
  assert(reparsed[0].phoneRaw === "01012345678", "phone preserved");

  // Import still strips BOM even if manually present without formula escapes
  const bomOnly = parseRosterCsvV2(
    "\uFEFFid,name,team,teamOrder,employmentStatus,phone\n1,홍길동,1조,1,ACTIVE,\n"
  );
  assert(bomOnly.length === 1 && bomOnly[0].name === "홍길동", "BOM strip on import");

  // Full Export → Preview round-trip on normal roster (unchanged rows)
  const exportNormal = buildRosterExportCsv(existing);
  const previewRt = buildRosterImportPreviewV2(
    parseRosterCsvV2(exportNormal),
    existing
  );
  assert(!previewRt.summary.applyBlocked, "export→preview not blocked");
  assert(previewRt.summary.needsReview === 0, "export→preview no review");
  assert(
    previewRt.applyPayload.creates.length === 0 &&
      previewRt.applyPayload.updates.length === 0,
    "export→preview all unchanged"
  );

  section("thirdBandSubgroup parse / preview / round-trip");
  const bandExisting: RosterExisting[] = [
    {
      id: 201,
      name: "삼부주중",
      team: "9조",
      teamOrder: 1,
      employmentStatus: "ACTIVE",
      phoneNormalized: null,
      thirdBandSubgroup: "WEEKDAY",
    },
    {
      id: 202,
      name: "삼부주말",
      team: "10조",
      teamOrder: 1,
      employmentStatus: "ACTIVE",
      phoneNormalized: null,
      thirdBandSubgroup: "WEEKEND",
    },
    {
      id: 203,
      name: "삼부일반",
      team: "11조",
      teamOrder: 1,
      employmentStatus: "ACTIVE",
      phoneNormalized: null,
      thirdBandSubgroup: null,
    },
    {
      id: 204,
      name: "일부캐디",
      team: "1조",
      teamOrder: 1,
      employmentStatus: "ACTIVE",
      phoneNormalized: null,
      thirdBandSubgroup: null,
    },
  ];

  const pWeekday = parseRosterCsvV2(
    "id,name,team,teamOrder,employmentStatus,phone,thirdBandSubgroup\n,신규주중,9조,2,ACTIVE,,주중\n"
  );
  assert(
    pWeekday[0].thirdBandSubgroup === "WEEKDAY",
    "9조 + 주중 → WEEKDAY parse"
  );
  const prevWeekday = buildRosterImportPreviewV2(pWeekday, bandExisting);
  assert(
    prevWeekday.applyPayload.creates.some(
      (c) => c.name === "신규주중" && c.thirdBandSubgroup === "WEEKDAY"
    ),
    "9조 + 주중 → WEEKDAY create payload"
  );

  const pWeekend = parseRosterCsvV2(
    "id,name,team,teamOrder,employmentStatus,phone,thirdBandSubgroup\n,신규주말,10조,2,ACTIVE,,주말\n"
  );
  assert(
    pWeekend[0].thirdBandSubgroup === "WEEKEND",
    "10조 + 주말 → WEEKEND parse"
  );
  const prevWeekend = buildRosterImportPreviewV2(pWeekend, bandExisting);
  assert(
    prevWeekend.applyPayload.creates.some(
      (c) => c.name === "신규주말" && c.thirdBandSubgroup === "WEEKEND"
    ),
    "10조 + 주말 → WEEKEND create payload"
  );

  const pGeneral = parseRosterCsvV2(
    "id,name,team,teamOrder,employmentStatus,phone,thirdBandSubgroup\n,신규일반,11조,2,ACTIVE,,일반\n"
  );
  assert(pGeneral[0].thirdBandSubgroup === null, "11조 + 일반 → null parse");
  const prevGeneral = buildRosterImportPreviewV2(pGeneral, bandExisting);
  assert(
    prevGeneral.applyPayload.creates.some(
      (c) => c.name === "신규일반" && c.thirdBandSubgroup === null
    ),
    "11조 + 일반 → null create payload"
  );

  const pEn = parseRosterCsvV2(
    "id,name,team,teamOrder,employmentStatus,phone,thirdBandSubgroup\n,영문주중,9조,3,ACTIVE,,  weekday  \n,영문주말,10조,3,ACTIVE,,WEEKEND\n"
  );
  assert(pEn[0].thirdBandSubgroup === "WEEKDAY", "영문 WEEKDAY 지원");
  assert(pEn[1].thirdBandSubgroup === "WEEKEND", "영문 WEEKEND 지원");

  const pLegacy = parseRosterCsvV2(
    "id,name,team,teamOrder,employmentStatus,phone,thirdBandSubgroup\n,레거시주중,9조,4,ACTIVE,,주중반\n,레거시주말,10조,4,ACTIVE,,주말반\n"
  );
  assert(pLegacy[0].thirdBandSubgroup === "WEEKDAY", "legacy 주중반 → WEEKDAY");
  assert(pLegacy[1].thirdBandSubgroup === "WEEKEND", "legacy 주말반 → WEEKEND");

  const pDriving = parseRosterCsvV2(
    "id,name,team,teamOrder,employmentStatus,phone,thirdBandSubgroup\n,드라이빙금지,9조,5,ACTIVE,,드라이빙\n"
  );
  assert(
    pDriving[0].parseErrors.some((e) => e.includes("일반/주중/주말")),
    "DRIVING/드라이빙은 thirdBand 컬럼에서 거부"
  );

  const pBad18 = parseRosterCsvV2(
    "id,name,team,teamOrder,employmentStatus,phone,thirdBandSubgroup\n204,일부캐디,1조,1,ACTIVE,,주중\n"
  );
  const prevBad18 = buildRosterImportPreviewV2(pBad18, bandExisting);
  assert(
    prevBad18.lines.some(
      (l) =>
        l.action === "needsReview" &&
        l.id === 204 &&
        String(l.reason ?? "").includes("1~8조")
    ),
    "1~8조 + 주중 → blocking needsReview"
  );
  assert(prevBad18.summary.applyBlocked === true, "1~8조 + 주중 apply blocked");
  assert(
    prevBad18.applyPayload.updates.length === 0,
    "1~8조 + 주중 empty payload"
  );

  const pKeep = parseRosterCsvV2(
    "id,name,team,teamOrder,employmentStatus,phone,thirdBandSubgroup\n201,삼부주중,9조,1,ACTIVE,,\n"
  );
  const prevKeep = buildRosterImportPreviewV2(pKeep, bandExisting);
  assert(
    prevKeep.lines.some(
      (l) =>
        l.action === "unchanged" &&
        l.id === 201 &&
        l.nextThirdBandSubgroup === "WEEKDAY"
    ),
    "기존 Caddy + blank → 기존 WEEKDAY 유지"
  );
  assert(
    !prevKeep.applyPayload.updates.some((u) => u.id === 201),
    "blank keep not in updates"
  );

  const pNewBlank = parseRosterCsvV2(
    "id,name,team,teamOrder,employmentStatus,phone,thirdBandSubgroup\n,신규빈칸,12조,1,ACTIVE,,\n"
  );
  const prevNewBlank = buildRosterImportPreviewV2(pNewBlank, bandExisting);
  assert(
    prevNewBlank.applyPayload.creates.some(
      (c) => c.name === "신규빈칸" && c.thirdBandSubgroup === null
    ),
    "신규 Caddy + blank → null"
  );

  const pClear = parseRosterCsvV2(
    "id,name,team,teamOrder,employmentStatus,phone,thirdBandSubgroup\n201,삼부주중,9조,1,ACTIVE,,일반\n"
  );
  const prevClear = buildRosterImportPreviewV2(pClear, bandExisting);
  assert(
    prevClear.applyPayload.updates.some(
      (u) => u.id === 201 && u.thirdBandSubgroup === null
    ),
    "일반 명시 → 기존 WEEKDAY clear"
  );
  assert(
    prevClear.lines.some(
      (l) =>
        l.id === 201 &&
        l.action === "update" &&
        l.currentThirdBandSubgroup === "WEEKDAY" &&
        l.nextThirdBandSubgroup === null
    ),
    "preview 3부구분 주중 → 일반"
  );

  const pSixCol = parseRosterCsvV2(
    "id,name,team,teamOrder,employmentStatus,phone\n201,삼부주중,9조,1,ACTIVE,\n202,삼부주말,10조,1,ACTIVE,\n"
  );
  assert(
    pSixCol[0].thirdBandSubgroup === undefined &&
      pSixCol[1].thirdBandSubgroup === undefined,
    "6컬럼 CSV는 thirdBand 컬럼 생략"
  );
  const prevSix = buildRosterImportPreviewV2(pSixCol, bandExisting);
  assert(
    prevSix.summary.update === 0 &&
      prevSix.lines.filter((l) => l.action === "unchanged").length === 2,
    "6컬럼 CSV import 시 기존 subgroup 유지"
  );

  const pMoveClear = parseRosterCsvV2(
    "id,name,team,teamOrder,employmentStatus,phone\n201,삼부주중,1조,2,ACTIVE,\n"
  );
  const prevMove = buildRosterImportPreviewV2(pMoveClear, bandExisting);
  assert(
    prevMove.applyPayload.updates.some(
      (u) =>
        u.id === 201 && u.team === "1조" && u.thirdBandSubgroup === null
    ),
    "9~12→1~8 이동 시 subgroup null"
  );

  const pNoInfer = parseRosterCsvV2(
    "id,name,team,teamOrder,employmentStatus,phone,thirdBandSubgroup\n204,일부캐디,9조,6,ACTIVE,,\n"
  );
  const prevNoInfer = buildRosterImportPreviewV2(pNoInfer, bandExisting);
  assert(
    prevNoInfer.applyPayload.updates.some(
      (u) => u.id === 204 && u.team === "9조" && (u.thirdBandSubgroup == null)
    ) ||
      prevNoInfer.lines.some(
        (l) =>
          l.id === 204 &&
          l.nextTeam === "9조" &&
          l.nextThirdBandSubgroup == null
      ),
    "1~8→9~12 이동 시 subgroup 자동 추정 없음 (null)"
  );

  const exportedBand = buildRosterExportCsv(bandExisting);
  assert(exportedBand.includes(",주중\n") || exportedBand.includes(",주중"), "export WEEKDAY→주중");
  assert(exportedBand.includes("주말"), "export WEEKEND→주말");
  assert(exportedBand.includes("일반"), "export null→일반");
  const rtBand = buildRosterImportPreviewV2(
    parseRosterCsvV2(exportedBand),
    bandExisting
  );
  assert(!rtBand.summary.applyBlocked, "export→import round-trip not blocked");
  assert(rtBand.summary.needsReview === 0, "round-trip no review");
  assert(
    rtBand.applyPayload.updates.length === 0 &&
      rtBand.applyPayload.creates.length === 0,
    "export→import round-trip 값 불변"
  );

  section("apply transaction timeout / atomicity / public errors");
  assert(
    ROSTER_IMPORT_APPLY_TX_TIMEOUT_MS >= 45_000 &&
      ROSTER_IMPORT_APPLY_TX_TIMEOUT_MS <= 60_000,
    "tx timeout in 45–60s range"
  );
  assert(
    ROSTER_IMPORT_APPLY_TX_TIMEOUT_MS > 5_000,
    "tx timeout exceeds Prisma 5s default"
  );
  assert(
    ROSTER_IMPORT_APPLY_TX_MAX_WAIT_MS >= 5_000,
    "maxWait at least Prisma default"
  );
  assert(
    ROSTER_IMPORT_APPLY_ROUTE_MAX_DURATION_SECONDS <= 300,
    "maxDuration within Vercel Fluid Hobby/Pro 300s ceiling"
  );
  assert(
    ROSTER_IMPORT_APPLY_TX_TIMEOUT_MS / 1000 <
      ROSTER_IMPORT_APPLY_ROUTE_MAX_DURATION_SECONDS,
    "tx timeout shorter than route maxDuration"
  );
  assert(
    ROSTER_IMPORT_APPLY_TX_TIMEOUT_MS +
      ROSTER_IMPORT_APPLY_TX_MAX_WAIT_MS +
      15_000 <=
      ROSTER_IMPORT_APPLY_ROUTE_MAX_DURATION_SECONDS * 1000,
    "maxWait + timeout + 15s headroom fit in route maxDuration"
  );
  assert(
    ROSTER_IMPORT_APPLY_TX_OPTIONS.timeout === ROSTER_IMPORT_APPLY_TX_TIMEOUT_MS &&
      ROSTER_IMPORT_APPLY_TX_OPTIONS.maxWait ===
        ROSTER_IMPORT_APPLY_TX_MAX_WAIT_MS,
    "exported tx options match constants"
  );
  assert(
    rosterImportApplySuccessMessage({
      updated: 175,
      created: 2,
      phoneUpdated: 10,
    }) === "명단 반영 완료: 갱신 175 · 신규 2 · 전화 10",
    "success message includes apply counts"
  );

  type StoreRow = RosterExisting;
  const TEAMS = [
    "1조",
    "2조",
    "3조",
    "4조",
    "5조",
    "6조",
    "7조",
    "8조",
    "9조",
    "10조",
    "11조",
    "12조",
  ];

  function phoneForIndex(i: number): string {
    return `0101${String(i).padStart(7, "0")}`;
  }

  function cloneStore(src: Map<number, StoreRow>): Map<number, StoreRow> {
    return new Map([...src.entries()].map(([k, v]) => [k, { ...v }]));
  }

  function createTransactionalPrisma(
    store: Map<number, StoreRow>,
    opts?: {
      throwOnUpdateId?: number;
      throwOnCreateIndex?: number;
      nextCreateId?: number;
      metrics?: {
        executeRaw: number;
        createManyAndReturn: number;
      };
      onTransaction?: (options?: {
        maxWait?: number;
        timeout?: number;
      }) => void;
    }
  ) {
    let nextCreateId = opts?.nextCreateId ?? 50_000;
    const executeBatchUpdate = async (query: {
      values: readonly unknown[];
    }) => {
      opts?.metrics && opts.metrics.executeRaw++;
      const fieldsPerRow = 11;
      if (query.values.length % fieldsPerRow !== 0) {
        throw new Error("unexpected batch SQL parameter count");
      }
      let affected = 0;
      for (let i = 0; i < query.values.length; i += fieldsPerRow) {
        const [
          rawId,
          setTeam,
          team,
          setTeamOrder,
          teamOrder,
          setEmploymentStatus,
          employmentStatus,
          setPhone,
          phoneNormalized,
          setThirdBandSubgroup,
          thirdBandSubgroup,
        ] = query.values.slice(i, i + fieldsPerRow);
        const id = Number(rawId);
        if (opts?.throwOnUpdateId === id) {
          throw new Error("forced mid-transaction failure");
        }
        const row = store.get(id);
        if (!row) continue;
        if (setTeam) row.team = String(team);
        if (setTeamOrder) row.teamOrder = Number(teamOrder);
        if (setEmploymentStatus) {
          row.employmentStatus = String(employmentStatus);
        }
        if (setPhone) {
          row.phoneNormalized = phoneNormalized as string;
        }
        if (setThirdBandSubgroup) {
          row.thirdBandSubgroup =
            (thirdBandSubgroup as RosterExisting["thirdBandSubgroup"]) ?? null;
        }
        affected++;
      }
      return affected;
    };

    const caddy = {
      findMany: async () => [...store.values()],
      createManyAndReturn: async ({
        data,
      }: {
        data: Record<string, unknown>[];
        select: { id: true };
      }) => {
        opts?.metrics && opts.metrics.createManyAndReturn++;
        const rows: Array<{ id: number }> = [];
        for (let i = 0; i < data.length; i++) {
          if (opts?.throwOnCreateIndex === i) {
            throw new Error("forced batch create failure");
          }
          const id = nextCreateId++;
          const item = data[i];
          store.set(id, {
            id,
            name: String(item.name),
            team: String(item.team),
            teamOrder: Number(item.teamOrder) || 1,
            employmentStatus: String(item.employmentStatus || "ACTIVE"),
            phoneNormalized: (item.phoneNormalized as string) ?? null,
            thirdBandSubgroup:
              (item.thirdBandSubgroup as RosterExisting["thirdBandSubgroup"]) ??
              null,
          });
          rows.push({ id });
        }
        return rows;
      },
    };
    async function transaction<T>(
      fn: (tx: any) => Promise<T>,
      options?: { maxWait?: number; timeout?: number }
    ): Promise<T> {
      opts?.onTransaction?.(options);
      const snapshot = cloneStore(store);
      const tx = {
        caddy,
        $executeRaw: executeBatchUpdate,
        $transaction: transaction,
      };
      try {
        return await fn(tx);
      } catch (e) {
        const rolled = cloneStore(snapshot);
        store.clear();
        for (const [k, v] of rolled) store.set(k, v);
        throw e;
      }
    }
    return {
      caddy,
      $executeRaw: executeBatchUpdate,
      $transaction: transaction,
    };
  }

  const bulkCount = 175;
  const bulkExisting: RosterExisting[] = [];
  for (let i = 0; i < bulkCount; i++) {
    bulkExisting.push({
      id: 2000 + i,
      name: `대량${i}`,
      team: TEAMS[i % TEAMS.length],
      teamOrder: Math.floor(i / TEAMS.length) + 1,
      employmentStatus: "ACTIVE",
      phoneNormalized: null,
    });
  }
  const bulkPayload = {
    updates: bulkExisting.map((e, i) => ({
      id: e.id,
      phone: phoneForIndex(i),
    })),
    creates: [] as Array<{ name: string; team: string; teamOrder: number }>,
  };

  let bulkTxOptions: { maxWait?: number; timeout?: number } | undefined;
  const bulkStore = cloneStore(
    new Map(bulkExisting.map((e) => [e.id, { ...e }]))
  );
  const bulkMetrics = { executeRaw: 0, createManyAndReturn: 0 };
  const bulkPrisma = createTransactionalPrisma(bulkStore, {
    metrics: bulkMetrics,
    onTransaction: (options) => {
      bulkTxOptions = options;
    },
  });
  const bulkResult = await applyRosterImportPayloadV2(bulkPayload, bulkPrisma, {
    existingForGuard: bulkExisting,
  });
  assert(bulkResult.updated === 175, "175 updates commit");
  assert(
    [...bulkStore.values()].every((r) => r.phoneNormalized),
    "all 175 phones committed"
  );
  assert(
    bulkMetrics.executeRaw === 1 && bulkMetrics.createManyAndReturn === 0,
    "175 updates use one write statement, not O(N) calls"
  );
  assert(
    bulkTxOptions?.timeout === ROSTER_IMPORT_APPLY_TX_TIMEOUT_MS,
    "175-update apply uses 60s timeout not 5s default"
  );

  const createCount = 88;
  const createPayload = {
    updates: [] as Array<{ id: number }>,
    creates: Array.from({ length: createCount }, (_, i) => ({
      name: `대량신규-${i}`,
      team: TEAMS[i % 8],
      teamOrder: Math.floor(i / 8) + 1,
      employmentStatus: "ACTIVE" as const,
      ...(i === 0 ? { phone: "01077770000" } : {}),
    })),
  };
  const createStore = new Map<number, StoreRow>();
  const createMetrics = { executeRaw: 0, createManyAndReturn: 0 };
  const createPrisma = createTransactionalPrisma(createStore, {
    metrics: createMetrics,
  });
  const createResult = await applyRosterImportPayloadV2(
    createPayload,
    createPrisma,
    { existingForGuard: [] }
  );
  assert(createResult.created === 88, "88 creates commit");
  assert(
    createResult.createdIds.length === 88 &&
      new Set(createResult.createdIds).size === 88,
    "88 created ids returned"
  );
  assert(
    createMetrics.executeRaw === 0 &&
      createMetrics.createManyAndReturn === 1,
    "88 creates use one createManyAndReturn statement"
  );
  assert(
    [...createStore.values()].filter((r) => r.phoneNormalized == null).length ===
      87,
    "createMany preserves null phones"
  );

  const mixedExisting: RosterExisting[] = [
    {
      id: 70_001,
      name: "혼합기존",
      team: "9조",
      teamOrder: 1,
      employmentStatus: "ACTIVE",
      phoneNormalized: null,
      thirdBandSubgroup: "WEEKDAY",
    },
  ];
  const mixedPayload = {
    updates: [{ id: 70_001, thirdBandSubgroup: null }],
    creates: [
      {
        name: "혼합신규",
        team: "10조",
        teamOrder: 1,
        employmentStatus: "ACTIVE" as const,
        thirdBandSubgroup: "WEEKEND" as const,
      },
    ],
  };
  const mixedStore = cloneStore(
    new Map(mixedExisting.map((e) => [e.id, { ...e }]))
  );
  const mixedMetrics = { executeRaw: 0, createManyAndReturn: 0 };
  const mixedPrisma = createTransactionalPrisma(mixedStore, {
    metrics: mixedMetrics,
  });
  const mixedResult = await applyRosterImportPayloadV2(
    mixedPayload,
    mixedPrisma,
    { existingForGuard: mixedExisting }
  );
  const mixedCreated = [...mixedStore.values()].find(
    (row) => row.name === "혼합신규"
  );
  assert(
    mixedResult.updated === 1 &&
      mixedResult.created === 1 &&
      mixedMetrics.executeRaw === 1 &&
      mixedMetrics.createManyAndReturn === 1,
    "mixed update + create uses two write statements"
  );
  assert(
    mixedStore.get(70_001)?.phoneNormalized == null &&
      mixedStore.get(70_001)?.thirdBandSubgroup === null,
    "batch update keeps null phone and applies explicit null subgroup"
  );
  assert(
    mixedCreated?.phoneNormalized == null &&
      mixedCreated?.thirdBandSubgroup === "WEEKEND",
    "batch create stores null phone and enum subgroup"
  );

  const mixedFailStore = cloneStore(
    new Map(mixedExisting.map((e) => [e.id, { ...e }]))
  );
  const mixedFailPrisma = createTransactionalPrisma(mixedFailStore, {
    throwOnCreateIndex: 0,
  });
  try {
    await applyRosterImportPayloadV2(mixedPayload, mixedFailPrisma, {
      existingForGuard: mixedExisting,
    });
    assert(false, "mixed create error should fail");
  } catch (e) {
    assert(
      e instanceof RosterImportApplyError && e.code === "apply_failed",
      "mixed create error maps to apply_failed"
    );
  }
  assert(
    mixedFailStore.size === 1 &&
      mixedFailStore.get(70_001)?.thirdBandSubgroup === "WEEKDAY",
    "create failure rolls back preceding batch update"
  );

  const failStore = cloneStore(
    new Map(bulkExisting.map((e) => [e.id, { ...e }]))
  );
  const failPrisma = createTransactionalPrisma(failStore, {
    throwOnUpdateId: bulkExisting[50].id,
  });
  try {
    await applyRosterImportPayloadV2(bulkPayload, failPrisma, {
      existingForGuard: bulkExisting,
    });
    assert(false, "mid-transaction throw should fail");
  } catch (e) {
    assert(
      e instanceof RosterImportApplyError && e.code === "apply_failed",
      "internal tx error mapped to apply_failed"
    );
    assert(
      e instanceof Error &&
        !String(e.message).toLowerCase().includes("prisma") &&
        !String(e.message).includes("forced mid-transaction"),
      "Prisma/internal error text not in apply error message"
    );
    assert(
      e instanceof RosterImportApplyError &&
        e.message === ROSTER_IMPORT_APPLY_FAILED_USER_MESSAGE,
      "user-safe apply failure message"
    );
  }
  assert(
    [...failStore.values()].every((r) => r.phoneNormalized == null),
    "transaction error rolls back all 175 updates"
  );

  const prismaTimeout = Object.assign(
    new Error(
      "Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, PrismaClientKnownRequestError"
    ),
    { code: "P2028" }
  );
  const leakPrisma = {
    caddy: {
      findMany: async () => existing,
      createManyAndReturn: async () => [{ id: 1 }],
    },
    $executeRaw: async () => 1,
    $transaction: async () => {
      throw prismaTimeout;
    },
  };
  try {
    await applyRosterImportPayloadV2(happy.applyPayload, leakPrisma, {
      existingForGuard: existing,
    });
    assert(false, "prisma timeout should fail apply");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(
      e instanceof RosterImportApplyError &&
        e.code === "apply_failed" &&
        msg === ROSTER_IMPORT_APPLY_FAILED_USER_MESSAGE,
      "prisma timeout becomes user-safe apply_failed"
    );
    assert(
      !msg.toLowerCase().includes("prisma") &&
        !msg.includes("5000") &&
        !msg.includes("P2028") &&
        !msg.includes("expired transaction"),
      "UI-facing apply error omits Prisma timeout details"
    );
  }

  section("apply server revalidation — needsReview/slot/phone blocking");
  const guardPrisma = createTransactionalPrisma(
    cloneStore(new Map(existing.map((e) => [e.id, { ...e }])))
  );
  try {
    await applyRosterImportPayloadV2(
      {
        updates: [],
        creates: [{ name: "박준형", team: "1조", teamOrder: 4 }],
      },
      guardPrisma,
      { existingForGuard: existing }
    );
    assert(false, "needsReview create should fail apply");
  } catch (e) {
    assert(
      e instanceof RosterImportApplyError &&
        String(e.message).includes("needsReview"),
      "apply revalidates needsReview names"
    );
  }
  try {
    await applyRosterImportPayloadV2(
      {
        updates: [],
        creates: [{ name: "슬롯초과", team: "1조", teamOrder: 25 }],
      },
      guardPrisma,
      { existingForGuard: existing }
    );
    assert(false, "over-capacity create should fail apply");
  } catch (e) {
    assert(
      e instanceof RosterImportApplyError && e.code === "slot_out_of_range",
      "apply revalidates slot capacity"
    );
  }
  try {
    await applyRosterImportPayloadV2(
      {
        updates: [{ id: 1, phone: "" }],
        creates: [],
      },
      guardPrisma,
      { existingForGuard: existing }
    );
    assert(false, "empty phone should fail apply");
  } catch (e) {
    assert(
      e instanceof RosterImportApplyError &&
        e.code === "phone_delete_forbidden",
      "apply blocks phone delete"
    );
  }
  try {
    await applyRosterImportPayloadV2(
      {
        updates: [{ id: 1, phone: "01099998888" }],
        creates: [],
      },
      guardPrisma,
      { existingForGuard: existing }
    );
    assert(false, "duplicate phone should fail apply");
  } catch (e) {
    assert(
      e instanceof RosterImportApplyError && e.code === "phone_duplicate",
      "apply revalidates phone uniqueness vs existing"
    );
  }
  try {
    await applyRosterImportPayloadV2(
      {
        updates: [{ id: 999_999, team: "1조" }],
        creates: [],
      },
      guardPrisma,
      { existingForGuard: existing }
    );
    assert(false, "missing update id should fail apply");
  } catch (e) {
    assert(
      e instanceof RosterImportApplyError &&
        String(e.message).includes("존재하지 않는 id"),
      "apply revalidates update id"
    );
  }
  assert(
    happy.summary.applyBlocked === false &&
      Array.isArray(happy.applyPayload.updates),
    "preview→apply payload still produced after revalidation tests"
  );

  section("apply failure UX source guards");
  const root = path.join(__dirname, "..");
  const pageSrc = fs.readFileSync(
    path.join(root, "src/app/manage/caddies/page.tsx"),
    "utf8"
  );
  const applyRouteSrc = fs.readFileSync(
    path.join(root, "src/app/api/caddies/import/apply/route.ts"),
    "utf8"
  );
  assert(
    /export const maxDuration = 90/.test(applyRouteSrc),
    "apply route exports maxDuration = 90 literal"
  );
  assert(
    applyRouteSrc.includes("ROSTER_IMPORT_APPLY_FAILED_USER_MESSAGE"),
    "apply route returns user-safe failure message"
  );
  assert(
    !applyRouteSrc.includes('e?.message || "apply 실패"') &&
      !applyRouteSrc.includes("e?.message || 'apply 실패'"),
    "apply route does not return raw exception message"
  );
  const applyUi = pageSrc.slice(
    pageSrc.indexOf("/api/caddies/import/apply"),
    pageSrc.indexOf("Apply 반영")
  );
  assert(
    applyUi.includes("ROSTER_IMPORT_APPLY_FAILED_USER_MESSAGE"),
    "apply UI uses shared failure message"
  );
  assert(
    !applyUi.includes("data?.error"),
    "apply UI does not render API/Prisma error text"
  );
  assert(
    pageSrc.includes("rosterImportApplySuccessMessage"),
    "success uses 명단 반영 완료 helper"
  );
  assert(
    pageSrc.includes("cm-import-apply-error") &&
      pageSrc.includes("Preview 미반영"),
    "failure shown near import panel and preview marked 미반영"
  );
  assert(
    pageSrc.includes("cm-banner") && pageSrc.includes("is-error"),
    "top banner has error tone for apply failure"
  );

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
