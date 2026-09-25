/**
 * Google Play review account maintenance: dry-run / confirm / target isolation.
 * No production DB. Passwords are never printed.
 *
 *   npm run test:play-review-accounts-unit
 */
import fs from "node:fs";
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
