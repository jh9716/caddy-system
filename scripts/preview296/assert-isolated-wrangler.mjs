/**
 * Refuse to deploy preview-296 if wrangler still points at Production Worker/R2.
 * Does not print secrets. Does not call Cloudflare.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const wranglerPath = path.join(root, "cloudflare/verthill-chat/wrangler.jsonc");
const workflowProd = path.join(root, ".github/workflows/cloudflare-worker-deploy.yml");
const workflowPreview = path.join(root, ".github/workflows/cloudflare-worker-preview-296.yml");

function stripJsonc(raw) {
  return raw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
}

function must(cond, message) {
  if (!cond) {
    console.error(`preview296 wrangler assert failed: ${message}`);
    process.exit(1);
  }
}

const raw = fs.readFileSync(wranglerPath, "utf8");
const cfg = JSON.parse(stripJsonc(raw));
const preview = cfg.env?.preview296;

must(cfg.name === "verthill-chat", "default wrangler name must stay verthill-chat");
must(cfg.r2_buckets?.[0]?.bucket_name === "verthill-chat-media", "default R2 stays production bucket name");
must(preview, "env.preview296 missing");
must(preview.name === "verthill-chat-preview-296", "preview worker name");
must(preview.r2_buckets?.[0]?.bucket_name === "verthill-chat-media-preview-296", "preview R2 bucket");
must(preview.r2_buckets?.[0]?.binding === "CHAT_MEDIA", "preview R2 binding");
must(preview.r2_buckets?.[0]?.bucket_name !== "verthill-chat-media", "preview R2 must not be production");
must(Array.isArray(preview.migrations) && preview.migrations.some((m) => m.tag === "v1"), "preview has v1 DO migration");
must(Array.isArray(preview.migrations) && preview.migrations.some((m) => m.tag === "v2"), "preview has v2 DO migration");
must(preview.preview_urls === false, "preview_urls stay false");
must(!/"CHAT_MEDIA_SECRET"\s*:/.test(raw), "no media secret values in wrangler");
must(!/"CHAT_AUTH_SECRET"\s*:/.test(raw), "no auth secret values in wrangler");

const prodWf = fs.readFileSync(workflowProd, "utf8");
must(/wrangler deploy\s*$/m.test(prodWf), "production workflow still default deploy");
must(!prodWf.includes("--env preview296"), "production workflow must not deploy preview296");
must(!prodWf.includes("verthill-chat-preview-296"), "production workflow must not name preview worker");

const previewWf = fs.readFileSync(workflowPreview, "utf8");
must(previewWf.includes("wrangler deploy --env preview296"), "preview workflow uses --env preview296");
must(previewWf.includes("verthill-chat-preview-296"), "preview workflow targets isolated name");
must(!/wrangler deploy\s*$/m.test(previewWf.replace(/wrangler deploy --env preview296/g, "")), "preview workflow never bare deploy");

console.log("preview296 wrangler isolation assert ok");
