/**
 * 세션 폐기 안정성(작업 1·4) — 실제 fetch(undici) 를 로컬 127.0.0.1 HTTP 서버/닫힌 포트에만 보낸다.
 * 실 Worker·DB·퇴사 API·외부 네트워크 사용 없음.
 * 시나리오: 정상(ok) / Worker 응답 지연 / 일부 Room 실패(partial) / 네트워크 실패 / 중복 요청 / 구 Worker 호환.
 */
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";

process.env.CHAT_INTERNAL_SECRET = "unit-test-only-not-a-secret";

let passed = 0, failed = 0;
function assert(c: unknown, m: string) { if (c) { passed++; console.log("  ✓", m); } else { failed++; console.log("  ✗", m); } }

type Handler = (body: { userId: number; sessionVersion: number }) => Promise<{ status: number; json?: unknown }>;
let handler: Handler = async () => ({ status: 200, json: { ok: true, status: "ok" } });
let hits = 0;

function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        hits++;
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const out = await handler(body);
        res.statusCode = out.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out.json ?? {}));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve({ server, port: typeof a === "object" && a ? a.port : 0 });
    });
  });
}

function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

const warns: string[] = [];
const errs: string[] = [];
const realWarn = console.warn;
const realErr = console.error;
console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function noSecrets(lines: string[], port: number): boolean {
  const joined = lines.join("\n").replace(/(elapsedMs|totalMs)=\d+/g, "");
  return !/unit-test-only|127\.0\.0\.1|http:|ws:|sessionVersion|userId|\b4242\b|\b77\b|authorization|x-chat-internal/i.test(joined)
    && !joined.includes(String(port));
}

