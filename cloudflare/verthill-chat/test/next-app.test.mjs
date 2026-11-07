// 로컬 단위 테스트: Worker → Next 호출 대상(정확 호스트), bypass 헤더 포함/제외, 리다이렉트 차단, 운영 동작 불변.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const out = await build({
  entryPoints: { nextApp: "src/nextApp.ts", sessionCheck: "src/sessionCheck.ts" },
  bundle: true, format: "esm", platform: "neutral", write: false, outdir: "/tmp/na",
});
const load = async (name) => import("data:text/javascript;base64," +
  Buffer.from(out.outputFiles.find((f) => f.path.endsWith(`${name}.js`)).text).toString("base64"));
const na = await load("nextApp");
const sc = await load("sessionCheck");
const originCli = require("../scripts/assert-preview-app-origin.cjs");

const H = "caddy-system-gt8t-git-preview-session-r-fd6310-jh9716s-projects.vercel.app";
const PV = `https://${H}`;
const prev = (extra = {}) => ({ CHAT_TOKEN_AUDIENCE: "preview", ...extra });
const BYPASS = "test-bypass-value-not-real-0000";

const DENY = [
  "", " " + PV, PV + " ", "http://" + H, `https://${H}.`, `https://${H}./`, `https://${H.toUpperCase()}`,
  `https://Caddy-system-gt8t-git-preview-session-r-fd6310-jh9716s-projects.vercel.app`,
  "https://caddy-system-gt8t-a1b2c3d4e-jh9716s-projects.vercel.app",
  "https://caddy-system-gt8t-abc123xyz-jh9716s-projects.vercel.app/api/chat/push-dispatch",
  "https://caddy-system-gt8t.vercel.app", "https://caddy-system-gt8t-git-main-jh9716s-projects.vercel.app",
  "https://caddy-system-gt8t-git-feature-x-jh9716s-projects.vercel.app",
  "https://caddy-system-gt8t-git-preview-session-r-fd63102-jh9716s-projects.vercel.app",
  "https://www.verthill.kr", "https://www.verthill.kr/api/chat/push-dispatch", "https://verthill.kr", "https://x.verthill.kr",
  `https://${H}.evil.com`, `https://evil-${H}`, `https://x.${H}`, `https://${H}@evil.com`, `https://user:pw@${H}`,
  `https://evil.com@${H}`, `https://${H}:443`, `https://${H}:8443`, `https://xn--caddy-system-gt8t-git-preview-session-r-fd6310-jh9716s-projects.vercel.app`,
  "https://127.0.0.1", "https://[::1]", "javascript:alert(1)", `${PV}/other`, `${PV}/api/chat/session-check`, `${PV}/?a=1`, `${PV}/#f`,
  `${PV}/%61pi/chat/push-dispatch`, `${PV}//evil.com`, `${PV}\\@evil.com`, `${PV}/api/chat/push-dispatch/`, `${PV}/api/chat/push-dispatch?x`,
];

test("정확한 Preview 호스트만 허용, 나머지 전부 거부", () => {
  for (const u of [PV, PV + "/", PV + "/api/chat/push-dispatch"]) assert.equal(na.isAllowedPreviewAppUrl(u), true, u);
  for (const u of DENY) assert.equal(na.isAllowedPreviewAppUrl(u), false, u);
  // 설정으로 넓힐 수 없음 (allowlist 변수 제거)
  assert.equal(na.isAllowedPreviewAppUrl("https://www.verthill.kr", { CHAT_PREVIEW_APP_ALLOWED_HOSTS: "www.verthill.kr" }), false);
  const src = readFileSync("src/nextApp.ts", "utf8") + readFileSync("src/index.ts", "utf8");
  assert.doesNotMatch(src, /CHAT_PREVIEW_APP_ALLOWED_HOSTS/);
});

test("워크플로 app_origin 검증기: 같은 호스트만", () => {
  assert.equal(originCli.PREVIEW_APP_HOST, na.PREVIEW_APP_HOST);
  assert.equal(originCli.isAllowedPreviewOrigin(PV), true);
  assert.equal(originCli.isAllowedPreviewOrigin(PV + "/"), true);
  for (const u of [...DENY, PV + "/api/chat/push-dispatch", PV + "//"]) assert.equal(originCli.isAllowedPreviewOrigin(u), false, u);
});

