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
  AUTO_REDIRECT_MAX,
  AUTO_REDIRECT_WINDOW_MS,
  nextAutoRedirectState,
} from "../src/lib/redirectLoopGuard";
import { parseMineLinkPayload, resolveCaddyLinkScreen } from "../src/lib/caddyLinkRequestUi";

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

console.log("\n== E 루프 가드 (경로 무관 누적, 정상 렌더 시 초기화) ==");
{
  const run = (targets: string[], step = 100, resetAfter: number[] = []) => {
    let raw: string | null = null;
    const allows: boolean[] = [];
    targets.forEach((_t, i) => {
      if (resetAfter.includes(i)) raw = null; // 정상 렌더 → resetAutoRedirects
      const r = nextAutoRedirectState(raw, 1_000_000 + i * step);
      raw = r.serialized;
      allows.push(r.allow);
    });
    return allows;
  };
  const alt = Array.from({ length: 10 }, (_, i) => (i % 2 ? "/caddy" : "/caddy/link"));
  const a1 = run(alt);
  assert(a1.slice(0, AUTO_REDIRECT_MAX).every(Boolean), `교대 이동도 ${AUTO_REDIRECT_MAX}회까지 허용`);
  assert(a1.indexOf(false) === AUTO_REDIRECT_MAX, "/caddy ↔ /caddy/link 교대 루프 차단 (이전 대상별 가드는 0회 차단)");
  assert(run(["/caddy/link"]).every(Boolean), "정상: 로그인 → /caddy → /caddy/link 1회 통과");
  assert(run(["/caddy/link", "/caddy"]).every(Boolean), "정상: 승인 후 /caddy/link → /caddy 통과");
  const reloads = Array.from({ length: 8 }, () => "/caddy/link");
  assert(run(reloads, 100, [1, 2, 3, 4, 5, 6, 7]).every(Boolean), "새로고침·뒤로가기 8회: 매번 정상 렌더로 초기화 → 차단 없음");
  assert(run(Array.from({ length: 8 }, () => "/x"), AUTO_REDIRECT_WINDOW_MS).every(Boolean), "시간창 밖 이동은 차단 없음");
  assert(nextAutoRedirectState("{bad", 1).allow, "손상 저장값 → 허용(fail-open)");
}

console.log("\n== G /caddy/link 화면 상태 (무한 '불러오는 중' 없음) ==");
{
  const m = { linked: false, caddyId: null, request: null };
  const S = resolveCaddyLinkScreen;
  assert(S({ loading: true, redirecting: false, fatalError: "", mine: null }) === "loading", "로딩 중");
  assert(S({ loading: false, redirecting: false, fatalError: "본인확인을 진행할 수 없는", mine: null }) === "error", "역할 불가 → 오류 화면");
  assert(S({ loading: false, redirecting: false, fatalError: "조회 실패", mine: null }) === "error", "/mine 비정상 응답 → 오류 화면");
  assert(S({ loading: false, redirecting: false, fatalError: "", mine: null }) === "error", "로딩 종료 + mine 없음 → 오류 화면 (불러오는 중 아님)");
  assert(S({ loading: false, redirecting: true, fatalError: "", mine: null }) === "redirecting", "자동 이동 중 → 이동 중 표시");
  assert(S({ loading: false, redirecting: false, fatalError: "", mine: m }) === "content", "정상 → 본인확인 화면");
  assert(S({ loading: false, redirecting: false, fatalError: "x", mine: m }) === "error", "오류 우선");
  // 전수: loading=false 이면 절대 loading 이 아님
  let ok = true;
  for (const r of [true, false]) for (const f of ["", "e"]) for (const mm of [null, m]) {
    if (S({ loading: false, redirecting: r, fatalError: f, mine: mm }) === "loading") ok = false;
  }
  assert(ok, "로딩 종료 후 모든 조합이 content·error·redirecting 중 하나");
  assert(parseMineLinkPayload({ ok: true, linked: false, caddyId: null, request: null }) !== null, "정상 /mine 응답 파싱");
  assert(parseMineLinkPayload(null) === null, "null 응답 → 형식 오류");
  assert(parseMineLinkPayload({ error: "x" }) === null, "linked 누락 → 형식 오류");
  assert(parseMineLinkPayload({ linked: "yes" }) === null, "linked 타입 오류 → 형식 오류");
  assert(parseMineLinkPayload({ linked: false, request: "x" }) === null, "request 타입 오류 → 형식 오류");
}

console.log("\n== F 소스 연결 ==");
{
  const link = read("src/app/caddy/link/CaddyLinkClient.tsx");
  assert(link.includes("resolveCaddyLinkPageGate(roleData.role)"), "CaddyLinkClient가 공용 게이트 사용");
  assert(!link.includes('roleData.role !== "caddy"'), "caddy 단독 검사 제거");
  assert(!link.includes("/login?callbackUrl=/caddy/link"), "/caddy/link → /login 자동 되돌림 없음");
  assert(!link.includes("if (loading || !mine)"), "무한 로딩 조건 제거");
  assert(link.includes("resolveCaddyLinkScreen("), "화면 상태 함수 사용");
  assert(link.includes("다시 시도") && link.includes("로그아웃 후 로그인 화면으로"), "오류 화면 사용자 동작 버튼");
  assert(link.includes("parseMineLinkPayload(data)"), "/mine 응답 형식 검사");
  assert(link.includes("recordAutoRedirect()") && link.includes("resetAutoRedirects()"), "link: 가드 기록·초기화");
  const caddy = read("src/app/caddy/page.tsx");
  assert(caddy.includes("recordAutoRedirect()") && caddy.includes("resetAutoRedirects()"), "/caddy: 가드 기록·초기화");
  assert(!/allowClientRedirect/.test(caddy + link), "이전 대상별 가드 제거");
  const login = read("src/app/login/page.tsx");
  assert(login.includes("resolveLoginPageRedirect(auth)"), "/login이 공용 규칙 사용");
  const mw = read("src/middleware.ts");
  assert(/pathname\.startsWith\("\/manage"\)[\s\S]{0,80}session\.role !== "admin"/.test(mw), "middleware /manage admin 전용 불변");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
