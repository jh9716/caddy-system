/**
 * Unlinked Kakao least-privilege: login + /caddy/link stay open,
 * staff-internal surfaces 403 with caddy_not_linked.
 * local caddy_local only. No production write.
 * 실행: npm run test:unlinked-kakao-guard-unit
 */
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import { prisma } from "../src/lib/prisma";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import {
  SESSION_COOKIE_NAME,
  buildSessionClaims,
  signSessionClaims,
} from "../src/lib/sessionCookies";
import {
  UNLINKED_STAFF_ERROR,
  UNLINKED_STAFF_MESSAGE,
  denyUnlinkedStaff,
  isRetiredCaddySessionBlocked,
  isUnlinkedStaffAccount,
  unlinkedStaffForbiddenResponse,
} from "../src/lib/auth";
import { findOrCreateKakaoSessionUser } from "../src/lib/kakaoSessionUser";
import { GET as GET_ME } from "../src/app/api/me/route";
import { POST as POST_LOGOUT } from "../src/app/api/logout/route";
import { POST as POST_LOGOUT_ALL } from "../src/app/api/auth/logout-all/route";
import {
  GET as GET_LINK,
  POST as POST_LINK,
} from "../src/app/api/caddy-link-requests/route";
import { GET as GET_MINE } from "../src/app/api/caddy-link-requests/mine/route";
import { POST as POST_CANCEL } from "../src/app/api/caddy-link-requests/[id]/cancel/route";
import {
  GET as GET_REPORTS,
  POST as POST_REPORT,
} from "../src/app/api/course-reports/route";
import { GET as GET_REPORT } from "../src/app/api/course-reports/[id]/route";
import { GET as GET_NOTICE } from "../src/app/api/notice/route";
import { GET as GET_SUMMARY } from "../src/app/api/summary/route";
import { GET as GET_PUBLISHED } from "../src/app/api/assignments/published/route";
import { GET as GET_BOARD_COMMENTS } from "../src/app/api/board/[date]/comments/route";
import { POST as POST_CHAT_TOKEN } from "../src/app/api/chat/token/route";
import { GET as GET_PUSH } from "../src/app/api/push/subscription/route";
import { GET as GET_NATIVE_PUSH } from "../src/app/api/push/native-token/route";
import { GET as GET_OFF } from "../src/app/api/off-requests/route";

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

function section(title: string) {
  console.log("\n==", title, "==");
}

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

async function cookieFor(user: {
  id: number | null;
  username: string;
  role: "admin" | "caddy" | "leader";
  sessionVersion: number;
}) {
  return `${SESSION_COOKIE_NAME}=${await signSessionClaims(
    buildSessionClaims({
      userId: user.id,
      username: user.username,
      role: user.role,
      sessionVersion: user.sessionVersion,
    })
  )}`;
}

function req(url: string, cookie: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(url, {
    ...init,
    headers: {
      cookie,
      ...(init?.headers || {}),
    },
  });
}

