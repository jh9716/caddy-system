/**
 * Temporary Preview DB probe: env gate + classify. No production DB.
 */
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import {
  classifyPreviewDbIdentity,
  evaluatePreviewDbProbeGate,
  PREVIEW_DB_PROBE_BRANCH,
  PREVIEW_DB_PROBE_DATABASE,
  PREVIEW_DB_PROBE_ENDPOINT_ID,
} from "../src/lib/previewDbProbe";
import { GET } from "../src/app/api/diag/preview-db-probe/route";
import {
  SESSION_COOKIE_NAME,
  buildSessionClaims,
  signSessionClaims,
} from "../src/lib/sessionCookies";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET || "unit-test-session-secret-32chars!!";

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

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function env(partial: Record<string, string | undefined>) {
  return {
    VERCEL: undefined,
    VERCEL_ENV: undefined,
    VERCEL_GIT_COMMIT_REF: undefined,
    ...partial,
  };
}

console.log("== gate ==");
assert(
  evaluatePreviewDbProbeGate(
    env({
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: PREVIEW_DB_PROBE_BRANCH,
    })
  ).allowQuery === true,
  "preview + exact branch allows query"
);
assert(
  evaluatePreviewDbProbeGate(
    env({
      VERCEL: "1",
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: PREVIEW_DB_PROBE_BRANCH,
    })
  ).denyReason === "production",
  "production blocked before query"
);
assert(
  evaluatePreviewDbProbeGate(env({ VERCEL: "1", VERCEL_ENV: "production" })).allowQuery ===
    false,
  "production without branch still blocked"
);
assert(
  evaluatePreviewDbProbeGate(
    env({
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "preview-db-free-board-v1",
    })
  ).denyReason === "branch_mismatch",
  "other preview branch blocked"
);
assert(
  evaluatePreviewDbProbeGate(env({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: PREVIEW_DB_PROBE_BRANCH }))
    .denyReason === "not_vercel",
  "non-Vercel blocked"
);
assert(
  evaluatePreviewDbProbeGate(
    env({ VERCEL: "1", VERCEL_ENV: "development", VERCEL_GIT_COMMIT_REF: PREVIEW_DB_PROBE_BRANCH })
  ).denyReason === "not_preview",
  "development is not preview"
);

console.log("== classify ==");
assert(
  classifyPreviewDbIdentity({
    neonEndpoint: PREVIEW_DB_PROBE_ENDPOINT_ID,
    database: PREVIEW_DB_PROBE_DATABASE,
  }).match === true,
  "preview endpoint + neondb matches"
);
assert(
  classifyPreviewDbIdentity({
    neonEndpoint: "ep-crimson-cell-a1i1tpce",
    database: PREVIEW_DB_PROBE_DATABASE,
  }).match === false,
  "production endpoint does not match"
);
assert(
  classifyPreviewDbIdentity({
    neonEndpoint: PREVIEW_DB_PROBE_ENDPOINT_ID,
    database: "postgres",
  }).databaseMatch === false,
  "wrong database does not match"
);
assert(
  classifyPreviewDbIdentity({ neonEndpoint: "n/a", database: "neondb" }).endpointMatch === false,
  "missing neon endpoint does not match"
);

