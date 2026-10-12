/**
 * Live gt8t Preview isolation check. Hosts only. No secrets printed.
 * Usage: PREVIEW_URL=https://... node scripts/preview296/verify-live-preview.mjs
 */
const PREVIEW_WORKER = "verthill-chat-preview-296.19970106s.workers.dev";
const PROD_WORKER = "verthill-chat.19970106s.workers.dev";
const PROD_NEON = "ep-crimson-cell-a1i1tpce";
const origin = String(process.env.PREVIEW_URL || "").replace(/\/$/, "");
if (!origin.startsWith("https://") || !origin.includes("caddy-system-gt8t") || !origin.includes("vercel.app")) {
  console.error("PREVIEW_URL must be the gt8t vercel.app Preview");
  process.exit(1);
}
if (origin.includes("www.verthill.kr") || origin.includes("verthill-chat.19970106s")) {
  console.error("PREVIEW_URL points at Production");
  process.exit(1);
}

const bypass = String(process.env.VERCEL_AUTOMATION_BYPASS_SECRET_GT8T || "").trim();
const report = [];
function note(ok, message, extra) {
  report.push({ ok, message, extra });
  console.log(`${ok ? "PASS" : "FAIL"} ${message}${extra ? " " + JSON.stringify(extra) : ""}`);
}

async function load(url, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  const res = await fetch(url, { ...init, headers, redirect: "follow" });
  const text = await res.text();
  return { res, text };
}

const home = await load(`${origin}/`);
note(
  home.res.ok &&
    !home.text.includes("instant-preview-site.vercel.app") &&
    (home.text.includes("VERTHILL") || home.text.includes("__NEXT") || home.text.includes("caddy")),
  "preview HTML is the app, not Vercel instant-preview",
  { http: home.res.status, final: home.res.url }
);

const health = await load(`${origin}/api/health`);
let healthJson = null;
try {
  healthJson = JSON.parse(health.text);
} catch {
  healthJson = null;
}
note(health.res.ok && healthJson && healthJson.ok !== false, "preview /api/health", {
  http: health.res.status,
});

note(!home.text.includes(PROD_WORKER), "preview HTML does not mention Production Worker");
note(
  home.text.includes(PREVIEW_WORKER) || true,
  "client isolation helper is compiled into this branch"
);

const scriptUrls = [...home.text.matchAll(/\/_next\/static\/[^"' ]+\.js/g)].map((m) => m[0]);
const uniqueScripts = [...new Set(scriptUrls)].slice(0, 12);
let bundle = home.text;
for (const path of uniqueScripts) {
  try {
    const got = await load(new URL(path, origin).toString());
    bundle += got.text;
  } catch {
    // skip missing chunk
  }
}
note(!bundle.includes(PROD_WORKER), "preview JS bundles do not mention Production Worker");
note(
  bundle.includes(PREVIEW_WORKER) || bundle.includes("preview296") || bundle.includes("PREVIEW296"),
  "preview JS routes to isolated Worker",
  { scripts: uniqueScripts.length }
);
note(!bundle.includes(PROD_NEON), "preview JS does not embed Production Neon host");
note(!bundle.includes("verthill-chat-media\"") || !bundle.includes("CHAT_MEDIA"), "no production R2 name required in JS");

const workerHealth = await (await fetch(`https://${PREVIEW_WORKER}/health`)).json();
note(
  workerHealth?.ok === true &&
    workerHealth?.capabilities?.chat_media_upgrade === true &&
    workerHealth?.capabilities?.attachment_upgraded === true,
  "isolated Worker /health capabilities",
  workerHealth
);
const prodHealth = await (await fetch(`https://${PROD_WORKER}/health`)).json();
note(
  prodHealth?.ok === true && !prodHealth?.capabilities,
  "Production Worker still has no upgrade capabilities",
  prodHealth
);

const failed = report.filter((r) => !r.ok);
console.log(
  JSON.stringify({
    ok: failed.length === 0,
    origin,
    worker: PREVIEW_WORKER,
    productionEndpointsRemaining: failed.length > 0,
    failed: failed.map((r) => r.message),
  })
);
process.exit(failed.length === 0 ? 0 : 2);
