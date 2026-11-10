/**
 * Temporary Preview isolation diag. No database or blob I/O.
 * 실행: npm run test:preview-isolation-diag-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  PREVIEW_BLOB_STORE_ID,
  PREVIEW_DB_HOST,
  PREVIEW_DB_POOLER_HOST,
  PREVIEW_ISOLATION_BRANCH,
  PRODUCTION_BLOB_STORE_ID,
  PRODUCTION_DB_ENDPOINT_MARKER,
  inspectPreviewIsolation,
  previewIsolationEnabled,
} from "../src/lib/previewIsolationDiag";
import { GET } from "../src/app/api/preview-isolation-diag/route";

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

const PREVIEW_URL = `postgresql://u:secret-pass-value@${PREVIEW_DB_HOST}/neondb?sslmode=require`;
const POOLER_URL = `postgresql://u:secret-pass-value@${PREVIEW_DB_POOLER_HOST}/neondb?sslmode=require`;
const PROD_URL = `postgresql://u:secret-pass-value@${PRODUCTION_DB_ENDPOINT_MARKER}.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
const LOCAL_URL = "postgresql://caddy:caddy@localhost:5432/caddy_local";

const GOOD_ENV = {
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: PREVIEW_ISOLATION_BRANCH,
  DATABASE_URL: PREVIEW_URL,
  BLOB_STORE_ID: PREVIEW_BLOB_STORE_ID,
};

function section(title: string) {
  console.log("\n==", title, "==");
}

section("inspect flags");
{
  const ok = inspectPreviewIsolation(GOOD_ENV);
  assert(ok.previewRuntime === true, "preview runtime");
  assert(ok.previewDbMatch === true, "preview db host matches");
  assert(ok.previewBlobMatch === true, "preview blob store matches");
  assert(ok.safeToTest === true, "safeToTest when all match");
  assert(previewIsolationEnabled(GOOD_ENV) === true, "enabled on preview PR branch");
}

{
  const pooler = inspectPreviewIsolation({ ...GOOD_ENV, DATABASE_URL: POOLER_URL });
  assert(pooler.previewDbMatch === true, "preview pooler host allowed");
  assert(pooler.safeToTest === true, "safeToTest on pooler host");
}

{
  const prod = inspectPreviewIsolation({ ...GOOD_ENV, DATABASE_URL: PROD_URL });
  assert(prod.previewDbMatch === false, "production endpoint fails db match");
  assert(prod.safeToTest === false, "production endpoint is not safeToTest");
}

{
  const local = inspectPreviewIsolation({ ...GOOD_ENV, DATABASE_URL: LOCAL_URL });
  assert(local.previewDbMatch === false, "localhost fails db match");
  assert(local.safeToTest === false, "localhost is not safeToTest");
}

{
  const missing = inspectPreviewIsolation({ ...GOOD_ENV, DATABASE_URL: "" });
  assert(missing.previewDbMatch === false, "empty DATABASE_URL fails closed");
}

{
  const badHost = inspectPreviewIsolation({
    ...GOOD_ENV,
    DATABASE_URL: `postgresql://u:p@ep-odd-voice-aokrqp5t-hgm.c-2.ap-southeast-1.aws.neon.tech/neondb`,
  });
  assert(badHost.previewDbMatch === false, "compute-suffix host is not allowed");
}

{
  const prodBlob = inspectPreviewIsolation({
    ...GOOD_ENV,
    BLOB_STORE_ID: PRODUCTION_BLOB_STORE_ID,
  });
  assert(prodBlob.previewBlobMatch === false, "production blob store fails");
  assert(prodBlob.safeToTest === false, "production blob is not safeToTest");
}

{
  const prodRuntime = inspectPreviewIsolation({
    ...GOOD_ENV,
    VERCEL_ENV: "production",
  });
  assert(prodRuntime.previewRuntime === false, "production VERCEL_ENV is not previewRuntime");
  assert(prodRuntime.safeToTest === false, "production runtime is not safeToTest");
  assert(previewIsolationEnabled({ ...GOOD_ENV, VERCEL_ENV: "production" }) === false, "disabled on production");
}

{
  const otherBranch = inspectPreviewIsolation({
    ...GOOD_ENV,
    VERCEL_GIT_COMMIT_REF: "main",
  });
  assert(otherBranch.safeToTest === false, "wrong branch is not safeToTest");
  assert(previewIsolationEnabled({ ...GOOD_ENV, VERCEL_GIT_COMMIT_REF: "main" }) === false, "disabled off PR branch");
}

async function runAsyncCases() {
section("GET route");
  const saved: Record<string, string | undefined> = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_GIT_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF,
    DATABASE_URL: process.env.DATABASE_URL,
    BLOB_STORE_ID: process.env.BLOB_STORE_ID,
  };

  async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
    process.env.VERCEL_ENV = env.VERCEL_ENV;
    process.env.VERCEL_GIT_COMMIT_REF = env.VERCEL_GIT_COMMIT_REF;
    process.env.DATABASE_URL = env.DATABASE_URL;
    process.env.BLOB_STORE_ID = env.BLOB_STORE_ID;
    try {
      await fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  await withEnv(GOOD_ENV, async () => {
    const res = await GET();
    const json = (await res.json()) as Record<string, unknown>;
    const text = JSON.stringify(json);
    assert(res.status === 200, "preview GET 200");
    assert(
      Object.keys(json).sort().join(",") ===
        "previewBlobMatch,previewDbMatch,previewRuntime,safeToTest",
      "response keys are the four booleans"
    );
    assert(json.previewRuntime === true, "GET previewRuntime");
    assert(json.previewDbMatch === true, "GET previewDbMatch");
    assert(json.previewBlobMatch === true, "GET previewBlobMatch");
    assert(json.safeToTest === true, "GET safeToTest");
    assert(!text.includes("secret-pass-value"), "response omits db password");
    assert(!text.includes("postgresql://"), "response omits connection string");
    assert(!text.includes(PREVIEW_DB_HOST), "response omits db host");
    assert(!text.includes(PREVIEW_BLOB_STORE_ID), "response omits blob store id");
  });

  await withEnv({ ...GOOD_ENV, DATABASE_URL: PROD_URL }, async () => {
    const res = await GET();
    const json = (await res.json()) as Record<string, unknown>;
    const text = JSON.stringify(json);
    assert(res.status === 200, "preview+prod-db still 200 with flags");
    assert(json.previewDbMatch === false, "GET production db match false");
    assert(json.safeToTest === false, "GET production db not safe");
    assert(!text.includes(PRODUCTION_DB_ENDPOINT_MARKER), "response omits production host");
    assert(!text.includes("secret-pass-value"), "prod-db response omits password");
  });

  await withEnv({ ...GOOD_ENV, VERCEL_ENV: "production" }, async () => {
    const res = await GET();
    const json = (await res.json()) as Record<string, unknown>;
    assert(res.status === 404, "production runtime 404");
    assert(!("safeToTest" in json), "404 does not expose diagnostic flags");
  });

  await withEnv({ ...GOOD_ENV, VERCEL_GIT_COMMIT_REF: "main" }, async () => {
    const res = await GET();
    assert(res.status === 404, "other branch 404");
  });
}

section("source hygiene");
{
  const lib = fs.readFileSync(
    path.join("src/lib/previewIsolationDiag.ts"),
    "utf8"
  );
  const route = fs.readFileSync(
    path.join("src/app/api/preview-isolation-diag/route.ts"),
    "utf8"
  );
  assert(!/\bconsole\.(log|info|debug|warn|error)\b/.test(lib), "lib has no console logging");
  assert(!/\bconsole\.(log|info|debug|warn|error)\b/.test(route), "route has no console logging");
  assert(!lib.includes("prisma"), "lib does not import prisma");
  assert(!route.includes("prisma"), "route does not import prisma");
  assert(
    route.includes("TEMPORARY") && lib.includes("TEMPORARY"),
    "temporary removal comment present"
  );
  assert(
    fs.existsSync(path.join("src/app/api/preview-isolation-diag/route.ts")),
    "route is not a Next.js private _folder"
  );
}

runAsyncCases()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  })
  .catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