(async () => {
  const { server, port } = await startServer();
  process.env.NEXT_PUBLIC_CHAT_WS_URL = `ws://127.0.0.1:${port}`;
  const mod = await import("../src/lib/chatSessionRevoke");
  const { notifyChatSessionRevoked, classifyRevokeCauseCode, classifyRevokeError, CHAT_SESSION_REVOKE_TOTAL_BUDGET_MS } = mod;

  console.log("1. 정상 퇴사 알림(Worker status=ok)");
  handler = async () => ({ status: 200, json: { ok: true, status: "ok", rooms: { ok: 13, total: 13 } } });
  hits = 0; warns.length = 0; errs.length = 0;
  assert((await notifyChatSessionRevoked({ userId: 4242, sessionVersion: 77 })) === "ok" && hits === 1, "200 status=ok → ok, 1회");
  assert(warns.length === 0 && errs.length === 0, "성공 시 실패 로그 없음");

  console.log("구 Worker 호환(200 {ok:true})");
  handler = async () => ({ status: 200, json: { ok: true } });
  assert((await notifyChatSessionRevoked({ userId: 4242, sessionVersion: 77 })) === "ok", "본문 status 없는 2xx 는 기존처럼 ok");

  console.log("2. Worker 응답 지연(시도당 시간 초과)");
  handler = async () => { await sleep(4000); return { status: 200, json: { ok: true, status: "ok" } }; };
  hits = 0; warns.length = 0; errs.length = 0;
  {
    const t0 = Date.now();
    const r = await notifyChatSessionRevoked({ userId: 4242, sessionVersion: 77 });
    const el = Date.now() - t0;
    assert(r === "failed", "지연 → failed(성공으로 보지 않음)");
    assert(el <= CHAT_SESSION_REVOKE_TOTAL_BUDGET_MS + 400, `총 예산 이내(${el}ms)`);
    assert(warns.some((w) => /stage=fetch attempt=1\/3 elapsedMs=\d+ status=network err=TimeoutError abort=timeout cause=none/.test(w)), "진단: stage=fetch attempt elapsedMs err=TimeoutError abort=timeout cause=none");
    assert(errs.some((e) => /notify failed status=network attempts=\d totalMs=\d+ last=\(stage=fetch/.test(e)), "최종 실패 로그: status=network + attempts + totalMs + last 진단");
    assert(noSecrets([...warns, ...errs], port), "로그에 식별자·URL·포트·비밀값 없음");
  }

  console.log("3. 일부 Room 알림 실패(Worker 502 partial)");
  handler = async () => ({ status: 502, json: { ok: false, status: "partial", epochStored: true, rooms: { ok: 11, total: 13, failed: 1, timeout: 1, skipped: 0 } } });
  hits = 0; warns.length = 0; errs.length = 0;
  {
    const r = await notifyChatSessionRevoked({ userId: 4242, sessionVersion: 77 });
    assert(r === "failed", "partial → 성공 아님(failed)");
    assert(hits >= 2 && hits <= 3, `partial 은 재시도(${hits}회, 멱등)`);
    assert(warns.some((w) => /stage=response attempt=1\/3 elapsedMs=\d+ status=502 worker=partial rooms=11\/13/.test(w)), "진단: stage=response status=502 worker=partial rooms=11/13");
    assert(noSecrets([...warns, ...errs], port), "로그에 식별자·URL 없음");
  }
  console.log("3b. partial 후 재시도에서 전체 성공");
  {
    let n = 0;
    handler = async () => (++n === 1
      ? { status: 502, json: { ok: false, status: "partial", rooms: { ok: 12, total: 13 } } }
      : { status: 200, json: { ok: true, status: "ok", rooms: { ok: 13, total: 13 } } });
    hits = 0;
    assert((await notifyChatSessionRevoked({ userId: 4242, sessionVersion: 77 })) === "ok" && hits === 2, "partial → 재시도 → ok");
  }
  console.log("3c. 2xx 이지만 본문 status=partial(방어)");
  {
    handler = async () => ({ status: 200, json: { ok: false, status: "partial", rooms: { ok: 1, total: 13 } } });
    hits = 0;
    assert((await notifyChatSessionRevoked({ userId: 4242, sessionVersion: 77 })) === "failed" && hits >= 2, "2xx+partial 도 성공으로 보지 않음(재시도 후 failed)");
  }
  console.log("Directory 단계 실패(Worker 503 failed)");
  {
    handler = async () => ({ status: 503, json: { ok: false, status: "failed", stage: "directory", reason: "timeout" } });
    warns.length = 0;
    assert((await notifyChatSessionRevoked({ userId: 4242, sessionVersion: 77 })) === "failed", "503 failed → failed");
    assert(warns.some((w) => /status=503 worker=failed/.test(w)), "진단: worker=failed");
  }

  console.log("4. Worker 네트워크 실패(닫힌 로컬 포트)");
  {
    const dead = await closedPort();
    process.env.NEXT_PUBLIC_CHAT_WS_URL = `ws://127.0.0.1:${dead}`;
    warns.length = 0; errs.length = 0;
    const r = await notifyChatSessionRevoked({ userId: 4242, sessionVersion: 77 });
    assert(r === "failed", "연결 거부 → failed");
    assert(warns.some((w) => /stage=fetch .*status=network err=TypeError abort=no cause=ECONNREFUSED/.test(w)), "진단: err=TypeError abort=no cause=ECONNREFUSED(실제 undici cause.code)");
    assert(noSecrets([...warns, ...errs], dead), "로그에 URL·포트 없음");
    process.env.NEXT_PUBLIC_CHAT_WS_URL = `ws://127.0.0.1:${port}`;
  }

  console.log("cause.code 분류(추측 금지)");
  assert(classifyRevokeCauseCode({ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }) === "UND_ERR_CONNECT_TIMEOUT", "알려진 형식 코드 통과");
  assert(classifyRevokeCauseCode({}) === "none", "cause 없음 → none");
  assert(classifyRevokeCauseCode({ cause: { code: "connect 10.0.0.1:443 failed" } }) === "unknown", "형식 밖(주소 포함 가능) → unknown");
  assert(classifyRevokeCauseCode({ cause: { code: 42 } }) === "unknown", "문자열 아님 → unknown");
  assert(classifyRevokeError(Object.assign(new Error("x"), { name: "AbortError" })).abort === "abort", "AbortError → abort=abort");
  assert(classifyRevokeError({ name: "bad name with space" }).errName === "unknown", "이상한 오류 이름 → unknown");

  console.log("5. 동일 revoke 중복 요청(동시)");
  {
    const seen: Array<{ userId: number; sessionVersion: number }> = [];
    handler = async (b) => { seen.push(b); await sleep(50); return { status: 200, json: { ok: true, status: "ok" } }; };
    const rs = await Promise.all([1, 2, 3].map(() => notifyChatSessionRevoked({ userId: 4242, sessionVersion: 77 })));
    assert(rs.every((x) => x === "ok") && seen.length === 3 && seen.every((b) => b.sessionVersion === 77), "중복 동시 전송 모두 ok, 같은 sv(Worker max 보관 → 되돌림 없음)");
  }

  console.warn = realWarn; console.error = realErr;
  server.close();
  console.log(`\nsession-revoke-stability-unit: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error = realErr; console.error(e); process.exit(1); });
