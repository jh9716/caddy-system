// TEMPORARY DIAGNOSTIC — remove after Preview 401 diagnosis (with src/diag.ts).
// 로컬 단위 테스트: preview 에서만 진단 로그, 금지 정보 미포함, 운영은 무출력·main 과 동일 응답.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { signTestTokenV2 } from "./token-helper.mjs";

const stub = { name: "cfw", setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cfw", namespace: "cfw" }));
  b.onLoad({ filter: /.*/, namespace: "cfw" }, () => ({ contents: "export class DurableObject { constructor(ctx, env){ this.ctx = ctx; this.env = env; } }", loader: "js" }));
} };
async function loadWorker(entry) {
  const out = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", write: false, plugins: [stub], logLevel: "silent" });
  return (await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"))).default;
}
const cur = await loadWorker("src/index.ts");
const MAIN = "/tmp/mainwt/cloudflare/verthill-chat/src/index.ts";
const mainW = existsSync(MAIN) ? await loadWorker(MAIN) : null;

const PV = "https://caddy-system-gt8t-git-preview-db-workflow-jh9716s-projects.vercel.app";
const S = { auth: "SENTINEL_AUTH_SECRET_7f3a9c", internal: "SENTINEL_INTERNAL_SECRET_2b8d", bypass: "SENTINEL_BYPASS_SECRET_91ce", q: "SENTINELQUERY55" };
const UID = 987654;
const dirNs = { idFromName: () => "id", get: () => ({ fetch: async () => new Response('{"rooms":[]}', { status: 200 }) }) };
const envOf = (preview, extra = {}) => ({
  CHAT_AUTH_SECRET: S.auth, CHAT_INTERNAL_SECRET: S.internal, CHAT_DIRECTORY: dirNs, CHAT_ROOM: dirNs,
  CHAT_PUSH_DISPATCH_URL: preview ? PV + "/api/chat/push-dispatch" : "https://www.verthill.kr/api/chat/push-dispatch",
  ...(preview ? { CHAT_TOKEN_AUDIENCE: "preview", PREVIEW_APP_BYPASS_SECRET: S.bypass } : {}), ...extra,
});
const tok = (o = {}) => signTestTokenV2({ userId: UID, displayName: "SENTINELNAME", team: "A", sv: 4, ...o }, o.secret || S.auth).token;

async function run(worker, env, token, nextImpl, path = "/directory/rooms") {
  const logs = []; const calls = [];
  const ol = console.log, oe = console.error, ow = console.warn, of = globalThis.fetch;
  console.log = (...a) => logs.push(a.join(" ")); console.error = (...a) => logs.push("ERR " + a.join(" ")); console.warn = (...a) => logs.push("WARN " + a.join(" "));
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: { ...init, signal: undefined, headers: { ...init.headers, "x-chat-internal-auth": "<sig>", "x-chat-internal-ts": "<ts>" } } }); return nextImpl ? nextImpl() : new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }); };
  try {
    const q = token == null ? `?x=${S.q}` : `?token=${encodeURIComponent(token)}&x=${S.q}`;
    const res = await worker.fetch(new Request("https://w.example" + path + q), env, { waitUntil() {}, passThroughOnException() {} });
    return { status: res.status, body: await res.text(), logs, calls };
  } finally { console.log = ol; console.error = oe; console.warn = ow; globalThis.fetch = of; }
}
const diagLines = (logs) => logs.filter((l) => l.startsWith("[TEMP-DIAG preview-chat-401] ")).map((l) => JSON.parse(l.slice(l.indexOf("{"))));
function assertClean(logs, token) {
  const all = logs.join("\n");
  const forbidden = [S.auth, S.internal, S.bypass, S.q, String(UID), "SENTINELNAME", "token=", PV.slice(8)];
  if (token) forbidden.push(token, ...token.split(".").filter((p) => p.length > 6), token.slice(0, 8), token.slice(-8));
  for (const f of forbidden) assert.ok(!all.includes(f), "로그에 금지 값 포함: " + f.slice(0, 4) + "…");
  for (const k of ["27", "28", "29", "26"]) assert.ok(!/"(len|length)"/.test(all), k);
}