test("preview: URL 유도, bypass 헤더는 정확 호스트 + secret 일 때만", () => {
  const env = prev({ CHAT_PUSH_DISPATCH_URL: PV + "/api/chat/push-dispatch", PREVIEW_APP_BYPASS_SECRET: BYPASS });
  const url = na.nextAppUrl(env, "/api/chat/session-check");
  assert.equal(url, PV + "/api/chat/session-check");
  assert.equal(na.nextPushDispatchUrl(env), PV + "/api/chat/push-dispatch");
  assert.deepEqual(na.nextAppExtraHeaders(env, url), { "x-vercel-protection-bypass": BYPASS });
  for (const u of DENY.filter((d) => d === d.trim() && /^https?:\/\//.test(d)))
    assert.deepEqual(na.nextAppExtraHeaders(env, u.replace(/\/$/, "") + "/api/chat/session-check"), {}, u);
  assert.deepEqual(na.nextAppExtraHeaders(prev({ CHAT_PUSH_DISPATCH_URL: PV }), url), {});
  for (const bad of DENY) {
    const e = prev({ CHAT_PUSH_DISPATCH_URL: bad, PREVIEW_APP_BYPASS_SECRET: BYPASS });
    assert.equal(na.nextAppUrl(e, "/api/chat/session-check"), "", bad);
    assert.equal(na.nextPushDispatchUrl(e), "", bad);
  }
  assert.deepEqual(na.nextAppFetchInit(env), { redirect: "manual" });
});

test("운영: 기존 유도·fetch 옵션과 동일, bypass 헤더 없음, redirect 옵션 없음", () => {
  const old = (raw, p) => { const s = String(raw || "").trim(); if (!s) return ""; try { const u = new URL(s); u.pathname = p; u.search = ""; return u.toString(); } catch { return ""; } };
  const samples = ["", "https://www.verthill.kr/api/chat/push-dispatch", "https://www.verthill.kr/api/chat/push-dispatch?x=1", " https://a.b/c ", "not a url", PV];
  for (const aud of [undefined, "", "production"]) for (const raw of samples) {
    const env = { CHAT_TOKEN_AUDIENCE: aud, CHAT_PUSH_DISPATCH_URL: raw, PREVIEW_APP_BYPASS_SECRET: BYPASS };
    for (const p of ["/api/chat/session-check", "/api/chat/attachments/consume", "/api/chat/attachments/cleanup"]) assert.equal(na.nextAppUrl(env, p), old(raw, p));
    assert.equal(na.nextPushDispatchUrl(env), String(raw).trim());
    assert.deepEqual(na.nextAppExtraHeaders(env, "https://www.verthill.kr/x"), {});
    assert.deepEqual(na.nextAppExtraHeaders(env, PV + "/x"), {});
    assert.deepEqual(na.nextAppFetchInit(env), {});
  }
});

const claims = { v: 2, userId: 7, sid: "s", sv: 3, role: "caddy", name: "n", iat: 1, exp: 9999999999 };
async function withFetch(fn, impl) {
  const orig = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return impl ? impl(url, init) : new Response('{"ok":true}', { status: 200 }); };
  try { return { r: await fn(), calls }; } finally { globalThis.fetch = orig; }
}
const PE = prev({ CHAT_AUTH_SECRET: "a", CHAT_INTERNAL_SECRET: "i", CHAT_PUSH_DISPATCH_URL: PV + "/api/chat/push-dispatch", PREVIEW_APP_BYPASS_SECRET: BYPASS });

test("W1: Worker session-check skip is /ws WebSocket upgrade only", () => {
  assert.equal(sc.shouldSkipWorkerSessionCheck("/ws", "websocket"), true);
  assert.equal(sc.shouldSkipWorkerSessionCheck("/ws", "WebSocket"), true);
  assert.equal(sc.shouldSkipWorkerSessionCheck("/ws", null), false, "HTTP /ws probe still checks");
  assert.equal(sc.shouldSkipWorkerSessionCheck("/ws", ""), false);
  assert.equal(sc.shouldSkipWorkerSessionCheck("/directory/ws", "websocket"), false, "Directory never skips");
  assert.equal(sc.shouldSkipWorkerSessionCheck("/directory/rooms", "websocket"), false);
  assert.equal(sc.shouldSkipWorkerSessionCheck("/health", "websocket"), false);
});

test("preview session-check: 200/401/403/503/redirect/미설정", async () => {
  let { r, calls } = await withFetch(() => sc.assertChatSessionCurrent(PE, claims));
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PV + "/api/chat/session-check");
  assert.equal(calls[0].init.headers["x-vercel-protection-bypass"], BYPASS);
  assert.equal(calls[0].init.redirect, "manual");
  for (const [st, exp] of [[401, { ok: false, status: 401, error: "stale_session" }], [403, { ok: false, status: 401, error: "stale_session" }],
    [503, { ok: false, status: 503, error: "session_check_unavailable" }]]) {
    ({ r } = await withFetch(() => sc.assertChatSessionCurrent(PE, claims), () => new Response("x", { status: st })));
    assert.deepEqual(r, exp, String(st));
  }
  for (const st of [301, 302, 303, 307, 308]) {
    ({ r, calls } = await withFetch(() => sc.assertChatSessionCurrent(PE, claims),
      () => new Response(null, { status: st, headers: { location: "https://evil.example/steal" } })));
    assert.deepEqual(r, { ok: false, status: 503, error: "session_check_unavailable" }, String(st));
    assert.equal(calls.length, 1, "리다이렉트 재요청 없음");
    assert.ok(calls.every((c) => !String(c.url).includes("evil")));
  }
  ({ r, calls } = await withFetch(() => sc.assertChatSessionCurrent(PE, claims), () => ({ status: 0, type: "opaqueredirect", ok: false })));
  assert.deepEqual(r, { ok: false, status: 503, error: "session_check_unavailable" });
  for (const env of [prev({ CHAT_AUTH_SECRET: "a", CHAT_INTERNAL_SECRET: "i" }),
    prev({ CHAT_AUTH_SECRET: "a", CHAT_INTERNAL_SECRET: "i", CHAT_PUSH_DISPATCH_URL: "https://caddy-system-gt8t-a1b2c3d4e-jh9716s-projects.vercel.app/api/chat/push-dispatch" }),
    prev({ CHAT_AUTH_SECRET: "a", CHAT_INTERNAL_SECRET: "i", CHAT_PUSH_DISPATCH_URL: "https://www.verthill.kr/api/chat/push-dispatch" })]) {
    ({ r, calls } = await withFetch(() => sc.assertChatSessionCurrent(env, claims)));
    assert.deepEqual(r, { ok: false, status: 503, error: "session_check_unconfigured" });
    assert.equal(calls.length, 0);
  }
});

