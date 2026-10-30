/**
 * PC 플로팅 채팅 P1 — no DB.
 * 실행: npm run test:floating-chat-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  canShowFloatingChat,
  floatingChatSockets,
  normalizeOutgoingBody,
  parseFloatingChatState,
  serializeFloatingChatState,
  totalUnread,
  unreadBadgeText,
} from "../src/lib/floatingChat";

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) { passed++; console.log("  ✓", msg); } else { failed++; console.error("  ✗", msg); }
}

const pc = 1440;
assert(canShowFloatingChat({ role: "admin", pathname: "/manage/caddies", viewportWidth: pc }), "admin PC 업무 화면 표시");
assert(canShowFloatingChat({ role: "caddy", pathname: "/board", viewportWidth: pc }), "caddy PC 표시");
assert(canShowFloatingChat({ role: "leader", pathname: "/", viewportWidth: 960 }), "leader 960 경계 표시");
assert(!canShowFloatingChat({ role: "admin", pathname: "/", viewportWidth: 959 }), "959 이하 숨김");
assert(!canShowFloatingChat({ role: "admin", pathname: "/chat", viewportWidth: pc }), "/chat 숨김");
assert(!canShowFloatingChat({ role: "admin", pathname: "/chat/x", viewportWidth: pc }), "/chat 하위 숨김");
assert(!canShowFloatingChat({ role: "admin", pathname: "/login", viewportWidth: pc }), "/login 숨김");
assert(!canShowFloatingChat({ role: "admin", pathname: "/change-password", viewportWidth: pc }), "/change-password 숨김");
assert(!canShowFloatingChat({ role: null, pathname: "/", viewportWidth: pc }), "비로그인 숨김");
assert(!canShowFloatingChat({ role: "marshal", pathname: "/", viewportWidth: pc }), "채팅 권한 없는 역할 숨김");

assert(parseFloatingChatState(null).ui === "closed", "빈 상태 → closed");
assert(parseFloatingChatState("{bad").ui === "closed", "깨진 JSON → closed");
const st = parseFloatingChatState(serializeFloatingChatState({ ui: "min", roomId: "dm-1-2" }));
assert(st.ui === "min" && st.roomId === "dm-1-2", "상태 왕복");
assert(parseFloatingChatState(JSON.stringify({ ui: "x", roomId: 5 })).roomId === null, "잘못된 값 무시");

const c = floatingChatSockets({ ui: "closed", viewingRoom: true });
assert(!c.directory && !c.room, "닫힘: 연결 없음");
const m = floatingChatSockets({ ui: "min", viewingRoom: true });
assert(m.directory && !m.room, "최소화: 목록만");
const o = floatingChatSockets({ ui: "open", viewingRoom: true });
assert(o.directory && o.room, "열림+방: 목록+방");
assert(!floatingChatSockets({ ui: "open", viewingRoom: false }).room, "열림+목록: 방 소켓 없음");

assert(totalUnread([{ unread: 3 }, { unread: 0 }, { unread: null }, { unread: 2 }]) === 5, "안 읽음 합계");
assert(unreadBadgeText(0) === "" && unreadBadgeText(7) === "7" && unreadBadgeText(120) === "99+", "배지 문구");
assert(normalizeOutgoingBody("  hi \r\n") === "hi", "본문 trim");
assert(normalizeOutgoingBody("   ") === null, "빈 본문 거부");
assert(normalizeOutgoingBody("a".repeat(2001)) === null, "2000자 초과 거부");

const root = path.join(__dirname, "..");
const comp = fs.readFileSync(path.join(root, "src/components/chat/FloatingChat.tsx"), "utf8");
const layout = fs.readFileSync(path.join(root, "src/app/layout.tsx"), "utf8");
const css = fs.readFileSync(path.join(root, "src/app/globals.css"), "utf8");
assert(layout.includes("<FloatingChat role={role} />"), "루트 레이아웃에 상시 마운트");
assert(comp.includes('"/api/chat/token"') && comp.includes("chatWsUrl(") && comp.includes("chatDirectoryWsUrl("), "기존 토큰·WS 경로 재사용");
assert(/type: "message",\s*clientMessageId,\s*body,\s*mentions: \[\],\s*mentionAll: false/.test(comp), "기존 메시지 전송 형식");
assert(!comp.includes("consumeUnauthorizedMemberResponse"), "플로팅에서는 로그인 리다이렉트 없음");
assert(comp.includes("subscribeChatSessionReset"), "세션 리셋 구독");
assert(/\.vh-fc-launcher,\s*\.vh-fc-panel \{\s*display: none;/.test(css), "모바일 기본 숨김 CSS");
assert(css.includes("@media (min-width: 960px) {\n  .vh-fc-launcher {"), "PC 전용 스타일");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
