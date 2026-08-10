/**
 * 캐디 명단 import Preview 전용 (DB 쓰기 없음)
 *
 * 사용:
 *   npx tsx scripts/preview-roster-import.ts <최신명단.xlsx> [--existing existing.json]
 *
 * existing 소스 (우선순위):
 *   1) --existing <json>  : [{id,name,team}, ...]  (권장, DB 접속 불필요)
 *   2) DATABASE_URL       : prisma.caddy.findMany 읽기 전용
 *
 * 절대 apply / delete / update / create 를 DB에 실행하지 않습니다.
 */

import fs from "node:fs";
import path from "node:path";
import {
  buildImportPreview,
  parseImportFile,
  type ExistingCaddy,
  type ImportPreview,
} from "../lib/caddyImport";

function usageAndExit(msg?: string): never {
  if (msg) console.error("ERROR:", msg);
  console.error(`
Usage:
  npx tsx scripts/preview-roster-import.ts <roster.xlsx|csv> [--existing existing.json] [--out report.json]

--existing  JSON array: [{ "id": 1, "name": "홍길동", "team": "1조" }, ...]
            없으면 DATABASE_URL 로 읽기 전용 조회를 시도합니다.

이 스크립트는 Preview만 수행하며 DB apply를 하지 않습니다.
`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let file: string | undefined;
  let existingPath: string | undefined;
  let outPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--existing") {
      existingPath = args[++i];
      continue;
    }
    if (a === "--out") {
      outPath = args[++i];
      continue;
    }
    if (a.startsWith("-")) usageAndExit(`unknown flag: ${a}`);
    if (!file) file = a;
    else usageAndExit(`unexpected arg: ${a}`);
  }

  return { file, existingPath, outPath };
}

function loadExistingFromJson(filePath: string): ExistingCaddy[] {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error("--existing JSON must be an array");
  }
  return raw.map((row, i) => {
    const id = Number(row.id);
    const name = String(row.name ?? "").trim();
    const team = String(row.team ?? "").trim();
    if (!id || !name || !team) {
      throw new Error(`--existing row[${i}] needs id,name,team`);
    }
    return { id, name, team, status: row.status ?? null };
  });
}

async function loadExistingFromDb(): Promise<ExistingCaddy[]> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "existing 소스가 없습니다. --existing existing.json 을 주거나 DATABASE_URL 을 설정하세요."
    );
  }
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    // 읽기 전용
    return await prisma.caddy.findMany({
      select: { id: true, name: true, team: true, status: true },
      orderBy: { id: "asc" },
    });
  } finally {
    await prisma.$disconnect();
  }
}

function printSection<T>(
  title: string,
  count: number,
  rows: T[],
  format: (row: T) => string
) {
  console.log(`\n## ${title} (${count})`);
  if (rows.length === 0) {
    console.log("(없음)");
    return;
  }
  for (const row of rows) console.log(format(row));
}

function printPreview(preview: ImportPreview, importCount: number, existingCount: number) {
  console.log("=== ROSTER IMPORT PREVIEW (read-only, no DB apply) ===");
  console.log(`import rows: ${importCount}`);
  console.log(`existing rows: ${existingCount}`);
  console.log("summary:", JSON.stringify(preview.summary, null, 2));
  console.log("touchesEmploymentStatus:", preview.touchesEmploymentStatus);

  printSection(
    "update — 기존 ID 유지, 조 변경",
    preview.summary.update,
    preview.updates,
    (u) => `id=${u.id}\t${u.name}\t${u.currentTeam} -> ${u.nextTeam}`
  );

  printSection(
    "unchanged — 기존 ID 유지, 조 동일",
    preview.summary.unchanged,
    preview.unchanged,
    (u) => `id=${u.id}\t${u.name}\t${u.team}`
  );

  printSection(
    "create — 신규만",
    preview.summary.new,
    preview.creates,
    (c) => `(new)\t${c.name}\t-> ${c.team}\t(row ${c.rowNumber})`
  );

  printSection(
    "needsReview — 자동 매칭/생성 안 함",
    preview.summary.needsReview,
    preview.needsReview,
    (r) =>
      `${r.name}\t최신조=${r.team}\t${r.reason}` +
      (r.candidateIds?.length ? `\t후보id=[${r.candidateIds.join(",")}]` : "")
  );

  printSection(
    "missingInImport — 최신 명단에 없음(자동 퇴사 없음)",
    preview.summary.missingInImport,
    preview.missingInImport,
    (m) => `id=${m.id}\t${m.name}\t${m.team}`
  );

  // 검증 포인트
  const updateIds = new Set(preview.updates.map((u) => u.id));
  const unchangedIds = new Set(preview.unchanged.map((u) => u.id));
  const overlap = [...updateIds].filter((id) => unchangedIds.has(id));
  const createHasId = preview.creates.some((c: any) => c.id != null);
  const reviewInApply = preview.applyPayload.creates.some((c) =>
    ["박준형", "김기환2", "김예진1", "김예진2"].includes(c.name.trim())
  );

  console.log("\n## validation checks");
  console.log(
    JSON.stringify(
      {
        updateAndUnchangedIdOverlap: overlap,
        createRowsDoNotCarryId: !createHasId,
        applyPayloadUpdatesOnlyChangeTeam: preview.applyPayload.updates.every(
          (u) => Object.keys(u).sort().join(",") === "id,team"
        ),
        applyPayloadHasNoNeedsReviewCreates: !reviewInApply,
        allUpdateIdsArePositive: preview.updates.every((u) => u.id > 0),
      },
      null,
      2
    )
  );
}

async function main() {
  const { file, existingPath, outPath } = parseArgs(process.argv);
  if (!file) usageAndExit("roster file path required");

  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) usageAndExit(`file not found: ${abs}`);

  const buf = fs.readFileSync(abs);
  const importRows = parseImportFile(buf, path.basename(abs));

  const existing = existingPath
    ? loadExistingFromJson(path.resolve(existingPath))
    : await loadExistingFromDb();

  const preview = buildImportPreview(importRows, existing);
  printPreview(preview, importRows.length, existing.length);

  const report = {
    mode: "preview-only",
    dbApply: false,
    sourceFile: abs,
    existingSource: existingPath ? path.resolve(existingPath) : "DATABASE_URL(read-only)",
    importCount: importRows.length,
    existingCount: existing.length,
    summary: preview.summary,
    updates: preview.updates,
    unchanged: preview.unchanged,
    creates: preview.creates,
    needsReview: preview.needsReview,
    missingInImport: preview.missingInImport,
    lines: preview.lines,
    applyPayload: preview.applyPayload,
    touchesEmploymentStatus: preview.touchesEmploymentStatus,
  };

  const defaultOut = path.resolve(
    "roster-import-preview-report.json"
  );
  const dest = outPath ? path.resolve(outPath) : defaultOut;
  fs.writeFileSync(dest, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nreport written: ${dest}`);
  console.log("NOTE: DB apply was NOT executed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
