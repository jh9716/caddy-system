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
  type RosterExisting,
} from "../lib/caddyRosterImportV2";
import {
  parseImportEmploymentStatus,
  parseImportTeamOrder,
} from "../lib/caddyImportRules";

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
  let nextId = 100;
  const prisma = {
    caddy: {
      findMany: async () => [...store.values()],
      update: async ({
        where,
        data,
      }: {
        where: { id: number };
        data: Record<string, unknown>;
      }) => {
        const row = store.get(where.id);
        if (!row) throw new Error("missing");
        assert(
          !("assignments" in data) && !("schedules" in data),
          "no relation fields in update"
        );
        Object.assign(row, data);
        if (data.phoneNormalized !== undefined) {
          row.phoneNormalized = data.phoneNormalized as string;
        }
        return { id: where.id };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = nextId++;
        store.set(id, {
          id,
          name: String(data.name),
          team: String(data.team),
          teamOrder: Number(data.teamOrder) || 1,
          employmentStatus: String(data.employmentStatus || "ACTIVE"),
          phoneNormalized: (data.phoneNormalized as string) ?? null,
        });
        return { id };
      },
      aggregate: async () => ({ _max: { teamOrder: 1 } }),
    },
    $transaction: async <T,>(fn: (tx: typeof prisma) => Promise<T>) => fn(prisma),
  };

  const result = await applyRosterImportPayloadV2(happy.applyPayload, prisma, {
    existingForGuard: existing,
  });
  assert(result.updated === 2, "updated 2");
  assert(result.created === 1, "created 1");
  assert(store.get(1)?.phoneNormalized === "01011112222", "id1 phone set");
  assert(store.get(2)?.team === "2조", "id2 team moved");
  assert(store.get(2)?.employmentStatus === "LEAVE", "id2 leave");
  assert(store.get(2)?.phoneNormalized === "01099998888", "id2 phone kept");
  assert(store.has(30), "missing id30 still present");
  assert(store.get(30)?.employmentStatus === "ACTIVE", "missing not retired");

  section("export csv");
  const csv = buildRosterExportCsv(existing);
  assert(csv.charCodeAt(0) === 0xfeff, "UTF-8 BOM at start");
  assert(
    csv.slice(1).startsWith("id,name,team,teamOrder,employmentStatus,phone\n"),
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

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
