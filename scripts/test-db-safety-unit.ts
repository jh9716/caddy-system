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

console.log("== create-admin.mjs requires password + prod confirm ==");
{
  const src = fs.readFileSync(path.resolve("scripts/create-admin.mjs"), "utf8");
  assert(!src.includes("011697"), "no legacy default password");
  assert(!src.includes("ADMIN_PASSWORD ||"), "no ADMIN_PASSWORD fallback");
  assert(src.includes("ADMIN_PASSWORD 가 필요합니다"), "missing password fails closed");
  assert(src.includes("PROD_MAINTENANCE_CONFIRM"), "reuses maintenance confirm");
  assert(src.includes("CREATE_ADMIN"), "exact CREATE_ADMIN task id");
  assert(!src.includes("ALLOW_PROD_DB=1"), "no ALLOW_PROD_DB=1 bypass");
  assert(
    src.includes("ALLOW_PROD_DB 같은 범용 스위치는 없습니다"),
    "documents no generic prod-db switch"
  );
  assert(src.includes("select: { id: true, username: true, role: true }"), "upsert does not return password");
  assert(!/console\.log\([^)]*plainPassword/.test(src), "does not log password var");
  assert(!/console\.log\([^)]*ADMIN_PASSWORD/.test(src), "does not log ADMIN_PASSWORD");
  assert(!/console\.log\([^)]*hashed/.test(src), "does not log hash");
  const script = path.resolve("scripts/create-admin.mjs");
  const noPw = spawnSync(process.execPath, [script], {
    env: {
      ...process.env,
      ADMIN_PASSWORD: "",
      DATABASE_URL: LOCAL,
      NODE_ENV: "development",
      VERCEL: "",
      NODE_OPTIONS: "",
      PROD_MAINTENANCE_CONFIRM: "",
    },
    encoding: "utf8",
  });
  assert(noPw.status !== 0, "no ADMIN_PASSWORD exits non-zero");
  assert(
    String(noPw.stderr || noPw.stdout).includes("ADMIN_PASSWORD"),
    "missing password error mentions ADMIN_PASSWORD"
  );
  assert(
    !String(noPw.stderr || noPw.stdout).includes("011697"),
    "missing password error does not print a default password"
  );
  const neon = spawnSync(process.execPath, [script], {
    env: {
      ...process.env,
      ADMIN_PASSWORD: "temporary-not-logged",
      ADMIN_USERNAME: "should_not_create",
      DATABASE_URL: NEON,
      PRODUCTION_DATABASE_URL: NEON,
      NODE_ENV: "development",
      VERCEL: "",
      NODE_OPTIONS: "",
      PROD_MAINTENANCE_CONFIRM: "",
      ALLOW_PROD_DB: "1",
    },
    encoding: "utf8",
  });
  assert(neon.status !== 0, "neon without confirm fail-closed");
  assert(
    String(neon.stderr || neon.stdout).includes("PROD_MAINTENANCE_CONFIRM=CREATE_ADMIN"),
    "neon error names exact confirm token"
  );
  assert(
    !String(neon.stderr || neon.stdout).includes("temporary-not-logged"),
    "prod-block error does not log password"
  );
  const wrongConfirm = spawnSync(process.execPath, [script], {
    env: {
      ...process.env,
      ADMIN_PASSWORD: "temporary-not-logged",
      DATABASE_URL: NEON,
      PRODUCTION_DATABASE_URL: NEON,
      NODE_ENV: "development",
      VERCEL: "",
      NODE_OPTIONS: "",
      PROD_MAINTENANCE_CONFIRM: "NOPE",
    },
    encoding: "utf8",
  });
  assert(wrongConfirm.status !== 0, "wrong confirm token fail-closed");
}

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
  assert(
    guardSrc.includes("inspect-comment-v1-prod-readonly"),
    "guard allowlists comment v1 inspect"
  );
  assert(
    guardSrc.includes("inspect-device-push-token-prod-readonly"),
    "guard allowlists device push token inspect"
  );
  assert(
    guardSrc.includes("inspect-marshal-penalty-p1p3-prod-readonly"),
    "guard allowlists marshal P1–P3 inspect"
  );
  assert(
    guardSrc.includes("deploy-marshal-penalty-p1p3-migration"),
    "guard knows marshal P1–P3 deploy script"
  );
  assert(
    guardSrc.includes("--sync-checksums"),
    "guard treats marshal checksum sync as a write"
  );
  const devicePushDeploy = fs.readFileSync(
    path.resolve("scripts/maintenance/deploy-device-push-token-migration.ts"),
    "utf8"
  );
  assert(
    devicePushDeploy.includes("PREPARE_DEVICE_PUSH_TOKEN_175_20260922"),
    "device push deploy uses exact confirm task-id"
  );
  assert(devicePushDeploy.includes('["migrate", "deploy"]'), "device push deploy uses migrate deploy");
  assert(!devicePushDeploy.includes('["migrate", "dev"]'), "device push deploy no migrate dev call");
  assert(!devicePushDeploy.includes('["migrate", "reset"]'), "device push deploy no migrate reset call");
  assert(!devicePushDeploy.includes('["db", "push"]'), "device push deploy no db push call");
  const devicePushMig = fs.readFileSync(
    path.resolve("prisma/migrations/20260921120000_device_push_token/migration.sql"),
    "utf8"
  );
  assert(devicePushMig.includes("CREATE TYPE \"DevicePushPlatform\""), "device push CREATE TYPE");
  assert(devicePushMig.includes("CREATE TABLE \"DevicePushToken\""), "device push CREATE TABLE");
  assert(
    devicePushMig.includes('CREATE UNIQUE INDEX "DevicePushToken_userId_token_key"'),
    "device push unique(userId, token)"
  );
  assert(
    !/\bDROP\s+(TABLE|COLUMN|INDEX|TYPE)\b/i.test(devicePushMig),
    "device push migration no DROP"
  );
  assert(!/(^|\n)\s*UPDATE\s+/i.test(devicePushMig), "device push migration no UPDATE");
  assert(!/(^|\n)\s*INSERT\s+/i.test(devicePushMig), "device push migration no INSERT");
  assert(!/(^|\n)\s*DELETE\s+FROM\b/i.test(devicePushMig), "device push migration no DELETE FROM");
  assert(
    !/\bALTER\s+TABLE\s+"PushSubscription"/i.test(devicePushMig),
    "device push no PushSubscription ALTER"
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
  const commentMig = fs.readFileSync(
    path.resolve("prisma/migrations/20260919070000_comment_v1/migration.sql"),
    "utf8"
  );
  assert(commentMig.includes("CREATE TYPE \"CommentTargetType\""), "comment migration CREATE TYPE");
  assert(commentMig.includes("CREATE TABLE \"CommentThread\""), "comment migration CommentThread");
  assert(commentMig.includes("CREATE TABLE \"Comment\""), "comment migration Comment");
  assert(!/\bDROP\s+(TABLE|COLUMN|INDEX|TYPE)\b/i.test(commentMig), "comment migration no DROP");
  assert(!/(^|\n)\s*UPDATE\s+/i.test(commentMig), "comment migration no UPDATE");
  assert(!/(^|\n)\s*DELETE\s+/i.test(commentMig), "comment migration no DELETE");
  const commentDeploy = fs.readFileSync(
    path.resolve("scripts/maintenance/deploy-comment-v1-migration.ts"),
    "utf8"
  );
  assert(
    commentDeploy.includes("COMMENT_V1_20260919"),
    "comment deploy uses exact confirm task-id"
  );
  assert(commentDeploy.includes('["migrate", "deploy"]'), "comment deploy uses migrate deploy");
  assert(!commentDeploy.includes('["migrate", "dev"]'), "comment deploy no migrate dev call");
  assert(!commentDeploy.includes('["migrate", "reset"]'), "comment deploy no migrate reset call");
  assert(!commentDeploy.includes('["db", "push"]'), "comment deploy no db push call");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
