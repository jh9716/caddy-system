/**
 * 자유게시판 V1 — local caddy_local only (assertLocalDatabaseUrl).
 * 실행: npm run test:free-board-unit
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import { SESSION_COOKIE_NAME, buildSessionClaims, signSessionClaims } from "../src/lib/sessionCookies";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import {
  createMemoryCourseReportPhotoStore,
  type CourseReportPhotoStore,
} from "../src/lib/courseReportPhotoStorage";
import {
  resolveFreeBoardStorageDecision,
  setFreeBoardStoreFactoryForTests,
} from "../src/lib/freeBoardPhotoStorage";

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}
function section(t: string) {
  console.log("\n==", t, "==");
}
const read = (rel: string) => fs.readFileSync(path.resolve(rel), "utf8");
const png = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const jpeg = () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const webp = () => Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

async function cookieFor(u: { id: number | null; username: string; role: "admin" | "caddy" | "leader" }) {
  return `${SESSION_COOKIE_NAME}=${await signSessionClaims(
    buildSessionClaims({ userId: u.id, username: u.username, role: u.role, sessionVersion: 0 })
  )}`;
}
const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(url, init);
const json = (r: Response) => r.json().catch(() => ({}));
const idP = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prevSecret = process.env.SESSION_SECRET;
  const prevFlag = process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED;
  process.env.SESSION_SECRET = "free-board-unit-secret-32chars!!!!";

  section("flag OFF (기본값) — Production 비노출");
  delete process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED;
  const { isFreeBoardEnabled } = await import("../src/lib/freeBoardConstants");
  const { memberNavItems } = await import("../src/lib/boardNav");
  assert(isFreeBoardEnabled() === false, "flag default off");
  assert(!memberNavItems().some((i) => i.href === "/community"), "member nav hides /community when off");
  const { ADMIN_MAIN_NAV } = await import("../src/lib/adminManageNav");
  assert(!ADMIN_MAIN_NAV.some((i) => i.href === "/community"), "admin nav hides /community when off");
  {
    const layout = read("src/app/community/layout.tsx");
    assert(/if \(!isFreeBoardEnabled\(\)\) notFound\(\)/.test(layout), "layout: flag OFF → notFound");
    const access = read("src/lib/freeBoard.ts");
    assert(/if \(!isFreeBoardEnabled\(\)\) return freeBoardDisabledResponse\(\)/.test(access), "API guard: flag OFF → 404 before auth");
    for (const f of [
      "src/app/api/free-board/route.ts",
      "src/app/api/free-board/[id]/route.ts",
      "src/app/api/free-board/[id]/photos/route.ts",
      "src/app/api/free-board/[id]/photos/[photoId]/route.ts",
      "src/app/api/free-board/[id]/comments/route.ts",
      "src/app/api/free-board/[id]/comments/[commentId]/route.ts",
    ]) {
      const src = read(f);
      const handlers = (src.match(/export async function (GET|POST|PATCH|DELETE)/g) || []).length;
      const guards = (src.match(/requireFreeBoardReader\(req\)/g) || []).length;
      assert(handlers > 0 && handlers === guards, `${f}: 모든 handler 가 flag/auth guard 사용`);
    }
  }
  const listMod = await import("../src/app/api/free-board/route");
  const off = await listMod.GET(req("http://local/api/free-board"));
  assert(off.status === 404, "API 404 when flag off");

  section("가배치표 게시판 명칭 / 사진 보기");
  {
    const C = await import("../src/lib/freeBoardConstants");
    assert(C.FREE_BOARD_LABEL === "가배치표 게시판", "표시 명칭 = 가배치표 게시판");
    const visibleFiles = [
      "src/app/community/page.tsx",
      "src/app/community/new/page.tsx",
      "src/app/community/[id]/page.tsx",
      "src/app/community/[id]/edit/page.tsx",
      "src/app/community/[id]/FreeBoardDetailActions.tsx",
      "src/app/community/[id]/FreeBoardComments.tsx",
      "src/app/community/FreeBoardForm.tsx",
      "src/app/community/FreeBoardPhotoGallery.tsx",
      "src/app/community/loading.tsx",
      "src/lib/boardNav.ts",
      "src/lib/adminManageNav.ts",
    ];
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    for (const f of visibleFiles) {
      assert(!strip(read(f)).includes("자유게시판"), `사용자 표시 '자유게시판' 없음: ${f}`);
    }
    assert(read("src/lib/boardNav.ts").includes("label: FREE_BOARD_LABEL") && read("src/lib/adminManageNav.ts").includes("label: FREE_BOARD_LABEL"), "메뉴 라벨 = FREE_BOARD_LABEL");
    assert(read("src/lib/boardNav.ts").includes('label: "배치표"'), "확정 배치표(/board) 메뉴 라벨 유지");
    assert(read("src/app/community/page.tsx").includes("+ 가배치표 올리기"), "목록: 가배치표 올리기 버튼");
    assert(read("src/app/community/new/page.tsx").includes("가배치표 올리기"), "작성 화면 제목");
    assert(read("src/app/community/[id]/edit/page.tsx").includes("가배치표 수정"), "수정 화면 제목");
    assert(/metadata = \{ title: FREE_BOARD_LABEL \}/.test(read("src/app/community/layout.tsx")), "페이지 title metadata");
    const g = read("src/app/community/FreeBoardPhotoGallery.tsx");
    assert(g.includes('target="_blank"') && g.includes("원본 보기"), "상세 사진: 탭/링크로 원본 새 탭 (핀치 줌)");
    assert(!g.includes("course-report-photo-grid") && !g.includes("course-report-photo-lightbox"), "공용 코스제보 갤러리/라이트박스 미사용");
    const css = read("src/app/globals.css");
    assert(/\.free-board-sheet-img \{[^}]*width: 100%;[^}]*height: auto;[^}]*object-fit: contain;/.test(css), "상세 사진 전체 폭 + contain (잘림 없음)");
    assert(!/user-scalable|maximumScale/.test(read("src/app/layout.tsx")), "viewport 확대 금지 설정 없음");
    const pc = await import("../src/lib/freeBoardPhotoClient");
    assert(C.FREE_BOARD_PHOTO_LONG_EDGE === 2560 && C.FREE_BOARD_PHOTO_JPEG_QUALITY === 0.9, "가배치표 전처리 2560px / 0.9");
    assert(C.FREE_BOARD_PHOTO_MAX_BYTES === 3 * 1024 * 1024, "서버 장당 3MB 제한 그대로");
    const t1 = pc.freeBoardTargetSize(1170, 2532, 2560);
    assert(t1.width === 1170 && t1.height === 2532, "아이폰 세로 캡처(1170x2532) 축소 없음");
    const t2 = pc.freeBoardTargetSize(4032, 3024, 2560);
    assert(t2.width === 2560 && t2.height === 1920, "카메라 4032x3024 → 2560x1920");
    assert(pc.FREE_BOARD_ENCODE_STEPS.every(([e, q]) => e >= 1600 && q >= 0.75), "3MB 초과 시 단계 축소 (최소 1600px)");
    const cc = await import("../src/lib/courseReportPhotoConstants");
    assert(cc.COURSE_REPORT_PHOTO_LONG_EDGE === 1200 && cc.COURSE_REPORT_PHOTO_JPEG_QUALITY === 0.8, "공용 코스제보/공지 전처리 1200/0.8 변경 없음");
    assert(read("src/app/community/FreeBoardForm.tsx").includes("prepareFreeBoardPhoto(file)"), "폼은 가배치표 전용 전처리 사용");
  }

  section("source safety");
  {
    const files = [
      "src/lib/freeBoard.ts",
      "src/lib/freeBoardPhoto.ts",
      "src/lib/freeBoardComments.ts",
      "src/app/community/FreeBoardForm.tsx",
      "src/app/community/[id]/FreeBoardComments.tsx",
    ];
    for (const rel of files) {
      const src = read(rel);
      assert(!src.includes("dangerouslySetInnerHTML"), `${rel} no innerHTML`);
      if (rel === "src/lib/freeBoard.ts") {
        const chatImports = src.match(/^import .*chat.*$/gim) ?? [];
        assert(chatImports.length === 1 && chatImports[0].includes("chatEnvAdminIdentity"), `${rel} only env-admin identity dependency`);
      } else {
        assert(!/chat/i.test(src.replace(/chatgpt/gi, "")), `${rel} no chat dependency`);
      }
    }
    assert(read("src/lib/freeBoard.ts").includes("resolveEnvAdminChatIdentity"), "env 관리자 DB User 매핑 재사용");
    assert(!fs.existsSync("src/app/board/community"), "/board 경로 미사용");
    const mig = read("prisma/migrations/20261031220000_free_board_v1/migration.sql");
    assert(!/DROP|ALTER TABLE "(?!FreeBoard)/.test(mig.replace(/ALTER TABLE "FreeBoard\w*"/g, "")), "migration additive only");
    assert(read("src/lib/freeBoardPhoto.ts").includes("FREE_BOARD_STORAGE_PREFIX"), "dedicated storage prefix");
  }

  process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED = "1";
  assert(isFreeBoardEnabled() === true, "flag on");
  assert(memberNavItems().some((i) => i.href === "/community"), "member nav shows /community when on");

  const { GET: LIST, POST: CREATE } = listMod;
  const { GET: DETAIL, PATCH, DELETE: DEL } = await import("../src/app/api/free-board/[id]/route");
  const { POST: PHOTO_POST } = await import("../src/app/api/free-board/[id]/photos/route");
  const { GET: PHOTO_GET, DELETE: PHOTO_DEL } = await import(
    "../src/app/api/free-board/[id]/photos/[photoId]/route"
  );
  const { GET: C_LIST, POST: C_POST } = await import("../src/app/api/free-board/[id]/comments/route");
  const { PATCH: C_PATCH, DELETE: C_DEL } = await import("../src/app/api/free-board/[id]/comments/[commentId]/route");
  const { buildFreeBoardPhotoStorageKey, isFreeBoardStorageKey } = await import("../src/lib/freeBoardPhoto");

  const tag = `fb_${Date.now()}`;
  const hash = await bcrypt.hash("x", 4);
  const caddyIds: number[] = [];
  const userIds: number[] = [];
  const postIds: number[] = [];
  // 실제 Blob 호출 없음: 정책 판정은 실제 코드, store 만 메모리 mock.
  const mem = createMemoryCourseReportPhotoStore();
  const sharedMem = createMemoryCourseReportPhotoStore();
  let sharedCalls = 0;
  let deleteCalls = 0;
  let failDeleteKeys = new Set<string>();
  let failPutRemaining = 0;
  const dedicated: CourseReportPhotoStore = {
    ...mem,
    async put(...a) {
      if (failPutRemaining > 0) {
        failPutRemaining--;
        throw new Error("mock put failure");
      }
      return mem.put(...a);
    },
    async delete(key) {
      deleteCalls++;
      if (failDeleteKeys.has(key)) throw new Error("mock delete failure");
      return mem.delete(key);
    },
  };
  const sharedSpy: CourseReportPhotoStore = {
    ...sharedMem,
    async put(...a) {
      sharedCalls++;
      return sharedMem.put(...a);
    },
    async delete(k) {
      sharedCalls++;
      return sharedMem.delete(k);
    },
  };
  setFreeBoardStoreFactoryForTests({ dedicated: () => dedicated, shared: () => sharedSpy });
  const prevEnv = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    FREE_BOARD_STORAGE_ENV: process.env.FREE_BOARD_STORAGE_ENV,
    FREE_BOARD_BLOB_READ_WRITE_TOKEN: process.env.FREE_BOARD_BLOB_READ_WRITE_TOKEN,
    FREE_BOARD_PREVIEW_BLOB_STORE_ID: process.env.FREE_BOARD_PREVIEW_BLOB_STORE_ID,
    FREE_BOARD_PRODUCTION_BLOB_STORE_ID: process.env.FREE_BOARD_PRODUCTION_BLOB_STORE_ID,
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
    BLOB_STORE_ID: process.env.BLOB_STORE_ID,
    ADMIN_CHAT_USER_ID: process.env.ADMIN_CHAT_USER_ID,
  };
  // 가짜 값 (실제 토큰 아님)
  const FAKE_PREVIEW = "vercel_blob_rw_previewstore111_fakesecret";
  const FAKE_PROD = "vercel_blob_rw_prodstore999_fakesecret";
  Object.assign(process.env, {
    VERCEL_ENV: "preview",
    FREE_BOARD_STORAGE_ENV: "preview",
    FREE_BOARD_BLOB_READ_WRITE_TOKEN: FAKE_PREVIEW,
    FREE_BOARD_PREVIEW_BLOB_STORE_ID: "previewstore111",
    FREE_BOARD_PRODUCTION_BLOB_STORE_ID: "prodstore999",
    BLOB_READ_WRITE_TOKEN: FAKE_PROD,
  });
  delete process.env.BLOB_STORE_ID;

  section("storage isolation policy (fail-closed)");
  {
    const D = (env: Record<string, string>) => resolveFreeBoardStorageDecision(env);
    const GOOD = {
      VERCEL_ENV: "preview",
      FREE_BOARD_STORAGE_ENV: "preview",
      FREE_BOARD_BLOB_READ_WRITE_TOKEN: FAKE_PREVIEW,
      FREE_BOARD_PREVIEW_BLOB_STORE_ID: "previewstore111",
      FREE_BOARD_PRODUCTION_BLOB_STORE_ID: "prodstore999",
    };
    const code = (d: ReturnType<typeof D>) => (d.ok ? "ALLOW" : d.code);
    const without = (k: string) => {
      const e: Record<string, string> = { ...GOOD };
      delete e[k];
      return e;
    };
    assert(code(D(GOOD)) === "ALLOW", "allow: 모든 증명 충족 (공용 자격증명 없음)");
    assert(code(D({ ...GOOD, BLOB_READ_WRITE_TOKEN: FAKE_PROD })) === "ALLOW", "allow: 공용 토큰 있고 다른 store");
    assert(code(D({ ...GOOD, VERCEL_ENV: "development" })) === "ALLOW", "allow: development 도 동일 규칙");
    assert(code(D(without("FREE_BOARD_STORAGE_ENV"))) === "free_board_preview_storage_missing", "block: 마커 없음");
    assert(code(D({ ...GOOD, FREE_BOARD_STORAGE_ENV: "production" })) === "free_board_preview_storage_missing", "block: 마커 값 다름");
    assert(code(D(without("FREE_BOARD_BLOB_READ_WRITE_TOKEN"))) === "free_board_preview_storage_missing", "block: 전용 토큰 없음 (공용 fallback 없음)");
    assert(code(D({ ...GOOD, FREE_BOARD_BLOB_READ_WRITE_TOKEN: "garbage" })) === "free_board_storage_token_invalid", "block: 토큰 형식 불명");
    assert(code(D(without("FREE_BOARD_PREVIEW_BLOB_STORE_ID"))) === "free_board_storage_isolation_unproven", "block: preview store id 선언 없음");
    assert(code(D({ ...GOOD, FREE_BOARD_PREVIEW_BLOB_STORE_ID: "otherstore" })) === "free_board_storage_isolation_unproven", "block: 선언 id ≠ 토큰 id");
    assert(code(D({ ...GOOD, FREE_BOARD_PREVIEW_BLOB_STORE_ID: "bad id!" })) === "free_board_storage_isolation_unproven", "block: 선언 id 형식 오류");
    assert(code(D(without("FREE_BOARD_PRODUCTION_BLOB_STORE_ID"))) === "free_board_storage_isolation_unproven", "block: 운영 store id 모름 (증명 불가)");
    assert(code(D({ ...GOOD, FREE_BOARD_PRODUCTION_BLOB_STORE_ID: "??" })) === "free_board_storage_isolation_unproven", "block: 운영 store id 형식 오류");
    assert(code(D({ ...GOOD, FREE_BOARD_PRODUCTION_BLOB_STORE_ID: "previewstore111" })) === "free_board_storage_shared", "block: 운영 id == preview id");
    assert(code(D({ ...GOOD, FREE_BOARD_PRODUCTION_BLOB_STORE_ID: "store_PreviewStore111" })) === "free_board_storage_shared", "block: store_ 접두/대소문자 정규화 후 동일");
    assert(code(D({ ...GOOD, BLOB_READ_WRITE_TOKEN: FAKE_PREVIEW })) === "free_board_storage_shared", "block: 공용 토큰과 동일");
    assert(code(D({ ...GOOD, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_previewstore111_other" })) === "free_board_storage_shared", "block: 공용 토큰 store 동일");
    assert(code(D({ ...GOOD, BLOB_READ_WRITE_TOKEN: "weird-format" })) === "free_board_storage_isolation_unproven", "block: 공용 토큰 파싱 불가");
    assert(code(D({ ...GOOD, BLOB_STORE_ID: "store_previewstore111" })) === "free_board_storage_shared", "block: BLOB_STORE_ID 동일");
    assert(code(D({ ...GOOD, BLOB_STORE_ID: "!!" })) === "free_board_storage_isolation_unproven", "block: BLOB_STORE_ID 파싱 불가");
    assert(code(D({})) === "free_board_preview_storage_missing", "block: 로컬/미설정");
    assert(code(D({ VERCEL_ENV: "production" })) === "ALLOW" && (D({ VERCEL_ENV: "production" }) as { mode: string }).mode === "shared", "production: 기존 공용 store 그대로 (변경 없음)");
    assert(code(D({ VERCEL_ENV: "production", FREE_BOARD_STORAGE_ENV: "preview" })) === "free_board_storage_env_mismatch", "production + preview 마커 차단");
    // no-leak sentinel: 모든 판정 결과 직렬화에 토큰/스토어 id 미포함
    const SENT = "zzsentinel777";
    const leakCases = [
      { ...GOOD, FREE_BOARD_BLOB_READ_WRITE_TOKEN: `vercel_blob_rw_${SENT}_secretpart`, FREE_BOARD_PREVIEW_BLOB_STORE_ID: SENT },
      { ...GOOD, FREE_BOARD_PRODUCTION_BLOB_STORE_ID: SENT },
      { ...GOOD, BLOB_READ_WRITE_TOKEN: `vercel_blob_rw_${SENT}_x` },
      { ...GOOD, FREE_BOARD_BLOB_READ_WRITE_TOKEN: `${SENT}secretpart` },
    ];
    const out = leakCases.map((e) => JSON.stringify(D(e))).join(" ");
    assert(!out.includes(SENT) && !out.includes("secretpart"), "no-leak: 판정 결과에 id/토큰 조각 없음");
    const src = read("src/lib/freeBoardPhotoStorage.ts");
    assert(!/console\.(log|error|warn|info)/.test(src), "storage 정책 모듈 로그 출력 없음");
    const photoSrc = read("src/lib/freeBoardPhoto.ts");
    assert(!/storageKey,?\s*\}|key:\s*it\.storageKey/.test(photoSrc.slice(photoSrc.indexOf("orphanLogger"))), "orphan 로그에 key 없음");
  }

  section("storage prefix guard");
  {
    const { guardFreeBoardStore, FREE_BOARD_KEY_RE } = await import("../src/lib/freeBoardPhotoStorage");
    const calls: string[] = [];
    const inner = createMemoryCourseReportPhotoStore();
    const spy: CourseReportPhotoStore = {
      ...inner,
      async put(k, b, m) { calls.push(k); return inner.put(k, b, m); },
      async get(k) { calls.push(k); return inner.get(k); },
      async delete(k) { calls.push(k); return inner.delete(k); },
    };
    const g = guardFreeBoardStore(spy);
    const okKey = "free-board/12/0f8fad5b-d9cb-469f-a165-70867728950e.png";
    assert(FREE_BOARD_KEY_RE.test(okKey), "정상 key 허용");
    await g.put(okKey, png(), "image/png");
    for (const bad of [
      "notices/1/0f8fad5b-d9cb-469f-a165-70867728950e.png",
      "course-reports/1/0f8fad5b-d9cb-469f-a165-70867728950e.png",
      "free-board/../notices/x.png",
      "free-board/1/../../notices/0f8fad5b-d9cb-469f-a165-70867728950e.png",
      "free-board/abc/0f8fad5b-d9cb-469f-a165-70867728950e.png",
      "free-board/1/anything.png",
      "free-board/",
    ]) {
      let threw = 0;
      for (const fn of [() => g.get(bad), () => g.delete(bad), () => g.put(bad, png(), "image/png")]) {
        try { await fn(); } catch { threw++; }
      }
      assert(threw === 3, `차단: ${bad.split("/")[0]}/… (get/delete/put)`);
    }
    assert(calls.length === 1 && calls[0] === okKey, "inner store 는 free-board key 만 호출됨");
  }
  try {
    const cA = await prisma.caddy.create({
      data: { name: "자유캐디A", team: "1조", caddyType: "HOUSE", employmentStatus: "ACTIVE" },
    });
    const cB = await prisma.caddy.create({
      data: { name: "자유캐디B", team: "2조", caddyType: "HOUSE", employmentStatus: "ACTIVE" },
    });
    const cLeader = await prisma.caddy.create({
      data: { name: "자유조장", team: "1조", caddyType: "HOUSE", employmentStatus: "ACTIVE" },
    });
    caddyIds.push(cA.id, cB.id, cLeader.id);
    const uA = await prisma.user.create({
      data: { username: `${tag}_a`, password: hash, role: "caddy", caddyId: cA.id },
    });
    const uB = await prisma.user.create({
      data: { username: `${tag}_b`, password: hash, role: "caddy", caddyId: cB.id },
    });
    const uAdmin = await prisma.user.create({
      data: { username: `${tag}_admin`, password: hash, role: "admin" },
    });
    const uLeader = await prisma.user.create({
      data: { username: `${tag}_leader`, password: hash, role: "leader", managedTeams: ["1조"], caddyId: cLeader.id },
    });
    userIds.push(uA.id, uB.id, uAdmin.id, uLeader.id);
    const A = await cookieFor({ id: uA.id, username: uA.username, role: "caddy" });
    const B = await cookieFor({ id: uB.id, username: uB.username, role: "caddy" });
    const ADM = await cookieFor({ id: uAdmin.id, username: uAdmin.username, role: "admin" });
    const L = await cookieFor({ id: uLeader.id, username: uLeader.username, role: "leader" });
    const ENV_ADM = await cookieFor({ id: null, username: "env-admin", role: "admin" });
    process.env.ADMIN_CHAT_USER_ID = String(uAdmin.id);
    const H = (cookie: string) => ({ cookie, "content-type": "application/json" });

    section("auth");
    assert((await LIST(req("http://local/api/free-board"))).status === 401, "unauth list 401");
    assert(
      (
        await CREATE(
          req("http://local/api/free-board", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "t", body: "b" }),
          })
        )
      ).status === 401,
      "unauth create 401"
    );

    section("create / validation / 관리자 전용");
    assert((await CREATE(req("http://local/api/free-board", { method: "POST", headers: H(A), body: JSON.stringify({ title: "t", body: "b" }) }))).status === 403, "caddy create 403");
    assert((await CREATE(req("http://local/api/free-board", { method: "POST", headers: H(B), body: JSON.stringify({ title: "t", body: "b" }) }))).status === 403, "other caddy create 403");
    assert((await CREATE(req("http://local/api/free-board", { method: "POST", headers: H(L), body: JSON.stringify({ title: "t", body: "b" }) }))).status === 403, "leader create 403");
    const bad1 = await CREATE(
      req("http://local/api/free-board", { method: "POST", headers: H(ADM), body: JSON.stringify({ title: " ", body: "b" }) })
    );
    assert(bad1.status === 400, "empty title 400");
    const bad2 = await CREATE(
      req("http://local/api/free-board", {
        method: "POST",
        headers: H(ADM),
        body: JSON.stringify({ title: "x".repeat(101), body: "b" }),
      })
    );
    assert(bad2.status === 400, "title too long 400");
    const bad3 = await CREATE(
      req("http://local/api/free-board", {
        method: "POST",
        headers: H(ADM),
        body: JSON.stringify({ title: "t", body: "b".repeat(5001) }),
      })
    );
    assert(bad3.status === 400, "body too long 400");
    const created = await CREATE(
      req("http://local/api/free-board", {
        method: "POST",
        headers: H(ADM),
        body: JSON.stringify({ title: " 첫 글 ", body: "<b>내용</b>" }),
      })
    );
    const cBody = await json(created);
    assert(created.status === 201, "create 201");
    const pid = Number(cBody.id);
    postIds.push(pid);
    assert(cBody.post.title === "첫 글", "title trimmed");
    assert(cBody.post.body === "<b>내용</b>", "body stored as plain text");
    assert(cBody.post.authorDisplayName === uAdmin.username, "author display = admin username");
    assert(cBody.post.canEdit && cBody.post.canDelete, "admin can edit/delete");
    const envCreated = await CREATE(
      req("http://local/api/free-board", { method: "POST", headers: H(ENV_ADM), body: JSON.stringify({ title: "환경 관리자", body: "b" }) })
    );
    const envCreatedBody = await json(envCreated);
    postIds.push(Number(envCreatedBody.id));
    assert(envCreated.status === 201 && envCreatedBody.post.authorUserId === uAdmin.id, "env 관리자 → 지정 DB admin User 매핑 후 작성");

    section("list / detail");
    const list = await json(await LIST(req("http://local/api/free-board", { headers: { cookie: B } })));
    const row = list.posts.find((p: { id: number }) => p.id === pid);
    assert(row && row.canEdit === false && row.canDelete === false, "other: no edit/delete flags");
    assert(list.canCompose === false, "caddy cannot compose");
    const adminList = await json(await LIST(req("http://local/api/free-board", { headers: { cookie: ADM } })));
    const arow = adminList.posts.find((p: { id: number }) => p.id === pid);
    assert(arow.canDelete === true && arow.canEdit === true, "admin: edit/delete yes");
    const det = await DETAIL(req(`http://local/api/free-board/${pid}`, { headers: { cookie: B } }), idP(pid));
    assert(det.status === 200, "detail 200");
    assert((await DETAIL(req(`http://local/api/free-board/${pid}`, { headers: { cookie: L } }), idP(pid))).status === 200, "leader detail 200");
    assert((await DETAIL(req(`http://local/api/free-board/999999`, { headers: { cookie: B } }), idP(999999))).status === 404, "missing 404");
    assert((await DETAIL(req(`http://local/api/free-board/abc`, { headers: { cookie: B } }), { params: Promise.resolve({ id: "abc" }) })).status === 404, "bad id 404");

    section("edit (admin only)");
    const patch = (cookie: string, body: unknown) =>
      PATCH(req(`http://local/api/free-board/${pid}`, { method: "PATCH", headers: H(cookie), body: JSON.stringify(body) }), idP(pid));
    assert((await patch(B, { title: "x", body: "y" })).status === 403, "other PATCH 403");
    assert((await patch(A, { title: "x", body: "y" })).status === 403, "caddy PATCH 403");
    assert((await patch(ADM, { title: "", body: "y" })).status === 400, "admin PATCH invalid 400");
    const ok = await patch(ADM, { title: "수정 제목", body: "수정 내용" });
    assert(ok.status === 200, "admin PATCH 200");
    const after = await prisma.freeBoardPost.findUnique({ where: { id: pid } });
    assert(after?.title === "수정 제목" && after?.authorUserId === uAdmin.id, "DB updated, author unchanged");

    section("photos (max 9, type, permission, prefix)");
    const up = (cookie: string, bytes: Uint8Array, id = pid) => {
      const fd = new FormData();
      fd.append("file", new Blob([bytes as BlobPart], { type: "image/png" }), "p.png");
      return PHOTO_POST(req(`http://local/api/free-board/${id}/photos`, { method: "POST", headers: { cookie }, body: fd }), idP(id));
    };
    const streamedUpload = (id: number, cookie: string, chunks: Uint8Array[], headers: Record<string, string> = {}) => {
      let index = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index >= chunks.length) return controller.close();
          controller.enqueue(chunks[index++]);
        },
      });
      return PHOTO_POST(
        new NextRequest(`http://local/api/free-board/${id}/photos`, {
          method: "POST",
          headers: { cookie, "content-type": "image/png", ...headers },
          body,
          duplex: "half",
        }),
        idP(id)
      );
    };
    assert((await up(B, png())).status === 403, "other upload 403");
    const notImg = await up(ADM, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    assert(notImg.status >= 400 && notImg.status < 500, "non-image rejected 4xx");

    const securityPost = await json(
      await CREATE(req("http://local/api/free-board", { method: "POST", headers: H(ADM), body: JSON.stringify({ title: "업로드 보안", body: "b" }) }))
    );
    const securityPostId = Number(securityPost.id);
    postIds.push(securityPostId);
    const exact3Mb = new Uint8Array(3 * 1024 * 1024);
    exact3Mb.set(png());
    assert((await streamedUpload(securityPostId, ADM, [exact3Mb])).status === 201, "Content-Length 없이 정확히 3MB PNG 허용");
    assert((await streamedUpload(securityPostId, ADM, [jpeg()], { "content-type": "image/jpeg" })).status === 201, "JPEG 업로드 유지");
    assert((await streamedUpload(securityPostId, ADM, [webp()], { "content-type": "image/webp" })).status === 201, "WebP 업로드 유지");
    const requestLimit = 3 * 1024 * 1024 + 64 * 1024;
    const oversizedChunks = [Uint8Array.from(png()), new Uint8Array(requestLimit)];
    const noLengthOversize = await streamedUpload(securityPostId, ADM, oversizedChunks);
    assert(noLengthOversize.status === 413, "Content-Length 없는 초과 스트림 → 413");
    const spoofedLengthOversize = await streamedUpload(securityPostId, ADM, oversizedChunks, { "content-length": "12" });
    assert(spoofedLengthOversize.status === 413, "조작된 작은 Content-Length + 초과 스트림 → 413");
    const declaredOversize = await streamedUpload(securityPostId, ADM, [png()], { "content-length": String(requestLimit + 1) });
    assert(declaredOversize.status === 413, "선언 Content-Length 초과 → body 파싱 전 413");
    assert((await prisma.freeBoardPhoto.count({ where: { postId: securityPostId } })) === 3, "차단 요청은 사진 행을 만들지 않음");
    let lastPhotoId = 0;
    for (let i = 0; i < 9; i++) {
      const r = await up(ADM, png());
      const b = await json(r);
      if (r.status !== 201) console.error("upload", i, r.status, b);
      lastPhotoId = Number(b.photo?.id);
    }
    assert((await prisma.freeBoardPhoto.count({ where: { postId: pid } })) === 9, "9 photos stored");
    const tenth = await up(ADM, png());
    assert(tenth.status === 409, "10th photo 409");
    assert((await prisma.freeBoardPhoto.count({ where: { postId: pid } })) === 9, "still 9 after 10th");
    const keys = await prisma.freeBoardPhoto.findMany({ where: { postId: pid }, select: { storageKey: true } });
    assert(keys.every((k) => k.storageKey.startsWith(`free-board/${pid}/`)), "all keys under free-board/<postId>/");
    assert(isFreeBoardStorageKey(buildFreeBoardPhotoStorageKey(1, "image/png")), "key builder prefix");
    assert(!isFreeBoardStorageKey("notices/1/x.png"), "notice key rejected");
    assert(!isFreeBoardStorageKey("free-board/../notices/x.png"), "traversal rejected");
    const pget = await PHOTO_GET(
      req(`http://local/api/free-board/${pid}/photos/${lastPhotoId}`, { headers: { cookie: B } }),
      { params: Promise.resolve({ id: String(pid), photoId: String(lastPhotoId) }) }
    );
    assert(pget.status === 200, "photo GET 200 for reader");
    const pdelOther = await PHOTO_DEL(
      req(`http://local/api/free-board/${pid}/photos/${lastPhotoId}`, { method: "DELETE", headers: { cookie: B } }),
      { params: Promise.resolve({ id: String(pid), photoId: String(lastPhotoId) }) }
    );
    assert(pdelOther.status === 403, "other photo delete 403");
    const pdel = await PHOTO_DEL(
      req(`http://local/api/free-board/${pid}/photos/${lastPhotoId}`, { method: "DELETE", headers: { cookie: ADM } }),
      { params: Promise.resolve({ id: String(pid), photoId: String(lastPhotoId) }) }
    );
    assert(pdel.status === 200, "admin photo delete 200");
    assert((await up(ADM, png())).status === 201, "upload again after delete (8→9)");
    assert(sharedCalls === 0, "preview 에서 공용 store 미사용");

    section("comments");
    const cpost = (cookie: string, body: unknown) =>
      C_POST(req(`http://local/api/free-board/${pid}/comments`, { method: "POST", headers: H(cookie), body: JSON.stringify({ body }) }), idP(pid));
    const c1 = await cpost(B, "B 댓글");
    assert(c1.status === 201, "comment create 201");
    const c1id = Number((await json(c1)).comment.id);
    const leaderComment = await cpost(L, "조장 댓글");
    const leaderCommentId = Number((await json(leaderComment)).comment.id);
    assert(leaderComment.status === 201, "leader comment create 201");
    const adminComment = await cpost(ADM, "관리자 댓글");
    const adminCommentId = Number((await json(adminComment)).comment.id);
    assert(adminComment.status === 201, "admin comment create 201");
    const envAdminComment = await cpost(ENV_ADM, "환경 관리자 댓글");
    const envAdminCommentBody = await json(envAdminComment);
    const envAdminCommentId = Number(envAdminCommentBody.comment.id);
    assert(envAdminComment.status === 201 && envAdminCommentBody.comment?.authorUserId === uAdmin.id, "env 관리자 댓글 DB User 매핑");
    assert((await cpost(B, "  ")).status === 400, "empty comment 400");
    const cl = await json(await C_LIST(req(`http://local/api/free-board/${pid}/comments`, { headers: { cookie: A } }), idP(pid)));
    assert(cl.comments.length === 4 && cl.comments[0].authorDisplayName === "자유캐디B", "comment list with authors");
    assert(
      (await json(await LIST(req("http://local/api/free-board", { headers: { cookie: A } })))).posts.find(
        (p: { id: number }) => p.id === pid
      ).commentCount === 4,
      "list commentCount 4"
    );
    const cdel = (cookie: string, cid: number) =>
      C_DEL(req(`http://local/api/free-board/${pid}/comments/${cid}`, { method: "DELETE", headers: { cookie } }), {
        params: Promise.resolve({ id: String(pid), commentId: String(cid) }),
      });
    const cpatch = (cookie: string, cid: number, body: string) =>
      C_PATCH(req(`http://local/api/free-board/${pid}/comments/${cid}`, { method: "PATCH", headers: H(cookie), body: JSON.stringify({ body }) }), {
        params: Promise.resolve({ id: String(pid), commentId: String(cid) }),
      });
    assert((await cdel(A, c1id)).status === 403, "non-author comment delete 403");
    assert((await cpatch(A, c1id, "x")).status === 403, "non-author comment edit 403");
    assert((await cpatch(ADM, c1id, "x")).status === 403, "admin cannot edit another user's comment");
    assert((await cpatch(B, c1id, "B 댓글 수정")).status === 200, "comment author edit 200");
    assert((await cpatch(L, leaderCommentId, "조장 댓글 수정")).status === 200, "leader own comment edit 200");
    assert((await cpatch(ENV_ADM, envAdminCommentId, "환경 관리자 댓글 수정")).status === 200, "env admin own comment edit 200");
    assert((await cpatch(L, adminCommentId, "x")).status === 403, "leader cannot edit admin comment");
    const c2id = Number((await json(await cpost(A, "A 댓글"))).comment.id);
    assert((await cdel(ADM, c1id)).status === 200, "admin comment delete 200");
    assert((await cdel(A, c2id)).status === 200, "own comment delete 200");
    assert((await cdel(L, leaderCommentId)).status === 200, "leader own comment delete 200");
    const thread = await prisma.commentThread.findFirst({ where: { targetType: "FREE_BOARD_POST", targetKey: String(pid) } });
    assert(thread != null, "FREE_BOARD_POST thread");

    section("upload blocked when preview storage missing");
    {
      const saved = process.env.FREE_BOARD_BLOB_READ_WRITE_TOKEN;
      delete process.env.FREE_BOARD_BLOB_READ_WRITE_TOKEN;
      const r = await up(ADM, png());
      const b = await json(r);
      assert(r.status === 503 && b.error === "free_board_preview_storage_missing", "전용 저장소 없음 → 503 code");
      process.env.FREE_BOARD_BLOB_READ_WRITE_TOKEN = saved;
      assert(sharedCalls === 0, "공용 store 호출 0회 (preview)");
    }

    section("concurrent uploads (race-safe 9 limit)");
    {
      const p2 = await json(
        await CREATE(req("http://local/api/free-board", { method: "POST", headers: H(ADM), body: JSON.stringify({ title: "동시", body: "b" }) }))
      );
      const id2 = Number(p2.id);
      postIds.push(id2);
      const results = await Promise.all(Array.from({ length: 15 }, () => up(ADM, png(), id2)));
      const okN = results.filter((r) => r.status === 201).length;
      const limitN = results.filter((r) => r.status === 409).length;
      assert(okN === 9, `동시 15건 중 성공 9 (실제 ${okN})`);
      assert(limitN === 6, `나머지 6건 409 (실제 ${limitN})`);
      assert((await prisma.freeBoardPhoto.count({ where: { postId: id2 } })) === 9, "DB 9장");
      const keys2 = await prisma.freeBoardPhoto.findMany({ where: { postId: id2 }, select: { storageKey: true } });
      let stored = 0;
      for (const k of keys2) if (await mem.head(k.storageKey)) stored++;
      assert(stored === 9, "DB 행마다 객체 존재");
    }

    section("client upload helper: 1/5/9장, 부분 실패 → 실패분만 재시도, 멱등");
    {
      const { uploadFreeBoardPhotos, newFreeBoardUploadKey } = await import("../src/lib/freeBoardUploadClient");
      const { normalizeFreeBoardUploadKey } = await import("../src/lib/freeBoardPhoto");
      const mkPost = async (title: string) => {
        const r = await json(
          await CREATE(req("http://local/api/free-board", { method: "POST", headers: H(ADM), body: JSON.stringify({ title, body: "b" }) }))
        );
        postIds.push(Number(r.id));
        return Number(r.id);
      };
      let netFail = new Set<number>();
      let calls = 0;
      const post = (async (url: string, init: RequestInit) => {
        const n = calls++;
        if (netFail.has(n)) throw new TypeError("Failed to fetch");
        const id = Number(String(url).split("/")[3]);
        return PHOTO_POST(
          req(`http://local${url}`, { method: "POST", headers: { ...(init.headers as Record<string, string>), cookie: ADM }, body: init.body as FormData }),
          idP(id)
        );
      }) as unknown as typeof fetch;
      const mkItems = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
          key: `k${i}`,
          uploadKey: newFreeBoardUploadKey(),
          blob: new Blob([png()], { type: "image/png" }),
          status: "ready" as const,
        })) as { key: string; uploadKey: string; blob: Blob; status: "ready" | "uploading" | "done" | "failed"; error?: string }[];
      const apply = (items: ReturnType<typeof mkItems>) => (key: string, patch: object) => {
        const it = items.find((x) => x.key === key)!;
        Object.assign(it, patch);
      };
      for (const n of [1, 5, 9]) {
        const id = await mkPost(`n${n}`);
        const items = mkItems(n);
        const prog: string[] = [];
        const r = await uploadFreeBoardPhotos(id, items, { post, onItem: apply(items), onProgress: (d, t) => prog.push(`${d}/${t}`) });
        assert(r.uploaded === n && r.failed === 0, `${n}장 업로드 성공`);
        assert((await prisma.freeBoardPhoto.count({ where: { postId: id } })) === n, `${n}장 DB 저장`);
        assert(prog[prog.length - 1] === `${n}/${n}` && prog[0] === `0/${n}`, `${n}장 진행률 0/${n}→${n}/${n}`);
      }
      // 부분 실패: 9장 중 네트워크 오류 2건 + 저장소 오류 1건
      const id9 = await mkPost("partial");
      const items = mkItems(9);
      calls = 0;
      netFail = new Set([2, 6]);
      failPutRemaining = 0;
      const realPut = dedicated.put;
      let putN = 0;
      dedicated.put = async (...a) => {
        if (putN++ === 3) throw new Error("mock put failure");
        return realPut(...a);
      };
      const r1 = await uploadFreeBoardPhotos(id9, items, { post, onItem: apply(items) });
      dedicated.put = realPut;
      assert(r1.uploaded === 6 && r1.failed === 3, `부분 실패 6 성공 / 3 실패 (실제 ${r1.uploaded}/${r1.failed})`);
      assert(items.filter((i) => i.status === "failed").length === 3, "실패 3장 표시");
      assert(items.filter((i) => i.status === "failed").every((i) => typeof i.error === "string" && i.error.length > 0), "실패 사유 표시");
      assert((await prisma.freeBoardPhoto.count({ where: { postId: id9 } })) === 6, "DB 6장");
      // 재시도: 실패분만 전송
      calls = 0;
      netFail = new Set();
      const r2 = await uploadFreeBoardPhotos(id9, items, { post, onItem: apply(items) });
      assert(calls === 3 && r2.uploaded === 3 && r2.failed === 0, "재시도는 실패한 3장만 전송");
      assert((await prisma.freeBoardPhoto.count({ where: { postId: id9 } })) === 9, "재시도 후 정확히 9장");
      // 응답 유실 시나리오: 서버는 저장했지만 클라이언트는 실패로 알고 전부 재전송 → 중복 0
      for (const it of items) it.status = "failed";
      calls = 0;
      const r3 = await uploadFreeBoardPhotos(id9, items, { post, onItem: apply(items) });
      assert(r3.uploaded === 9 && r3.failed === 0, "같은 uploadKey 재전송 9건 모두 ok (duplicate)");
      assert((await prisma.freeBoardPhoto.count({ where: { postId: id9 } })) === 9, "중복 생성 없음 (여전히 9장, 409 아님)");
      const keys9 = await prisma.freeBoardPhoto.findMany({ where: { postId: id9 }, select: { storageKey: true } });
      assert(new Set(keys9.map((k) => k.storageKey)).size === 9, "storageKey 고유");
      assert(keys9.every((k) => isFreeBoardStorageKey(k.storageKey)), "멱등 키도 free-board/<postId>/<uuid> 형식");
      let objs = 0;
      for (const k of keys9) if (await mem.head(k.storageKey)) objs++;
      assert(objs === 9, "중복 재전송 후에도 객체 9개 유지 (삭제되지 않음)");
      // 새 uploadKey 10번째는 여전히 409 (9장 제한 유지)
      const tenth = await uploadFreeBoardPhotos(id9, mkItems(1), { post });
      assert(tenth.failed === 1, "새 키 10번째 → 실패 (409)");
      // 동시 같은 키 2건 → 1행
      const idC = await mkPost("same-key-concurrent");
      const k = newFreeBoardUploadKey();
      const same = [0, 1].map((i) => ({ key: `s${i}`, uploadKey: k, blob: new Blob([png()], { type: "image/png" }), status: "ready" as const }));
      await Promise.all(same.map((it) => uploadFreeBoardPhotos(idC, [it], { post })));
      assert((await prisma.freeBoardPhoto.count({ where: { postId: idC } })) === 1, "동시 같은 키 2건 → 1행");
      const rowC = await prisma.freeBoardPhoto.findFirst({ where: { postId: idC } });
      assert(Boolean(await mem.head(rowC!.storageKey)), "동시 같은 키: 객체 유지");
      // 키 형식 검증
      assert(normalizeFreeBoardUploadKey(k.toUpperCase()) === k, "uploadKey 대소문자 정규화");
      for (const bad of ["../x", "notices/1", "", "1234", "00000000-0000-0000-0000-000000000000", 5, null]) {
        assert(normalizeFreeBoardUploadKey(bad) === null, `잘못된 uploadKey 무시: ${String(bad)}`);
      }
      // 타인이 남의 키로 재전송해도 남의 글이면 403
      const other = await PHOTO_POST(
        (() => {
          const fd = new FormData();
          fd.append("uploadKey", items[0].uploadKey);
          fd.append("file", new Blob([png()], { type: "image/png" }), "p.png");
          return req(`http://local/api/free-board/${id9}/photos`, { method: "POST", headers: { cookie: B }, body: fd });
        })(),
        idP(id9)
      );
      assert(other.status === 403, "타인 + 기존 uploadKey → 403 (정보 노출 없음)");
    }

    section("edit with removedPhotoIds (deferred delete)");
    {
      const before = await prisma.freeBoardPhoto.findMany({ where: { postId: pid }, orderBy: { id: "asc" } });
      const [r1, r2] = before;
      // 다른 글 사진 포함 → 전체 거부, 아무것도 바뀌지 않음
      const otherPhoto = await prisma.freeBoardPhoto.findFirst({ where: { postId: { not: pid } } });
      const delBefore = deleteCalls;
      const bad = await patch(ADM, { title: "t2", body: "b2", removedPhotoIds: [r1.id, otherPhoto!.id] });
      assert(bad.status === 404, "타 게시글 사진 포함 → 404");
      assert((await prisma.freeBoardPhoto.count({ where: { postId: pid } })) === before.length, "거부 시 사진 그대로");
      assert((await prisma.freeBoardPost.findUnique({ where: { id: pid } }))?.title === "수정 제목", "거부 시 본문 그대로");
      assert(deleteCalls === delBefore, "거부 시 객체 삭제 없음");
      assert((await patch(ADM, { title: "t", body: "b", removedPhotoIds: "x" })).status === 400, "removedPhotoIds 형식 오류 400");
      assert((await patch(B, { title: "t", body: "b", removedPhotoIds: [r1.id] })).status === 403, "타인 removedPhotoIds 403");
      // 부분 성공: r2 객체 삭제 실패 → 응답 성공, DB 일관, orphan 기록
      const { setFreeBoardOrphanLoggerForTests } = await import("../src/lib/freeBoardPhoto");
      const orphans: unknown[] = [];
      setFreeBoardOrphanLoggerForTests((i) => orphans.push(i));
      failDeleteKeys = new Set([r2.storageKey]);
      const ok2 = await patch(ADM, { title: "사진 정리", body: "본문", removedPhotoIds: [r1.id, r2.id] });
      const okBody = await json(ok2);
      assert(ok2.status === 200, "부분 성공도 200");
      assert(okBody.removedPhotos === 2 && okBody.blobCleanupFailed === 1, "removed 2, blobCleanupFailed 1");
      assert((await prisma.freeBoardPhoto.count({ where: { id: { in: [r1.id, r2.id] } } })) === 0, "DB 행 삭제됨");
      assert(!(await mem.head(r1.storageKey)), "성공 객체 삭제됨");
      assert(Boolean(await mem.head(r2.storageKey)), "실패 객체는 남음 (orphan)");
      assert(orphans.length === 1 && JSON.stringify(orphans).includes(String(r2.id)), "orphan 1건 기록 (photoId)");
      assert(!JSON.stringify(orphans).includes(r2.storageKey), "orphan 로그에 storage key 미포함");
      setFreeBoardOrphanLoggerForTests(null);
      failDeleteKeys = new Set();
      // DB 실패 → 롤백, 객체 삭제 없음
      const { saveFreeBoardPostEdit } = await import("../src/lib/freeBoardPhoto");
      const r3 = (await prisma.freeBoardPhoto.findFirst({ where: { postId: pid } }))!;
      const failingDb = new Proxy(prisma, {
        get(t, k) {
          if (k === "$transaction") return async () => { throw new Error("db down"); };
          return Reflect.get(t, k);
        },
      }) as typeof prisma;
      const delBefore2 = deleteCalls;
      let threw = false;
      try {
        await saveFreeBoardPostEdit(failingDb, { postId: pid, title: "x", body: "y", removedPhotoIds: [r3.id] });
      } catch {
        threw = true;
      }
      assert(threw, "DB 실패 → 예외");
      assert(deleteCalls === delBefore2, "DB 실패 시 객체 삭제 호출 0");
      assert(Boolean(await prisma.freeBoardPhoto.findUnique({ where: { id: r3.id } })), "DB 실패 시 사진 유지");
      assert(Boolean(await mem.head(r3.storageKey)), "DB 실패 시 객체 유지");
      // 취소 = 요청 없음 → 서버 변화 없음 (클라이언트 구조 확인)
      const form = read("src/app/community/FreeBoardForm.tsx");
      assert(!/method: "DELETE"/.test(form), "수정 화면에서 즉시 DELETE 호출 없음");
      assert(form.includes("removedPhotoIds: removedIds"), "저장 시 removedPhotoIds 전송");
      assert(form.lastIndexOf("uploadFreeBoardPhotos(postId") > form.indexOf("isEdit ? { title, body"), "새 사진은 저장 성공 후 업로드 (취소 시 업로드 없음)");
      // 폼 UX 정적 점검 (P1/P2)
      assert(/className="is-revealed"/.test(form) && (form.match(/is-revealed/g) || []).length >= 2, "미리보기/기존 사진 img 에 is-revealed (opacity:0 빈 썸네일 방지)");
      assert(!/<img src=\{photo\.previewUrl\} alt="" \/>/.test(form), "빈 썸네일 원인 패턴 제거");
      assert(/disabled=\{busy \|\| preparing > 0\}/.test(form), "전처리 중 등록 버튼 비활성");
      assert(form.includes("사진 업로드 ${Math.min(progress.done + 1, progress.total)}/${progress.total}"), "진행률 표시 (사진 업로드 n/N)");
      assert(form.includes("beforeunload") && form.includes('closest?.("a[href]")'), "이탈 방지 (beforeunload + 앱 내 링크)");
      assert(form.includes("savedPostId") && /if \(postId === null\)/.test(form), "재시도 시 글 재생성 없음 (postId 보존)");
      assert(!/[^-]disabled=\{!canAdd/.test(form) && form.includes("onAddClick") && form.includes("aria-disabled"), "+사진: 무반응 disabled 대신 안내");
      assert(form.includes("pickFailures") && form.includes("f.name"), "변환 실패 사진 파일명+사유 표시");
      assert(form.includes("실패한 사진") && form.includes("사진 없이 완료"), "실패분 재시도/완료 버튼");
      assert(!/revokeObjectURL\(url\)/.test(form), "표시 중 object URL 조기 해제 없음");
    }

    section("post delete");
    assert((await DEL(req(`http://local/api/free-board/${pid}`, { method: "DELETE", headers: { cookie: B } }), idP(pid))).status === 403, "other delete 403");
    const second = await json(
      await CREATE(req("http://local/api/free-board", { method: "POST", headers: H(ADM), body: JSON.stringify({ title: "관리자 글", body: "b" }) }))
    );
    postIds.push(Number(second.id));
    assert((await DEL(req(`http://local/api/free-board/${second.id}`, { method: "DELETE", headers: { cookie: ADM } }), idP(Number(second.id)))).status === 200, "admin delete others 200");
    assert((await DEL(req(`http://local/api/free-board/${pid}`, { method: "DELETE", headers: { cookie: A } }), idP(pid))).status === 403, "caddy delete 403");
    assert((await DEL(req(`http://local/api/free-board/${pid}`, { method: "DELETE", headers: { cookie: ADM } }), idP(pid))).status === 200, "admin delete 200");
    const gone = await prisma.freeBoardPost.findUnique({ where: { id: pid } });
    assert(gone?.deletedAt != null, "soft deleted");
    assert((await prisma.freeBoardPhoto.count({ where: { postId: pid } })) === 0, "photo rows cleaned");
    assert((await DETAIL(req(`http://local/api/free-board/${pid}`, { headers: { cookie: A } }), idP(pid))).status === 404, "deleted detail 404");
    assert((await cpost(A, "after delete")).status === 404, "comment on deleted 404");
    assert((await up(A, png())).status === 404, "photo on deleted 404");
    const l2 = await json(await LIST(req("http://local/api/free-board", { headers: { cookie: A } })));
    assert(!l2.posts.some((p: { id: number }) => p.id === pid), "deleted hidden from list");
  } finally {
    setFreeBoardStoreFactoryForTests(null);
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const threads = await prisma.commentThread.findMany({
      where: { targetType: "FREE_BOARD_POST", targetKey: { in: postIds.map(String) } },
    });
    await prisma.comment.deleteMany({ where: { threadId: { in: threads.map((t) => t.id) } } });
    await prisma.commentThread.deleteMany({ where: { id: { in: threads.map((t) => t.id) } } });
    await prisma.freeBoardPhoto.deleteMany({ where: { postId: { in: postIds } } });
    await prisma.freeBoardPost.deleteMany({ where: { id: { in: postIds } } });
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (caddyIds.length) await prisma.caddy.deleteMany({ where: { id: { in: caddyIds } } });
    process.env.SESSION_SECRET = prevSecret;
    if (prevFlag === undefined) delete process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED;
    else process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED = prevFlag;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
