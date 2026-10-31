// TEMPORARY DIAGNOSTIC — remove after Preview 403 diagnosis. 로컬 단위 테스트.
import { POST } from "../src/app/api/chat/session-check/route";
import { signChatInternalAuth, CHAT_SESSION_CHECK_PATH } from "../src/lib/chatInternalAuth";
import { diagnoseChatInternalRequest } from "../src/lib/chatInternalAuthDiag";
import { NextRequest } from "next/server";

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };
const env = process.env as Record<string, string | undefined>;
const S = { internal: "SENTINEL_INTERNAL_7aa1c9", auth: "SENTINEL_AUTH_55b2e0", other: "SENTINEL_OTHER_c3d4" };
const now = () => Math.floor(Date.now() / 1000);

async function req(secret: string | null, ts: number | string | null, opts: { noAuth?: boolean } = {}) {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (ts !== null) h["x-chat-internal-ts"] = String(ts);
  if (secret && !opts.noAuth) h["x-chat-internal-auth"] = await signChatInternalAuth(secret, CHAT_SESSION_CHECK_PATH, Number(ts));
  return { h, r: new NextRequest("https://p.example" + CHAT_SESSION_CHECK_PATH, { method: "POST", headers: h, body: JSON.stringify({ userId: 987654, sv: 3 }) }) };
}
function setEnv(vercelEnv: string | undefined, internal: string | undefined, auth: string | undefined) {
  env.VERCEL = "1";
  const set = (k: string, v: string | undefined) => { if (v === undefined) delete env[k]; else env[k] = v; };
  set("VERCEL_ENV", vercelEnv); set("CHAT_INTERNAL_SECRET", internal); set("CHAT_AUTH_SECRET", auth);
  delete env.NEXT_PUBLIC_CHAT_APP_ENV;
}
async function run(r: NextRequest) {
  const logs: string[] = []; const ol = console.log, oe = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" ")); console.error = (...a: unknown[]) => logs.push("ERR " + a.map(String).join(" "));
  try { const res = await POST(r); return { status: res.status, body: await res.text(), logs }; } finally { console.log = ol; console.error = oe; }
}
const parse = (logs: string[]) => logs.filter((l) => l.startsWith("[TEMP-DIAG preview-chat-403] ")).map((l) => JSON.parse(l.slice(l.indexOf("{"))));
function clean(logs: string[], h: Record<string, string>) {
  const all = logs.join("\n");
  for (const f of [S.internal, S.auth, S.other, "987654", h["x-chat-internal-auth"], h["x-chat-internal-ts"]].filter(Boolean) as string[])
    ok(!all.includes(f), "로그 누출: " + f.slice(0, 4));
}

(async () => {
  // 분기별 (preview)
  const cases: [string, () => Promise<{ h: Record<string, string>; r: NextRequest }>, [string | undefined, string | undefined], Record<string, unknown>][] = [
    ["secret 불일치", () => req(S.other, now()), [S.internal, S.auth], { internal_secret_configured: true, hmac_match: false, ts_status: "ok", auth_header_present: true }],
    ["Next internal 미설정 → auth fallback", () => req(S.internal, now()), [undefined, S.auth], { internal_secret_configured: false, auth_secret_fallback: true, hmac_match: false }],
    ["헤더 없음", () => req(null, null), [S.internal, S.auth], { ts_header_present: false, auth_header_present: false, ts_status: "missing" }],
    ["auth 헤더 없음", () => req(S.internal, now(), { noAuth: true }), [S.internal, S.auth], { ts_header_present: true, auth_header_present: false }],
    ["ts 형식 오류", () => req(S.internal, "abc"), [S.internal, S.auth], { ts_status: "malformed" }],
    ["ts 과거", () => req(S.internal, now() - 600), [S.internal, S.auth], { ts_status: "skew_past", skew_bucket: "gt60s", hmac_match: true }],
    ["ts 미래", () => req(S.internal, now() + 600), [S.internal, S.auth], { ts_status: "skew_future", skew_bucket: "gt60s" }],
  ];
  for (const [name, mk, [i, a], exp] of cases) {
    setEnv("preview", i, a);
    const { h, r } = await mk();
    const out = await run(r);
    ok(out.status === 403 && out.body === '{"error":"forbidden"}', name + " 403");
    const d = parse(out.logs);
    ok(d.length === 1, name + " 로그 1줄");
    for (const [k, v] of Object.entries(exp)) ok(d[0]?.[k] === v, `${name} ${k}=${String(v)} (got ${String(d[0]?.[k])})`);
    clean(out.logs, h);
  }
  // 일치 시 diag 함수는 hmac_match=true
  setEnv("preview", S.internal, S.auth);
  { const { r } = await req(S.internal, now()); const d = await diagnoseChatInternalRequest(r, CHAT_SESSION_CHECK_PATH); ok(d.hmac_match && d.ts_status === "ok" && d.skew_bucket === "le5s", "일치 판정"); }
  // 운영/기타 환경: 로그 0, 응답 동일
  for (const ve of ["production", undefined, "development"]) {
    setEnv(ve, S.internal, S.auth);
    for (const mk of [() => req(S.other, now()), () => req(null, null), () => req(S.internal, now() - 600)]) {
      const { r } = await mk();
      const out = await run(r);
      ok(out.status === 403 && out.body === '{"error":"forbidden"}' && out.logs.length === 0, `env=${ve} 무출력·동일 응답`);
    }
  }
  // NEXT_PUBLIC_CHAT_APP_ENV=preview 라도 VERCEL_ENV!=preview 면 무출력
  setEnv("production", S.internal, S.auth); env.NEXT_PUBLIC_CHAT_APP_ENV = "preview";
  { const { r } = await req(S.other, now()); const out = await run(r); ok(out.logs.length === 0, "VERCEL_ENV=production 이면 무출력"); }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
