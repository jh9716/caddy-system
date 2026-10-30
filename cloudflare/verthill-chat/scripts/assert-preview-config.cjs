// Preview Worker 배포 전 설정 검증 (배포·네트워크 없음). 실패 시 exit 1.
// 사용: node scripts/assert-preview-config.cjs [wrangler.jsonc]
"use strict";
const { unstable_readConfig } = require("wrangler");

const PREVIEW_NAME = "verthill-chat-preview";
const PREVIEW_BUCKET = "verthill-chat-media-preview";
const PRODUCTION_NAME = "verthill-chat";
const PRODUCTION_BUCKET = "verthill-chat-media";

function fail(msg) {
  console.error("preview config guard FAILED: " + msg);
  process.exit(1);
}

const configPath = process.argv[2] || "wrangler.jsonc";
const prod = unstable_readConfig({ config: configPath });
const cfg = unstable_readConfig({ config: configPath, env: "preview" });

if (prod.name !== PRODUCTION_NAME) fail(`unexpected top-level worker name ${JSON.stringify(prod.name)}`);
if (cfg.name !== PREVIEW_NAME) fail(`env.preview worker name must be ${PREVIEW_NAME}, got ${JSON.stringify(cfg.name)}`);
if (cfg.name === PRODUCTION_NAME || cfg.name === prod.name) fail("preview resolves to the production worker name");
if ((cfg.vars || {}).CHAT_TOKEN_AUDIENCE !== "preview") fail("CHAT_TOKEN_AUDIENCE must be \"preview\"");

const buckets = cfg.r2_buckets || [];
if (buckets.length === 0) fail("preview R2 binding missing");
for (const b of buckets) {
  const names = [b.bucket_name, b.preview_bucket_name].filter(Boolean);
  if (names.includes(PRODUCTION_BUCKET)) fail("preview config references production R2 bucket");
  if (b.bucket_name !== PREVIEW_BUCKET) fail(`unexpected R2 bucket ${JSON.stringify(b.bucket_name)}`);
}

const dos = (cfg.durable_objects && cfg.durable_objects.bindings) || [];
if (dos.length === 0) fail("preview DO bindings missing");
for (const d of dos) {
  // script_name 이 있으면 다른 Worker(운영 포함)의 DO 를 빌려 쓰는 것이므로 금지
  if (d.script_name) fail(`DO binding ${d.name} has script_name=${JSON.stringify(d.script_name)}; preview must own its DOs`);
  if (d.environment) fail(`DO binding ${d.name} points to another environment`);
}
for (const key of ["services", "queues", "d1_databases", "kv_namespaces", "routes"]) {
  const v = cfg[key];
  if (Array.isArray(v) && v.length > 0) fail(`unexpected ${key} in preview config`);
}
if (cfg.route) fail("unexpected route in preview config");
const raw = JSON.stringify({ r2: cfg.r2_buckets, dos: cfg.durable_objects, vars: cfg.vars });
if (/"verthill-chat-media"/.test(raw) || /"script_name"/.test(raw)) fail("production reference found in preview bindings");

console.log(`preview config guard passed: worker=${cfg.name} r2=${buckets.map((b) => b.bucket_name).join(",")} do=${dos.map((d) => d.name).join(",")}`);