test("운영 session-check: fetch 인자/결과가 main 과 동일 (redirect 옵션·bypass 없음)", async () => {
  const pr = { CHAT_AUTH_SECRET: "a", CHAT_INTERNAL_SECRET: "i", CHAT_PUSH_DISPATCH_URL: "https://www.verthill.kr/api/chat/push-dispatch", PREVIEW_APP_BYPASS_SECRET: BYPASS };
  const { r, calls } = await withFetch(() => sc.assertChatSessionCurrent(pr, claims));
  assert.deepEqual(r, { ok: true });
  assert.equal(calls[0].url, "https://www.verthill.kr/api/chat/session-check");
  assert.deepEqual(Object.keys(calls[0].init).sort(), ["body", "headers", "method", "signal"]);
  assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ["content-type", "x-chat-internal-auth", "x-chat-internal-ts"]);
  // 운영에서 302 는 기존처럼 !ok → stale_session 401 (main 과 동일 결과)
  const { r: r2 } = await withFetch(() => sc.assertChatSessionCurrent(pr, claims), () => new Response(null, { status: 302 }));
  assert.deepEqual(r2, { ok: false, status: 401, error: "stale_session" });
});

test("index.ts: Next 호출 4곳 모두 nextAppFetchInit 사용", () => {
  const idx = readFileSync("src/index.ts", "utf8");
  assert.equal((idx.match(/\.\.\.nextAppFetchInit\(this\.env\)/g) || []).length, 3); // cleanup, consume, push-dispatch
  assert.match(readFileSync("src/sessionCheck.ts", "utf8"), /\.\.\.nextAppFetchInit\(env\)/);
});

