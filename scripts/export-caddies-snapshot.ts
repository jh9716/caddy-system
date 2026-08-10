/**
 * 기존 캐디 스냅샷 읽기 전용 export (DB 쓰기 없음)
 *
 *   DATABASE_URL=... npx tsx scripts/export-caddies-snapshot.ts [out.json]
 *
 * preview:roster 의 --existing 입력으로 사용합니다.
 */

import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL 이 필요합니다 (읽기 전용).");
    process.exit(1);
  }

  const out = path.resolve(process.argv[2] || "existing-caddies.json");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.caddy.findMany({
      select: { id: true, name: true, team: true, status: true },
      orderBy: { id: "asc" },
    });
    fs.writeFileSync(out, JSON.stringify(rows, null, 2), "utf8");
    console.log(`exported ${rows.length} caddies -> ${out}`);
    console.log("read-only: no DB writes performed");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
