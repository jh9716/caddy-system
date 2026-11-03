/**
 * 조장(leader) 로그인 무한 리다이렉트 회귀 테스트 (DB·네트워크 없음)
 * 실행: npm run test:leader-login-loop-unit
 * 모델: /login(서버) → /caddy(layout + client gate + mine) → /caddy/link(client gate + mine)
 */
import fs from "node:fs";
import path from "node:path";
import {
  resolveCaddyLinkPageGate,
  resolveCaddyPageGate,
  resolveLoginPageRedirect,
  resolvePostLoginHref,
} from "../src/lib/roleRouting";
import { isLinkableKakaoUser } from "../src/lib/userCaddyLink";
import {
  REDIRECT_LOOP_MAX,
  REDIRECT_LOOP_WINDOW_MS,
  nextRedirectLoopState,
} from "../src/lib/redirectLoopGuard";

let passed = 0;
let failed = 0;
function assert(c: unknown, m: string) {
  if (c) { passed++; console.log("  ✓", m); } else { failed++; console.error("  ✗", m); }
}
const read = (r: string) => fs.readFileSync(path.resolve(r), "utf8");

type U = { role: string | null; linked: boolean };
/** 실제 게이트 함수로 리다이렉트 체인을 따라간다. 최대 20홉. */
function follow(u: U, start: string, linkGate = resolveCaddyLinkPageGate): { hops: string[]; loop: boolean; end: string } {
  const hops = [start];
  let cur = start;
  for (let i = 0; i < 20; i++) {
    let next: string | null = null;
    if (cur === "/login") {
      next = resolveLoginPageRedirect(u.role ? { role: u.role } : null);
    } else if (cur === "/caddy") {
      if (!u.role) next = "/login";
      else {
        const g = resolveCaddyPageGate(u.role);
        if (g.action !== "enter") next = g.href;
        else if (!u.linked) next = "/caddy/link";
      }
    } else if (cur === "/caddy/link") {
      if (!u.role) next = "/login";
      else {
        const g = linkGate(u.role);
        if (g.action === "replace") next = g.href;
        else if (g.action === "enter" && u.linked) next = "/caddy";
        else if (g.action === "error") next = null;
        else if ((g as { action: string }).action === "legacy_login") next = "/login";
      }
    }
    if (!next) return { hops, loop: false, end: cur };
    hops.push(next);
    cur = next;
  }
  return { hops, loop: true, end: cur };
}

console.log("\n== A 원인 재현: 기존 /caddy/link 게이트(caddy만 허용) ==");
{
  const legacy = (role: unknown) =>
    role === "caddy" ? ({ action: "enter" } as const) : ({ action: "legacy_login" } as unknown as ReturnType<typeof resolveCaddyLinkPageGate>);
  const r = follow({ role: "leader", linked: false }, "/caddy", legacy);
  assert(r.loop, "기존 규칙: 미연결 leader /caddy → /caddy/link → /login → /caddy 무한 루프");
}

console.log("\n== B 수정 후 체인 (역할 × 연결) ==");
const cases: Array<[string, U, string]> = [
  ["caddy 연결", { role: "caddy", linked: true }, "/caddy"],
  ["caddy 미연결", { role: "caddy", linked: false }, "/caddy/link"],
  ["leader 연결", { role: "leader", linked: true }, "/caddy"],
  ["leader 미연결", { role: "leader", linked: false }, "/caddy/link"],
  ["admin", { role: "admin", linked: false }, "/manage"],
  ["비로그인", { role: null, linked: false }, "/login"],
];
for (const [name, u, end] of cases) {
  for (const start of ["/login", "/caddy", "/caddy/link"]) {
    const r = follow(u, start);
    assert(!r.loop && r.end === end, `${name} ${start} → ${end} (루프 없음, ${r.hops.join(">")})`);
    assert(r.hops.length <= 4, `${name} ${start} 홉 ≤3`);
  }
}

