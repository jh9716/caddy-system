/**
 * Preview 채팅 환경 분리 — no DB, no network.
 * 실행: npm run test:chat-preview-env-unit
 */
import {
  appChatAudience,
  chatEnvironmentStatus,
  isPreviewChatHost,
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
  assert(appChatAudience({ VERCEL_ENV: "development" }) === "production", "development → production");
  assert(appChatAudience({ VERCEL_ENV: "preview" }) === "preview", "VERCEL_ENV=preview → preview");
  assert(appChatAudience({ NEXT_PUBLIC_VERCEL_ENV: "preview" }) === "preview", "브라우저 NEXT_PUBLIC_VERCEL_ENV=preview → preview");

  // 호스트 판정
  assert(!isPreviewChatHost(PROD_WS), "운영 Worker 호스트는 preview 아님");
  assert(isPreviewChatHost(PREV_WS), "verthill-chat-preview 호스트 허용");
  assert(!isPreviewChatHost("wss://chat.verthill.kr"), "preview 표식 없는 커스텀 도메인 거부");
  assert(!isPreviewChatHost("not a url"), "잘못된 URL 거부");
  assert(!isPreviewChatHost(""), "빈 값 거부");
  assert(!isPreviewChatHost("wss://evil.com/verthill-chat-preview"), "경로에만 preview 있는 주소 거부");

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
  if (saved === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = saved;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
void main();
