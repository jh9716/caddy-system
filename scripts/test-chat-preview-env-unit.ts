/**
 * Preview 채팅 환경 분리 — no DB, no network.
 * 실행: npm run test:chat-preview-env-unit
 */
import {
  appChatAudience,
  chatEnvironmentStatus,
  isPreviewChatHost,
  parseHostList,
} from "../src/lib/chatEnvironment";
import {
  canonicalChatTokenPayload,
  chatTokenAudience,
  parseChatTokenAudience,
  signChatToken,
  verifyChatToken,
  type ChatTokenClaims,
} from "../src/lib/chatToken";

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) { passed++; console.log("  ✓", msg); } else { failed++; console.error("  ✗", msg); }
}

const PROD_WS = "wss://verthill-chat.example.workers.dev";
const PREV_WS = "wss://verthill-chat-preview.example.workers.dev";

async function main() {
  // 환경 판정
  assert(appChatAudience({}) === "production", "환경값 없음(로컬) → production");
  assert(appChatAudience({ VERCEL_ENV: "production" }) === "production", "VERCEL_ENV=production → production");
  assert(appChatAudience({ VERCEL_ENV: "development", NODE_ENV: "development" }) === "production", "vercel dev(로컬) → production");
  assert(appChatAudience({ VERCEL_ENV: "production", VERCEL: "1" }) === "production", "Vercel 운영 → production");
  assert(appChatAudience({ VERCEL_ENV: "production", VERCEL: "1", NEXT_PUBLIC_CHAT_APP_ENV: "production" }) === "production", "Vercel 운영 빌드값 → production");
  assert(appChatAudience({ VERCEL_ENV: "development", NODE_ENV: "production" }) === "preview", "development 이지만 production 빌드 → preview(fail-closed)");
  assert(appChatAudience({ VERCEL_ENV: "staging" }) === "preview", "알 수 없는 VERCEL_ENV → preview");
  assert(appChatAudience({ VERCEL_ENV: "Preview " }) === "preview", "대소문자·공백 정규화");
  assert(appChatAudience({ VERCEL: "1" }) === "preview", "Vercel 인데 VERCEL_ENV 없음 → preview");
  assert(appChatAudience({ NEXT_PUBLIC_CHAT_APP_ENV: "preview" }) === "preview", "브라우저 빌드값 preview(NEXT_PUBLIC_VERCEL_ENV 없음) → preview");
  assert(appChatAudience({ NEXT_PUBLIC_CHAT_APP_ENV: "preview", VERCEL_ENV: "production" }) === "preview", "preview 신호가 하나라도 있으면 preview");
  assert(!chatEnvironmentStatus({ VERCEL: "1", NEXT_PUBLIC_CHAT_WS_URL: "wss://verthill-chat.example.workers.dev" }).ok, "VERCEL_ENV 없음 + 운영 주소 → 차단");
  assert(!chatEnvironmentStatus({ VERCEL_ENV: "staging", NEXT_PUBLIC_CHAT_WS_URL: "wss://verthill-chat.example.workers.dev" }).ok, "알 수 없는 값 + 운영 주소 → 차단");
  assert(!chatEnvironmentStatus({ NEXT_PUBLIC_CHAT_APP_ENV: "preview", NEXT_PUBLIC_CHAT_WS_URL: "wss://verthill-chat.example.workers.dev" }).ok, "브라우저 빌드값 preview + 운영 주소 → 차단");
  assert(appChatAudience({ VERCEL_ENV: "preview" }) === "preview", "VERCEL_ENV=preview → preview");
  assert(appChatAudience({ NEXT_PUBLIC_VERCEL_ENV: "preview" }) === "preview", "브라우저 NEXT_PUBLIC_VERCEL_ENV=preview → preview");

  // 호스트 판정
  assert(!isPreviewChatHost(PROD_WS), "운영 Worker 호스트는 preview 아님");
  assert(isPreviewChatHost(PREV_WS), "verthill-chat-preview 호스트 허용");
  assert(!isPreviewChatHost("wss://chat.verthill.kr"), "preview 표식 없는 커스텀 도메인 거부");
  assert(!isPreviewChatHost("not a url"), "잘못된 URL 거부");
  assert(!isPreviewChatHost(""), "빈 값 거부");
  assert(!isPreviewChatHost("wss://evil.com/verthill-chat-preview"), "경로에만 preview 있는 주소 거부");

  // 공격 케이스 표 (kind 별)
  const A = "acct1";
  const table: Array<[string, "ws" | "http", boolean, string]> = [
    [`wss://verthill-chat-preview.${A}.workers.dev`, "ws", true, "정상 WS"],
    [`wss://verthill-chat-preview.${A}.workers.dev/`, "ws", true, "정상 WS (끝 슬래시)"],
    [`https://verthill-chat-preview.${A}.workers.dev`, "http", true, "정상 HTTP"],
    [`https://verthill-chat-preview.${A}.workers.dev`, "ws", false, "WS 자리에 https 거부"],
    [`wss://verthill-chat-preview.${A}.workers.dev`, "http", false, "HTTP 자리에 wss 거부"],
    [`ws://verthill-chat-preview.${A}.workers.dev`, "ws", false, "ws 평문 거부"],
    [`http://verthill-chat-preview.${A}.workers.dev`, "http", false, "http 평문 거부"],
    [`ftp://verthill-chat-preview.${A}.workers.dev`, "http", false, "다른 스킴 거부"],
    [`javascript:alert(1)`, "http", false, "javascript: 거부"],
    [`wss://verthill-chat.${A}.workers.dev`, "ws", false, "운영 Worker 거부"],
    [`https://verthill-chat.${A}.workers.dev`, "http", false, "운영 Worker(HTTP) 거부"],
    [`wss://verthill-chat-preview.evil.com`, "ws", false, "다른 도메인 거부"],
    [`wss://evil-verthill-chat-preview.${A}.workers.dev`, "ws", false, "접두 위장 거부"],
    [`wss://verthill-chat-preview-evil.${A}.workers.dev`, "ws", false, "접미 위장 거부"],
    [`wss://verthill-chat-preview.workers.dev.evil.com`, "ws", false, "workers.dev 뒤 도메인 거부"],
    [`wss://verthill-chat-preview.${A}.workers.dev.evil.com`, "ws", false, "정상 호스트 뒤 도메인 거부"],
    [`wss://preview.verthill-chat.${A}.workers.dev`, "ws", false, "preview.verthill-chat 거부"],
    [`wss://verthill-chat-preview.workers.dev`, "ws", false, "계정 라벨 없음 거부"],
    [`wss://verthill-chat-preview.a.b.workers.dev`, "ws", false, "계정 라벨 2개 거부"],
    [`wss://verthill-chat-preview.-bad.workers.dev`, "ws", false, "잘못된 라벨(- 시작) 거부"],
    [`wss://verthill-chat-preview.${A}.workers.dev.`, "ws", false, "끝 점 거부"],
    [`wss://VERTHILL-CHAT-PREVIEW.${A}.workers.dev`, "ws", false, "대문자 거부"],
    [`wss://user:pass@verthill-chat-preview.${A}.workers.dev`, "ws", false, "userinfo 거부"],
    [`wss://verthill-chat-preview.${A}.workers.dev@evil.com`, "ws", false, "@ 로 호스트 바꿔치기 거부"],
    [`wss://evil.com@verthill-chat-preview.${A}.workers.dev`, "ws", false, "userinfo 위장 거부"],
    [`wss://verthill-chat-preview.${A}.workers.dev:8443`, "ws", false, "포트 지정 거부"],
    [`wss://verthill-chat-preview.${A}.workers.dev:443`, "ws", false, "기본 포트 명시 표기 거부"],
    [`wss://verthill-chat-preview.${A}.workers.dev/ws`, "ws", false, "경로 거부"],
    [`wss://verthill-chat-preview.${A}.workers.dev?x=1`, "ws", false, "쿼리 거부"],
    [`wss://verthill-chat-preview.${A}.workers.dev#x`, "ws", false, "해시 거부"],
    [`wss://evil.com/verthill-chat-preview.${A}.workers.dev`, "ws", false, "경로에 숨긴 호스트 거부"],
    [`wss://evil.com\\@verthill-chat-preview.${A}.workers.dev`, "ws", false, "백슬래시 우회 거부"],
    [`wss://verthill-chat-preview%2E${A}.workers.dev`, "ws", false, "퍼센트 인코딩 거부"],
    [`wss://verthill-chat-prevіew.${A}.workers.dev`, "ws", false, "키릴 문자 위장(IDN) 거부"],
    [`wss://xn--verthill-chat-preview-abc.${A}.workers.dev`, "ws", false, "punycode 거부"],
    [`wss://127.0.0.1`, "ws", false, "IPv4 거부"],
    [`wss://[::1]`, "ws", false, "IPv6 거부"],
    [`wss://2130706433`, "ws", false, "정수 IP 거부"],
    [` wss://verthill-chat-preview.${A}.workers.dev`, "ws", false, "앞 공백 거부"],
    [`wss://verthill-chat-preview.${A}.workers.dev\n`, "ws", false, "개행 거부"],
    [`wss:/verthill-chat-preview.${A}.workers.dev`, "ws", false, "슬래시 1개 거부"],
    [`//verthill-chat-preview.${A}.workers.dev`, "ws", false, "스킴 없음 거부"],
    [`wss://chat-preview.verthill.kr`, "ws", false, "승인 안 된 커스텀 도메인 거부"],
  ];
  for (const [url, kind, want, label] of table) {
    assert(isPreviewChatHost(url, { kind }) === want, `호스트표: ${label}`);
  }
  // 커스텀 도메인 허용 목록 (정확 일치만)
  const allowed = parseHostList("chat-preview.verthill.kr, BAD.Example.com,127.0.0.1,xn--abc.com,ok-host.test.");
  assert(JSON.stringify(allowed) === JSON.stringify(["chat-preview.verthill.kr"]), "허용목록: 대문자·IP·punycode·끝 점 항목은 버림");
  assert(isPreviewChatHost("wss://chat-preview.verthill.kr", { kind: "ws", allowedHosts: allowed }), "허용목록 정확 일치 허용");
  assert(!isPreviewChatHost("wss://x.chat-preview.verthill.kr", { kind: "ws", allowedHosts: allowed }), "허용목록 하위 도메인 거부");
  assert(!isPreviewChatHost("wss://chat-preview.verthill.kr.evil.com", { kind: "ws", allowedHosts: allowed }), "허용목록 뒤 도메인 거부");
  assert(!isPreviewChatHost("ws://chat-preview.verthill.kr", { kind: "ws", allowedHosts: allowed }), "허용목록이어도 ws 평문 거부");
  assert(!isPreviewChatHost("wss://chat.verthill.kr", { kind: "ws", allowedHosts: ["chat.verthill.kr"], productionHosts: ["chat.verthill.kr"] }), "운영 호스트는 허용목록에 있어도 거부");
  assert(!isPreviewChatHost(`wss://verthill-chat-preview.${A}.workers.dev`, { kind: "ws", productionHosts: [`verthill-chat-preview.${A}.workers.dev`] }), "운영 호스트 목록과 같으면 거부");
  const envAllowed = chatEnvironmentStatus({ VERCEL_ENV: "preview", NEXT_PUBLIC_CHAT_WS_URL: "wss://chat-preview.verthill.kr", CHAT_PREVIEW_ALLOWED_HOSTS: "chat-preview.verthill.kr" });
  assert(envAllowed.ok, "env 허용목록으로 커스텀 도메인 허용");
  const envNot = chatEnvironmentStatus({ VERCEL_ENV: "preview", NEXT_PUBLIC_CHAT_WS_URL: "wss://chat-preview.verthill.kr" });
  assert(!envNot.ok, "허용목록 없으면 커스텀 도메인 차단(기본 빈 목록)");
  const envHttpWorker = chatEnvironmentStatus({ VERCEL_ENV: "preview", NEXT_PUBLIC_CHAT_WS_URL: PREV_WS, CHAT_WORKER_URL: "http://verthill-chat-preview.example.workers.dev" });
  assert(!envHttpWorker.ok, "서버측 Worker 주소 http 평문 차단");

  // 상태 (fail-closed)
  assert(chatEnvironmentStatus({ VERCEL_ENV: "production", NEXT_PUBLIC_CHAT_WS_URL: PROD_WS }).ok, "운영: 기존 설정 그대로 ok");
  assert(chatEnvironmentStatus({}).ok, "로컬: ok (기존 127.0.0.1 폴백 유지)");
  const unconf = chatEnvironmentStatus({ VERCEL_ENV: "preview" });
  assert(!unconf.ok && unconf.code === "chat_preview_unconfigured", "Preview + 주소 없음 → 차단");
  const prodOnPrev = chatEnvironmentStatus({ VERCEL_ENV: "preview", NEXT_PUBLIC_CHAT_WS_URL: PROD_WS });
  assert(!prodOnPrev.ok && prodOnPrev.code === "chat_preview_production_host", "Preview + 운영 WS 주소 → 차단");
  const mixed = chatEnvironmentStatus({ VERCEL_ENV: "preview", NEXT_PUBLIC_CHAT_WS_URL: PREV_WS, CHAT_WORKER_URL: "https://verthill-chat.example.workers.dev" });
  assert(!mixed.ok && mixed.code === "chat_preview_production_host", "Preview + 서버측 Worker 주소만 운영 → 차단");
  const good = chatEnvironmentStatus({ VERCEL_ENV: "preview", NEXT_PUBLIC_CHAT_WS_URL: PREV_WS, CHAT_WORKER_URL: "https://verthill-chat-preview.example.workers.dev" });
  assert(good.ok && good.audience === "preview", "Preview + preview 주소 → 허용(audience=preview)");

  // 토큰 aud
  assert(parseChatTokenAudience(undefined) === "production" && parseChatTokenAudience("preview") === "preview" && parseChatTokenAudience("staging") === null, "audience 설정값 해석 (알 수 없는 값은 null)");
  const now = Math.floor(Date.now() / 1000);
  const base: ChatTokenClaims = { v: 2, binding: "session", userId: 5, displayName: "테스트", role: "caddy", team: "1조", sv: 0, iat: now, exp: now + 600 };
  const prodCanon = canonicalChatTokenPayload(base);
  assert(prodCanon.split("|").length === 8, "운영 토큰 canonical 8칸 그대로 (기존 형식 불변)");
  const prevCanon = canonicalChatTokenPayload({ ...base, aud: "preview" });
  assert(prevCanon === prodCanon + "|aud=preview", "preview 토큰은 9번째 칸 aud=preview (HMAC 포함)");
  const S1 = "prod-secret-test", S2 = "preview-secret-test";
  const prodTok = await signChatToken(base, S1);
  const prevTok = await signChatToken({ ...base, aud: "preview" }, S2);
  const prodClaims = await verifyChatToken(prodTok, { secret: S1, audience: "production" });
  assert(prodClaims && chatTokenAudience(prodClaims) === "production", "운영 토큰 → 운영 검증 통과");
  assert((await verifyChatToken(prevTok, { secret: S1, audience: "production" })) === null, "preview 토큰 → 운영 검증 거부");
  const prevClaims = await verifyChatToken(prevTok, { secret: S2, audience: "preview" });
  assert(prevClaims && chatTokenAudience(prevClaims) === "preview", "preview 토큰 → preview 검증 통과");
  assert((await verifyChatToken(prodTok, { secret: S2, audience: "preview" })) === null, "운영 토큰 → preview 검증 거부");
  const prevSameSecret = await signChatToken({ ...base, aud: "preview" }, S1);
  assert((await verifyChatToken(prevSameSecret, { secret: S1, audience: "production" })) === null, "같은 비밀값이어도 aud 다르면 거부");
  const prodSameSecret = await signChatToken(base, S2);
  assert((await verifyChatToken(prodSameSecret, { secret: S2, audience: "preview" })) === null, "preview 비밀값으로 서명한 aud 없는 토큰도 preview 에서 거부");
  // 기본 audience (VERCEL_ENV 기준)
  const saved = process.env.VERCEL_ENV;
  delete process.env.VERCEL_ENV;
  assert((await verifyChatToken(prodTok, { secret: S1 })) !== null, "기본(VERCEL_ENV 없음) = production 검증");
  process.env.VERCEL_ENV = "preview";
  assert((await verifyChatToken(prodTok, { secret: S1 })) === null, "VERCEL_ENV=preview 에서 운영 토큰 거부(사진 접근 등)");
  // 발급(appChatAudience) ↔ 검증(verifyChatToken 기본) audience 일치 매트릭스
  {
    const keys = ["VERCEL", "VERCEL_ENV", "NEXT_PUBLIC_VERCEL_ENV", "NEXT_PUBLIC_CHAT_APP_ENV"] as const;
    const backup = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const cases: Array<[string, Record<string, string | undefined>, "production" | "preview"]> = [
      ["운영", { VERCEL: "1", VERCEL_ENV: "production" }, "production"],
      ["preview", { VERCEL: "1", VERCEL_ENV: "preview" }, "preview"],
      ["VERCEL=1 + VERCEL_ENV 없음", { VERCEL: "1" }, "preview"],
      ["알 수 없는 값", { VERCEL: "1", VERCEL_ENV: "staging" }, "preview"],
      ["로컬(신호 없음)", {}, "production"],
      ["빌드값 preview 만", { NEXT_PUBLIC_CHAT_APP_ENV: "preview" }, "preview"],
    ];
    for (const [label, envs, want] of cases) {
      for (const k of keys) delete process.env[k];
      Object.assign(process.env, envs);
      const issued = appChatAudience();
      const tok = await signChatToken(issued === "preview" ? { ...base, aud: "preview" } : base, S1);
      const ok = (await verifyChatToken(tok, { secret: S1 })) !== null;
      const otherTok = await signChatToken(issued === "preview" ? base : { ...base, aud: "preview" }, S1);
      const otherOk = (await verifyChatToken(otherTok, { secret: S1 })) !== null;
      assert(issued === want && ok && !otherOk, `발급·검증 audience 일치: ${label} → ${want}`);
    }
    const penv = process.env as Record<string, string | undefined>;
    for (const k of keys) { if (backup[k] === undefined) delete penv[k]; else penv[k] = backup[k]!; }
  }
  if (saved === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = saved;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
void main();