console.log("\n== C 게이트 정책 ==");
assert(resolveCaddyLinkPageGate("leader").action === "enter", "/caddy/link leader 허용");
assert(resolveCaddyLinkPageGate("caddy").action === "enter", "/caddy/link caddy 허용 (기존 유지)");
assert(resolveCaddyLinkPageGate("admin").action === "replace", "/caddy/link admin → /manage (관리자 정책 불변)");
assert(resolveCaddyLinkPageGate("staff").action === "error", "알 수 없는 역할 → 오류 표시 (리다이렉트 없음)");
assert(resolveCaddyLinkPageGate(null).action === "error", "role null → 오류 표시");
assert(resolveLoginPageRedirect({ role: "leader" }) === "/caddy", "/login leader → /caddy (기존 유지)");
assert(resolveLoginPageRedirect({ role: "admin" }) === "/manage", "/login admin → /manage");
assert(resolveLoginPageRedirect(null) === null, "/login 비로그인 → 폼 표시");
assert(resolvePostLoginHref({ role: "leader", callbackUrl: "/caddy/link" }) === "/caddy/link", "leader 로그인 후 /caddy/link callback 유지");
assert(resolvePostLoginHref({ role: "leader", callbackUrl: "/manage" }) === "/manage", "post-login 규칙 불변(관리자 권한 부여 아님: /manage는 middleware가 admin만)");

console.log("\n== D 본인확인 API 정책 (데이터 모델 지원) ==");
assert(isLinkableKakaoUser({ kakaoUserId: "k1", role: "leader" }), "Kakao leader는 본인확인 요청 가능 (API 기존 정책)");
assert(isLinkableKakaoUser({ kakaoUserId: "k1", role: "caddy" }), "Kakao caddy 가능");
assert(!isLinkableKakaoUser({ kakaoUserId: "k1", role: "admin" }), "admin 거부");
assert(!isLinkableKakaoUser({ kakaoUserId: null, role: "leader" }), "Kakao 없는 ID/PW leader는 거부(403 오류 표시, 루프 아님)");

console.log("\n== E 리다이렉트 루프 가드 ==");
{
  let raw: string | null = null;
  const t0 = 1_000_000;
  const allows: boolean[] = [];
  for (let i = 0; i < REDIRECT_LOOP_MAX + 2; i++) {
    const r = nextRedirectLoopState(raw, "/caddy/link", t0 + i * 100);
    raw = r.serialized; allows.push(r.allow);
  }
  assert(allows.slice(0, REDIRECT_LOOP_MAX).every(Boolean), `같은 대상 ${REDIRECT_LOOP_MAX}회까지 허용`);
  assert(!allows[REDIRECT_LOOP_MAX], "초과 시 차단");
  assert(nextRedirectLoopState(raw, "/caddy/link", t0 + REDIRECT_LOOP_WINDOW_MS + 1000).allow, "시간창 경과 후 다시 허용");
  assert(nextRedirectLoopState(raw, "/caddy", t0 + 600).allow, "다른 대상은 허용");
  assert(nextRedirectLoopState("{bad", "/x", 1).allow, "손상 저장값 → 허용(fail-open)");
}

console.log("\n== F 소스 연결 ==");
{
  const link = read("src/app/caddy/link/CaddyLinkClient.tsx");
  assert(link.includes("resolveCaddyLinkPageGate(roleData.role)"), "CaddyLinkClient가 공용 게이트 사용");
  assert(!link.includes('roleData.role !== "caddy"'), "caddy 단독 검사 제거");
  assert(!link.includes('/login?callbackUrl=/caddy/link'), "/caddy/link → /login 되돌림 제거");
  assert(link.includes('allowClientRedirect("/caddy")'), "/caddy 복귀에 루프 가드");
  const caddy = read("src/app/caddy/page.tsx");
  assert(caddy.includes("allowClientRedirect('/caddy/link')"), "/caddy → /caddy/link 루프 가드");
  const login = read("src/app/login/page.tsx");
  assert(login.includes("resolveLoginPageRedirect(auth)"), "/login이 공용 규칙 사용");
  const mw = read("src/middleware.ts");
  assert(/pathname\.startsWith\("\/manage"\)[\s\S]{0,80}session\.role !== "admin"/.test(mw), "middleware /manage admin 전용 불변");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