console.log("== source ==");
{
  const route = read("src/app/api/diag/preview-db-probe/route.ts");
  const lib = read("src/lib/previewDbProbe.ts");
  const sql = route.match(/SELECT[\s\S]*current_database\(\)[\s\S]*database/)?.[0] || "";
  assert(route.indexOf("evaluatePreviewDbProbeGate") < route.indexOf('import("@/lib/auth")'), "env gate before auth import");
  assert(route.indexOf('import("@/lib/auth")') < route.indexOf('import("@/lib/prisma")'), "admin import before prisma import");
  assert(!/from ["']@\/lib\/prisma["']/.test(route), "prisma is not a static import");
  assert(!/from ["']@\/lib\/auth["']/.test(route), "auth is not a static import");
  assert(/SELECT current_setting\('neon\.endpoint_id'/.test(route), "SELECT neon.endpoint_id");
  assert(/current_database\(\)/.test(route), "SELECT current_database");
  assert(sql.includes("current_setting") && sql.includes("current_database"), "probe SQL is identity SELECT");
  assert(!/\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b/i.test(sql), "probe SQL is SELECT only");
  assert(!/DATABASE_URL/.test(route), "route does not read DATABASE_URL");
  assert(!/password/i.test(route), "route no password");
  assert(!/parseDatabaseUrl/.test(route), "route does not parse URL");
  assert(!/ep-odd-voice-aokrqp5t\.c-2/.test(route), "route does not emit full host");
  assert(/TEMPORARY/.test(lib) && /TEMPORARY/.test(route), "temporary removal markers");
  assert(PREVIEW_DB_PROBE_BRANCH === "preview-db-comment-replies-8d28", "exact branch pin");
}

async function testRouteEnvDeny() {
  console.log("== route env deny ==");
  const prev = {
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_GIT_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF,
  };
  const restore = (key: "VERCEL" | "VERCEL_ENV" | "VERCEL_GIT_COMMIT_REF") => {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  };
  const req = new NextRequest("http://localhost/api/diag/preview-db-probe");
  process.env.VERCEL = "1";
  process.env.VERCEL_ENV = "production";
  process.env.VERCEL_GIT_COMMIT_REF = PREVIEW_DB_PROBE_BRANCH;
  const prod = await GET(req);
  const prodJson = await prod.json();
  assert(prod.status === 404, `production GET 404 (got ${prod.status})`);
  assert(prodJson.error === "not_found", "production body is not_found");
  assert(!("match" in prodJson), "production response has no match");
  assert(!("endpointMatch" in prodJson), "production response has no endpoint");

  process.env.VERCEL_ENV = "preview";
  process.env.VERCEL_GIT_COMMIT_REF = "main";
  const wrong = await GET(req);
  assert(wrong.status === 404, `wrong branch GET 404 (got ${wrong.status})`);

  process.env.VERCEL_ENV = "preview";
  process.env.VERCEL_GIT_COMMIT_REF = PREVIEW_DB_PROBE_BRANCH;
  const unauth = await GET(req);
  const unauthJson = await unauth.json();
  assert(unauth.status === 401, `preview+branch without admin 401 (got ${unauth.status})`);
  assert(unauthJson.error === "unauthorized", "unauth is unauthorized not probe result");
  assert(!("match" in unauthJson), "unauth has no match payload");

  assertLocalDatabaseUrl(process.env.DATABASE_URL, "preview-db-probe local SELECT");
  const token = await signSessionClaims(
    buildSessionClaims({
      userId: null,
      username: "admin",
      role: "admin",
      sessionVersion: 0,
    })
  );
  const adminReq = new NextRequest("http://localhost/api/diag/preview-db-probe", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
  const adminRes = await GET(adminReq);
  const adminJson = (await adminRes.json()) as Record<string, unknown>;
  const adminText = JSON.stringify(adminJson);
  assert(adminRes.status === 200, `local admin GET 200 (got ${adminRes.status})`);
  assert(adminJson.ok === true, "local admin ok");
  assert(adminJson.temporary === true, "local admin temporary");
  assert(adminJson.match === false, "local caddy_local is not preview neon");
  assert(adminJson.endpointMatch === false, "local endpoint does not match");
  assert(
    Object.keys(adminJson).sort().join(",") ===
      "databaseMatch,endpointMatch,match,ok,temporary",
    "response keys are match booleans only"
  );
  assert(!/postgresql:\/\//i.test(adminText), "response has no connection string");
  assert(!/password/i.test(adminText), "response has no password");
  assert(!/neon\.tech/i.test(adminText), "response has no neon host");
  assert(!/DATABASE_URL/.test(adminText), "response has no DATABASE_URL");

  restore("VERCEL");
  restore("VERCEL_ENV");
  restore("VERCEL_GIT_COMMIT_REF");
}

testRouteEnvDeny()
  .then(() => {
    console.log(`\nDONE: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
