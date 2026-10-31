// 로컬 단위 테스트: Worker → Next 호출 대상 검증, bypass 헤더 포함/제외, 미설정 503, 운영 동작 불변.
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

const PV = "https://caddy-system-gt8t-git-feature-x-jh9716s-projects.vercel.app";
const PVD = "https://caddy-system-gt8t-a1b2c3d4e-jh9716s-projects.vercel.app";
const prev = (extra = {}) => ({ CHAT_TOKEN_AUDIENCE: "preview", ...extra });
const BYPASS = "test-bypass-value-not-real-0000";

test("preview: 허용/거부 호스트 행렬", () => {
  const ok = [PV, PV + "/", PV + "/api/chat/push-dispatch", PVD];
  const bad = [
    "", " " + PV, PV + " ", "http://caddy-system-gt8t-git-x-jh9716s-projects.vercel.app",
    "https://www.verthill.kr/api/chat/push-dispatch", "https://verthill.kr", "https://x.verthill.kr",
    "https://user:pw@caddy-system-gt8t-git-x-jh9716s-projects.vercel.app",
    "https://caddy-system-gt8t-git-x-jh9716s-projects.vercel.app@evil.com",
    "https://caddy-system-gt8t-git-x-jh9716s-projects.vercel.app:8443",
    "https://caddy-system-gt8t-git-x-jh9716s-projects.vercel.app:443",
    "https://caddy-system-gt8t-git-x-jh9716s-projects.vercel.app.evil.com",
    "https://evil-caddy-system-gt8t-git-x-jh9716s-projects.vercel.app",
    "https://caddy-system-gt8t-git-x-otheruser-projects.vercel.app",
    "https://caddy-system-git-x-jh9716s-projects.vercel.app",
    "https://CADDY-SYSTEM-GT8T-git-x-jh9716s-projects.vercel.app",
    "https://caddy-system-gt8t--jh9716s-projects.vercel.app",
    PV + "/other", PV + "/?a=1", PV + "/#f", PV + "/%2e%2e/", PV + "\\x",
    "https://caddy-system-gt8t-git-x-jh9716s-projects.vercel.app./",
    "https://127.0.0.1", "https://verthill-chat.19970106s.workers.dev", "javascript:alert(1)",
  ];
  for (const u of ok) assert.equal(na.isAllowedPreviewAppUrl(u, prev()), true, u);
  for (const u of bad) assert.equal(na.isAllowedPreviewAppUrl(u, prev()), false, u);
  // 명시 허용 목록 (정확 일치만)
  const env = prev({ CHAT_PREVIEW_APP_ALLOWED_HOSTS: "preview.example.com" });
  assert.equal(na.isAllowedPreviewAppUrl("https://preview.example.com", env), true);
  assert.equal(na.isAllowedPreviewAppUrl("https://a.preview.example.com", env), false);
  assert.equal(na.isAllowedPreviewAppUrl("https://www.verthill.kr",
    prev({ CHAT_PREVIEW_APP_ALLOWED_HOSTS: "www.verthill.kr" })), false);
});

test("워크플로 입력 검증기 규칙이 Worker 와 동일", () => {
  const src = readFileSync("src/nextApp.ts", "utf8");
  assert.ok(src.includes(originCli.PREVIEW_VERCEL_HOST.source.replace(/\//g, "\\/")) || src.includes(originCli.PREVIEW_VERCEL_HOST.source));
  assert.equal(originCli.isAllowedPreviewOrigin(PV), true);
  assert.equal(originCli.isAllowedPreviewOrigin(PV + "/api/chat/push-dispatch"), false);
  assert.equal(originCli.isAllowedPreviewOrigin("https://www.verthill.kr"), false);
  assert.equal(originCli.isAllowedPreviewOrigin("http://" + PV.slice(8)), false);
});

test("preview: URL 유도 + bypass 헤더는 검증 호스트 + secret 있을 때만", () => {
  const env = prev({ CHAT_PUSH_DISPATCH_URL: PV + "/api/chat/push-dispatch", PREVIEW_APP_BYPASS_SECRET: BYPASS });
  const url = na.nextAppUrl(env, "/api/chat/session-check");
  assert.equal(url, PV + "/api/chat/session-check");
  assert.equal(na.nextPushDispatchUrl(env), PV + "/api/chat/push-dispatch");
  assert.deepEqual(na.nextAppExtraHeaders(env, url), { "x-vercel-protection-bypass": BYPASS });
  assert.deepEqual(na.nextAppExtraHeaders(env, "https://www.verthill.kr/api/chat/session-check"), {});
  assert.deepEqual(na.nextAppExtraHeaders(prev({ CHAT_PUSH_DISPATCH_URL: PV }), url), {});
  // 운영 호스트를 넣은 preview Worker → 호출 자체 안 함 (fail-closed)
  const badEnv = prev({ CHAT_PUSH_DISPATCH_URL: "https://www.verthill.kr/api/chat/push-dispatch", PREVIEW_APP_BYPASS_SECRET: BYPASS });
  assert.equal(na.nextAppUrl(badEnv, "/api/chat/session-check"), "");
  assert.equal(na.nextPushDispatchUrl(badEnv), "");
});

test("운영: 기존 유도 로직과 동일, bypass 헤더 절대 없음", () => {
  const old = (raw, p) => { const s = String(raw || "").trim(); if (!s) return ""; try { const u = new URL(s); u.pathname = p; u.search = ""; return u.toString(); } catch { return ""; } };
  const samples = ["", "https://www.verthill.kr/api/chat/push-dispatch", "https://www.verthill.kr/api/chat/push-dispatch?x=1", " https://a.b/c ", "not a url", PV];
  for (const aud of [undefined, "", "production"]) for (const raw of samples) {
    const env = { CHAT_TOKEN_AUDIENCE: aud, CHAT_PUSH_DISPATCH_URL: raw, PREVIEW_APP_BYPASS_SECRET: BYPASS };
    for (const p of ["/api/chat/session-check", "/api/chat/attachments/consume"]) assert.equal(na.nextAppUrl(env, p), old(raw, p));
    assert.equal(na.nextPushDispatchUrl(env), String(raw).trim());
    assert.deepEqual(na.nextAppExtraHeaders(env, "https://www.verthill.kr/x"), {});
    assert.deepEqual(na.nextAppExtraHeaders(env, PV + "/x"), {});
  }
});

const claims = { v: 2, userId: 7, sid: "s", sv: 3, role: "caddy", name: "n", iat: 1, exp: 9999999999 };
async function withFetch(fn, impl) {
  const orig = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, headers: init.headers }); return impl ? impl() : new Response('{"ok":true}', { status: 200 }); };
  try { return { r: await fn(), calls }; } finally { globalThis.fetch = orig; }
}

