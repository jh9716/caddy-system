/**
 * Prove #296 isolation. Prints hosts only. No secrets.
 * Exit 1 if any Production chat/DB endpoint is still in the live Preview path.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const PREVIEW_WORKER = "https://verthill-chat-preview-296.19970106s.workers.dev";
const PROD_WORKER = "https://verthill-chat.19970106s.workers.dev";
const PROD_NEON = "ep-crimson-cell-a1i1tpce";
const report = [];

function note(ok, message, extra) {
  report.push({ ok, message, ...(extra || {}) });
  console.log(`${ok ? "PASS" : "FAIL"} ${message}${extra ? " " + JSON.stringify(extra) : ""}`);
}

const wrangler = fs.readFileSync(path.join(root, "cloudflare/verthill-chat/wrangler.jsonc"), "utf8");
note(wrangler.includes('"name": "verthill-chat-preview-296"'), "wrangler preview worker name");
note(wrangler.includes('"bucket_name": "verthill-chat-media-preview-296"'), "wrangler preview R2");
note(!wrangler.includes("verthill-chat-media-preview-296") || wrangler.includes('"bucket_name": "verthill-chat-media"'), "default wrangler still names production R2");
note(wrangler.includes("new_sqlite_classes") && wrangler.includes("preview296"), "preview296 has own DO migrations");

const workflow = fs.readFileSync(path.join(root, ".github/workflows/cloudflare-worker-preview-296.yml"), "utf8");
note(workflow.includes("wrangler deploy --env preview296"), "preview workflow uses --env preview296");
note(!workflow.includes("https://neon.new"), "preview workflow does not create Neon");
note(!/secret put CHAT_PUSH_DISPATCH_URL/.test(workflow), "CHAT_PUSH_DISPATCH_URL never set");

const capacitor = fs.readFileSync(path.join(root, "capacitor.config.ts"), "utf8");
note(capacitor.includes('url: "https://www.verthill.kr"'), "capacitor still production url (APK not pointed yet)");

const previewHealth = await (await fetch(`${PREVIEW_WORKER}/health`)).json();
note(
  previewHealth?.ok === true &&
    previewHealth?.capabilities?.chat_media_upgrade === true &&
    previewHealth?.capabilities?.attachment_upgraded === true,
  "isolated worker health",
  previewHealth
);

const prodHealth = await (await fetch(`${PROD_WORKER}/health`)).json();
note(
  prodHealth?.ok === true && prodHealth?.service === "verthill-chat" && !prodHealth?.capabilities,
  "production worker untouched",
  prodHealth
);

const vercelToken = String(process.env.VERCEL_TOKEN || "").trim();
let vercelOk = false;
if (!vercelToken) {
  note(false, "VERCEL_TOKEN missing; gt8t Preview env cannot be set");
} else {
  try {
    const res = await fetch("https://api.vercel.com/v2/user", {
      headers: { Authorization: `Bearer ${vercelToken}` },
    });
    vercelOk = res.ok;
    note(res.ok, "VERCEL_TOKEN can call Vercel API", { http: res.status });
  } catch (error) {
    note(false, "VERCEL_TOKEN probe failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

if (process.env.DATABASE_URL && String(process.env.DATABASE_URL).includes(PROD_NEON)) {
  note(false, "current process DATABASE_URL is production Neon");
}

const failed = report.filter((r) => !r.ok);
const ready = failed.length === 0 && vercelOk;
console.log(
  JSON.stringify({
    ready,
    productionEndpointsRemaining: !ready,
    apk: ready ? "allowed" : "STOP",
    failed: failed.map((r) => r.message),
  })
);
process.exit(ready ? 0 : 2);