test("로컬 하네스 플래그: 127.0.0.1 http 만, bypass 헤더 없음, 플래그 없으면 거부", () => {
  const base = prev({ CHAT_PUSH_DISPATCH_URL: "http://127.0.0.1:5555", PREVIEW_APP_BYPASS_SECRET: BYPASS });
  assert.equal(na.nextAppUrl(base, "/api/chat/session-check"), "");
  const h = { ...base, CHAT_PREVIEW_LOCAL_HARNESS: "1" };
  assert.equal(na.nextAppUrl(h, "/api/chat/session-check"), "http://127.0.0.1:5555/api/chat/session-check");
  assert.deepEqual(na.nextAppExtraHeaders(h, "http://127.0.0.1:5555/api/chat/session-check"), {});
  for (const u of ["http://localhost:5555", "http://127.0.0.2:5555", "http://127.0.0.1:5555/x", "http://evil@127.0.0.1:5555", "https://www.verthill.kr"])
    assert.equal(na.nextAppUrl({ ...h, CHAT_PUSH_DISPATCH_URL: u }, "/p"), "", u);
  assert.doesNotMatch(readFileSync("wrangler.jsonc", "utf8"), /CHAT_PREVIEW_LOCAL_HARNESS|PREVIEW_APP_BYPASS_SECRET/);
  assert.doesNotMatch(readFileSync("../../.github/workflows/cloudflare-worker-preview-deploy.yml", "utf8"), /CHAT_PREVIEW_LOCAL_HARNESS/);
});

test("PR #349: 이전 Preview 별칭(preview-db-workflow)·Production 도메인 거부", () => {
  for (const u of ["https://caddy-system-gt8t-git-preview-db-workflow-jh9716s-projects.vercel.app",
    "https://caddy-system-gt8t-git-preview-db-workflow-jh9716s-projects.vercel.app/api/chat/push-dispatch",
    "https://caddy-system-gt8t-git-preview-session-revoke-fix-jh9716s-projects.vercel.app",
    "https://www.verthill.kr/api/chat/push-dispatch", "https://caddy-system-gt8t-git-main-jh9716s-projects.vercel.app"]) {
    assert.equal(na.isAllowedPreviewAppUrl(u), false, u);
    assert.equal(originCli.isAllowedPreviewOrigin(u), false, u);
  }
  assert.equal(H, "caddy-system-gt8t-git-preview-session-r-fd6310-jh9716s-projects.vercel.app");
});

