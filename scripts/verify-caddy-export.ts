/**
 * Export XLSX 읽기 전용 검증 (DB 조회 + 버퍼 생성, 쓰기 없음)
 * 사용: npx tsx scripts/verify-caddy-export.ts
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import {
  buildRosterExportBuffer,
  EXPORT_HEADERS,
  readExportHeaders,
} from "../lib/caddyExport";

const prisma = new PrismaClient();

async function main() {
  const caddies = await prisma.caddy.findMany({
    orderBy: [{ team: "asc" }, { teamOrder: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      team: true,
      teamOrder: true,
      caddyType: true,
      employeeCode: true,
      employmentStatus: true,
    },
  });

  const buffer = buildRosterExportBuffer(caddies);
  const headers = readExportHeaders(buffer);
  const expected = [...EXPORT_HEADERS];

  const checks = {
    caddyCount: caddies.length,
    bufferBytes: buffer.length,
    headersMatch: JSON.stringify(headers) === JSON.stringify(expected),
    expectedHeaders: expected,
    actualHeaders: headers,
    sampleIds: caddies.slice(0, 3).map((c) => c.id),
    allHaveId: caddies.every((c) => c.id > 0),
  };

  console.log("=== EXPORT VERIFICATION (read-only) ===");
  console.log(JSON.stringify(checks, null, 2));

  if (!checks.headersMatch) {
    throw new Error("Export headers do not match expected column order");
  }
  if (!checks.allHaveId) {
    throw new Error("Some caddies missing id");
  }
  if (checks.bufferBytes < 100) {
    throw new Error("Export buffer suspiciously small");
  }

  console.log("\nExport ready: id included, column order OK");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
