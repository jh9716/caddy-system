// 로컬 단위 테스트: ws 확인서 재사용(다른 방), 15초 만료, 변조, 비밀값 불일치, 헤더 제거. 합성 값만 사용.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const out = await build({ entryPoints: ["src/wsAssertion.ts"], bundle: true, format: "esm", platform: "neutral", write: false });
const m = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
const env = { CHAT_INTERNAL_SECRET: "local-synthetic-internal-secret-0000000000" };
const claims = { v: 2, userId: 41, displayName: "x", role: "caddy", sv: 3, iat: 1, exp: 4102444800 };
const T = 1800000000;
async function mk(room = "all", now = T) { const h = new Headers(); await m.attachWsAssertion(h, env, room, claims, now); return h; }
test("유효 확인서 → claims(sv 포함)", async () => {
  assert.deepEqual(await m.readWsAssertion(await mk(), env, "all", T + 1), claims);
});
test("다른 방으로 재사용 거부", async () => {
  assert.equal(await m.readWsAssertion(await mk("all"), env, "team-2", T), null);
});
test("15초 경과 거부, 15초 이내 허용, 미래 시각 거부", async () => {
  const h = await mk();
  assert.ok(await m.readWsAssertion(h, env, "all", T + 15));
  assert.equal(await m.readWsAssertion(h, env, "all", T + 16), null);
  assert.equal(await m.readWsAssertion(h, env, "all", T - 3), null);
});
test("claims 변조/서명 변조/비밀값 불일치/누락 거부", async () => {
  const h = await mk();
  const h2 = new Headers(h); h2.set(m.WS_ASSERT_CLAIMS_HEADER, Buffer.from(JSON.stringify({ ...claims, userId: 1 })).toString("base64url"));
  assert.equal(await m.readWsAssertion(h2, env, "all", T), null);
  const h3 = new Headers(h); h3.set(m.WS_ASSERT_HEADER, "AAAA");
  assert.equal(await m.readWsAssertion(h3, env, "all", T), null);
  assert.equal(await m.readWsAssertion(h, { CHAT_INTERNAL_SECRET: "other-synthetic-secret-111111111111111" }, "all", T), null);
  assert.equal(await m.readWsAssertion(new Headers(), env, "all", T), null);
});
test("토큰 만료(exp) claims 거부", async () => {
  const h = new Headers(); await m.attachWsAssertion(h, env, "all", { ...claims, exp: T - 1 }, T);
  assert.equal(await m.readWsAssertion(h, env, "all", T), null);
});
test("strip: 클라이언트 헤더 제거", async () => {
  const h = await mk(); m.stripWsAssertionHeaders(h);
  assert.equal([...h.keys()].filter((k) => k.startsWith("x-chat-ws")).length, 0);
});