test("probeChatSession(열린 소켓 재검증): Preview bypass+manual, 리다이렉트=unknown, 운영 불변", async () => {
  let { r, calls } = await withFetch(() => sc.probeChatSession(PE, claims));
  assert.equal(r, "current");
  assert.equal(calls[0].url, PV + "/api/chat/session-check");
  assert.equal(calls[0].init.headers["x-vercel-protection-bypass"], BYPASS);
  assert.equal(calls[0].init.redirect, "manual");
  ({ r } = await withFetch(() => sc.probeChatSession(PE, claims), () => new Response('{"ok":false,"code":"stale_session"}', { status: 401 })));
  assert.equal(r, "revoked");
  for (const st of [302, 307, 308]) {
    ({ r, calls } = await withFetch(() => sc.probeChatSession(PE, claims), () => new Response(null, { status: st, headers: { location: "https://evil.example/" } })));
    assert.equal(r, "unknown"); assert.equal(calls.length, 1);
  }
  // Vercel Protection 401 (JSON code 없음) → revoked 아님(unknown): 오탐으로 소켓 끊지 않음
  ({ r } = await withFetch(() => sc.probeChatSession(PE, claims), () => new Response("<html>auth</html>", { status: 401 })));
  assert.equal(r, "unknown");
  // 호스트 불일치 → 호출 없음
  ({ r, calls } = await withFetch(() => sc.probeChatSession({ ...PE, CHAT_PUSH_DISPATCH_URL: "https://www.verthill.kr/api/chat/push-dispatch" }, claims)));
  assert.equal(r, "unknown"); assert.equal(calls.length, 0);
  const pr = { CHAT_AUTH_SECRET: "a", CHAT_INTERNAL_SECRET: "i", CHAT_PUSH_DISPATCH_URL: "https://www.verthill.kr/api/chat/push-dispatch", PREVIEW_APP_BYPASS_SECRET: BYPASS };
  for (const aud of [undefined, "production"]) {
    ({ r, calls } = await withFetch(() => sc.probeChatSession({ ...pr, CHAT_TOKEN_AUDIENCE: aud }, claims)));
    assert.equal(r, "current");
    assert.deepEqual(Object.keys(calls[0].init).sort(), ["body", "headers", "method", "signal"]);
    assert.equal(calls[0].init.headers["x-vercel-protection-bypass"], undefined);
  }
});

test("Preview: bypass secret 미설정 → 헤더 없이 호출(=Vercel 401) → fail-closed stale_session, 헤더 누출 없음", async () => {
  const env = { ...PE }; delete env.PREVIEW_APP_BYPASS_SECRET;
  const { r, calls } = await withFetch(() => sc.assertChatSessionCurrent(env, claims), () => new Response("auth", { status: 401 }));
  assert.deepEqual(r, { ok: false, status: 401, error: "stale_session" });
  assert.equal(calls[0].init.headers["x-vercel-protection-bypass"], undefined);
  // 내부 HMAC 헤더 유지
  assert.ok(calls[0].init.headers["x-chat-internal-auth"]);
});

test("Preview 배포 워크플로: 코드만 배포, secrets-file/secret put 없음, 운영 워크플로 불변", () => {
  const previewWf = readFileSync("../../.github/workflows/cloudflare-worker-preview-deploy.yml", "utf8");
  const prodWf = readFileSync("../../.github/workflows/cloudflare-worker-deploy.yml", "utf8");
  const wranglerLines = previewWf.split("\n").filter((l) => /wrangler deploy/.test(l));
  assert.ok(wranglerLines.length >= 2, "dry-run + deploy");
  for (const line of wranglerLines) {
    assert.doesNotMatch(line, /--secrets-file/);
    assert.match(line, /--env preview|--env "\$DEPLOY_ENV"/);
    assert.match(line, /--name verthill-chat-preview/);
    assert.match(line, /--keep-vars/);
  }
  assert.doesNotMatch(previewWf, /wrangler secret /);
  assert.doesNotMatch(previewWf, /PREVIEW_CHAT_AUTH_SECRET|PREVIEW_CHAT_INTERNAL_SECRET|PREVIEW_VERCEL_AUTOMATION_BYPASS_SECRET/);
  assert.doesNotMatch(previewWf, /JSON\.stringify\(\{CHAT_AUTH_SECRET/);
  assert.match(previewWf, /wrangler deploy --env preview --name verthill-chat-preview --keep-vars/);
  assert.match(previewWf, /preview-chat-pr349-719c90f/);
  assert.match(prodWf, /No delete \/ reset \/ secret put/);
  assert.doesNotMatch(prodWf, /--env preview|--secrets-file|verthill-chat-preview/);
});

test("소스: secret 하드코딩·로그 출력 없음", () => {
  for (const f of ["src/nextApp.ts", "src/sessionCheck.ts", "src/index.ts", "src/directory.ts"]) {
    const s = readFileSync(f, "utf8");
    assert.doesNotMatch(s, /console\.[a-z]+\([^)]*PREVIEW_APP_BYPASS_SECRET/, f);
    assert.doesNotMatch(s, /console\.[a-z]+\([^)]*(bypass|secret)\b[^)]*\)/i, f);
  }
});
