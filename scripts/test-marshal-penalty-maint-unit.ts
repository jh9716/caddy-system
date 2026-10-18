/**
 * Marshal P1–P3 maintenance tool: gates, SQL audit, refusals.
 * Does not connect to production. Does not run migrate deploy.
 *
 *   npm run test:marshal-penalty-maint-unit
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APPLIED_AFTER,
  APPLIED_BEFORE,
  EXPECTED_ENGINES_HASH,
  EXPECTED_PROD_HOST,
  P4_HEAD_SHA,
  PENDING_NAMES,
  TASK,
  assertAllowedPrismaArgs,
  assertWriteConfirm,
  auditPendingSql,
  parseMaintMode,
  parsePrismaVersion,
  prismaSeriesOk,
} from "./maintenance/marshalPenaltyMaint";

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

function throws(fn: () => void, needle: string, msg: string) {
  try {
    fn();
    assert(false, msg);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    assert(text.includes(needle), `${msg} (${needle})`);
  }
}

const LOCAL = "postgresql://caddy:caddy@127.0.0.1:5432/caddy_local";
const NEON_WRONG =
  "postgresql://neondb_owner@ep-example-pooler.ap-southeast-1.aws.neon.tech/neondb";
const NEON_EXPECTED = `postgresql://neondb_owner@${EXPECTED_PROD_HOST}/neondb`;
const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(
  path.join(ROOT, "scripts/maintenance/marshalPenaltyMaint.ts"),
  "utf8"
);
const CLI = fs.readFileSync(
  path.join(ROOT, "scripts/maintenance/deploy-marshal-penalty-p1p3-migration.ts"),
  "utf8"
);
const INSPECT = fs.readFileSync(
  path.join(ROOT, "scripts/inspect-marshal-penalty-p1p3-prod-readonly.ts"),
  "utf8"
);
const GUARD = fs.readFileSync(path.join(ROOT, "scripts/guard-prod-db.cjs"), "utf8");

console.log("== mode parsing ==");
assert(parseMaintMode([]) === "inspect", "default mode is inspect");
assert(parseMaintMode(["--inspect"]) === "inspect", "--inspect");
assert(parseMaintMode(["--apply"]) === "apply", "--apply");
assert(parseMaintMode(["--sync-checksums"]) === "sync-checksums", "--sync-checksums");
throws(
  () => parseMaintMode(["--apply", "--inspect"]),
  "mutually exclusive",
  "apply+inspect rejected"
);

console.log("== SQL audit / constants ==");
auditPendingSql();
assert(PENDING_NAMES.length === 7, "exactly 7 pending names");
assert(APPLIED_BEFORE === 53 && APPLIED_AFTER === 60, "53 → 60");
assert(P4_HEAD_SHA === "5eb43469ccf9a241a5b69b6d84abd75e563b609d", "P4 ancestor SHA");

console.log("== prisma version parse ==");
{
  const sample = [
    "prisma                  : 5.22.0",
    "@prisma/client          : 5.22.0",
    "Default Engines Hash    : 605197351a3c8bdd595af2d2a9bc3025bca48ea2",
  ].join("\n");
  const v = parsePrismaVersion(sample);
  assert(v.cli === "5.22.0", "cli 5.22.0");
  assert(v.client === "5.22.0", "client 5.22.0");
  assert(v.enginesHash === EXPECTED_ENGINES_HASH, "engines hash");
  assert(prismaSeriesOk("5.22.0") === true, "5.22.x ok");
  assert(prismaSeriesOk("5.21.1") === false, "5.21 rejected");
  assert(prismaSeriesOk("6.0.0") === false, "6.x rejected");
}

console.log("== prisma argv allowlist ==");
assertAllowedPrismaArgs(["--version"], false);
assertAllowedPrismaArgs(["migrate", "status"], false);
assertAllowedPrismaArgs(["migrate", "deploy"], true);
throws(
  () => assertAllowedPrismaArgs(["migrate", "deploy"], false),
  "refuses prisma migrate deploy",
  "inspect refuses deploy"
);
throws(
  () => assertAllowedPrismaArgs(["migrate", "resolve", "--rolled-back", "x"], true),
  "refusing prisma",
  "migrate resolve refused"
);
throws(
  () => assertAllowedPrismaArgs(["db", "execute", "--file", "x.sql"], true),
  "refusing prisma",
  "db execute refused"
);
throws(
  () => assertAllowedPrismaArgs(["migrate", "deploy", "--schema", "x"], true),
  "no extra flags",
  "deploy extra flags refused"
);

console.log("== confirm tokens ==");
throws(
  () =>
    assertWriteConfirm("apply", true, { PROD_MAINTENANCE_CONFIRM: "" } as NodeJS.ProcessEnv, NEON_EXPECTED),
  TASK.applyProd,
  "prod apply without token"
);
throws(
  () =>
    assertWriteConfirm(
      "apply",
      true,
      { PROD_MAINTENANCE_CONFIRM: TASK.applyLocal } as NodeJS.ProcessEnv,
      NEON_EXPECTED
    ),
  TASK.applyProd,
  "local token refused on production apply"
);
throws(
  () =>
    assertWriteConfirm(
      "sync-checksums",
      true,
      { PROD_MAINTENANCE_CONFIRM: TASK.applyProd } as NodeJS.ProcessEnv,
      NEON_EXPECTED
    ),
  TASK.checksumProd,
  "migrate token cannot checksum-sync"
);
throws(
  () =>
    assertWriteConfirm(
      "apply",
      false,
      { PROD_MAINTENANCE_CONFIRM: TASK.applyProd } as NodeJS.ProcessEnv,
      LOCAL
    ),
  TASK.applyLocal,
  "prod token refused on local apply"
);
throws(
  () =>
    assertWriteConfirm(
      "apply",
      true,
      { PROD_MAINTENANCE_CONFIRM: TASK.applyProd, ALLOW_PROD_DB: "1" } as NodeJS.ProcessEnv,
      NEON_EXPECTED
    ),
  "ALLOW_PROD_DB",
  "ALLOW_PROD_DB is not a bypass"
);
assertWriteConfirm(
  "apply",
  true,
  { PROD_MAINTENANCE_CONFIRM: TASK.applyProd } as NodeJS.ProcessEnv,
  NEON_EXPECTED
);
assert(true, "prod apply confirm accepted without connecting");

console.log("== source: no silent production write path ==");
assert(!SRC.includes("ALLOW_PROD_DB=1"), "no ALLOW_PROD_DB=1");
assert(!SRC.includes('["migrate", "resolve"]'), "does not call migrate resolve");
assert(!SRC.includes('["db", "execute"]'), "does not call db execute");
assert(!/spawnSync\(\s*["']psql["']/.test(SRC), "does not spawn psql");
assert(SRC.includes('["migrate", "deploy"]') || SRC.includes('"migrate", "deploy"'), "uses migrate deploy");
assert(SRC.includes("node_modules"), "uses local prisma binary");
assert(!CLI.includes("npx"), "CLI does not call npx prisma");
assert(INSPECT.includes('--inspect"') || INSPECT.includes('["--inspect"]'), "readonly wrapper forces inspect");
assert(INSPECT.includes("refuses apply/sync"), "readonly wrapper rejects apply");
assert(GUARD.includes("inspect-marshal-penalty-p1p3-prod-readonly"), "guard allowlists inspect wrapper");
assert(GUARD.includes("deploy-marshal-penalty-p1p3-migration"), "guard knows deploy script");
assert(GUARD.includes("--sync-checksums"), "guard treats sync as write");

console.log("== spawn refusals (no production connect) ==");
{
  const tsx = resolveTsx();
  const script = path.join(ROOT, "scripts/maintenance/deploy-marshal-penalty-p1p3-migration.ts");
  const baseEnv = {
    ...process.env,
    NODE_OPTIONS: "",
    VERCEL: "",
    PRODUCTION_DATABASE_URL: "",
    ALLOW_PROD_DB: "",
    MARSHAL_WRITE_FREEZE_CONFIRM: "",
    NEON_PITR_WINDOW_CONFIRMED: "",
  };

  const noToken = spawnSync(tsx, [script, "--apply"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...baseEnv,
      DATABASE_URL: "postgresql://caddy:caddy@127.0.0.1:5432/caddy_maint_throwaway",
      PROD_MAINTENANCE_CONFIRM: "",
    },
  });
  assert(noToken.status !== 0, "apply without token exits non-zero");
  assert(
    String(noToken.stderr || noToken.stdout).includes(TASK.applyLocal),
    "apply without token names local confirm id"
  );

  const wrongDb = spawnSync(tsx, [script, "--apply"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...baseEnv,
      DATABASE_URL: NEON_WRONG,
      PROD_MAINTENANCE_CONFIRM: TASK.applyProd,
    },
  });
  assert(wrongDb.status !== 0, "wrong neon host refused");
  assert(
    String(wrongDb.stderr || wrongDb.stdout).includes("unexpected production host"),
    "wrong host error does not require a connection"
  );
  assert(
    !String(wrongDb.stderr || wrongDb.stdout).includes("neondb_owner"),
    "does not print DB user"
  );

  const sharedLocal = spawnSync(tsx, [script, "--apply"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...baseEnv,
      DATABASE_URL: LOCAL,
      PROD_MAINTENANCE_CONFIRM: TASK.applyLocal,
    },
  });
  assert(sharedLocal.status !== 0, "apply refuses shared caddy_local");

  const fakePrismaDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-prisma-"));
  const fakeBin = path.join(fakePrismaDir, "prisma");
  fs.writeFileSync(
    fakeBin,
    `#!/bin/sh
echo "prisma                  : 4.16.2"
echo "@prisma/client          : 4.16.2"
echo "Default Engines Hash    : deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
`
  );
  fs.chmodSync(fakeBin, 0o755);
  const badVer = spawnSync(tsx, [script, "--apply"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...baseEnv,
      DATABASE_URL: "postgresql://caddy:caddy@127.0.0.1:5432/caddy_maint_throwaway",
      PROD_MAINTENANCE_CONFIRM: TASK.applyLocal,
      MARSHAL_MAINT_PRISMA_BIN: fakeBin,
    },
  });
  assert(badVer.status !== 0, "wrong Prisma version refused");
  assert(
    String(badVer.stderr || badVer.stdout).includes("5.22"),
    "version error mentions 5.22"
  );
}

console.log("== guard: inspect argv allowed, apply argv blocked ==");
{
  const guard = path.join(ROOT, "scripts/guard-prod-db.cjs");
  const inspectArgv = spawnSync(
    process.execPath,
    ["-r", guard, "-e", "console.log('inspect-ok')", "scripts/maintenance/deploy-marshal-penalty-p1p3-migration.ts"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: NEON_WRONG,
        PRODUCTION_DATABASE_URL: NEON_WRONG,
        VERCEL: "",
        PROD_MAINTENANCE_CONFIRM: "",
      },
    }
  );
  assert(inspectArgv.status === 0, "guard allows deploy script without --apply");
  assert(String(inspectArgv.stdout).includes("inspect-ok"), "inspect-ok printed");

  const applyArgv = spawnSync(
    process.execPath,
    [
      "-r",
      guard,
      "-e",
      "console.log('should-not-run')",
      "scripts/maintenance/deploy-marshal-penalty-p1p3-migration.ts",
      "--apply",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: NEON_WRONG,
        PRODUCTION_DATABASE_URL: NEON_WRONG,
        VERCEL: "",
        PROD_MAINTENANCE_CONFIRM: "",
      },
    }
  );
  assert(applyArgv.status !== 0, "guard blocks --apply without confirm");
  assert(!String(applyArgv.stdout).includes("should-not-run"), "--apply did not continue");
}

function resolveTsx(): string {
  const candidates = [
    path.join(os.tmpdir(), "tsx-local/node_modules/.bin/tsx"),
    "/tmp/tsx-local/node_modules/.bin/tsx",
    path.join(ROOT, "node_modules/.bin/tsx"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("tsx binary missing for unit spawn tests");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