test("session-check: 미설정·운영호스트 → 503 unconfigured, 호출 없음", async () => {
  for (const env of [prev({ CHAT_AUTH_SECRET: "a", CHAT_INTERNAL_SECRET: "i" }),
    prev({ CHAT_AUTH_SECRET: "a", CHAT_INTERNAL_SECRET: "i", CHAT_PUSH_DISPATCH_URL: "https://www.verthill.kr/api/chat/push-dispatch" }),
    { CHAT_AUTH_SECRET: "a", CHAT_INTERNAL_SECRET: "i" }]) {
    const { r, calls } = await withFetch(() => sc.assertChatSessionCurrent(env, claims));
    assert.deepEqual(r, { ok: false, status: 503, error: "session_check_unconfigured" });
    assert.equal(calls.length, 0);
  }
});

test("session-check: preview 는 bypass 헤더 포함, 운영은 미포함", async () => {
  const pe = prev({ CHAT_AUTH_SECRET: "a", CHAT_INTERNAL_SECRET: "i", CHAT_PUSH_DISPATCH_URL: PV + "/api/chat/push-dispatch", PREVIEW_APP_BYPASS_SECRET: BYPASS });
  let { r, calls } = await withFetch(() => sc.assertChatSessionCurrent(pe, claims));
  assert.deepEqual(r, { ok: true });
  assert.equal(calls[0].url, PV + "/api/chat/session-check");
  assert.equal(calls[0].headers["x-vercel-protection-bypass"], BYPASS);
  const pr = { CHAT_AUTH_SECRET: "a", CHAT_INTERNAL_SECRET: "i", CHAT_PUSH_DISPATCH_URL: "https://www.verthill.kr/api/chat/push-dispatch", PREVIEW_APP_BYPASS_SECRET: BYPASS };
  ({ r, calls } = await withFetch(() => sc.assertChatSessionCurrent(pr, claims)));
  assert.equal(calls[0].url, "https://www.verthill.kr/api/chat/session-check");
  assert.equal("x-vercel-protection-bypass" in calls[0].headers, false);
  // SSO 차단(401 HTML) → stale_session 401 (현 증상 재현)
  ({ r } = await withFetch(() => sc.assertChatSessionCurrent(pe, claims), () => new Response("<html>", { status: 401 })));
  assert.deepEqual(r, { ok: false, status: 401, error: "stale_session" });
});

test("로컬 하네스 플래그: 127.0.0.1 http 만, bypass 헤더 없음, 플래그 없으면 거부", () => {
  const base = prev({ CHAT_PUSH_DISPATCH_URL: "http://127.0.0.1:5555", PREVIEW_APP_BYPASS_SECRET: BYPASS });
  assert.equal(na.nextAppUrl(base, "/api/chat/session-check"), "");
  const h = { ...base, CHAT_PREVIEW_LOCAL_HARNESS: "1" };
  assert.equal(na.nextAppUrl(h, "/api/chat/session-check"), "http://127.0.0.1:5555/api/chat/session-check");
  assert.deepEqual(na.nextAppExtraHeaders(h, "http://127.0.0.1:5555/api/chat/session-check"), {});
  for (const u of ["http://localhost:5555", "http://127.0.0.2:5555", "http://127.0.0.1:5555/x", "http://evil@127.0.0.1:5555", "https://www.verthill.kr"])
    assert.equal(na.nextAppUrl({ ...h, CHAT_PUSH_DISPATCH_URL: u }, "/p"), "", u);
  const cfg = readFileSync("wrangler.jsonc", "utf8");
  assert.doesNotMatch(cfg, /CHAT_PREVIEW_LOCAL_HARNESS|PREVIEW_APP_BYPASS_SECRET/);
  assert.doesNotMatch(readFileSync("../../.github/workflows/cloudflare-worker-preview-deploy.yml", "utf8"), /CHAT_PREVIEW_LOCAL_HARNESS/);
});
