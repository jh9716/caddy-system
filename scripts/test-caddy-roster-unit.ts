/**
 * DB 없는 단위 테스트 — import preview/apply 규칙 검증
 * 실행: npx tsx scripts/test-caddy-roster-unit.ts
 *
 * 실제 DB에 쓰지 않습니다.
 */

import {
  applyImportPayload,
  buildImportPreview,
  collapseImportRowsToPeople,
  parseImportFile,
  type ExistingCaddy,
} from "../lib/caddyImport";
import {
  isNeedsReviewName,
  shouldTouchEmploymentStatus,
} from "../lib/caddyImportRules";
import {
  buildTestRosterXlsxBuffer,
  parseTeamNameMatrix,
} from "../lib/caddyImportXlsx";

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
  section("rules");
  assert(isNeedsReviewName("박준형"), "박준형 needs review");
  assert(isNeedsReviewName("김기환2"), "김기환2 needs review");
  assert(isNeedsReviewName("김예진1"), "김예진1 needs review");
  assert(isNeedsReviewName("김예진2"), "김예진2 needs review");
  assert(!isNeedsReviewName("이영진"), "이영진 is normal");
  assert(shouldTouchEmploymentStatus() === false, "never touch employmentStatus");

  section("parseImportFile");
  const rows = parseImportFile(
    "team,name\n1조,이영진\n2조,신규자\n3조,박준형\n",
    "t.csv"
  );
  assert(rows.length === 3, "parsed 3 rows");
  assert(rows[0].name === "이영진" && rows[0].team === "1조", "first row ok");

  section("collapse — primary + extras merge, keep numbered suffix");
  const collapsed = collapseImportRowsToPeople(
    parseImportFile(
      [
        "team,name",
        "10조,김지수",
        "주중반,김지수",
        "1조,김예진1",
        "주중반,김예진2",
        "주말반,정재훈",
      ].join("\n")
    )
  );
  assert(collapsed.length === 4, "4 unique people after collapse");
  const kim = collapsed.find((p) => p.name === "김지수");
  assert(!!kim && kim.primaryTeam === "10조", "김지수 primary 10조");
  assert(!!kim && kim.extras.includes("주중반"), "김지수 has 주중반 extra");
  assert(!!kim && kim.team === "10조", "compatible team stays primary");
  assert(
    collapsed.some((p) => p.name === "김예진1") &&
      collapsed.some((p) => p.name === "김예진2"),
    "numbered suffixes kept as distinct people"
  );
  const jung = collapsed.find((p) => p.name === "정재훈");
  assert(
    !!jung && jung.primaryTeam === null && jung.team === "주말반",
    "extra-only → team=주말반"
  );

  section("buildImportPreview — id keep + team update + create + review");
  const existing: ExistingCaddy[] = [
    { id: 1, name: "이영진", team: "1조" },
    { id: 2, name: "박서진2", team: "1조" },
    { id: 10, name: "이동대상", team: "3조" },
    { id: 20, name: "박준형", team: "3조" },
    { id: 30, name: "DB만존재", team: "8조" },
  ];

  const importCsv = [
    "team,name",
    "1조,이영진", // unchanged
    "5조,이동대상", // team update, id 10 keep
    "7조,신규자", // create
    "3조,박준형", // needsReview — no match/create
    "4조,김기환2", // needsReview create 금지
  ].join("\n");

  const preview = buildImportPreview(parseImportFile(importCsv), existing);

  assert(preview.summary.update === 1, "1 update");
  assert(preview.updates[0]?.id === 10, "update keeps id 10");
  assert(preview.updates[0]?.nextTeam === "5조", "team becomes 5조");
  assert(preview.summary.unchanged === 1, "1 unchanged");
  assert(preview.unchanged[0]?.id === 1, "unchanged id 1");
  assert(preview.summary.new === 1, "1 new");
  assert(preview.creates[0]?.name === "신규자", "create 신규자");
  assert(preview.summary.needsReview === 2, "2 needsReview");
  assert(
    preview.needsReview.every((r) =>
      ["박준형", "김기환2"].includes(r.name)
    ),
    "review names correct"
  );
  assert(
    !preview.applyPayload.creates.some((c) => isNeedsReviewName(c.name)),
    "applyPayload has no review creates"
  );
  assert(
    !preview.applyPayload.updates.some((u) => u.id === 20),
    "박준형 id not in updates"
  );
  assert(preview.touchesEmploymentStatus === false, "preview no employmentStatus");
  assert(
    preview.missingInImport.some((m) => m.id === 30 && m.name === "DB만존재"),
    "missingInImport lists DB-only (no auto resign)"
  );
  assert(
    preview.missingInImport.some((m) => m.id === 20),
    "박준형 remains missingInImport for manual check (not auto-matched)"
  );
  assert(
    preview.summary.partitionMatchesUnique === true,
    "create+matched+needsReview == unique import people"
  );

  section("number variant / typo → needsReview (no auto merge)");
  const variantPreview = buildImportPreview(
    parseImportFile("team,name\n1조,김예진1\n12조,허도경\n"),
    [
      { id: 97, name: "김예진", team: "5조" },
      { id: 177, name: "허도겸", team: "8조" },
    ]
  );
  assert(
    variantPreview.needsReview.some(
      (r) =>
        r.name === "김예진1" &&
        (r.reason.includes("숫자 표기") ||
          r.reason.includes("번호 표기") ||
          r.candidateIds?.includes(97))
    ),
    "김예진1 number-variant / blocklist review"
  );
  assert(
    variantPreview.needsReview.some(
      (r) => r.name === "허도경" && r.reason.includes("철자 유사")
    ),
    "허도경 typo review"
  );
  assert(variantPreview.summary.new === 0, "no auto create for review names");

  section("duplicate names → needsReview");
  const dupExisting: ExistingCaddy[] = [
    { id: 1, name: "김현정", team: "1조" },
    { id: 2, name: "김현정", team: "2조" },
  ];
  const dupPreview = buildImportPreview(
    parseImportFile("team,name\n3조,김현정\n"),
    dupExisting
  );
  assert(dupPreview.summary.needsReview === 1, "duplicate → review");
  assert(dupPreview.summary.update === 0, "no auto update on dup");
  assert(dupPreview.summary.new === 0, "no auto create on dup");

  section("applyImportPayload — mock prisma, no real DB");
  const store = new Map<number, { id: number; name: string; team: string }>([
    [10, { id: 10, name: "이동대상", team: "3조" }],
  ]);
  let nextId = 1000;
  const mockPrisma = {
    caddy: {
      async update({ where, data }: any) {
        const row = store.get(where.id);
        if (!row) throw new Error("missing");
        row.team = data.team;
        assert(
          !("employmentStatus" in data) &&
            !("status" in data) &&
            !("extras" in data) &&
            !("extraFlags" in data),
          "update data only team"
        );
        return { ...row };
      },
      async create({ data }: any) {
        assert(
          !("employmentStatus" in data) &&
            !("status" in data) &&
            !("extras" in data),
          "create data only name/team"
        );
        const id = nextId++;
        const row = { id, name: data.name, team: data.team };
        store.set(id, row);
        return row;
      },
    },
  };

  const result = await applyImportPayload(preview.applyPayload, mockPrisma, {
    existingForGuard: existing,
  });
  assert(result.updated === 1, "applied 1 update");
  assert(result.created === 1, "applied 1 create");
  assert(store.get(10)?.team === "5조", "id 10 team updated in place");
  assert(store.get(10)?.id === 10, "id 10 unchanged");

  let rejected = false;
  try {
    await applyImportPayload(
      {
        updates: [],
        creates: [{ name: "박준형", team: "1조", extras: [] }],
      },
      mockPrisma
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "reject create for needsReview name");

  section("XLSX horizontal layout + dual cell merge");
  const aoa = [
    ["1조", "", "2조", "", "12조", "", "주중반", ""],
    ["카트", "성명", "카트", "성명", "카트", "성명", "카트", "성명"],
    [1, "이영진", 5, "이동대상", "", "카트없는사람", 9, "이영진"],
    ["", "박서진2", "", "신규자", "", "", "", ""],
    [2, "박준형", "", "", "", "", "", ""],
  ];
  const matrixRows = parseTeamNameMatrix(
    aoa.map((r) => r.map((c) => String(c ?? "")))
  );
  assert(
    matrixRows.some((r) => r.name === "이영진" && r.team === "1조"),
    "xlsx matrix: 이영진 -> 1조"
  );
  assert(
    matrixRows.filter((r) => r.name === "이영진").length === 2,
    "raw rows keep dual 이영진 cells"
  );
  assert(
    matrixRows.some((r) => r.name === "카트없는사람" && r.team === "12조"),
    "empty cart still included"
  );
  assert(
    matrixRows.some((r) => r.name === "박서진2" && r.team === "1조"),
    "name without cart on next row"
  );

  const xbuf = buildTestRosterXlsxBuffer(aoa);
  const xrows = parseImportFile(xbuf, "roster.xlsx");
  assert(xrows.length >= 5, "parseImportFile xlsx returns rows");
  const xPeople = collapseImportRowsToPeople(xrows);
  const young = xPeople.find((p) => p.name === "이영진");
  assert(
    !!young &&
      young.primaryTeam === "1조" &&
      young.extras.includes("주중반") &&
      young.mergedFromDuplicateCells,
    "이영진 collapsed to primary+주중반"
  );

  const xExisting: ExistingCaddy[] = [
    { id: 1, name: "이영진", team: "1조" },
    { id: 2, name: "박서진2", team: "8조" },
    { id: 10, name: "이동대상", team: "3조" },
    { id: 20, name: "박준형", team: "3조" },
    { id: 30, name: "DB만존재", team: "8조" },
  ];
  const xPreview = buildImportPreview(xrows, xExisting);
  assert(Array.isArray(xPreview.lines) && xPreview.lines.length > 0, "preview.lines present");
  assert(
    xPreview.updates.some(
      (u) => u.id === 1 && u.extrasOnly && u.nextExtras.includes("주중반")
    ),
    "이영진 extras-only update (team 유지, 주중반 추가)"
  );
  assert(
    xPreview.lines.some(
      (l) =>
        l.action === "update" &&
        l.id === 2 &&
        l.currentTeam === "8조" &&
        l.nextTeam === "1조"
    ),
    "lines show id/old/new team for update"
  );
  assert(
    xPreview.lines.some((l) => l.action === "needsReview" && l.name === "박준형"),
    "lines include needsReview"
  );
  assert(
    xPreview.lines.some((l) => l.action === "create" && l.name === "신규자"),
    "lines include create"
  );
  assert(
    xPreview.lines.some((l) => l.action === "missingInImport" && l.id === 30),
    "lines include missingInImport"
  );
  assert(
    !JSON.stringify(xPreview.applyPayload).includes("cart"),
    "applyPayload has no cart field"
  );
  assert(xPreview.touchesEmploymentStatus === false, "xlsx preview no employmentStatus");
  assert(
    xPreview.summary.uniqueImportPeople ===
      xPreview.summary.createPlusMatched + xPreview.summary.needsReview,
    "xlsx partition identity"
  );

  const csvStill = parseImportFile("team,name\n3조,홍길동\n", "a.csv");
  assert(
    csvStill[0]?.name === "홍길동" && csvStill[0]?.team === "3조",
    "CSV path still works"
  );

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
