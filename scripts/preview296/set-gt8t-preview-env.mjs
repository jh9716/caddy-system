/**
 * Point gt8t #296 Preview at the isolated Worker + prepared isolated DB.
 * Never writes Production Vercel env. Never sets CHAT_PUSH_DISPATCH_URL.
 */
const BRANCH = "cursor/chat-photo-preview-first-send-1267";
const PREVIEW_WORKER = "verthill-chat-preview-296.19970106s.workers.dev";
const PROD_WORKER = "verthill-chat.19970106s.workers.dev";
const PROD_NEON = "ep-crimson-cell-a1i1tpce";

const token = String(process.env.VERCEL_TOKEN || "").trim();
const teamId = String(process.env.VERCEL_ORG_ID || process.env.VERCEL_TEAM_ID || "").trim();
const projectId = String(process.env.VERCEL_PROJECT_ID || "").trim();

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} missing`);
  return value;
}

if (!token) throw new Error("VERCEL_TOKEN missing");
if (!projectId) throw new Error("VERCEL_PROJECT_ID missing");

const databaseUrl = required("DATABASE_URL");
const wsUrl = required("NEXT_PUBLIC_CHAT_WS_URL");
const workerUrl = required("CHAT_WORKER_URL");
const chatAuth = required("CHAT_AUTH_SECRET");
const chatMedia = required("CHAT_MEDIA_SECRET");
const chatInternal = required("CHAT_INTERNAL_SECRET");
const photoStorage = String(process.env.CHAT_PHOTO_STORAGE || "r2").trim();

if (databaseUrl.includes(PROD_NEON)) throw new Error("refusing production Neon");
if (new URL(databaseUrl).hostname === "localhost") throw new Error("refusing localhost DATABASE_URL");
if (!wsUrl.includes(PREVIEW_WORKER) || wsUrl.includes(PROD_WORKER)) {
  throw new Error("NEXT_PUBLIC_CHAT_WS_URL must be isolated preview296 Worker");
}
if (!workerUrl.includes(PREVIEW_WORKER) || workerUrl.includes(PROD_WORKER)) {
  throw new Error("CHAT_WORKER_URL must be isolated preview296 Worker");
}
if (photoStorage !== "r2") throw new Error("CHAT_PHOTO_STORAGE must be r2");

const qs = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";

async function api(path, init = {}) {
  const res = await fetch(`https://api.vercel.com${path}${path.includes("?") ? (teamId ? `&teamId=${encodeURIComponent(teamId)}` : "") : qs}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`vercel ${init.method || "GET"} ${path} ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

const upserts = {
  NEXT_PUBLIC_CHAT_WS_URL: wsUrl,
  CHAT_WORKER_URL: workerUrl,
  DATABASE_URL: databaseUrl,
  CHAT_AUTH_SECRET: chatAuth,
  CHAT_MEDIA_SECRET: chatMedia,
  CHAT_INTERNAL_SECRET: chatInternal,
  CHAT_PHOTO_STORAGE: photoStorage,
};

const envList = await api(`/v9/projects/${projectId}/env`);
const envs = Array.isArray(envList?.envs) ? envList.envs : [];

function isThisBranchPreview(item) {
  const targets = item?.target || [];
  if (targets.includes("production")) return false;
  if (!targets.includes("preview")) return false;
  return String(item?.gitBranch || "") === BRANCH;
}

for (const item of envs) {
  if (!isThisBranchPreview(item)) continue;
  if (item.key === "CHAT_PUSH_DISPATCH_URL" || Object.prototype.hasOwnProperty.call(upserts, item.key)) {
    await api(`/v9/projects/${projectId}/env/${item.id}`, { method: "DELETE" });
  }
}

for (const [key, value] of Object.entries(upserts)) {
  await api(`/v10/projects/${projectId}/env`, {
    method: "POST",
    body: JSON.stringify({
      key,
      value,
      type: "encrypted",
      target: ["preview"],
      gitBranch: BRANCH,
    }),
  });
}

const inheritedPush = envs.find((item) => {
  const targets = item?.target || [];
  if (item.key !== "CHAT_PUSH_DISPATCH_URL") return false;
  if (targets.includes("production")) return false;
  if (!targets.includes("preview")) return false;
  return !item.gitBranch || item.gitBranch === BRANCH;
});
if (inheritedPush) {
  console.log(
    JSON.stringify({
      warning: "CHAT_PUSH_DISPATCH_URL still listed on a Preview env row; boot assert rejects Production URLs",
    })
  );
}

let redeployed = false;
try {
  const sha = String(process.env.GITHUB_SHA || "").trim();
  await api(`/v13/deployments`, {
    method: "POST",
    body: JSON.stringify({
      name: "caddy-system-gt8t",
      gitSource: {
        type: "github",
        org: "jh9716",
        repo: "caddy-system",
        ref: BRANCH,
        ...(sha ? { sha } : {}),
      },
      target: "preview",
    }),
  });
  redeployed = true;
} catch (error) {
  console.log(
    JSON.stringify({
      vercelEnv: "set",
      redeploy: "failed",
      message: error instanceof Error ? error.message : String(error),
    })
  );
}

console.log(
  JSON.stringify({
    ok: true,
    project: "gt8t",
    gitBranch: BRANCH,
    worker: PREVIEW_WORKER,
    dbHost: new URL(databaseUrl).hostname,
    pushDispatch: "unset",
    redeployed,
  })
);
