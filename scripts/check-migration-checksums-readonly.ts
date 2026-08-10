/**
 * Read-only: compare local migration.sql sha256 vs Production _prisma_migrations.
 * Never writes. Never runs migrate.
 *
 *   DATABASE_URL=... npx tsx scripts/check-migration-checksums-readonly.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = path.resolve("prisma/migrations");

function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL required (read-only)");
    process.exit(2);
  }

  const dirs = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const local: Record<string, string> = {};
  for (const name of dirs) {
    const sql = path.join(ROOT, name, "migration.sql");
    if (fs.existsSync(sql)) local[name] = sha256File(sql);
  }

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ migration_name: string; checksum: string }>
    >(
      `SELECT migration_name, checksum FROM "_prisma_migrations" ORDER BY started_at`
    );

    const db = new Map(rows.map((r) => [r.migration_name, r.checksum]));
    const report = {
      mode: "read-only",
      localCount: Object.keys(local).length,
      dbCount: rows.length,
      matches: [] as string[],
      checksumMismatch: [] as Array<{
        name: string;
        local: string;
        db: string;
        note: string;
      }>,
      localOnly: [] as string[],
      dbOnly: [] as string[],
    };

    for (const [name, sum] of Object.entries(local)) {
      const dbSum = db.get(name);
      if (!dbSum) report.localOnly.push(name);
      else if (dbSum === sum) report.matches.push(name);
      else {
        report.checksumMismatch.push({
          name,
          local: sum,
          db: dbSum,
          note:
            name.startsWith("20260809101500") || name.startsWith("20260809220000")
              ? "Reconstructed from Production schema; sync DB checksum before migrate deploy"
              : "Unexpected checksum drift",
        });
      }
    }
    for (const name of db.keys()) {
      if (!(name in local)) report.dbOnly.push(name);
    }

    console.log(JSON.stringify(report, null, 2));
    // non-zero if unexpected mismatches (reconstructed ones are expected until sync)
    const unexpected = report.checksumMismatch.filter(
      (m) => !m.note.startsWith("Reconstructed")
    );
    if (unexpected.length || report.localOnly.length) process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
