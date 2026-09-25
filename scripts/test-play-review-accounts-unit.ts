/**
 * Google Play review account maintenance: dry-run / confirm / target isolation.
 * No production DB. Passwords are never printed.
 *
 *   npm run test:play-review-accounts-unit
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SUPER_ADMIN_USERNAME, STAFF_ADMIN_USERNAMES } from "../src/lib/staffAdminAccounts";
import { DRIVING_POOL_TEAM } from "../src/lib/caddyManage";
import {
  FORBIDDEN_USER_WRITE_USERNAMES,
  PLAY_REVIEW_ADMIN_USERNAME,
  PLAY_REVIEW_CADDY_MEMO,
  PLAY_REVIEW_CADDY_NAME,
  PLAY_REVIEW_CADDY_USERNAME,
  PLAY_REVIEW_CREATE_CONFIRM,
  PLAY_REVIEW_DISABLE_CONFIRM,
  canWritePlayReview,
  formatPlayReviewReport,
  isExpectedActiveAdmin,
  isExpectedActiveCaddyUser,
  isExpectedActiveReviewCaddy,
  isForbiddenUserWrite,
  parsePlayReviewArgs,
  planPlayReviewCreate,
  planPlayReviewDisable,
  readPlayReviewPassword,
  reportLooksSafe,
  shouldApplyPlayReviewWrite,
  type InspectedReviewCaddy,
  type InspectedReviewUser,
  type PlayReviewSnapshot,
} from "../src/lib/playReviewAccounts";

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

function user(partial: Partial<InspectedReviewUser>): InspectedReviewUser {
  return {
    id: 10,
    username: PLAY_REVIEW_ADMIN_USERNAME,
    role: "admin",
    kakaoUserId: null,
    caddyId: null,
    mustChangePassword: false,
    managedTeams: [],
    passwordPresent: true,
    ...partial,
  };
}

function caddy(partial: Partial<InspectedReviewCaddy>): InspectedReviewCaddy {
  return {
    id: 77,
    name: PLAY_REVIEW_CADDY_NAME,
    caddyType: "DRIVING",
    team: DRIVING_POOL_TEAM,
    teamOrder: 0,
    employmentStatus: "LEAVE",
    phoneNormalized: null,
    memo: PLAY_REVIEW_CADDY_MEMO,
    linkedUserId: 11,
    ...partial,
  };
}

function activeSnapshot(): PlayReviewSnapshot {
  const review = caddy({});
  return {
    admin: user({ id: 10 }),
    caddyUser: user({
      id: 11,
      username: PLAY_REVIEW_CADDY_USERNAME,
      role: "caddy",
      caddyId: review.id,
    }),
    reviewCaddies: [review],
  };
}

const libSrc = fs.readFileSync(
  path.join(process.cwd(), "src/lib/playReviewAccounts.ts"),
  "utf8"
);
const cliSrc = fs.readFileSync(
  path.join(process.cwd(), "scripts/maintenance/play-review-accounts.ts"),
  "utf8"
);

section("1 dry-run write 0");
{
  const plan = planPlayReviewCreate({
    admin: null,
    caddyUser: null,
    reviewCaddies: [],
  });
  const gate = canWritePlayReview({
    apply: false,
    confirm: null,
    mode: "create",
    isProduction: false,
    prodMaintenanceConfirm: null,
  });
  assert(plan.writes === true, "empty snapshot would create if applied");
  assert(gate.ok === false, "dry-run gate closed");
  assert(
    shouldApplyPlayReviewWrite(plan, gate) === false,
    "dry-run does not apply create"
  );
}

section("2 apply without confirm write 0");
{
  const plan = planPlayReviewCreate({
    admin: null,
    caddyUser: null,
    reviewCaddies: [],
  });
  const gate = canWritePlayReview({
    apply: true,
    confirm: null,
    mode: "create",
    isProduction: false,
    prodMaintenanceConfirm: null,
  });
  assert(gate.ok === false, "apply without confirm is blocked");
  assert(
    shouldApplyPlayReviewWrite(plan, gate) === false,
    "--apply without confirm writes 0"
  );
  const prodGate = canWritePlayReview({
    apply: true,
    confirm: PLAY_REVIEW_CREATE_CONFIRM,
    mode: "create",
    isProduction: true,
    prodMaintenanceConfirm: null,
  });
  assert(prodGate.ok === false, "production also needs PROD_MAINTENANCE_CONFIRM");
}

section("3 username admin write path absent");
{
  assert(
    FORBIDDEN_USER_WRITE_USERNAMES.includes(SUPER_ADMIN_USERNAME),
    "admin is in forbidden write list"
  );
  assert(isForbiddenUserWrite("admin") === true, "admin write forbidden helper");
  assert(
    !cliSrc.includes(`username: "${SUPER_ADMIN_USERNAME}"`),
    "CLI does not target username admin"
  );
  assert(
    !cliSrc.includes("where: { username: SUPER_ADMIN_USERNAME }"),
    "CLI does not query-update admin"
  );
  assert(
    cliSrc.includes("assertSafeUserWrite") &&
      cliSrc.includes("isForbiddenUserWrite"),
    "CLI guards user writes"
  );
}

section("4 real staff accounts not modified");
{
  for (const name of STAFF_ADMIN_USERNAMES) {
    assert(!cliSrc.includes(name), `CLI does not mention staff ${name.length}-char name`);
  }
  assert(
    !cliSrc.includes("STAFF_ADMIN_USERNAMES"),
    "CLI does not iterate staff admin usernames"
  );
  const disable = planPlayReviewDisable(activeSnapshot());
  assert(disable.action === "disable", "disable plan targets review snapshot");
  if (disable.action === "disable") {
    assert(
      disable.userIds.every((id) => id === 10 || id === 11),
      "disable userIds are review users only"
    );
    assert(disable.caddyId === 77, "disable caddyId is review caddy only");
  }
}

section("5-8 expected review shapes");
{
  const snap = activeSnapshot();
  assert(isExpectedActiveAdmin(snap.admin!) === true, "admin review role=admin");
  assert(
    isExpectedActiveCaddyUser(snap.caddyUser!, snap.reviewCaddies[0].id) === true,
    "caddy review role=caddy + review Caddy linked"
  );
  assert(snap.admin!.mustChangePassword === false, "admin mustChangePassword=false");
  assert(
    snap.caddyUser!.mustChangePassword === false,
    "caddy mustChangePassword=false"
  );
  assert(
    isExpectedActiveReviewCaddy(snap.reviewCaddies[0]) === true,
    "review Caddy DRIVING / LEAVE / teamOrder 0"
  );
  assert(snap.reviewCaddies[0].caddyType === "DRIVING", "caddyType DRIVING");
  assert(snap.reviewCaddies[0].employmentStatus === "LEAVE", "employmentStatus LEAVE");
  assert(snap.reviewCaddies[0].teamOrder === 0, "teamOrder 0");
  assert(snap.reviewCaddies[0].team === "드라이빙", "team 드라이빙");
}

section("9 passwords not printed");
{
  const report = formatPlayReviewReport(activeSnapshot());
  assert(reportLooksSafe(report), "report has no password/token/session/phone");
  assert(!report.includes("secret"), "report has no secret word");
  assert(report.includes("playreview_admin exists=true role=admin"), "admin line");
  assert(report.includes("caddyLinked=true"), "caddy linked line");
  const args = parsePlayReviewArgs([
    "--apply",
    "--confirm=CREATE_PLAY_REVIEW_ACCOUNTS",
  ]);
  assert(args.confirm === PLAY_REVIEW_CREATE_CONFIRM, "confirm parsed");
  const env = {
    PLAY_REVIEW_ADMIN_PASSWORD: "unit-admin-pass-XXXX",
    PLAY_REVIEW_CADDY_PASSWORD: "unit-caddy-pass-YYYY",
  };
  const adminPass = readPlayReviewPassword(env, "PLAY_REVIEW_ADMIN_PASSWORD");
  assert(adminPass.length > 0, "password read from env");
  assert(!report.includes(adminPass), "report does not include env password");
  assert(!libSrc.includes("console.log(adminPassword)"), "lib does not log admin password");
  assert(!cliSrc.includes("console.log(adminPassword)"), "CLI does not log admin password");
  assert(!cliSrc.includes("console.log(caddyPassword)"), "CLI does not log caddy password");
}

section("10 rerun does not duplicate");
{
  const again = planPlayReviewCreate(activeSnapshot());
  assert(again.action === "already_created", "matching snapshot is already_created");
  assert(again.writes === false, "rerun create writes 0");
  const partial = planPlayReviewCreate({
    admin: user({}),
    caddyUser: null,
    reviewCaddies: [],
  });
  assert(partial.action === "fail", "partial existing state fails");
  assert(partial.writes === false, "partial fail writes 0");
}

section("11 disable review targets only");
{
  const mismatch = planPlayReviewDisable({
    admin: user({}),
    caddyUser: user({
      id: 11,
      username: PLAY_REVIEW_CADDY_USERNAME,
      role: "caddy",
      caddyId: 999,
    }),
    reviewCaddies: [caddy({ id: 77 })],
  });
  assert(mismatch.action === "fail", "foreign caddyId fails disable");
  assert(mismatch.writes === false, "mismatch disable writes 0");

  const disabled: PlayReviewSnapshot = {
    admin: user({ passwordPresent: false }),
    caddyUser: user({
      id: 11,
      username: PLAY_REVIEW_CADDY_USERNAME,
      role: "caddy",
      caddyId: null,
      passwordPresent: false,
    }),
    reviewCaddies: [
      caddy({
        employmentStatus: "RETIRED",
        linkedUserId: null,
      }),
    ],
  };
  const already = planPlayReviewDisable(disabled);
  assert(already.action === "already_disabled", "disabled shape is already_disabled");
  assert(already.writes === false, "already disabled writes 0");

  const args = parsePlayReviewArgs([
    "--disable",
    "--apply",
    `--confirm=${PLAY_REVIEW_DISABLE_CONFIRM}`,
  ]);
  assert(args.disable === true, "disable flag parsed");
  const gate = canWritePlayReview({
    apply: args.apply,
    confirm: args.confirm,
    mode: "disable",
    isProduction: false,
    prodMaintenanceConfirm: null,
  });
  assert(gate.ok === true, "local disable apply+confirm allowed");
}

section("12 play-review-accounts.yml dispatch gates");
{
  const workflowRel = ".github/workflows/play-review-accounts.yml";
  const workflowPath = path.join(process.cwd(), workflowRel);
  const workflow = fs.readFileSync(workflowPath, "utf8");
  const androidWorkflow = fs.readFileSync(
    path.join(process.cwd(), ".github/workflows/android-release-aab.yml"),
    "utf8"
  );

  const yamlDump = path.join(os.tmpdir(), `play-review-wf-${process.pid}.json`);
  execSync(
    `python3 -c "import json,yaml,sys; data=yaml.safe_load(open(sys.argv[1])); json.dump(data, open(sys.argv[2],'w'))" "${workflowRel}" "${yamlDump}"`,
    { encoding: "utf8" }
  );
  const data = JSON.parse(fs.readFileSync(yamlDump, "utf8")) as {
    name: string;
    on?: Record<string, unknown>;
    true?: Record<string, unknown>;
    permissions?: { contents?: string };
    jobs: {
      "play-review-accounts": {
        env: Record<string, string>;
        steps: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
      };
    };
  };
  fs.rmSync(yamlDump, { force: true });
  const on = data.on ?? data.true ?? {};
  const job = data.jobs["play-review-accounts"];
  const lastStep = job.steps[job.steps.length - 1];
  const runScript = String(lastStep.run ?? "");
  assert(data.name === "Play Review Accounts", "workflow name parses");
  assert(Object.keys(on).join(",") === "workflow_dispatch", "workflow_dispatch is the only trigger");
  assert(
    Object.keys(lastStep.env ?? {}).join(",") === "PLAY_REVIEW_ACTION,PLAY_REVIEW_CONFIRM",
    "action/confirm arrive as env, not interpolated into argv"
  );
  assert(data.permissions?.contents === "read", "contents: read permission");
  assert(
    job.env.DATABASE_URL === "${{ secrets.DATABASE_URL }}" &&
      job.env.PLAY_REVIEW_ADMIN_PASSWORD ===
        "${{ secrets.PLAY_REVIEW_ADMIN_PASSWORD }}" &&
      job.env.PLAY_REVIEW_CADDY_PASSWORD ===
        "${{ secrets.PLAY_REVIEW_CADDY_PASSWORD }}",
    "job env uses the three repository secrets"
  );

  assert(
    /^on:\n  workflow_dispatch:\n/m.test(workflow) &&
      !/^\s+push:/m.test(workflow) &&
      !/^\s+pull_request:/m.test(workflow) &&
      !/^\s+schedule:/m.test(workflow) &&
      !/^\s+workflow_run:/m.test(workflow) &&
      !/^\s+release:/m.test(workflow),
    "no push/PR/schedule/workflow_run/release triggers"
  );
  assert(workflow.includes("default: dry-run"), "action default is dry-run");
  assert(/confirm:[\s\S]*default: ""/.test(workflow), "confirm default is empty");
  assert(workflow.includes("npm ci"), "uses npm ci");
  assert(workflow.includes("npx prisma generate"), "explicit prisma generate");
  assert(workflow.includes("npx --yes tsx"), "uses npx --yes tsx");
  assert(!/\bset -x\b/.test(workflow), "no set -x");
  assert(workflow.includes("set +x") && workflow.includes("set +o xtrace"), "xtrace disabled");
  assert(
    !/echo .*DATABASE_URL|echo .*PLAY_REVIEW_ADMIN_PASSWORD|echo .*PLAY_REVIEW_CADDY_PASSWORD/.test(
      workflow
    ),
    "does not echo secrets"
  );
  assert(
    !workflow.includes("prisma migrate") && !workflow.includes("db push"),
    "workflow does not migrate"
  );

  assert(runScript.includes("set +x"), "dispatch run script present");
  const dryIdx = runScript.indexOf('if [ "$action" = "dry-run" ]');
  const createIdx = runScript.indexOf('elif [ "$action" = "create" ]');
  const disableIdx = runScript.indexOf('elif [ "$action" = "disable" ]');
  const dryNpx = runScript.indexOf(
    "npx --yes tsx scripts/maintenance/play-review-accounts.ts\n"
  );
  const createConfirm = runScript.indexOf(
    'if [ "$confirm" != "CREATE_PLAY_REVIEW_ACCOUNTS" ]'
  );
  const createNpx = runScript.indexOf("--apply");
  const disableConfirm = runScript.indexOf(
    'if [ "$confirm" != "DISABLE_PLAY_REVIEW_ACCOUNTS" ]'
  );
  const disableNpx = runScript.indexOf("--disable");
  assert(
    dryIdx >= 0 && dryNpx > dryIdx && dryNpx < createIdx,
    "dry-run invokes tsx without --apply"
  );
  assert(
    createConfirm > createIdx && createNpx > createConfirm,
    "create confirm is checked before --apply"
  );
  assert(
    disableConfirm > disableIdx && disableNpx > disableConfirm,
    "disable confirm is checked before --apply"
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "play-review-wf-"));
  const mockBin = path.join(tmp, "bin");
  fs.mkdirSync(mockBin);
  fs.writeFileSync(
    path.join(mockBin, "npx"),
    `#!/usr/bin/env bash
set +x
printf 'RAN_TSX'
for arg in "$@"; do printf ' %s' "$arg"; done
printf '\\n'
exit 0
`,
    { mode: 0o755 }
  );
  const scriptPath = path.join(tmp, "dispatch.sh");
  fs.writeFileSync(scriptPath, runScript, { mode: 0o755 });

  const runDispatch = (action: string, confirm: string) => {
    try {
      const out = execFileSync("bash", [scriptPath], {
        encoding: "utf8",
        env: {
          PATH: `${mockBin}:${process.env.PATH ?? ""}`,
          PLAY_REVIEW_ACTION: action,
          PLAY_REVIEW_CONFIRM: confirm,
        },
      });
      return { code: 0, out };
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string };
      return {
        code: typeof err.status === "number" ? err.status : 1,
        out: `${err.stdout ?? ""}${err.stderr ?? ""}`,
      };
    }
  };

  const dry = runDispatch("dry-run", "");
  assert(dry.code === 0, "dry-run mock exits 0");
  assert(
    dry.out.includes("RAN_TSX --yes tsx scripts/maintenance/play-review-accounts.ts") &&
      !dry.out.includes("--apply"),
    "dry-run mock runs tsx without --apply"
  );

  const badCreate = runDispatch("create", "WRONG");
  assert(badCreate.code === 1, "wrong create confirm exits 1");
  assert(!badCreate.out.includes("RAN_TSX"), "wrong create confirm never runs tsx");

  const badDisable = runDispatch("disable", "");
  assert(badDisable.code === 1, "empty disable confirm exits 1");
  assert(!badDisable.out.includes("RAN_TSX"), "wrong disable confirm never runs tsx");

  const okCreate = runDispatch("create", PLAY_REVIEW_CREATE_CONFIRM);
  assert(okCreate.code === 0 && okCreate.out.includes("--apply"), "valid create reaches apply argv");
  const okDisable = runDispatch("disable", PLAY_REVIEW_DISABLE_CONFIRM);
  assert(
    okDisable.code === 0 && okDisable.out.includes("--disable"),
    "valid disable reaches disable argv"
  );

  assert(
    androidWorkflow.includes("name: Android Release AAB") &&
      androidWorkflow.includes("workflow_dispatch"),
    "android-release-aab.yml still present and dispatch-only"
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

section("source + hashing");
{
  assert(cliSrc.includes('from "../../src/lib/userPassword"'), "reuses hashPassword module");
  assert(cliSrc.includes("hashPassword"), "calls hashPassword");
  assert(cliSrc.includes("PLAY_REVIEW_ADMIN_PASSWORD"), "admin password env only");
  assert(cliSrc.includes("PLAY_REVIEW_CADDY_PASSWORD"), "caddy password env only");
  assert(!cliSrc.includes("--password"), "no password CLI flag");
  assert(cliSrc.includes("$transaction"), "create/disable use transaction");
  assert(cliSrc.includes('employmentStatus: "LEAVE"'), "create Caddy as LEAVE");
  assert(cliSrc.includes('caddyType: "DRIVING"'), "create Caddy as DRIVING");
  assert(libSrc.includes(PLAY_REVIEW_CADDY_MEMO), "memo constant present");
}

if (failed > 0) {
  console.error(`\nplay-review-accounts tests failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nplay-review-accounts tests passed: ${passed}`);
