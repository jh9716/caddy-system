/**
 * Production team-affiliation migrate helpers. No database connection.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  EXPECTED_HOST,
  EXPECTED_INDEXES,
  MIGRATION_NAME,
  PITR_CONFIRM,
  SQL_REL,
  TASK_ID,
  assertEmptyAffiliationRows,
  assertPitrConfirmed,
  assertProductionEndpoint,
  assertTeamAffiliationSchema,
  auditTeamAffiliationMigrationSql,
  listsEqual,
  localMigrationChecksum,
} from "./maintenance/teamAffiliationProd";

const requireCjs = createRequire(__filename);
const { gateSingleMigration } = requireCjs("./maintenance/single-migration-gate.cjs") as {
  gateSingleMigration: (input: {
    target: string;
    repo: string[];
    appliedFinished: string[];
    failedNames: string[];
    statusPending: string[];
  }) => { action: string; reason: string; pendingFromRepo: string[] };
};

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

const ROOT = path.resolve(__dirname, "..");
const sql = fs.readFileSync(path.join(ROOT, SQL_REL), "utf8");

console.log("== migration.sql additive ==");
auditTeamAffiliationMigrationSql(sql);
assert(true, "real migration.sql passes audit");
throws(() => auditTeamAffiliationMigrationSql("INSERT INTO \"Caddy\" VALUES (1)"), "rejects INSERT");
throws(() => auditTeamAffiliationMigrationSql("UPDATE \"Caddy\" SET team='9조'"), "rejects Caddy UPDATE");
throws(() => auditTeamAffiliationMigrationSql("DROP TABLE \"Caddy\""), "rejects DROP");
throws(
  () => auditTeamAffiliationMigrationSql('ALTER TABLE "Caddy" ADD COLUMN "x" INT'),
  "rejects ALTER Caddy"
);
throws(
  () => auditTeamAffiliationMigrationSql("CREATE TABLE \"TeamAffiliationVersion\" (id int)"),
  "rejects incomplete SQL without Item table"
);

console.log("== production endpoint ==");
const good = `postgresql://u:p@${EXPECTED_HOST}/${"neondb"}?sslmode=require`;
assert(assertProductionEndpoint(good).ok === true, "production host+neondb accepted");
assert(
  assertProductionEndpoint(
    "postgresql://u:p@ep-odd-voice-aokrqp5t.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require"
  ).ok === false,
  "Preview host rejected"
);
assert(
  assertProductionEndpoint(
    `postgresql://u:p@${EXPECTED_HOST.replace("ep-crimson-cell-a1i1tpce", "ep-crimson-cell-a1i1tpce-pooler")}/neondb?sslmode=require`
  ).ok === false,
  "pooler rejected"
);
assert(
  assertProductionEndpoint(`postgresql://u:p@${EXPECTED_HOST}/postgres?sslmode=require`).ok === false,
  "non-neondb rejected"
);
assert(
  assertProductionEndpoint(
    "postgresql://u:p@ep-crimson-cell-a1i1tpce.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&options=endpoint%3Dep-odd-voice-aokrqp5t"
  ).ok === false,
  "preview marker in options rejected"
);

console.log("== PITR confirm ==");
throws(() => assertPitrConfirmed({} as NodeJS.ProcessEnv), "missing PITR flag HOLD");
throws(
  () => assertPitrConfirmed({ NEON_PITR_WINDOW_CONFIRMED: "1" } as NodeJS.ProcessEnv),
  "wrong PITR flag HOLD"
);
assertPitrConfirmed({ NEON_PITR_WINDOW_CONFIRMED: PITR_CONFIRM } as NodeJS.ProcessEnv);
assert(true, "NEON_PITR_WINDOW_CONFIRMED=YES accepted");

console.log("== gateSingleMigration reuse ==");
const repo = ["20261109193000_comment_replies_v1", MIGRATION_NAME];
assert(
  gateSingleMigration({
    target: MIGRATION_NAME,
    repo,
    appliedFinished: ["20261109193000_comment_replies_v1"],
    failedNames: [],
    statusPending: [MIGRATION_NAME],
  }).action === "deploy",
  "only target pending → deploy"
);
assert(
  gateSingleMigration({
    target: MIGRATION_NAME,
    repo: [...repo, "20261118000000_other"],
    appliedFinished: ["20261109193000_comment_replies_v1"],
    failedNames: [],
    statusPending: [MIGRATION_NAME, "20261118000000_other"],
  }).action === "hold",
  "extra pending → hold"
);
assert(
  gateSingleMigration({
    target: MIGRATION_NAME,
    repo,
    appliedFinished: ["20261109193000_comment_replies_v1"],
    failedNames: ["20260809101500_broken"],
    statusPending: [MIGRATION_NAME],
  }).action === "hold",
  "failed → hold"
);
assert(
  gateSingleMigration({
    target: MIGRATION_NAME,
    repo,
    appliedFinished: ["20261109193000_comment_replies_v1", "20269999999999_unknown"],
    failedNames: [],
    statusPending: [MIGRATION_NAME],
  }).action === "hold",
  "unknown applied → hold"
);
assert(
  gateSingleMigration({
    target: MIGRATION_NAME,
    repo,
    appliedFinished: repo,
    failedNames: [],
    statusPending: [],
  }).action === "already-applied",
  "already applied → already-applied"
);
assert(listsEqual(["a"], ["a"]) && !listsEqual(["a"], ["b"]), "listsEqual");

console.log("== schema probe ==");
const full = {
  versionTable: true,
  itemTable: true,
  indexes: [...EXPECTED_INDEXES],
  fk: { name: "TeamAffiliationItem_versionId_fkey", deleteRule: "CASCADE" },
  versionRows: 0,
  itemRows: 0,
};
assertTeamAffiliationSchema(full);
assertEmptyAffiliationRows(full);
throws(
  () => assertTeamAffiliationSchema({ ...full, versionTable: false }),
  "missing version table HOLD"
);
throws(() => assertEmptyAffiliationRows({ ...full, versionRows: 1 }), "non-empty version HOLD");

console.log("== checksum of local SQL ==");
const sum = localMigrationChecksum(MIGRATION_NAME);
assert(/^[a-f0-9]{64}$/.test(sum), "local sha256 is 64 hex chars");
assert(sum === localMigrationChecksum(MIGRATION_NAME), "checksum stable across reads");

console.log("== deploy script fail-closed without confirm ==");
{
  const prodUrl = `postgresql://u:p@${EXPECTED_HOST}/neondb?sslmode=require`;
  const blocked = spawnSync("bash", ["scripts/tsx-safe.sh", "scripts/maintenance/deploy-team-affiliation-migration.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: prodUrl,
      PROD_MAINTENANCE_CONFIRM: "",
      NEON_PITR_WINDOW_CONFIRMED: PITR_CONFIRM,
      NODE_OPTIONS: "",
    },
    encoding: "utf8",
  });
  assert(blocked.status !== 0, "deploy without confirm exits non-zero");
  assert(
    String(blocked.stderr || blocked.stdout).includes("PROD_MAINTENANCE_CONFIRM"),
    "guard names PROD_MAINTENANCE_CONFIRM when URL is production"
  );
  const wrong = spawnSync("bash", ["scripts/tsx-safe.sh", "scripts/maintenance/deploy-team-affiliation-migration.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: prodUrl,
      PROD_MAINTENANCE_CONFIRM: "NOPE",
      NEON_PITR_WINDOW_CONFIRMED: PITR_CONFIRM,
      NODE_OPTIONS: "",
    },
    encoding: "utf8",
  });
  assert(wrong.status !== 0, "deploy with wrong confirm exits non-zero");
  assert(
    String(wrong.stderr || wrong.stdout).includes(`PROD_MAINTENANCE_CONFIRM=${TASK_ID}`),
    "error names exact confirm token"
  );
  const noPitr = spawnSync("bash", ["scripts/tsx-safe.sh", "scripts/maintenance/deploy-team-affiliation-migration.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: prodUrl,
      PROD_MAINTENANCE_CONFIRM: TASK_ID,
      NEON_PITR_WINDOW_CONFIRMED: "",
      NODE_OPTIONS: "",
    },
    encoding: "utf8",
  });
  assert(noPitr.status !== 0, "deploy without PITR confirm exits non-zero");
  assert(
    String(noPitr.stderr || noPitr.stdout).includes("NEON_PITR_WINDOW_CONFIRMED=YES"),
    "error names PITR confirm flag"
  );
}

console.log("== inspect refuses write flags ==");
{
  const r = spawnSync("bash", ["scripts/tsx-safe.sh", "scripts/inspect-team-affiliation-prod-readonly.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PRODUCTION_DATABASE_URL: `postgresql://u:p@${EXPECTED_HOST}/neondb?sslmode=require`,
      PROD_MAINTENANCE_CONFIRM: TASK_ID,
      NODE_OPTIONS: "",
    },
    encoding: "utf8",
  });
  assert(r.status !== 0, "inspect with confirm flag exits non-zero");
  assert(
    String(r.stderr || r.stdout).includes("write/migrate flags are not allowed"),
    "inspect refuses write flags before DB"
  );
}

console.log("== static source ==");
{
  const deploy = fs.readFileSync(path.join(ROOT, "scripts/maintenance/deploy-team-affiliation-migration.ts"), "utf8");
  assert(deploy.includes(TASK_ID), "deploy uses exact confirm task-id");
  assert(deploy.includes("gateSingleMigration"), "deploy reuses gateSingleMigration");
  assert(deploy.includes('["migrate", "status"]'), "deploy inspects migrate status first");
  assert(deploy.includes('["migrate", "deploy"]'), "deploy uses migrate deploy");
  assert(
    deploy.indexOf('["migrate", "status"]') < deploy.indexOf('["migrate", "deploy"]'),
    "status before deploy"
  );
  assert((deploy.match(/gateSingleMigration\(/g) || []).length >= 2, "gate re-read immediately before deploy");
  assert(deploy.includes("NEON_PITR_WINDOW_CONFIRMED"), "deploy requires PITR confirm");
  assert(!deploy.includes('["migrate", "dev"]'), "no migrate dev");
  assert(!deploy.includes('["migrate", "reset"]'), "no migrate reset");
  assert(!deploy.includes('["db", "push"]'), "no db push");
  assert(!deploy.includes("ALLOW_PROD_DB"), "no ALLOW_PROD_DB bypass");
  const inspect = fs.readFileSync(path.join(ROOT, "scripts/inspect-team-affiliation-prod-readonly.ts"), "utf8");
  assert(inspect.includes("write/migrate flags are not allowed"), "inspect refuses write flags");
  assert(!/"name"/.test(inspect), "inspect does not select name columns");
  assert(!/"payload"/.test(inspect), "inspect does not print board payload");
  assert(!/"body"/.test(inspect), "inspect does not select comment body");
  const guard = fs.readFileSync(path.join(ROOT, "scripts/guard-prod-db.cjs"), "utf8");
  assert(guard.includes("inspect-team-affiliation-prod-readonly"), "guard allowlists affiliation inspect");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
