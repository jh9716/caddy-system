/**
 * 커뮤니티 자유게시판 V1 (/talk, /api/talk) — local caddy_local only.
 * 실행: npm run test:community-board-unit
 * 실제 Blob 호출 없음 (메모리 store). 원격 DB 접속 없음 (assertLocalDatabaseUrl).
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { SESSION_COOKIE_NAME, buildSessionClaims, signSessionClaims } from "../src/lib/sessionCookies";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import { createMemoryCourseReportPhotoStore, type CourseReportPhotoStore } from "../src/lib/courseReportPhotoStorage";
import { setFreeBoardStoreFactoryForTests } from "../src/lib/freeBoardPhotoStorage";

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
const png = (n = 0) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, n & 255]);
const jpeg = () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

type Role = "admin" | "caddy" | "leader";
async function cookieFor(u: { id: number | null; username: string; role: Role }) {
  return `${SESSION_COOKIE_NAME}=${await signSessionClaims(
    buildSessionClaims({ userId: u.id, username: u.username, role: u.role, sessionVersion: 0 })
  )}`;
}
const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(url, init);
const json = (r: Response) => r.json().catch(() => ({}));
const idP = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const photoP = (id: number, photoId: number) => ({ params: Promise.resolve({ id: String(id), photoId: String(photoId) }) });
const commentP = (id: number, commentId: number) => ({
  params: Promise.resolve({ id: String(id), commentId: String(commentId) }),
});

function photoForm(bytes: Uint8Array | Uint8Array[], uploadKey?: string) {
  const fd = new FormData();
  if (uploadKey) fd.append("uploadKey", uploadKey);
  for (const b of Array.isArray(bytes) ? bytes : [bytes]) fd.append("file", new Blob([b as BlobPart]), "p.png");
  return fd;
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prev = {
    SESSION_SECRET: process.env.SESSION_SECRET,
    FLAG: process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED,
    KILL: process.env.NEXT_PUBLIC_COMMUNITY_FREE_BOARD_DISABLED,
    VERCEL_ENV: process.env.VERCEL_ENV,
    FREE_BOARD_STORAGE_ENV: process.env.FREE_BOARD_STORAGE_ENV,
    ADMIN_CHAT_USER_ID: process.env.ADMIN_CHAT_USER_ID,
  };
  process.env.SESSION_SECRET = "community-unit-secret-32chars!!!!!";
  // 저장소 정책: production 모드(공용 store)를 메모리 mock 으로. 실제 Blob 호출 없음.
  process.env.VERCEL_ENV = "production";
  delete process.env.FREE_BOARD_STORAGE_ENV;
  const mem = createMemoryCourseReportPhotoStore();
  const storeCalls: string[] = [];
  const storeFault = { put: false };
  const spy: CourseReportPhotoStore = {
    ...mem,
    async put(k, b, m) {
      storeCalls.push(`put:${k}`);
      if (storeFault.put) throw new Error("mock storage down");
      return mem.put(k, b, m);
    },
    async delete(k) {
      storeCalls.push(`del:${k}`);
      return mem.delete(k);
    },
  };
  setFreeBoardStoreFactoryForTests({ dedicated: () => spy, shared: () => spy });

  const C = await import("../src/lib/communityBoardConstants");
  const nav = await import("../src/lib/boardNav");
  // ADMIN_MAIN_NAV 는 모듈 로드 시점 값 → 플래그 ON 상태에서 불러온다.
  const prevFlagForNav = process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED;
  process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED = "1";
  const adminNav = await import("../src/lib/adminManageNav");
  if (prevFlagForNav === undefined) delete process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED;
  else process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED = prevFlagForNav;
  const list = await import("../src/app/api/talk/route");
  const one = await import("../src/app/api/talk/[id]/route");
  const photos = await import("../src/app/api/talk/[id]/photos/route");
  const photoOne = await import("../src/app/api/talk/[id]/photos/[photoId]/route");
  const comments = await import("../src/app/api/talk/[id]/comments/route");
  const commentOne = await import("../src/app/api/talk/[id]/comments/[commentId]/route");
  const fbList = await import("../src/app/api/free-board/route");
  const fbPhotoOne = await import("../src/app/api/free-board/[id]/photos/[photoId]/route");
  const fbComments = await import("../src/app/api/free-board/[id]/comments/route");
  const lib = await import("../src/lib/communityBoard");
  const plib = await import("../src/lib/communityBoardPhoto");

  section("flag / kill switch (새 환경변수 없이 기존 커뮤니티 플래그를 따름)");
  delete process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED;
  assert(C.isCommunityFreeBoardEnabled() === false, "기존 플래그 OFF → 자유게시판 OFF");
  assert(!nav.memberNavItems().some((i) => i.href === "/talk"), "OFF: 캐디·조장 메뉴에 없음");
  assert((await list.GET(req("http://local/api/talk"))).status === 404, "OFF: API 404");
  process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED = "1";
  process.env.NEXT_PUBLIC_COMMUNITY_FREE_BOARD_DISABLED = "1";
  assert(C.isCommunityFreeBoardEnabled() === false, "kill switch=1 → OFF");
  assert((await list.GET(req("http://local/api/talk"))).status === 404, "kill switch: API 404");
  delete process.env.NEXT_PUBLIC_COMMUNITY_FREE_BOARD_DISABLED;
  assert(C.isCommunityFreeBoardEnabled() === true, "플래그 ON → 자유게시판 ON");

  section("메뉴 (관리자·조장·캐디 진입 경로, 기존 순서 유지)");
  {
    const m = nav.memberNavItems().map((i) => i.href);
    assert(m.join(",") === "/,/notice,/course-reports,/community,/talk,/board,/off-requests,/chat,/caddy", `캐디·조장 메뉴: ${m.join(",")}`);
    assert(nav.memberNavItems().find((i) => i.href === "/talk")?.label === "자유게시판", "메뉴 이름 = 자유게시판");
    assert(nav.memberNavItems().find((i) => i.href === "/community")?.label === "가배치표 게시판", "가배치표 메뉴 이름 유지");
    const a = adminNav.ADMIN_MAIN_NAV.map((i) => i.href);
    const ci = a.indexOf("/community");
    assert(ci >= 0 && a[ci + 1] === "/talk", "관리자 메뉴: 가배치표 바로 다음에 자유게시판");
    assert(
      a.filter((h) => h !== "/talk").join(",") ===
        "/manage,/manage/caddies,/manage/marshals,/manage/carts,/manage/off-requests,/manage/assignments,/board,/notice,/chat,/course-reports,/community,/manage/tools",
      `관리자 기존 메뉴 순서 그대로: ${a.join(",")}`
    );
    const talkItem = nav.memberNavItems().find((i) => i.href === "/talk")!;
    assert(talkItem.match("/talk") && talkItem.match("/talk/3") && !talkItem.match("/talkx"), "메뉴 활성 판정");
    const boardItem = nav.memberNavItems().find((i) => i.href === "/board")!;
    assert(!boardItem.match("/talk"), "배치표 메뉴와 겹치지 않음");
  }

  const tag = `cm_${Date.now()}`;
  const hash = await bcrypt.hash("x", 4);
  const caddyIds: number[] = [];
  const userIds: number[] = [];
  const fbPostIds: number[] = [];
  const freeBoardBefore = await prisma.freeBoardPost.count();
  const freeBoardPhotoBefore = await prisma.freeBoardPhoto.count();

  try {
    const mk = (name: string, team: string, employmentStatus: "ACTIVE" | "RETIRED" | "LEAVE" = "ACTIVE") =>
      prisma.caddy.create({ data: { name, team, caddyType: "HOUSE", employmentStatus } });
    const cA = await mk("자유캐디가", "1조");
    const cB = await mk("자유캐디나", "2조");
    const cL = await mk("자유조장다", "1조");
    const cR = await mk("퇴사캐디라", "3조", "RETIRED");
    const cLeave = await mk("휴직캐디마", "3조", "LEAVE");
    caddyIds.push(cA.id, cB.id, cL.id, cR.id, cLeave.id);
    const u = async (suffix: string, role: Role, caddyId: number | null, extra: Record<string, unknown> = {}) => {
      const row = await prisma.user.create({
        data: { username: `${tag}_${suffix}`, password: hash, role, caddyId, ...extra },
      });
      userIds.push(row.id);
      return row;
    };
    const uA = await u("a", "caddy", cA.id);
    const uB = await u("b", "caddy", cB.id);
    const uL = await u("leader", "leader", cL.id, { managedTeams: ["1조"] });
    const uAdm = await u("admin", "admin", null);
    const uR = await u("retired", "caddy", cR.id);
    const uLeave = await u("leave", "caddy", cLeave.id);
    const uUnlinked = await u("unlinked", "caddy", null);
    const uMust = await u("must", "caddy", null, { mustChangePassword: true });
    const A = await cookieFor({ id: uA.id, username: uA.username, role: "caddy" });
    const B = await cookieFor({ id: uB.id, username: uB.username, role: "caddy" });
    const L = await cookieFor({ id: uL.id, username: uL.username, role: "leader" });
    const ADM = await cookieFor({ id: uAdm.id, username: uAdm.username, role: "admin" });
    const R = await cookieFor({ id: uR.id, username: uR.username, role: "caddy" });
    const LV = await cookieFor({ id: uLeave.id, username: uLeave.username, role: "caddy" });
    const UN = await cookieFor({ id: uUnlinked.id, username: uUnlinked.username, role: "caddy" });
    const MUST = await cookieFor({ id: uMust.id, username: uMust.username, role: "caddy" });
    const FORGED_ROLE = await cookieFor({ id: uA.id, username: uA.username, role: "admin" });
    const ENV_ADM = await cookieFor({ id: null, username: "env-admin", role: "admin" });
    process.env.ADMIN_CHAT_USER_ID = String(uAdm.id);
    const H = (cookie: string) => ({ cookie, "content-type": "application/json" });
    const create = (cookie: string, body: unknown) =>
      list.POST(req("http://local/api/talk", { method: "POST", headers: H(cookie), body: JSON.stringify(body) }));
    const listAs = (cookie: string, qs = "") => list.GET(req(`http://local/api/talk${qs}`, { headers: { cookie } }));

    section("접근 제한 (비로그인·퇴사·미연결·비밀번호 변경 강제)");
    assert((await list.GET(req("http://local/api/talk"))).status === 401, "비로그인 목록 401");
    assert(
      (await list.POST(req("http://local/api/talk", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).status === 401,
      "비로그인 작성 401"
    );
    assert((await listAs(R)).status === 401, "퇴사(RETIRED) 캐디 401");
    assert((await create(R, { title: "t", body: "b" })).status === 401, "퇴사 캐디 작성 401");
    assert((await listAs(UN)).status === 403, "캐디 연결 안 된 계정 403");
    assert((await listAs(MUST)).status !== 200, "비밀번호 변경 강제 계정 차단");
    assert((await listAs(LV)).status === 200, "휴직(LEAVE)은 기존 정책대로 허용");
    assert((await listAs("vh_session=forged.value")).status === 401, "위조 쿠키 401");

    section("글쓰기: 관리자·조장·캐디 모두 가능, 작성자는 세션 기준");
    const pA = await create(A, { title: " 캐디 첫 글 ", body: "<script>alert(1)</script>\n둘째 줄", authorUserId: uB.id, authorDisplayName: "가짜" });
    const pAj = await json(pA);
    assert(pA.status === 201, "캐디 작성 201");
    assert(pAj.post.authorUserId === uA.id, "요청의 authorUserId 무시 → 세션 사용자");
    assert(pAj.post.authorDisplayName === "자유캐디가", "표시명 = 연결 캐디 이름 (요청 값 무시)");
    assert(pAj.post.title === "캐디 첫 글", "제목 앞뒤 공백 제거");
    assert(pAj.post.body === "<script>alert(1)</script>\n둘째 줄", "본문은 평문 그대로 저장 (화면은 텍스트로만 출력)");
    const postA = Number(pAj.id);
    const pL = await json(await create(L, { title: "조장 글", body: "조장 내용" }));
    assert(pL.post?.authorUserId === uL.id, "조장 작성 201");
    const postL = Number(pL.id);
    const pAdm = await json(await create(ADM, { title: "관리자 글", body: "관리자 내용" }));
    assert(pAdm.post?.authorUserId === uAdm.id, "관리자 작성 201");
    const postAdm = Number(pAdm.id);
    const pEnv = await create(ENV_ADM, { title: "env 관리자 글", body: "b" });
    const pEnvj = await json(pEnv);
    assert(pEnv.status === 201 && pEnvj.post.authorUserId === uAdm.id, "env 관리자 → 지정 DB 관리자 계정으로 작성");
    const pForgedRole = await json(await create(FORGED_ROLE, { title: "역할 위조", body: "b" }));
    assert(pForgedRole.post == null || pForgedRole.post.canDelete !== true || pForgedRole.post.authorUserId === uA.id, "쿠키 역할 위조는 DB 역할로 판정");
    if (pForgedRole.id) {
      const row = await prisma.communityPost.findUnique({ where: { id: Number(pForgedRole.id) } });
      assert(row?.authorUserId === uA.id, "역할 위조 쿠키도 작성자는 본인");
    }
    assert((await create(A, { title: " ", body: "b" })).status === 400, "빈 제목 400");
    assert((await create(A, { title: "t", body: "  " })).status === 400, "빈 본문 400");
    assert((await create(A, { title: "x".repeat(101), body: "b" })).status === 400, "제목 101자 400");
    assert((await create(A, { title: "t", body: "b".repeat(5001) })).status === 400, "본문 5001자 400");
    assert((await create(A, { title: 123, body: ["x"] })).status === 400, "문자열 아닌 값 400");
    const multiline = await json(await create(B, { title: "줄\n바꿈 제목", body: "본문" }));
    assert(multiline.post?.title === "줄 바꿈 제목", "제목 줄바꿈 → 공백");
    const postB = Number(multiline.id);

    section("목록: 최신순·작성자·시각·댓글 수·사진 표시");
    {
      const r = await listAs(B);
      const j = await json(r);
      assert(r.status === 200 && j.canCompose === true, "캐디 목록 200 + 글쓰기 가능");
      const ids = j.posts.map((p: { id: number }) => p.id);
      assert(ids.indexOf(postB) < ids.indexOf(postAdm) && ids.indexOf(postAdm) < ids.indexOf(postA), "최신순 정렬");
      const rowA = j.posts.find((p: { id: number }) => p.id === postA);
      assert(rowA && rowA.authorDisplayName === "자유캐디가" && typeof rowA.createdAt === "string", "작성자 이름·작성 시각");
      assert(rowA && !("body" in rowA), "목록 응답에 본문 없음");
      assert(rowA && rowA.canEdit === false && rowA.canDelete === false, "다른 사람 글: 수정·삭제 표시 없음");
      const lj = await json(await listAs(L));
      assert(lj.canCompose === true, "조장 글쓰기 가능");
      const aj = await json(await listAs(ADM));
      const rowAdmView = aj.posts.find((p: { id: number }) => p.id === postA);
      assert(aj.canCompose === true && rowAdmView.canDelete === true && rowAdmView.canEdit === false, "관리자: 타인 글 삭제 O / 수정 X");
    }

    section("수정: 본인만 (타인·관리자 차단)");
    {
      const patch = (cookie: string, id: number, body: unknown) =>
        one.PATCH(req(`http://local/api/talk/${id}`, { method: "PATCH", headers: H(cookie), body: JSON.stringify(body) }), idP(id));
      const ok = await patch(A, postA, { title: "캐디 글 수정", body: "수정 본문", authorUserId: uB.id });
      const okj = await json(ok);
      assert(ok.status === 200 && okj.post.title === "캐디 글 수정", "본인 수정 200");
      assert(okj.post.authorUserId === uA.id, "수정 시 작성자 변경 불가");
      assert((await patch(B, postA, { title: "남의 글", body: "x" })).status === 403, "다른 캐디 수정 403");
      assert((await patch(L, postA, { title: "조장이", body: "x" })).status === 403, "조장도 타인 글 수정 403");
      assert((await patch(ADM, postA, { title: "관리자가", body: "x" })).status === 403, "관리자도 타인 글 수정 403");
      assert((await patch(ENV_ADM, postA, { title: "env", body: "x" })).status === 403, "env 관리자도 타인 글 수정 403");
      const row = await prisma.communityPost.findUnique({ where: { id: postA } });
      assert(row?.title === "캐디 글 수정" && row.authorUserId === uA.id, "차단된 수정은 DB 변화 없음");
      assert((await patch(A, 99999999, { title: "t", body: "b" })).status === 404, "없는 글 404");
      assert((await patch(A, postA, { title: "", body: "b" })).status === 400, "수정 검증 400");
    }

    section("상세");
    {
      const r = await one.GET(req(`http://local/api/talk/${postA}`, { headers: { cookie: B } }), idP(postA));
      const j = await json(r);
      assert(r.status === 200 && j.post.body === "수정 본문" && j.post.edited === false || j.post.edited === true, "상세 200");
      assert((await one.GET(req(`http://local/api/talk/abc`, { headers: { cookie: B } }), { params: Promise.resolve({ id: "abc" }) })).status === 404, "잘못된 id 404");
    }

    section("댓글·답글");
    let rootId = 0;
    {
      const post = (cookie: string, body: unknown, id = postA) =>
        comments.POST(req(`http://local/api/talk/${id}/comments`, { method: "POST", headers: H(cookie), body: JSON.stringify(body) }), idP(id));
      const c1 = await post(B, { body: "댓글입니다" });
      const c1j = await json(c1);
      assert(c1.status === 201 && c1j.comment.authorUserId === uB.id, "캐디 댓글 201");
      rootId = c1j.comment.id;
      const r1 = await post(L, { body: "답글입니다", parentId: rootId });
      const r1j = await json(r1);
      assert(r1.status === 201 && r1j.comment.parentId === rootId, "조장 답글 201 (parentId)");
      const r2 = await post(A, { body: "답글의 답글", parentId: r1j.comment.id });
      const r2j = await json(r2);
      assert(r2.status === 201 && r2j.comment.parentId === rootId, "답글은 1단계로 원댓글에 묶임 (기존 정책)");
      assert((await post(A, { body: "" })).status === 400, "빈 댓글 400");
      const forged = await json(await post(A, { body: "위조", authorUserId: uB.id }));
      assert(forged.comment?.authorUserId === uA.id, "댓글 작성자 위조 무시");
      const editOther = await commentOne.PATCH(
        req(`http://local/api/talk/${postA}/comments/${rootId}`, { method: "PATCH", headers: H(A), body: JSON.stringify({ body: "남의 댓글 수정" }) }),
        commentP(postA, rootId)
      );
      assert(editOther.status === 403, "타인 댓글 수정 403");
      const editAdmin = await commentOne.PATCH(
        req(`http://local/api/talk/${postA}/comments/${rootId}`, { method: "PATCH", headers: H(ADM), body: JSON.stringify({ body: "관리자 수정" }) }),
        commentP(postA, rootId)
      );
      assert(editAdmin.status === 403, "관리자도 타인 댓글 수정 403");
      const editOwn = await commentOne.PATCH(
        req(`http://local/api/talk/${postA}/comments/${rootId}`, { method: "PATCH", headers: H(B), body: JSON.stringify({ body: "내 댓글 수정" }) }),
        commentP(postA, rootId)
      );
      assert(editOwn.status === 200, "본인 댓글 수정 200");
      const delOther = await commentOne.DELETE(
        req(`http://local/api/talk/${postA}/comments/${forged.comment.id}`, { method: "DELETE", headers: { cookie: B } }),
        commentP(postA, forged.comment.id)
      );
      assert(delOther.status === 403, "타인 댓글 삭제 403");
      const delAdmin = await commentOne.DELETE(
        req(`http://local/api/talk/${postA}/comments/${forged.comment.id}`, { method: "DELETE", headers: { cookie: ADM } }),
        commentP(postA, forged.comment.id)
      );
      assert(delAdmin.status === 200, "관리자 댓글 삭제 200");
      const cl = await json(await comments.GET(req(`http://local/api/talk/${postA}/comments`, { headers: { cookie: L } }), idP(postA)));
      assert(Array.isArray(cl.comments) && cl.canCompose === true, "댓글 목록 + 작성 가능");
      const lj = await json(await listAs(B));
      assert(lj.posts.find((p: { id: number }) => p.id === postA)?.commentCount === 3, "목록 댓글 수 = 살아있는 댓글 3");
      const cross = await comments.GET(req(`http://local/api/talk/${postA}/comments`, { headers: { cookie: L } }), idP(postA));
      assert(cross.status === 200, "자유게시판 댓글 조회");
      const viaFb = await fbComments.GET(req(`http://local/api/free-board/${postA}/comments`, { headers: { cookie: ADM } }), idP(postA));
      const viaFbJ = await json(viaFb);
      assert(
        viaFb.status === 404 || (Array.isArray(viaFbJ.comments) && !viaFbJ.comments.some((c: { id: number }) => c.id === rootId)),
        "가배치표 댓글 API 로 자유게시판 댓글 조회 불가"
      );
      const thread = await prisma.commentThread.findFirst({ where: { targetType: "COMMUNITY_POST", targetKey: String(postA) } });
      assert(thread != null, "댓글 thread 종류 = COMMUNITY_POST (가배치표 FREE_BOARD_POST 와 분리)");
    }

    section("댓글 수 일치: 상단(서버 count)·목록·댓글 영역(liveCount) — 등록·수정·삭제 후 항상 같음");
    {
      const { liveCommentCount } = await import("../src/lib/boardCommentsState");
      const cpost = (cookie: string, body: unknown) =>
        comments.POST(req(`http://local/api/talk/${postL}/comments`, { method: "POST", headers: H(cookie), body: JSON.stringify(body) }), idP(postL));
      const cdel = (cookie: string, cid: number) =>
        commentOne.DELETE(req(`http://local/api/talk/${postL}/comments/${cid}`, { method: "DELETE", headers: { cookie } }), commentP(postL, cid));
      const counts = async () => {
        const header = (await lib.countCommunityComments(prisma, [postL])).get(postL) ?? 0;
        const listed = (await json(await listAs(L))).posts.find((p: { id: number }) => p.id === postL)?.commentCount ?? -1;
        const area = liveCommentCount((await json(await comments.GET(req(`http://local/api/talk/${postL}/comments`, { headers: { cookie: L } }), idP(postL)))).comments);
        return { header, listed, area };
      };
      const same = (c: { header: number; listed: number; area: number }, n: number) => c.header === n && c.listed === n && c.area === n;
      let c = await counts();
      assert(same(c, 0), `처음: 상단·목록·영역 모두 0 (${JSON.stringify(c)})`);
      const root = await json(await cpost(B, { body: "수 확인 댓글" }));
      const reply = await json(await cpost(A, { body: "수 확인 답글", parentId: root.comment.id }));
      c = await counts();
      assert(same(c, 2), `댓글+답글 등록 후 모두 2 (${JSON.stringify(c)})`);
      await commentOne.PATCH(
        req(`http://local/api/talk/${postL}/comments/${root.comment.id}`, { method: "PATCH", headers: H(B), body: JSON.stringify({ body: "수정됨" }) }),
        commentP(postL, root.comment.id)
      );
      c = await counts();
      assert(same(c, 2), `댓글 수정 후에도 모두 2 (${JSON.stringify(c)})`);
      assert((await cdel(A, reply.comment.id)).status === 200, "답글 작성자 삭제 200");
      c = await counts();
      assert(same(c, 1), `답글 삭제 후 모두 1 (${JSON.stringify(c)})`);
      assert((await cdel(B, root.comment.id)).status === 200, "원댓글 작성자 삭제 200");
      c = await counts();
      assert(same(c, 0), `댓글·답글 모두 삭제 후 모두 0 — 새로고침 시 상단도 0 (${JSON.stringify(c)})`);
      const again = await json(await cpost(L, { body: "다시 댓글" }));
      c = await counts();
      assert(same(c, 1), `삭제 뒤 다시 등록 시 모두 1 (${JSON.stringify(c)})`);
      assert((await cdel(ADM, again.comment.id)).status === 200, "관리자 댓글 삭제 200");
      c = await counts();
      assert(same(c, 0), `관리자 삭제 후 모두 0 (${JSON.stringify(c)})`);
      // 원댓글 먼저 삭제(답글 남김) → 원댓글은 '삭제된 댓글' 자리표시로만 남고 숫자에서 빠짐
      const r2 = await json(await cpost(B, { body: "원댓글2" }));
      await cpost(A, { body: "답글2", parentId: r2.comment.id });
      assert((await cdel(B, r2.comment.id)).status === 200, "원댓글 먼저 삭제 200");
      c = await counts();
      assert(same(c, 1), `원댓글만 삭제(답글 남음) → 모두 1 (${JSON.stringify(c)})`);
    }

    section("상세 화면 상단 댓글 수가 댓글 영역 숫자와 같은 상태를 씀 (소스 확인)");
    {
      const fs = await import("node:fs");
      const page = fs.readFileSync("src/app/talk/[id]/page.tsx", "utf8");
      const cc = fs.readFileSync("src/app/talk/[id]/TalkCommentCount.tsx", "utf8");
      const fbc = fs.readFileSync("src/app/community/[id]/FreeBoardComments.tsx", "utf8");
      const fbPage = fs.readFileSync("src/app/community/[id]/page.tsx", "utf8");
      assert(page.includes("<TalkCommentCountProvider initialCount={post.commentCount}>"), "상세: 서버 count 로 시작하는 공용 상태");
      assert(page.includes("<TalkCommentCountLabel") && !page.includes("<span>댓글 {post.commentCount}</span>"), "상단은 고정 숫자가 아니라 공용 상태 표시");
      assert(page.includes("<TalkComments") && !page.includes("<FreeBoardComments"), "댓글 영역은 공용 상태를 갱신하는 래퍼 사용");
      assert(cc.includes("onLiveCountChange={ctx?.setCount}"), "댓글 영역 liveCount → 상단 숫자 갱신");
      assert(/if \(onLiveCountChange\) onLiveCountChange\(liveCount\)/.test(fbc), "알림은 콜백을 넘긴 경우에만 (가배치표 기본 동작 그대로)");
      assert(!fbPage.includes("onLiveCountChange") && !fbPage.includes("TalkComment"), "가배치표 상세는 새 콜백·래퍼 미사용");
    }

    section("사진: 작성자 업로드, 형식·용량·장수 서버 검증");
    const upload = (cookie: string, id: number, body: FormData | Uint8Array, headers: Record<string, string> = {}) =>
      photos.POST(
        req(`http://local/api/talk/${id}/photos`, {
          method: "POST",
          headers: { cookie, ...headers },
          body: body as BodyInit,
        }),
        idP(id)
      );
    const up1 = await upload(A, postA, photoForm(png(1)));
    const up1j = await json(up1);
    assert(up1.status === 201 && up1j.photo?.mimeType === "image/png", "본인 글 사진 업로드 201");
    const photo1 = Number(up1j.photo.id);
    const key1 = (await prisma.communityPhoto.findUnique({ where: { id: photo1 } }))!.storageKey;
    assert(key1.startsWith(`community/free/${postA}/`) && plib.isCommunityStorageKey(key1), "저장 key = community/free/<postId>/");
    assert((await upload(B, postA, photoForm(png(2)))).status === 403, "다른 캐디가 남의 글에 사진 403");
    assert((await upload(ADM, postA, photoForm(png(3)))).status === 403, "관리자도 남의 글에 사진 추가 403");
    const txt = await upload(A, postA, photoForm(new TextEncoder().encode("<svg onload=alert(1)>")));
    assert(txt.status >= 400 && txt.status < 500 && txt.status !== 404, `이미지 아닌 파일 거부 (${txt.status})`);
    const big = new Uint8Array(3 * 1024 * 1024 + 10);
    big.set(png(4), 0);
    assert((await upload(A, postA, photoForm(big))).status === 413, "3MB 초과 413");
    assert((await upload(A, postA, photoForm([png(5), png(6)]))).status === 400, "한 요청에 여러 장 → 거부");
    {
      const before = await prisma.communityPhoto.count({ where: { postId: postA } });
      storeFault.put = true;
      const failed = await upload(A, postA, photoForm(png(7)));
      storeFault.put = false;
      const fj = await json(failed);
      assert(failed.status === 502 && fj.error === "storage_put_failed", `저장소 오류 → 502 안내 (${failed.status})`);
      assert(typeof fj.message === "string" && !/token|secret|blob/i.test(fj.message), "오류 문구에 내부 정보 없음");
      assert((await prisma.communityPhoto.count({ where: { postId: postA } })) === before, "저장 실패 시 DB 행 생성 안 됨");
    }
    const key = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const dupA = await json(await upload(A, postA, photoForm(jpeg(), key)));
    const dupB = await upload(A, postA, photoForm(jpeg(), key));
    const dupBj = await json(dupB);
    assert(dupB.status === 200 && dupBj.duplicate === true && dupBj.photo.id === dupA.photo.id, "같은 uploadKey 재시도 → 중복 생성 없음");
    for (let i = 0; i < 7; i++) await upload(A, postA, photoForm(png(10 + i)));
    assert((await prisma.communityPhoto.count({ where: { postId: postA } })) === 9, "9장까지 저장");
    const tenth = await upload(A, postA, photoForm(png(30)));
    assert(tenth.status === 409, "10번째 사진 409");
    assert((await prisma.communityPhoto.count({ where: { postId: postA } })) === 9, "10번째는 저장 안 됨");
    {
      // 동시 업로드도 9장 제한 유지 (B 글로 확인)
      const ups = await Promise.all(Array.from({ length: 12 }, (_, i) => upload(B, postB, photoForm(png(50 + i)))));
      const okN = ups.filter((r) => r.status === 201).length;
      assert(okN === 9 && (await prisma.communityPhoto.count({ where: { postId: postB } })) === 9, `동시 12장 → 9장만 (${okN})`);
    }

    section("사진 보기·삭제 권한 + 게시판 간 분리");
    {
      const get = (cookie: string | null, id: number, pid: number) =>
        photoOne.GET(req(`http://local/api/talk/${id}/photos/${pid}`, { headers: cookie ? { cookie } : {} }), photoP(id, pid));
      const g1 = await get(B, postA, photo1);
      assert(g1.status === 200 && g1.headers.get("cache-control")?.includes("private"), "로그인 캐디 사진 보기 200 (private)");
      assert((await get(null, postA, photo1)).status === 401, "비로그인 사진 401");
      assert((await get(R, postA, photo1)).status === 401, "퇴사 캐디 사진 401");
      assert((await get(B, postL, photo1)).status === 404, "다른 글 id 로 사진 접근 404");
      // 가배치표 글/사진 준비 (가배치표는 관리자만 작성)
      // 새 로컬 DB 에서는 두 게시판 id 가 우연히 같아(모두 1) 분리 확인이 무의미해짐 → 로컬 테스트 DB 의 가배치표 id 시퀀스만 앞으로 이동.
      for (const t of ["FreeBoardPost", "FreeBoardPhoto"]) {
        await prisma.$executeRawUnsafe(
          `SELECT setval(pg_get_serial_sequence('"${t}"', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM "${t}"), 100000))`
        );
      }
      const fbCreate = await fbList.POST(
        req("http://local/api/free-board", { method: "POST", headers: H(ADM), body: JSON.stringify({ title: "가배치표", body: "운영" }) })
      );
      const fbj = await json(fbCreate);
      assert(fbCreate.status === 201, "가배치표: 관리자 작성 그대로 201");
      const fbId = Number(fbj.id);
      fbPostIds.push(fbId);
      const fbPhoto = await prisma.freeBoardPhoto.create({
        data: { postId: fbId, storageKey: `free-board/${fbId}/0f8fad5b-d9cb-469f-a165-70867728951f.png`, mimeType: "image/png", size: 13 },
      });
      await mem.put(fbPhoto.storageKey, png(99), "image/png");
      // 자유게시판 사진 id 를 가배치표 API 로 → 404
      const viaFb = await fbPhotoOne.GET(
        req(`http://local/api/free-board/${postA}/photos/${photo1}`, { headers: { cookie: ADM } }),
        photoP(postA, photo1)
      );
      assert(viaFb.status === 404, "자유게시판 사진을 가배치표 API 로 조회 불가 (404)");
      const viaFbDel = await fbPhotoOne.DELETE(
        req(`http://local/api/free-board/${postA}/photos/${photo1}`, { method: "DELETE", headers: { cookie: ADM } }),
        photoP(postA, photo1)
      );
      assert(viaFbDel.status === 404 && (await prisma.communityPhoto.findUnique({ where: { id: photo1 } })) != null, "가배치표 API 로 자유게시판 사진 삭제 불가");
      // 가배치표 사진 id 를 자유게시판 API 로 → 404
      assert((await get(ADM, fbId, fbPhoto.id)).status === 404, "가배치표 사진을 자유게시판 API 로 조회 불가 (404)");
      const tDel = await photoOne.DELETE(
        req(`http://local/api/talk/${fbId}/photos/${fbPhoto.id}`, { method: "DELETE", headers: { cookie: ADM } }),
        photoP(fbId, fbPhoto.id)
      );
      assert(tDel.status === 404 && (await prisma.freeBoardPhoto.findUnique({ where: { id: fbPhoto.id } })) != null, "자유게시판 API 로 가배치표 사진 삭제 불가");
      // 저장소 가드: 자유게시판 store 는 free-board/·notices/ key 접근 불가
      const g = plib.guardCommunityStore(spy);
      let blocked = 0;
      for (const bad of [
        fbPhoto.storageKey,
        "notices/1/0f8fad5b-d9cb-469f-a165-70867728950e.png",
        "course-reports/1/0f8fad5b-d9cb-469f-a165-70867728950e.png",
        "community/free/../../free-board/1/0f8fad5b-d9cb-469f-a165-70867728950e.png",
        "community/gallery/1/0f8fad5b-d9cb-469f-a165-70867728950e.png",
      ]) {
        for (const fn of [() => g.get(bad), () => g.delete(bad)]) {
          try {
            await fn();
          } catch {
            blocked++;
          }
        }
      }
      assert(blocked === 10, "자유게시판 저장소 가드: 다른 기능 key get/delete 전부 차단");
      assert(await mem.get(fbPhoto.storageKey), "가배치표 사진 객체 그대로");
      // 사진 1장 삭제: 작성자만
      const delOther = await photoOne.DELETE(
        req(`http://local/api/talk/${postA}/photos/${photo1}`, { method: "DELETE", headers: { cookie: B } }),
        photoP(postA, photo1)
      );
      assert(delOther.status === 403, "다른 캐디 사진 삭제 403");
      // 수정 저장 시 다른 글 사진 id 를 섞으면 전체 거부
      const otherPhoto = (await prisma.communityPhoto.findFirst({ where: { postId: postB } }))!;
      const mixed = await one.PATCH(
        req(`http://local/api/talk/${postA}`, {
          method: "PATCH",
          headers: H(A),
          body: JSON.stringify({ title: "t2", body: "b2", removedPhotoIds: [photo1, otherPhoto.id] }),
        }),
        idP(postA)
      );
      assert(mixed.status === 404, "수정 시 남의 글 사진 id 포함 → 404");
      assert(
        (await prisma.communityPhoto.findUnique({ where: { id: otherPhoto.id } })) != null &&
          (await prisma.communityPhoto.findUnique({ where: { id: photo1 } })) != null &&
          (await prisma.communityPost.findUnique({ where: { id: postA } }))?.title === "캐디 글 수정",
        "거부 시 아무것도 바뀌지 않음"
      );
      const okRemove = await one.PATCH(
        req(`http://local/api/talk/${postA}`, {
          method: "PATCH",
          headers: H(A),
          body: JSON.stringify({ title: "캐디 글 수정", body: "수정 본문", removedPhotoIds: [photo1] }),
        }),
        idP(postA)
      );
      assert(okRemove.status === 200 && (await prisma.communityPhoto.findUnique({ where: { id: photo1 } })) == null, "본인 수정 화면에서 사진 삭제");
      assert(!(await mem.get(key1)), "삭제된 사진 객체 정리");
      const lj = await json(await listAs(B));
      assert(lj.posts.find((p: { id: number }) => p.id === postA)?.photoCount === 8, "목록 사진 수 표시용 값 = 8");
    }

    section("검색 (제목·본문) + 페이지네이션");
    {
      const extra: number[] = [];
      for (let i = 1; i <= 23; i++) {
        const j = await json(await create(i % 2 ? A : L, { title: `${tag} 페이지 ${String(i).padStart(2, "0")}`, body: i === 7 ? "Needle 본문에만" : "일반" }));
        extra.push(Number(j.id));
      }
      const p1 = await json(await listAs(B, `?q=${encodeURIComponent(tag)}`));
      assert(p1.total === 23 && p1.posts.length === 20 && p1.page === 1 && p1.totalPages === 2, "검색 23건 → 1페이지 20건");
      assert(p1.posts[0].title.endsWith("23"), "검색 결과도 최신순");
      const p2 = await json(await listAs(B, `?q=${encodeURIComponent(tag)}&page=2`));
      assert(p2.posts.length === 3 && p2.page === 2, "2페이지 3건");
      const p9 = await json(await listAs(B, `?q=${encodeURIComponent(tag)}&page=99`));
      assert(p9.page === 2, "범위 밖 페이지 → 마지막 페이지");
      const pBad = await json(await listAs(B, `?page=-3`));
      assert(pBad.page === 1, "잘못된 페이지 → 1");
      const ids1 = new Set(p1.posts.map((p: { id: number }) => p.id));
      assert(!p2.posts.some((p: { id: number }) => ids1.has(p.id)), "페이지 간 중복 없음");
      const body = await json(await listAs(B, `?q=needle`));
      assert(body.total === 1 && body.posts[0].id === extra[6], "본문 검색 (대소문자 무시)");
      const none = await json(await listAs(B, `?q=${encodeURIComponent("없는검색어zz")}`));
      assert(none.total === 0 && none.posts.length === 0 && none.page === 1, "검색 결과 없음");
      const pct = await json(await listAs(B, `?q=${encodeURIComponent("%")}`));
      assert(Array.isArray(pct.posts), "특수문자 검색 안전");
      assert(lib.normalizeCommunitySearch("a".repeat(80)).length === 50, "검색어 50자 제한");
      const fbSearch = await json(await listAs(ADM, `?q=${encodeURIComponent("가배치표")}`));
      assert(!fbSearch.posts.some((p: { id: number; title: string }) => fbPostIds.includes(p.id) && p.title === "가배치표"), "자유게시판 검색에 가배치표 글 없음");
    }

    section("삭제: 본인 또는 관리자 (관리자 = 부적절한 글 관리)");
    {
      const del = (cookie: string, id: number) =>
        one.DELETE(req(`http://local/api/talk/${id}`, { method: "DELETE", headers: { cookie } }), idP(id));
      assert((await del(B, postA)).status === 403, "다른 캐디 삭제 403");
      assert((await del(L, postA)).status === 403, "조장도 타인 글 삭제 403");
      assert((await prisma.communityPost.findUnique({ where: { id: postA } }))?.deletedAt == null, "차단된 삭제 → DB 그대로");
      const admDel = await del(ADM, postA);
      assert(admDel.status === 200, "관리자 삭제 200");
      const row = await prisma.communityPost.findUnique({ where: { id: postA } });
      assert(row?.deletedAt != null && row.deletedByUserId === uAdm.id, "soft delete + 삭제자 기록");
      assert((await prisma.communityPhoto.count({ where: { postId: postA } })) === 0, "삭제 글 사진 정리");
      assert((await one.GET(req(`http://local/api/talk/${postA}`, { headers: { cookie: A } }), idP(postA))).status === 404, "삭제 글 상세 404");
      assert((await del(ADM, postA)).status === 404, "이미 삭제된 글 404");
      const lj = await json(await listAs(A));
      assert(!lj.posts.some((p: { id: number }) => p.id === postA), "삭제 글 목록 제외");
      const cAfter = await comments.POST(
        req(`http://local/api/talk/${postA}/comments`, { method: "POST", headers: H(B), body: JSON.stringify({ body: "늦은 댓글" }) }),
        idP(postA)
      );
      assert(cAfter.status === 404, "삭제 글에 댓글 404");
      assert((await del(L, postL)).status === 200, "조장 본인 글 삭제 200");
      assert((await prisma.communityPost.findUnique({ where: { id: postL } }))?.deletedByUserId === uL.id, "본인 삭제 기록");
    }

    section("가배치표 보호 (데이터 혼입·권한 변경 없음)");
    {
      const fbAsCaddy = await fbList.POST(
        req("http://local/api/free-board", { method: "POST", headers: H(A), body: JSON.stringify({ title: "t", body: "b" }) })
      );
      assert(fbAsCaddy.status === 403, "가배치표: 캐디 작성 여전히 403 (관리자 전용 유지)");
      const fbAsLeader = await fbList.POST(
        req("http://local/api/free-board", { method: "POST", headers: H(L), body: JSON.stringify({ title: "t", body: "b" }) })
      );
      assert(fbAsLeader.status === 403, "가배치표: 조장 작성 여전히 403");
      const fbl = await json(await fbList.GET(req("http://local/api/free-board", { headers: { cookie: A } })));
      const talkIds = new Set((await prisma.communityPost.findMany({ select: { id: true } })).map((r) => r.id));
      const fbTitles = fbl.posts.map((p: { title: string }) => p.title);
      assert(!fbTitles.some((t: string) => t.includes(tag) || t === "조장 글" || t === "관리자 글"), "가배치표 목록에 자유게시판 글 없음");
      assert(fbl.canCompose === false, "가배치표 캐디 글쓰기 버튼 없음 그대로");
      assert((await prisma.freeBoardPost.count()) === freeBoardBefore + fbPostIds.length, "가배치표 글 수 = 기존 + 테스트용 1건 (자유게시판 글 섞임 없음)");
      assert((await prisma.freeBoardPhoto.count()) === freeBoardPhotoBefore + 1, "가배치표 사진 수 = 기존 + 테스트용 1건");
      const tl = await json(await listAs(ADM));
      assert(!tl.posts.some((p: { title: string }) => p.title === "가배치표"), "자유게시판 목록에 가배치표 글 없음");
      assert(talkIds.size > 0, "자유게시판 글은 CommunityPost 테이블에만");
    }

    section("테이블 없음(마이그레이션 미적용) 감지 → 503 안내");
    {
      const e = new Prisma.PrismaClientKnownRequestError("The table `public.CommunityPost` does not exist in the current database.", {
        code: "P2021",
        clientVersion: "5",
      });
      assert(lib.isCommunityTableMissing(e), "P2021 감지");
      assert(!lib.isCommunityTableMissing(new Error("other")), "다른 오류는 그대로");
      const res = lib.communityUnavailableResponse();
      assert(res.status === 503, "준비 중 503");
    }

    section("source safety");
    {
      const files = [
        "src/app/talk/page.tsx",
        "src/app/talk/[id]/page.tsx",
        "src/app/talk/[id]/TalkPhotoGallery.tsx",
        "src/app/talk/[id]/TalkDetailActions.tsx",
        "src/app/talk/[id]/edit/page.tsx",
        "src/app/talk/new/page.tsx",
        "src/app/community/FreeBoardForm.tsx",
        "src/app/community/[id]/FreeBoardComments.tsx",
      ];
      for (const f of files) assert(!read(f).includes("dangerouslySetInnerHTML"), `${f}: innerHTML 없음`);
      for (const f of [
        "src/app/api/talk/route.ts",
        "src/app/api/talk/[id]/route.ts",
        "src/app/api/talk/[id]/photos/route.ts",
        "src/app/api/talk/[id]/photos/[photoId]/route.ts",
        "src/app/api/talk/[id]/comments/route.ts",
        "src/app/api/talk/[id]/comments/[commentId]/route.ts",
      ]) {
        const src = read(f);
        const handlers = (src.match(/export async function (GET|POST|PATCH|DELETE)/g) || []).length;
        const guards = (src.match(/requireCommunityReader\(req\)/g) || []).length;
        assert(handlers > 0 && handlers === guards, `${f}: 모든 handler 가 인증 가드 사용`);
        assert(!/freeBoardPost|freeBoardPhoto/.test(src), `${f}: 가배치표 테이블 미사용`);
      }
      for (const f of ["src/lib/communityBoard.ts", "src/lib/communityBoardPhoto.ts", "src/lib/communityBoardComments.ts"]) {
        assert(!/prisma\.freeBoard|db\.freeBoard|tx\.freeBoard/.test(read(f)), `${f}: 가배치표 테이블 접근 없음`);
      }
      const mig = read("prisma/migrations/20261120160000_community_free_board_v1/migration.sql");
      const code = mig.replace(/--[^\n]*/g, "");
      const codeNoFk = code.replace(/ON (DELETE|UPDATE) (RESTRICT|CASCADE)/g, "");
      assert(!/\bDROP\b|\bRENAME\b|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/i.test(codeNoFk), "migration: DROP/RENAME/UPDATE/DELETE 없음");
      const altered = [...code.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
      assert(altered.every((t) => t === "CommunityPost" || t === "CommunityPhoto"), "migration: 새 테이블에만 ALTER (FK)");
      assert(/ALTER TYPE "CommentTargetType" ADD VALUE IF NOT EXISTS 'COMMUNITY_POST'/.test(code), "migration: enum 값 추가만");
      assert(!/FreeBoard/.test(code), "migration: 가배치표 테이블 미변경");
      assert(read("src/middleware.ts").includes('"/talk/:path*"'), "middleware: /talk 로그인 필요");
      assert(read("src/app/talk/layout.tsx").includes("isUnlinkedStaffAccount"), "화면: 미연결 계정 차단");
    }
  } finally {
    const talkPosts = await prisma.communityPost.findMany({
      where: { authorUserId: { in: userIds } },
      select: { id: true },
    });
    const talkIds = talkPosts.map((p) => p.id);
    const threads = await prisma.commentThread.findMany({
      where: {
        OR: [
          { targetType: "COMMUNITY_POST", targetKey: { in: talkIds.map(String) } },
          { targetType: "FREE_BOARD_POST", targetKey: { in: fbPostIds.map(String) } },
        ],
      },
      select: { id: true },
    });
    const tIds = threads.map((t) => t.id);
    await prisma.comment.updateMany({ where: { threadId: { in: tIds } }, data: { parentId: null } });
    await prisma.comment.deleteMany({ where: { threadId: { in: tIds } } });
    await prisma.commentThread.deleteMany({ where: { id: { in: tIds } } });
    await prisma.communityPhoto.deleteMany({ where: { postId: { in: talkIds } } });
    await prisma.communityPost.deleteMany({ where: { id: { in: talkIds } } });
    await prisma.freeBoardPhoto.deleteMany({ where: { postId: { in: fbPostIds } } });
    await prisma.freeBoardPost.deleteMany({ where: { id: { in: fbPostIds } } });
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (caddyIds.length) await prisma.caddy.deleteMany({ where: { id: { in: caddyIds } } });
    setFreeBoardStoreFactoryForTests(null);
    for (const [k, v] of Object.entries({
      SESSION_SECRET: prev.SESSION_SECRET,
      NEXT_PUBLIC_FREE_BOARD_ENABLED: prev.FLAG,
      NEXT_PUBLIC_COMMUNITY_FREE_BOARD_DISABLED: prev.KILL,
      VERCEL_ENV: prev.VERCEL_ENV,
      FREE_BOARD_STORAGE_ENV: prev.FREE_BOARD_STORAGE_ENV,
      ADMIN_CHAT_USER_ID: prev.ADMIN_CHAT_USER_ID,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
