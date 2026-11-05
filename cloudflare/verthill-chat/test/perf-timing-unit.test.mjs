// 로컬 단위 테스트: Preview 전용 WS 구간 계측 (ms 숫자만). 합성 값만 사용.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
const out = await build({ entryPoints: ["src/perfTiming.ts"], bundle: true, format: "esm", platform: "neutral", write: false });
const m = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
test("운영(audience 미설정/production) → 비활성, preview → 활성", () => {
  assert.equal(m.perfEnabled({}), false);
  assert.equal(m.perfEnabled({ CHAT_TOKEN_AUDIENCE: "production" }), false);
  assert.equal(m.perfEnabled({ CHAT_TOKEN_AUDIENCE: "preview" }), true);
});
test("encode/decode: 허용 키·정수 ms 만", () => {
  const enc = m.encodePerf({ tok: 1, sc: 1234.6, mem: -5, edge: 9e9, userId: 7, room: "all" });
  assert.equal(enc, "tok=1;sc=1235");
  assert.deepEqual(m.decodePerf("tok=1;sc=1235;userId=7;room=all;mem=abc"), { tok: 1, sc: 1235 });
  assert.deepEqual(m.decodePerf("x".repeat(500)), {});
  assert.deepEqual(m.decodePerf(null), {});
});
test("Server-Timing 파싱: app/db/cold 숫자만", () => {
  assert.deepEqual(m.parseSessionServerTiming("app;dur=812, cold;dur=1, db;dur=640"), { scApp: 812, scDb: 640, scCold: 1 });
  assert.deepEqual(m.parseSessionServerTiming("app;desc=secret;dur=1, foo;dur=3"), {});
  assert.deepEqual(m.parseSessionServerTiming(null), {});
});
test("perf 프레임: type=perf, 숫자만, 식별자 없음", () => {
  const f = JSON.parse(m.perfFrame({ tok: 0, sc: 1200, userId: 3 }, { doAssert: 1, doAccept: 0, doHist: 2, room: "x" }));
  assert.equal(f.type, "perf");
  assert.deepEqual(f.t, { tok: 0, sc: 1200, doAssert: 1, doAccept: 0, doHist: 2 });
  assert.ok(Object.values(f.t).every((v) => Number.isInteger(v)));
});
test("index.ts: perf 는 preview 판정으로만 생성, 인증 호출 순서 유지, 프레임은 history 뒤", () => {
  const src = readFileSync("src/index.ts", "utf8");
  assert.match(src, /const perf: PerfMarks \| undefined = perfEnabled\(env\) \? \{\} : undefined;/);
  assert.ok(src.indexOf("this.sendHistory(server, authorized.claims.userId, null, HISTORY_LIMIT);") < src.indexOf("server.send(perfFrameWithColo("));
  assert.match(src, /forwarded\.headers\.delete\(WS_PERF_HEADER\);\n\s*perf\.edge/);
  assert.doesNotMatch(src, /console\.(log|info)\([^)]*perf/i);
});

test("colo 검증: 대문자 3글자만", () => {
  assert.equal(m.safeColo("ICN"), "ICN");
  for (const bad of ["icn", "ICNX", "IC", "1CN", "", null, undefined, 7, "LAX ", "<b>"]) assert.equal(m.safeColo(bad), null);
});
test("doAge 구간", () => {
  assert.deepEqual([0, 9999, 10000, 59999, 60000, 599999, 600000, NaN].map(m.doAgeBucket), [0, 0, 1, 1, 2, 2, 3, 0]);
});
test("perfFrameWithColo: 잘못된 colo 제거, 숫자 외 필드 없음", () => {
  const a = JSON.parse(m.perfFrameWithColo({ sc: 5 }, { doFirst: 1, doAge: 0 }, "LAX"));
  assert.equal(a.colo, "LAX"); assert.deepEqual(a.t, { sc: 5, doFirst: 1, doAge: 0 });
  const b = JSON.parse(m.perfFrameWithColo({ sc: 5 }, { doFirst: 1 }, "1.2.3.4"));
  assert.equal(b.colo, undefined);
});
test("index.ts: 자동응답은 preview 판정 안에서만, colo 헤더는 제거 후 설정", () => {
  const src = readFileSync("src/index.ts", "utf8");
  assert.match(src, /if \(perfEnabled\(env\)\) \{\n\s*try \{\n\s*this\.ctx\.setWebSocketAutoResponse/);
  assert.equal((src.match(/setWebSocketAutoResponse/g) || []).length, 1);
  assert.match(src, /forwarded\.headers\.delete\(WS_COLO_HEADER\);\n\s*const colo = safeColo/);
});
