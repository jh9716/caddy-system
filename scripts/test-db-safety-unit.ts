/**
 * DB URL safety unit tests. No database connection.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  assertLocalDatabaseUrl,
  assertLocalFixtureDatabase,
  assertNotProductionDatabaseUrl,
  isLocalDatabaseUrl,
  isProductionDatabaseUrl,
} from "../src/lib/dbSafety";

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

function throws(fn: () => void, msg: string) {
  try {
    fn();
    assert(false, msg);
  } catch {
    assert(true, msg);
  }
}

const LOCAL = "postgresql://caddy:caddy@localhost:5432/caddy_local";
const NEON =
  "postgresql://neondb_owner@ep-example-pooler.ap-southeast-1.aws.neon.tech/neondb";

console.log("== isLocal / isProduction ==");
assert(isLocalDatabaseUrl(LOCAL) === true, "localhost is local");
assert(isLocalDatabaseUrl(NEON) === false, "neon is not local");
assert(isProductionDatabaseUrl(NEON) === true, "neon host is production");
assert(isProductionDatabaseUrl(LOCAL) === false, "localhost is not production");

process.env.PRODUCTION_DATABASE_URL = NEON;
assert(
  isProductionDatabaseUrl(NEON) === true,
  "exact PRODUCTION_DATABASE_URL match is production"
);
assert(
  isProductionDatabaseUrl(
    "postgresql://caddy:caddy@127.0.0.1:5432/caddy_local"
  ) === false,
  "127.0.0.1 is not production"
);

console.log("== assertLocalDatabaseUrl ==");
assert(assertLocalDatabaseUrl(LOCAL) === LOCAL, "local URL accepted");
throws(() => assertLocalDatabaseUrl(NEON), "neon URL rejected for local write");
throws(
  () => assertLocalDatabaseUrl("postgresql://user@db.example.com:5432/x"),
  "remote non-local rejected"
);
throws(() => assertLocalDatabaseUrl(undefined), "missing URL rejected");

console.log("== fixture / 2099 still blocked on production ==");
throws(
  () => assertLocalFixtureDatabase(NEON),
  "fixture abort on neon even for future-date seeds"
);
assert(assertLocalFixtureDatabase(LOCAL) === LOCAL, "fixture allows localhost");

console.log("== assertNotProductionDatabaseUrl ==");
assertNotProductionDatabaseUrl(LOCAL, "seed");
throws(
  () => assertNotProductionDatabaseUrl(NEON, "seed"),
  "seed helper aborts on neon"
);

console.log("== guard-prod-db.cjs aborts ad-hoc neon DATABASE_URL ==");
{
  const guard = path.resolve("scripts/guard-prod-db.cjs");
  const r = spawnSync(
    process.execPath,
    ["-r", guard, "-e", "console.log('should-not-run')"],
    {
      env: {
        ...process.env,
        DATABASE_URL: NEON,
        PRODUCTION_DATABASE_URL: NEON,
        NODE_ENV: "development",
        VERCEL: "",
        PROD_MAINTENANCE_CONFIRM: "",
      },
      encoding: "utf8",
    }
  );
  assert(r.status !== 0, "guard exits non-zero on neon");
  assert(
    String(r.stderr || r.stdout).includes("Production/Neon"),
    "guard error mentions Production/Neon"
  );
}
{
  const guard = path.resolve("scripts/guard-prod-db.cjs");
  const r = spawnSync(
    process.execPath,
    ["-r", guard, "-e", "console.log('ok-local')"],
    {
      env: {
        ...process.env,
        DATABASE_URL: LOCAL,
        NODE_ENV: "development",
        VERCEL: "",
        PROD_MAINTENANCE_CONFIRM: "",
      },
      encoding: "utf8",
    }
  );
  assert(r.status === 0, "guard allows localhost");
  assert(String(r.stdout).includes("ok-local"), "local process ran");
}

console.log("== readonly inspect allowlist includes push subscription ==");
{
  const guardSrc = fs.readFileSync(path.resolve("scripts/guard-prod-db.cjs"), "utf8");
  assert(
    guardSrc.includes("inspect-push-subscription-prod-readonly"),
    "guard allowlists push subscription inspect"
  );
  assert(
    guardSrc.includes("inspect-notice-v2-prod-readonly"),
    "guard allowlists notice v2 inspect"
  );
  assert(
    guardSrc.includes("inspect-board-push-freshness-prod-readonly"),
    "guard allowlists board push inspect"
  );
  assert(
    guardSrc.includes("inspect-course-report-photo-v1-prod-readonly"),
    "guard allowlists course report photo inspect"
  );
  const photoDeploy = fs.readFileSync(
    path.resolve("scripts/maintenance/deploy-course-report-photo-v1-migration.ts"),
    "utf8"
  );
  assert(
    photoDeploy.includes("COURSE_REPORT_PHOTO_V1_20260919"),
    "photo deploy uses exact confirm task-id"
  );
  assert(photoDeploy.includes('["migrate", "deploy"]'), "photo deploy uses migrate deploy");
  assert(!photoDeploy.includes('["migrate", "dev"]'), "photo deploy no migrate dev call");
  assert(!photoDeploy.includes('["migrate", "reset"]'), "photo deploy no migrate reset call");
  assert(!photoDeploy.includes('["db", "push"]'), "photo deploy no db push call");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
