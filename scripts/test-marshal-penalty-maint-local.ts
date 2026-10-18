/**
 * Marshal P1–P3 maintenance on throwaway local Postgres only.
 * Never uses PRODUCTION_DATABASE_URL. Drops the databases it creates.
 *
 *   npm run test:marshal-penalty-maint-local
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertLocalDatabaseUrl } from "../src/lib/dbSafety";
import { APPLIED_AFTER, PENDING_NAMES, TASK } from "./maintenance/marshalPenaltyMaint";

const ROOT = path.resolve(__dirname, "..");
const DUMP = "/tmp/marshal-rehearse/at53-seeded.dump";
const EMPTY_DUMP = "/tmp/marshal-rehearse/at53.dump";
const SCRIPT = path.join(ROOT, "scripts/maintenance/deploy-marshal-penalty-p1p3-migration.ts");
const TSX = resolveTsx();
const PG = {
  host: "127.0.0.1",
  user: "caddy",
  password: "caddy",
};

let passed = 0;
let failed = 0;
const created: string[] = [];

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}

function resolveTsx(): string {
  const candidates = [
    "/tmp/tsx-local/node_modules/.bin/tsx",
    path.join(os.tmpdir(), "tsx-local/node_modules/.bin/tsx"),
    path.join(ROOT, "node_modules/.bin/tsx"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("tsx binary missing");
}

function localUrl(db: string): string {
  return `postgresql://${PG.user}:${PG.password}@${PG.host}:5432/${db}`;
}

function psql(db: string, sql: string): string {
  return execFileSync(
    "psql",
    ["-h", PG.host, "-U", PG.user, "-d", db, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql],
    {
      encoding: "utf8",
      env: { ...process.env, PGPASSWORD: PG.password, DATABASE_URL: "", PRODUCTION_DATABASE_URL: "" },
    }
  ).trim();
}

function dropDb(name: string) {
  execFileSync(
    "psql",
    [
      "-h",
      PG.host,
      "-U",
      PG.user,
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `DROP DATABASE IF EXISTS ${name};`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PGPASSWORD: PG.password, DATABASE_URL: "", PRODUCTION_DATABASE_URL: "" },
    }
  );
}

function createDb(name: string, dump: string) {
  if (!/^caddy_maint_[a-z0-9_]+$/.test(name)) {
    throw new Error(`refusing database name ${name}`);
  }
  dropDb(name);
  execFileSync(
    "psql",
    [
      "-h",
      PG.host,
      "-U",
      PG.user,
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `CREATE DATABASE ${name} OWNER ${PG.user};`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PGPASSWORD: PG.password, DATABASE_URL: "", PRODUCTION_DATABASE_URL: "" },
    }
  );
  created.push(name);
  execFileSync("pg_restore", ["--no-owner", "--no-acl", "-h", PG.host, "-U", PG.user, "-d", name, dump], {
    encoding: "utf8",
    env: { ...process.env, PGPASSWORD: PG.password, DATABASE_URL: "", PRODUCTION_DATABASE_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runMaint(
  db: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): { status: number | null; out: string } {
  const url = localUrl(db);
  assertLocalDatabaseUrl(url, "throwaway local only");
  const r = spawnSync(TSX, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: url,
      PRODUCTION_DATABASE_URL: "",
      NODE_OPTIONS: "",
      VERCEL: "",
      ALLOW_PROD_DB: "",
      MARSHAL_MAINT_PRISMA_BIN: "",
      ...extraEnv,
    },
  });
  return { status: r.status, out: `${r.stdout || ""}\n${r.stderr || ""}` };
}

function jsonFrom(out: string): Record<string, unknown> {
  const start = out.lastIndexOf("\n{") >= 0 ? out.lastIndexOf("\n{") + 1 : out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON in output");
  return JSON.parse(out.slice(start, end + 1)) as Record<string, unknown>;
}

try {
  if (!fs.existsSync(DUMP) || !fs.existsSync(EMPTY_DUMP)) {
    throw new Error("local 53-migration dumps missing under /tmp/marshal-rehearse");
  }
  assertLocalDatabaseUrl(localUrl("caddy_maint_probe"), "probe");

  console.log("== inspect default on 53-mig seeded throwaway ==");
  createDb("caddy_maint_seed53", DUMP);
  {
    const r = runMaint("caddy_maint_seed53", [], {
      PROD_MAINTENANCE_CONFIRM: "",
      MARSHAL_WRITE_FREEZE_CONFIRM: "",
    });
    assert(r.status === 0, "inspect exits 0 on expected 53+7 local fixture");
    const j = jsonFrom(r.out);
    assert(j.ok === true, "inspect ok");
    assert(j.mode === "inspect", "mode inspect");
    assert(j.wrote === false, "inspect wrote=false");
    assert(j.applied === 53, "applied 53");
    assert(Array.isArray(j.pending) && (j.pending as string[]).length === 7, "pending 7");
    assert(j.isProd === false, "not production");
    assert(!/postgresql:\/\/[^\s]+:[^@\s]+@/.test(r.out), "connection string/password not printed");
  }

  console.log("== apply without freeze refused ==");
  {
    const r = runMaint("caddy_maint_seed53", ["--apply"], {
      PROD_MAINTENANCE_CONFIRM: TASK.applyLocal,
      MARSHAL_WRITE_FREEZE_CONFIRM: "",
    });
    assert(r.status !== 0, "apply without freeze exits non-zero");
    assert(r.out.includes("MARSHAL_WRITE_FREEZE_CONFIRM=HELD"), "freeze required");
    assert(psql("caddy_maint_seed53", "SELECT COUNT(*) FROM _prisma_migrations;") === "53", "still 53");
  }

  console.log("== unfinished migration refused ==");
  createDb("caddy_maint_unfin", EMPTY_DUMP);
  psql(
    "caddy_maint_unfin",
    `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
     VALUES ('maint-unfinished', '0', NULL, '${PENDING_NAMES[0]}', NULL, NULL, NOW(), 0);`
  );
  {
    const r = runMaint("caddy_maint_unfin", ["--apply"], {
      PROD_MAINTENANCE_CONFIRM: TASK.applyLocal,
      MARSHAL_WRITE_FREEZE_CONFIRM: TASK.freeze,
      MARSHAL_MAINT_EXPECT_ACTIVE: "0",
    });
    assert(r.status !== 0, "unfinished apply refused");
    assert(/unfinished/i.test(r.out), "mentions unfinished");
    assert(!/migrate resolve/.test(r.out), "did not resolve");
    const unfinished = psql(
      "caddy_maint_unfin",
      `SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NULL;`
    );
    assert(unfinished === "1", "unfinished row left untouched");
  }

  console.log("== unexpected checksum refused ==");
  {
    psql(
      "caddy_maint_seed53",
      `UPDATE "_prisma_migrations"
       SET checksum = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
       WHERE migration_name = '20261013120000_marshal_month_rotation_p2';`
    );
    const r = runMaint("caddy_maint_seed53", ["--inspect"], {
      PROD_MAINTENANCE_CONFIRM: "",
    });
    assert(r.status !== 0, "unexpected checksum inspect exits non-zero");
    assert(r.out.includes("20261013120000_marshal_month_rotation_p2"), "names drifted migration");
    const apply = runMaint("caddy_maint_seed53", ["--apply"], {
      PROD_MAINTENANCE_CONFIRM: TASK.applyLocal,
      MARSHAL_WRITE_FREEZE_CONFIRM: TASK.freeze,
    });
    assert(apply.status !== 0, "unexpected checksum apply refused");
    assert(psql("caddy_maint_seed53", "SELECT COUNT(*) FROM _prisma_migrations;") === "53", "checksum refuse did not migrate");
  }

  console.log("== happy local migrate deploy 53 → 60 ==");
  createDb("caddy_maint_happy", DUMP);
  {
    const beforeCaddies = psql("caddy_maint_happy", `SELECT COUNT(*) FROM "Caddy";`);
    const r = runMaint("caddy_maint_happy", ["--apply"], {
      PROD_MAINTENANCE_CONFIRM: TASK.applyLocal,
      MARSHAL_WRITE_FREEZE_CONFIRM: TASK.freeze,
    });
    assert(r.status === 0, "happy apply exits 0");
    const j = jsonFrom(r.out);
    assert(j.ok === true, "happy apply ok");
    assert(j.applyMode === "deployed", "deployed");
    assert(j.applied === APPLIED_AFTER, "applied 60");
    assert(j.identityUnchanged === true, "identity unchanged");
    assert(psql("caddy_maint_happy", "SELECT COUNT(*) FROM _prisma_migrations;") === "60", "db has 60 migrations");
    assert(
      psql(
        "caddy_maint_happy",
        `SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'marshal_penalty_fill_coverage' AND NOT tgisinternal;`
      ) === "1",
      "coverage trigger exists"
    );
    assert(
      psql(
        "caddy_maint_happy",
        `SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name = 'MarshalPenaltyDuty' AND column_name = 'coverage'
           AND is_nullable = 'NO' AND column_default IS NULL;`
      ) === "1",
      "coverage NOT NULL no default"
    );
    assert(
      psql(
        "caddy_maint_happy",
        `SELECT COUNT(*) FROM information_schema.tables
         WHERE table_name = 'MarshalPenaltyOccurrence';`
      ) === "1",
      "MarshalPenaltyOccurrence exists"
    );
    assert(
      psql(
        "caddy_maint_happy",
        `SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name = 'MarshalMonthPlan' AND column_name = 'needsRegeneration';`
      ) === "1",
      "needsRegeneration exists"
    );
    assert(
      psql(
        "caddy_maint_happy",
        `SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name = 'MarshalPenaltyOccurrence' AND column_name IN ('pinnedOn','autoHeldOn');`
      ) === "2",
      "pinnedOn and autoHeldOn exist"
    );
    assert(
      psql(
        "caddy_maint_happy",
        `SELECT COUNT(*) FROM pg_indexes
         WHERE indexname = 'MarshalMonthSlot_planId_date_shift_caddyId_key';`
      ) === "1",
      "slot shift+caddy UNIQUE exists"
    );
    assert(
      psql(
        "caddy_maint_happy",
        `SELECT COUNT(*) FROM pg_indexes
         WHERE indexname = 'MarshalMonthSlot_planId_date_caddyId_key';`
      ) === "0",
      "old slot caddy UNIQUE dropped"
    );
    assert(psql("caddy_maint_happy", `SELECT COUNT(*) FROM "Caddy";`) === beforeCaddies, "caddy count unchanged");
  }

  console.log("== already-applied is a no-op ==");
  {
    const r = runMaint("caddy_maint_happy", ["--apply"], {
      PROD_MAINTENANCE_CONFIRM: TASK.applyLocal,
      MARSHAL_WRITE_FREEZE_CONFIRM: TASK.freeze,
    });
    assert(r.status === 0, "already-applied exits 0");
    const j = jsonFrom(r.out);
    assert(j.applyMode === "already-applied", "already-applied mode");
    assert(j.wrote === false, "already-applied did not write");
  }

  console.log("== failure aborts without resolve ==");
  createDb("caddy_maint_fail", DUMP);
  const p1Path = path.join(
    ROOT,
    "prisma/migrations",
    PENDING_NAMES[0],
    "migration.sql"
  );
  const originalSql = fs.readFileSync(p1Path, "utf8");
  try {
    fs.writeFileSync(
      p1Path,
      "-- intentional local failure fixture\nSELECT 1 FROM marshal_maint_missing_relation;\n"
    );
    const r = runMaint("caddy_maint_fail", ["--apply"], {
      PROD_MAINTENANCE_CONFIRM: TASK.applyLocal,
      MARSHAL_WRITE_FREEZE_CONFIRM: TASK.freeze,
    });
    assert(r.status !== 0, "injected failure exits non-zero");
    assert(/P3018|P3009|migrate deploy failed|HOLD/i.test(r.out), "failure classified as HOLD");
    assert(!/migrate resolve/.test(r.out), "no migrate resolve on failure");
    const applied = Number(psql("caddy_maint_fail", "SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;"));
    assert(applied === 53, `finished migrations stay 53 (got ${applied})`);
  } finally {
    fs.writeFileSync(p1Path, originalSql);
  }
  assert(fs.readFileSync(p1Path, "utf8") === originalSql, "P1 SQL restored after failure test");
} catch (e) {
  failed++;
  console.error("  ✗ fatal", e instanceof Error ? e.message : e);
} finally {
  for (const name of created) {
    try {
      dropDb(name);
    } catch (e) {
      console.error("cleanup failed", name, e instanceof Error ? e.message : e);
    }
  }
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