async function jsonOf(res: Response) {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

async function assertUnlinkedForbidden(res: Response, label: string) {
  const body = await jsonOf(res);
  assert(res.status === 403, `${label} 403`);
  assert(body.error === UNLINKED_STAFF_ERROR, `${label} error code`);
  assert(body.message === UNLINKED_STAFF_MESSAGE, `${label} message`);
  assert(body.published === undefined, `${label} no published leak`);
  assert(body.ok !== true, `${label} not ok`);
  return body;
}

async function main() {
  section("helper + source");
  {
    assert(
      isUnlinkedStaffAccount({ role: "caddy", caddyId: null }) === true,
      "unlinked caddy"
    );
    assert(
      isUnlinkedStaffAccount({ role: "leader", caddyId: null }) === true,
      "unlinked leader"
    );
    assert(
      isUnlinkedStaffAccount({ role: "caddy", caddyId: 3 }) === false,
      "linked caddy"
    );
    assert(
      isUnlinkedStaffAccount({ role: "admin", caddyId: null }) === false,
      "admin caddyId=null allowed"
    );
    const denied = denyUnlinkedStaff({ role: "caddy", caddyId: null });
    assert(denied instanceof Response && denied.status === 403, "deny helper 403");
    assert(!denyUnlinkedStaff({ role: "admin", caddyId: null }), "deny skips admin");
    const res = unlinkedStaffForbiddenResponse();
    const body = await jsonOf(res);
    assert(res.status === 403 && body.error === "caddy_not_linked", "shared 403 shape");
    assert(
      !isRetiredCaddySessionBlocked({
        role: "caddy",
        caddyId: null,
        employmentStatus: "RETIRED",
      }),
      "unlinked is not RETIRED-blocked (login → /caddy/link)"
    );
    assert(
      isRetiredCaddySessionBlocked({
        role: "caddy",
        caddyId: 1,
        employmentStatus: "RETIRED",
      }),
      "RETIRED linked still blocked"
    );

    const files = [
      "src/lib/auth.ts",
      "src/lib/courseReportAccess.ts",
      "src/lib/noticeAccess.ts",
      "src/lib/boardComments.ts",
      "src/app/api/push/subscription/route.ts",
      "src/app/api/push/native-token/route.ts",
    ];
    for (const rel of files) {
      assert(read(rel).includes("denyUnlinkedStaff"), `${rel} uses common helper`);
    }
    assert(
      read("src/app/api/caddy-link-requests/route.ts").includes("resolveAuthUser") &&
        !read("src/app/api/caddy-link-requests/route.ts").includes("denyUnlinkedStaff"),
      "link submit not staff-gated"
    );
    assert(
      !read("src/app/api/caddy-link-requests/mine/route.ts").includes("denyUnlinkedStaff"),
      "mine not staff-gated"
    );
    assert(
      !read("src/app/api/caddy-link-requests/[id]/cancel/route.ts").includes(
        "denyUnlinkedStaff"
      ),
      "cancel not staff-gated"
    );
    assert(
      !read("src/app/api/me/route.ts").includes("denyUnlinkedStaff"),
      "/api/me not staff-gated"
    );
    assert(
      !read("src/app/api/auth/kakao/callback/route.ts").includes("denyUnlinkedStaff"),
      "kakao callback not staff-gated"
    );
    assert(
      !read("src/app/api/auth/kakao/native-session/route.ts").includes("denyUnlinkedStaff"),
      "kakao native-session not staff-gated"
    );
    assert(
      !read("src/app/api/chat/token/route.ts").includes("denyUnlinkedStaff"),
      "chat token path unchanged"
    );
    assert(
      read("src/lib/chatAuth.ts").includes('code: "caddy_not_linked"'),
      "chat still requires linked"
    );
  }

  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prevSecret = process.env.SESSION_SECRET;
  const prevChat = process.env.CHAT_AUTH_SECRET;
  process.env.SESSION_SECRET = "unlinked-kakao-guard-secret-32chars!!";
  process.env.CHAT_AUTH_SECRET = "unlinked-kakao-chat-secret-32chars!!";

  const tag = `ulg_${Date.now()}`;
  const hash = await bcrypt.hash("x", 4);
  const caddyIds: number[] = [];
  const userIds: number[] = [];
  const requestIds: number[] = [];
  const reportIds: number[] = [];

  try {
    const linkCaddy = await prisma.caddy.create({
      data: {
        name: `${tag}_링크대상`,
        team: "1조",
        caddyType: "HOUSE",
        employmentStatus: "ACTIVE",
      },
    });
    const linkedCaddy = await prisma.caddy.create({
      data: {
        name: `${tag}_연결캐디`,
        team: "1조",
        caddyType: "HOUSE",
        employmentStatus: "ACTIVE",
      },
    });
    const leaderCaddy = await prisma.caddy.create({
      data: {
        name: `${tag}_조장`,
        team: "1조",
        caddyType: "HOUSE",
        employmentStatus: "ACTIVE",
      },
    });
    const retiredCaddy = await prisma.caddy.create({
      data: {
        name: `${tag}_퇴직`,
        team: "1조",
        caddyType: "HOUSE",
        employmentStatus: "RETIRED",
      },
    });
    caddyIds.push(linkCaddy.id, linkedCaddy.id, leaderCaddy.id, retiredCaddy.id);

    const kakao = await findOrCreateKakaoSessionUser(
      prisma,
      `9${Date.now().toString().slice(-12)}`
    );
    if (!kakao) throw new Error("kakao first-login user missing");
    userIds.push(kakao.id);
    assert(kakao.role === "caddy" && kakao.caddyId == null, "first Kakao login unlinked caddy");

    const uLinked = await prisma.user.create({
      data: {
        username: `${tag}_linked`,
        password: hash,
        role: "caddy",
        caddyId: linkedCaddy.id,
        sessionVersion: 0,
      },
    });
    const uLeader = await prisma.user.create({
      data: {
        username: `${tag}_leader`,
        password: hash,
        role: "leader",
        caddyId: leaderCaddy.id,
        sessionVersion: 0,
      },
    });
    const uUnlinkedLeader = await prisma.user.create({
      data: {
        username: `${tag}_uleader`,
        password: hash,
        role: "leader",
        caddyId: null,
        sessionVersion: 0,
      },
    });
    const uAdmin = await prisma.user.create({
      data: {
        username: `${tag}_admin`,
        password: hash,
        role: "admin",
        caddyId: null,
        sessionVersion: 0,
      },
    });
    const uRetired = await prisma.user.create({
      data: {
        username: `${tag}_retired`,
        password: hash,
        role: "caddy",
        caddyId: retiredCaddy.id,
        sessionVersion: 0,
      },
    });
    userIds.push(uLinked.id, uLeader.id, uUnlinkedLeader.id, uAdmin.id, uRetired.id);

    const kakaoCookie = await cookieFor({
      id: kakao.id,
      username: kakao.username,
      role: "caddy",
      sessionVersion: kakao.sessionVersion,
    });
    const linkedCookie = await cookieFor({ ...uLinked, role: "caddy" });
    const leaderCookie = await cookieFor({ ...uLeader, role: "leader" });
    const unlinkedLeaderCookie = await cookieFor({
      ...uUnlinkedLeader,
      role: "leader",
    });
    const adminCookie = await cookieFor({ ...uAdmin, role: "admin" });
    const envAdminCookie = await cookieFor({
      id: null,
      username: "env-admin",
      role: "admin",
      sessionVersion: 0,
    });
    const retiredCookie = await cookieFor({ ...uRetired, role: "caddy" });

    section("allowed: me / logout / link flow");
    {
      const me = await GET_ME(req("https://www.verthill.kr/api/me", kakaoCookie));
      const meBody = await jsonOf(me);
      assert(me.status === 200 && meBody.authenticated === true, "unlinked /api/me 200");
      assert(
        (meBody.user as { username?: string })?.username === kakao.username,
        "me username"
      );

      const mine0 = await GET_MINE(
        req("https://www.verthill.kr/api/caddy-link-requests/mine", kakaoCookie)
      );
      const mine0Body = await jsonOf(mine0);
      assert(mine0.status === 200 && mine0Body.ok === true, "mine before submit");
      assert(mine0Body.linked === false, "mine linked=false");

      const submit = await POST_LINK(
        req("https://www.verthill.kr/api/caddy-link-requests", kakaoCookie, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `${tag}_링크대상`,
            phone: "010-1111-2222",
          }),
        })
      );
      const submitBody = await jsonOf(submit);
      assert(submit.status === 200 && submitBody.ok === true, "link request submit 200");
      const request = submitBody.request as { id?: number; status?: string };
      assert(typeof request?.id === "number", "request id");
      assert(request.status === "PENDING", "PENDING");
      requestIds.push(request.id as number);

      const mine = await GET_MINE(
        req("https://www.verthill.kr/api/caddy-link-requests/mine", kakaoCookie)
      );
      const mineBody = await jsonOf(mine);
      assert(mine.status === 200 && mineBody.ok === true, "mine after submit");
      assert((mineBody.request as { id?: number })?.id === request.id, "mine shows request");

      const cancel = await POST_CANCEL(
        req(
          `https://www.verthill.kr/api/caddy-link-requests/${request.id}/cancel`,
          kakaoCookie,
          { method: "POST" }
        ),
        { params: { id: String(request.id) } }
      );
      const cancelBody = await jsonOf(cancel);
      assert(cancel.status === 200 && cancelBody.ok === true, "cancel 200");
      assert(
        (cancelBody.request as { status?: string })?.status === "CANCELLED",
        "cancelled"
      );

      const resubmit = await POST_LINK(
        req("https://www.verthill.kr/api/caddy-link-requests", kakaoCookie, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `${tag}_링크대상`,
            phone: "010-1111-3333",
          }),
        })
      );
      const resubmitBody = await jsonOf(resubmit);
      assert(resubmit.status === 200, "submit after cancel still works");
      requestIds.push((resubmitBody.request as { id: number }).id);

      const logout = await POST_LOGOUT(
        req("https://www.verthill.kr/api/logout", kakaoCookie, { method: "POST" })
      );
      assert(logout.status === 200, "logout 200");
    }

    section("blocked: staff internals for unlinked kakao");
    {
      await assertUnlinkedForbidden(
        await GET_REPORTS(req("https://www.verthill.kr/api/course-reports", kakaoCookie)),
        "course-report list"
      );
      await assertUnlinkedForbidden(
        await GET_REPORT(
          req("https://www.verthill.kr/api/course-reports/999999", kakaoCookie),
          { params: { id: "999999" } }
        ),
        "course-report missing id"
      );
      await assertUnlinkedForbidden(
        await POST_REPORT(
          req("https://www.verthill.kr/api/course-reports", kakaoCookie, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: "nope",
              body: "nope",
              course: "VERTHILL",
              category: "OTHER",
            }),
          })
        ),
        "course-report write"
      );
      await assertUnlinkedForbidden(
        await GET_NOTICE(req("https://www.verthill.kr/api/notice", kakaoCookie)),
        "notice"
      );
      await assertUnlinkedForbidden(
        await GET_SUMMARY(req("https://www.verthill.kr/api/summary", kakaoCookie)),
        "summary"
      );
      await assertUnlinkedForbidden(
        await GET_PUBLISHED(
          req(
            "https://www.verthill.kr/api/assignments/published?date=2099-01-15",
            kakaoCookie
          )
        ),
        "published board"
      );
      await assertUnlinkedForbidden(
        await GET_BOARD_COMMENTS(
          req(
            "https://www.verthill.kr/api/board/2099-01-15/comments",
            kakaoCookie
          ),
          { params: { date: "2099-01-15" } }
        ),
        "board comment"
      );
      const chat = await POST_CHAT_TOKEN(
        req("https://www.verthill.kr/api/chat/token", kakaoCookie, { method: "POST" })
      );
      const chatBody = await jsonOf(chat);
      assert(chat.status === 403, "chat 403");
      assert(chatBody.error === "caddy_not_linked", "chat linked requirement kept");
      await assertUnlinkedForbidden(
        await GET_PUSH(req("https://www.verthill.kr/api/push/subscription", kakaoCookie)),
        "web push"
      );
      await assertUnlinkedForbidden(
        await GET_NATIVE_PUSH(
          req("https://www.verthill.kr/api/push/native-token", kakaoCookie)
        ),
        "native push"
      );
      await assertUnlinkedForbidden(
        await GET_OFF(req("https://www.verthill.kr/api/off-requests", kakaoCookie)),
        "off-requests"
      );
      await assertUnlinkedForbidden(
        await GET_REPORTS(
          req("https://www.verthill.kr/api/course-reports", unlinkedLeaderCookie)
        ),
        "unlinked leader course-report"
      );
    }

    section("linked caddy / leader / admin / RETIRED");
    {
      const list = await GET_REPORTS(
        req("https://www.verthill.kr/api/course-reports", linkedCookie)
      );
      assert(list.status === 200, "linked caddy course-report list");
      const created = await POST_REPORT(
        req("https://www.verthill.kr/api/course-reports", linkedCookie, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: `${tag}_ok`,
            body: "linked",
            course: "VERTHILL",
            category: "OTHER",
          }),
        })
      );
      const createdBody = await jsonOf(created);
      assert(created.status === 200, "linked caddy can write report");
      reportIds.push(createdBody.id as number);

      const notice = await GET_NOTICE(
        req("https://www.verthill.kr/api/notice", linkedCookie)
      );
      assert(notice.status === 200, "linked caddy notice");
      const summary = await GET_SUMMARY(
        req("https://www.verthill.kr/api/summary", linkedCookie)
      );
      assert(summary.status === 200, "linked caddy summary");
      const published = await GET_PUBLISHED(
        req(
          "https://www.verthill.kr/api/assignments/published?date=2099-01-15",
          linkedCookie
        )
      );
      const publishedBody = await jsonOf(published);
      assert(published.status === 200 && publishedBody.ok === true, "linked caddy published");

      const leaderNotice = await GET_NOTICE(
        req("https://www.verthill.kr/api/notice", leaderCookie)
      );
      assert(leaderNotice.status === 200, "linked leader notice");
      const leaderPub = await GET_PUBLISHED(
        req(
          "https://www.verthill.kr/api/assignments/published?date=2099-01-15",
          leaderCookie
        )
      );
      assert(leaderPub.status === 200, "linked leader published");

      const adminNotice = await GET_NOTICE(
        req("https://www.verthill.kr/api/notice", adminCookie)
      );
      assert(adminNotice.status === 200, "admin notice");
      const adminPub = await GET_PUBLISHED(
        req(
          "https://www.verthill.kr/api/assignments/published?date=2099-01-15",
          adminCookie
        )
      );
      assert(adminPub.status === 200, "admin published");
      const envAdminPub = await GET_PUBLISHED(
        req(
          "https://www.verthill.kr/api/assignments/published?date=2099-01-15",
          envAdminCookie
        )
      );
      assert(envAdminPub.status === 200, "env-admin published");
      const adminPending = await GET_LINK(
        req(
          "https://www.verthill.kr/api/caddy-link-requests?status=PENDING",
          adminCookie
        )
      );
      assert(adminPending.status === 200, "admin link inbox still works");

      const retiredList = await GET_REPORTS(
        req("https://www.verthill.kr/api/course-reports", retiredCookie)
      );
      assert(retiredList.status === 401, "RETIRED still 401");

      const logoutAll = await POST_LOGOUT_ALL(
        req("https://www.verthill.kr/api/auth/logout-all", kakaoCookie, {
          method: "POST",
        })
      );
      assert(logoutAll.status === 200, "unlinked logout-all still allowed");
    }
  } finally {
    if (reportIds.length) {
      await prisma.courseReport.deleteMany({ where: { id: { in: reportIds } } });
    }
    if (requestIds.length) {
      await prisma.caddyLinkRequest.deleteMany({ where: { id: { in: requestIds } } });
    }
    if (userIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (caddyIds.length) {
      await prisma.caddy.deleteMany({ where: { id: { in: caddyIds } } });
    }
    if (prevSecret == null) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSecret;
    if (prevChat == null) delete process.env.CHAT_AUTH_SECRET;
    else process.env.CHAT_AUTH_SECRET = prevChat;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