const json = (st, b) => () => new Response(JSON.stringify(b), { status: st, headers: { "content-type": "application/json" } });
const CASES = [
  ["missing token", null, null, { stage: "token", code: "unauthorized", token_reason: "missing" }, 401],
  ["malformed", "abc", null, { code: "invalid_token", token_reason: "malformed" }, 401],
  ["bad signature (secret 불일치)", tok({ aud: "preview", secret: "OTHER_SECRET_zz" }), null, { code: "invalid_token", token_reason: "bad_signature", auth_secret_mismatch_suspect: true }, 401],
  ["audience mismatch", tok(), null, { code: "invalid_token", token_reason: "audience_mismatch", auth_secret_mismatch_suspect: false }, 401],
  ["expired", tok({ aud: "preview", iat: 1000, exp: 2000 }), null, { code: "invalid_token", token_reason: "expired" }, 401],
  ["session ok", tok({ aud: "preview" }), null, { stage: "session_check_response", target_status: 200, vercel_block_suspect: false }, 200],
  ["Vercel 보호 401 HTML", tok({ aud: "preview" }), () => new Response("<html>auth</html>", { status: 401, headers: { "content-type": "text/html", server: "Vercel" } }),
    { stage: "session_check_response", target_status: 401, html_response: true, vercel_block_suspect: true, bypass_configured: true }, 401],
  ["SSO redirect", tok({ aud: "preview" }), () => new Response(null, { status: 302, headers: { location: "https://vercel.com/sso-api?url=x" } }),
    { stage: "session_check_response", target_status: 302, redirect: true, sso_redirect: true, vercel_block_suspect: true }, 503],
  ["Next 403 forbidden (internal secret 불일치)", tok({ aud: "preview" }), json(403, { error: "forbidden" }),
    { target_status: 403, next_error: "forbidden", internal_secret_mismatch_suspect: true, vercel_block_suspect: false }, 401],
  ["Next 401 stale", tok({ aud: "preview" }), json(401, { ok: false, code: "stale_session" }), { target_status: 401, next_error: "stale_session" }, 401],
  ["Next 503", tok({ aud: "preview" }), json(503, { error: "auth_unavailable" }), { target_status: 503, next_error: "auth_unavailable" }, 503],
];

for (const [name, t, impl, expect, status] of CASES) {
  test(`preview diag: ${name}`, async () => {
    const r = await run(cur, envOf(true), t, impl);
    assert.equal(r.status, status, r.body);
    const d = diagLines(r.logs);
    assert.ok(d.length >= 1);
    assert.ok(d.every((x) => x.path === "/directory/rooms"));
    const hit = d.find((x) => Object.entries(expect).every(([k, v]) => x[k] === v));
    assert.ok(hit, JSON.stringify(d));
    const last = d[d.length - 1];
    if (status !== 200) assert.equal(last.status, status);
    assertClean(r.logs, t);
  });
}

test("preview diag: session-check 미설정 → 503 + dispatch_url_configured=false", async () => {
  const r = await run(cur, envOf(true, { CHAT_PUSH_DISPATCH_URL: "" }), tok({ aud: "preview" }));
  assert.equal(r.status, 503);
  assert.ok(diagLines(r.logs).some((x) => x.code === "session_check_unconfigured" && x.dispatch_url_configured === false));
  assertClean(r.logs);
});

test("preview diag: room id 경로는 템플릿으로만", async () => {
  const r = await run(cur, envOf(true), null, null, "/directory/rooms/dm:987654:1/members");
  assert.ok(diagLines(r.logs).every((x) => x.path === "/directory/rooms/:id/members"));
  assertClean(r.logs);
});

test("운영: 진단 로그 0줄, 응답·Next 호출 인자가 main 과 동일", async (t) => {
  if (!mainW) return t.skip("main worktree 없음");
  const scen = [
    [null, null], ["abc", null], [tok({ secret: "OTHER" }), null], [tok({ aud: "preview" }), null], [tok({ iat: 1000, exp: 2000 }), null],
    [tok(), null], [tok(), () => new Response("<html>", { status: 401, headers: { "content-type": "text/html" } })],
    [tok(), () => new Response(null, { status: 302, headers: { location: "https://vercel.com/sso" } })],
    [tok(), json(403, { error: "forbidden" })], [tok(), json(503, { error: "x" })],
  ];
  for (const [t0, impl] of scen) {
    for (const env of [envOf(false), envOf(false, { CHAT_TOKEN_AUDIENCE: "production" }), envOf(false, { PREVIEW_APP_BYPASS_SECRET: S.bypass })]) {
      const a = await run(cur, env, t0, impl); const b = await run(mainW, env, t0, impl);
      assert.equal(a.logs.length, 0, a.logs.join("|"));
      assert.deepEqual([a.status, a.body], [b.status, b.body]);
      assert.deepEqual(a.calls, b.calls);
    }
  }
});
