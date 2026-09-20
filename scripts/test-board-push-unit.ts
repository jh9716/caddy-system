/**
 * Board published Web Push V1. local caddy_local only.
 * Mock provider: no external push network.
 * 실행: npm run test:board-push-unit
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import {
  SESSION_COOKIE_NAME,
  buildSessionClaims,
  signSessionClaims,
} from "../src/lib/sessionCookies";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import { parseYmd } from "../src/lib/availabilityEngine";
import {
  parseDailyBoardPublishedPayload,
  type PublishedPlacementV1,
} from "../src/lib/dailyBoardPublished";
import {
  BOARD_PUSH_CONFIRM,
  BOARD_PUSH_TITLE,
  BOARD_PUSH_AUDIT_ACTION,
  BOARD_PUSH_AUDIT_ENTITY,
  BOARD_PUSH_CONCURRENCY,
  BOARD_PUSH_STALE_MESSAGE,
} from "../src/lib/boardPushConstants";
import {
  buildBoardPushPayload,
  formatBoardPushBody,
  formatBoardPushDateKo,
  boardPushUrl,
} from "../src/lib/boardPushMessage";
import {
  mapWithConcurrency,
  uniqueAssignedCaddyIdsFromPublished,
} from "../src/lib/boardPushRecipients";
import {
  parseBoardPushSendRequest,
  previewBoardPush,
  sendBoardPush,
} from "../src/lib/boardPush";
import { GET as GET_PREVIEW } from "../src/app/api/push/board-preview/route";
import { POST as POST_SEND } from "../src/app/api/push/board-send/route";

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

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fakeP256(): string {
  const b = Buffer.alloc(65, 9);
  b[0] = 0x04;
  return b64url(b);
}

function fakeAuth(): string {
  return b64url(Buffer.alloc(16, 3));
}

function fakePriv(): string {
  return b64url(Buffer.alloc(32, 7));
}

function jsonHasSecrets(body: unknown): boolean {
  const s = JSON.stringify(body);
  return (
    /p256dh/i.test(s) ||
    /"auth"/i.test(s) ||
    /endpoint/i.test(s) ||
    /WEB_PUSH_VAPID_PRIVATE/i.test(s) ||
    /privateKey/i.test(s)
  );
}

async function boardPushAudits(date: string) {
  return prisma.$queryRaw<Array<{ id: number; payload: unknown }>>`
    SELECT id, payload FROM "Audit"
    WHERE action = ${BOARD_PUSH_AUDIT_ACTION}
      AND entity = ${BOARD_PUSH_AUDIT_ENTITY}
      AND payload->>'date' = ${date}
    ORDER BY id ASC
  `;
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

async function getPreview(cookie: string | undefined, date: string) {
  const url = `https://www.verthill.kr/api/push/board-preview?date=${encodeURIComponent(date)}`;
  const req = new NextRequest(url, {
    method: "GET",
    headers: cookie ? { cookie } : {},
  });
  return GET_PREVIEW(req);
}

async function postSend(cookie: string | undefined, body: unknown) {
  const init: ConstructorParameters<typeof NextRequest>[1] = {
    method: "POST",
    headers: {
      ...(cookie ? { cookie } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
  return POST_SEND(new NextRequest("https://www.verthill.kr/api/push/board-send", init));
}

function placement(
  partial: Partial<PublishedPlacementV1> & {
    caddyId: number | null;
    caddyName: string;
  }
): PublishedPlacementV1 {
  return {
    shift: "1부",
    course: "VERTHILL",
    teeTime: "07:00",
    teamName: null,
    reservationId: 1,
    reservationKey: "k1",
    caddyTeam: "1조",
    displayLabel: partial.caddyName,
    kind: "regular",
    locked: false,
    limousine: false,
    driving: false,
    twoWork: false,
    chageun: false,
    specialSupport: false,
    sequenceIndex: 0,
    ...partial,
  };
}

function publishedPayload(
  date: string,
  placements: PublishedPlacementV1[],
  sparesByShift: unknown[] = []
) {
  return parseDailyBoardPublishedPayload(
    {
      schemaVersion: 1,
      date,
      openCourses: ["VERTHILL"],
      placements,
      sparesByShift,
      publisherUsername: "admin",
    },
    date
  );
}

async function upsertPublished(
  date: string,
  version: number,
  payload: unknown
) {
  const key = parseYmd(date).start;
  await prisma.dailyBoardPublished.upsert({
    where: { date: key },
    create: {
      date: key,
      payload: payload as object,
      schemaVersion: 1,
      sourceDraftVersion: version,
      publishedAt: new Date(),
    },
    update: {
      payload: payload as object,
      sourceDraftVersion: version,
      publishedAt: new Date(),
    },
  });
}

async function upsertDraft(date: string, version: number | null) {
  const key = parseYmd(date).start;
  if (version == null) {
    await prisma.dailyBoardDraft.deleteMany({ where: { date: key } });
    return;
  }
  await prisma.dailyBoardDraft.upsert({
    where: { date: key },
    create: {
      date: key,
      payload: { date },
      schemaVersion: 1,
      version,
    },
    update: { version },
  });
}

async function addSub(
  userId: number,
  endpoint: string,
  enabled = true
) {
  return prisma.pushSubscription.create({
    data: {
      userId,
      endpoint,
      p256dh: fakeP256(),
      auth: fakeAuth(),
      enabled,
    },
  });
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prevSecret = process.env.SESSION_SECRET;
  const prevPub = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  const prevPriv = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  const prevSub = process.env.WEB_PUSH_SUBJECT;
  process.env.SESSION_SECRET = "board-push-unit-secret-32chars!!!!";
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = fakeP256();
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = fakePriv();
  process.env.WEB_PUSH_SUBJECT = "https://www.verthill.kr";

  const tag = `bpn_${Date.now()}`;
  const DATE = "2099-06-18";
  const hash = await bcrypt.hash("x", 4);
  const dateKey = parseYmd(DATE).start;

  section("source safety");
  {
    const files = [
      "src/lib/boardPush.ts",
      "src/lib/boardPushRecipients.ts",
      "src/lib/boardPushMessage.ts",
      "src/lib/boardPushAuth.ts",
      "src/lib/boardPushConstants.ts",
      "src/app/api/push/board-preview/route.ts",
      "src/app/api/push/board-send/route.ts",
      "src/components/manage/BoardPushNotifyCard.tsx",
    ];
    for (const rel of files) {
      const src = read(rel);
      assert(!src.includes("phoneNormalized"), `${rel} no phoneNormalized`);
      assert(!/from ["']web-push["']/.test(src), `${rel} no web-push import`);
      assert(!src.includes("WEB_PUSH_VAPID_PRIVATE_KEY"), `${rel} no private env`);
    }
    const core = read("src/lib/boardPush.ts");
    assert(core.includes("deliverWebPushMappings"), "reuses delivery helper");
    assert(core.includes("resolvePublishedFreshness"), "reuses freshness helper");
    assert(core.includes("loadFreshness"), "send reloads published+draft");
    assert(
      core.split("loadFreshness(").length - 1 >= 3,
      "freshness loaded at preview/send/recheck"
    );
    assert(core.includes("pg_advisory_xact_lock"), "advisory lock");
    assert(core.includes("BOARD_PUSH_SEND"), "audit action");
    assert(!/from ["']@\/lib\/audit["']/.test(core), "does not import console audit helper");
    assert(core.includes("tx.audit.create"), "Prisma Audit INSERT in claim tx");
    assert(core.includes('SELECT id, payload FROM "Audit"'), "Prisma Audit SELECT");
    assert(
      core.indexOf("claimBoardPushSend(") < core.lastIndexOf("await deliverWebPushMappings"),
      "claim invoked before deliverWebPushMappings"
    );
    assert(!core.includes("publishDailyBoard("), "no auto send on publish");
    assert(!core.includes("cron"), "no cron");
    const publish = read("src/lib/dailyBoardPublishedService.ts");
    assert(!publish.includes("boardPush"), "publishDailyBoard no boardPush");
    assert(!publish.includes("sendBoardPush"), "publish no send");
    const schema = read("prisma/schema.prisma");
    assert(!schema.includes("model BoardPush"), "no BoardPush table");
    const migrations = fs.readdirSync(path.join(process.cwd(), "prisma/migrations"));
    assert(
      !migrations.some((n) => /board.?push/i.test(n)),
      "no board-push migration"
    );
    const alimtalk = read("src/lib/alimtalkPublishedFreshness.ts");
    assert(alimtalk.includes("resolvePublishedFreshness"), "alimtalk helper untouched import target");
    const sw = read("public/sw.js");
    assert(!/caches\.open/.test(sw), "SW no caches.open");
    assert(sw.includes("skipWaiting"), "SW skipWaiting");
    const sessionLogout = read("src/app/api/push/subscription/route.ts");
    assert(sessionLogout.includes("deletePushSubscriptionForUser"), "unsubscribe still explicit DELETE");
    const card = read("src/components/manage/BoardPushNotifyCard.tsx");
    assert(card.includes("window.confirm"), "one confirm dialog");
    assert(card.includes("sending"), "sending disable");
    assert(card.includes("BOARD_PUSH_CONFIRM"), "confirm constant");
    const page = read("src/app/manage/assignments/page.tsx");
    assert(page.includes("BoardPushNotifyCard"), "assignments UI card");
    assert(BOARD_PUSH_CONCURRENCY >= 10 && BOARD_PUSH_CONCURRENCY <= 20, "concurrency 10-20");
  }

  section("message / grouping / concurrency helper");
  {
    assert(formatBoardPushDateKo("2026-09-18") === "9월 18일", "9월 18일");
    assert(
      formatBoardPushBody("2026-09-18") ===
        "9월 18일 배치표가 게시되었습니다. 앱에서 근무 일정을 확인해 주세요.",
      "body copy"
    );
    assert(boardPushUrl("2026-09-18") === "/board?date=2026-09-18", "url");
    const payload = buildBoardPushPayload("2026-09-18");
    assert(payload.title === BOARD_PUSH_TITLE, "title");
    assert(!payload.body.includes("07:00"), "no tee time");
    assert(!payload.body.includes("VERTHILL"), "no course in body");
    const grouped = uniqueAssignedCaddyIdsFromPublished({
      placements: [
        placement({ caddyId: 10, caddyName: "A", kind: "regular", shift: "1부" }),
        placement({
          caddyId: 10,
          caddyName: "A",
          kind: "oneTwo",
          shift: "2부",
          teeTime: "11:00",
        }),
        placement({
          caddyId: 10,
          caddyName: "A",
          kind: "fiftyFourHole",
          shift: "3부",
          teeTime: "14:00",
        }),
        placement({ caddyId: null, caddyName: "빈칸" }),
        placement({
          caddyId: 11,
          caddyName: "B",
          kind: "specialSupport",
          specialSupport: true,
        }),
      ],
    });
    assert(grouped.join(",") === "10,11", "unique caddyIds ignore null");
    let inflight = 0;
    let max = 0;
    await mapWithConcurrency(Array.from({ length: 40 }, (_, i) => i), 12, async () => {
      inflight += 1;
      max = Math.max(max, inflight);
      await new Promise((r) => setTimeout(r, 15));
      inflight -= 1;
    });
    assert(max <= 12, `concurrency cap (${max})`);
    assert(max >= 2, "uses a pool not serial-1");
  }

  const caddyIds: number[] = [];
  const userIds: number[] = [];
  let adminUserId = 0;
  let caddyUserId = 0;

  try {
    const regular = await prisma.caddy.create({
      data: { name: `${tag}_정규`, team: "1조", employmentStatus: "ACTIVE" },
    });
    const dual = await prisma.caddy.create({
      data: { name: `${tag}_2회`, team: "1조", employmentStatus: "ACTIVE" },
    });
    const spareOnly = await prisma.caddy.create({
      data: { name: `${tag}_예비`, team: "2조", employmentStatus: "ACTIVE" },
    });
    const noUserC = await prisma.caddy.create({
      data: { name: `${tag}_무계정`, team: "2조", employmentStatus: "ACTIVE" },
    });
    const retiredC = await prisma.caddy.create({
      data: { name: `${tag}_퇴사`, team: "3조", employmentStatus: "RETIRED" },
    });
    const supportC = await prisma.caddy.create({
      data: { name: `${tag}_지원`, team: "4조", employmentStatus: "ACTIVE" },
    });
    caddyIds.push(
      regular.id,
      dual.id,
      spareOnly.id,
      noUserC.id,
      retiredC.id,
      supportC.id
    );

    const uAdmin = await prisma.user.create({
      data: {
        username: `${tag}_admin`,
        password: hash,
        role: "admin",
        sessionVersion: 0,
      },
    });
    const uCaddy = await prisma.user.create({
      data: {
        username: `${tag}_caddy`,
        password: hash,
        role: "caddy",
        caddyId: regular.id,
        sessionVersion: 0,
      },
    });
    const uDual = await prisma.user.create({
      data: {
        username: `${tag}_dual`,
        password: hash,
        role: "caddy",
        caddyId: dual.id,
        sessionVersion: 0,
      },
    });
    const uRetired = await prisma.user.create({
      data: {
        username: `${tag}_retired`,
        password: hash,
        role: "caddy",
        caddyId: retiredC.id,
        sessionVersion: 0,
      },
    });
    const uSupport = await prisma.user.create({
      data: {
        username: `${tag}_support`,
        password: hash,
        role: "caddy",
        caddyId: supportC.id,
        sessionVersion: 0,
      },
    });
    userIds.push(uAdmin.id, uCaddy.id, uDual.id, uRetired.id, uSupport.id);
    adminUserId = uAdmin.id;
    caddyUserId = uCaddy.id;

    const adminCookie = await cookieFor({ ...uAdmin, role: "admin" });
    const caddyCookie = await cookieFor({ ...uCaddy, role: "caddy" });

    section("1-2 auth");
    {
      const unauthGet = await getPreview(undefined, DATE);
      assert(unauthGet.status === 401, "unauth GET 401");
      const unauthGetBody = await unauthGet.json();
      assert(!jsonHasSecrets(unauthGetBody), "unauth GET no secrets");
      const unauthPost = await postSend(undefined, {
        date: DATE,
        confirm: BOARD_PUSH_CONFIRM,
      });
      assert(unauthPost.status === 401, "unauth POST 401");
      const nonAdminGet = await getPreview(caddyCookie, DATE);
      assert(nonAdminGet.status === 403, "caddy GET 403");
      const nonAdminPost = await postSend(caddyCookie, {
        date: DATE,
        confirm: BOARD_PUSH_CONFIRM,
      });
      assert(nonAdminPost.status === 403, "caddy POST 403");
    }

    section("3 no published");
    {
      await prisma.dailyBoardPublished.deleteMany({ where: { date: dateKey } });
      await upsertDraft(DATE, 1);
      const prev = await previewBoardPush(prisma, DATE);
      assert(prev.published === false, "preview published false");
      assert(prev.canSend === false, "no published canSend false");
      assert(prev.freshness.status === "NO_PUBLISHED", "NO_PUBLISHED");
      const http = await getPreview(adminCookie, DATE);
      const body = await http.json();
      assert(http.status === 200 && body.canSend === false, "GET no published 200 canSend false");
      assert(!jsonHasSecrets(body), "preview no secrets");
      const sendHttp = await postSend(adminCookie, {
        date: DATE,
        confirm: BOARD_PUSH_CONFIRM,
      });
      assert(sendHttp.status === 404 || sendHttp.status === 409, "send no published 404/409");
      const sendBody = await sendHttp.json();
      assert(sendBody.error === "NO_PUBLISHED", "NO_PUBLISHED code");
      assert(!jsonHasSecrets(sendBody), "send error no secrets");
    }

    const basePlacements = [
      placement({ caddyId: regular.id, caddyName: "정규", kind: "regular" }),
      placement({
        caddyId: dual.id,
        caddyName: "2회",
        kind: "regular",
        shift: "1부",
      }),
      placement({
        caddyId: dual.id,
        caddyName: "2회",
        kind: "oneTwo",
        shift: "2부",
        teeTime: "11:12",
      }),
      placement({
        caddyId: dual.id,
        caddyName: "2회",
        kind: "twoThree",
        shift: "3부",
        teeTime: "14:00",
      }),
      placement({ caddyId: noUserC.id, caddyName: "무계정" }),
      placement({ caddyId: retiredC.id, caddyName: "퇴사" }),
      placement({
        caddyId: supportC.id,
        caddyName: "지원",
        kind: "specialSupport",
        specialSupport: true,
      }),
      placement({ caddyId: null, caddyName: "미배정" }),
    ];
    const spares = [
      {
        shift: "1부",
        spare1: {
          caddyId: spareOnly.id,
          name: "예비",
          team: "2조",
          displayLabel: "예비",
        },
        spare2: null,
      },
    ];

    section("4 CURRENT canSend true");
    {
      const payload = publishedPayload(DATE, basePlacements, spares);
      await upsertPublished(DATE, 39, payload);
      await upsertDraft(DATE, 39);
      const prev = await previewBoardPush(prisma, DATE);
      assert(prev.freshness.status === "CURRENT", "CURRENT");
      assert(prev.canSend === true, "CURRENT canSend");
      assert(prev.sourceDraftVersion === 39, "source v39");
      assert(prev.currentDraftVersion === 39, "draft v39");
    }

    section("5 STALE canSend false");
    {
      await upsertDraft(DATE, 40);
      const prev = await previewBoardPush(prisma, DATE);
      assert(prev.freshness.status === "STALE", "STALE");
      assert(prev.canSend === false, "STALE canSend false");
      const http = await getPreview(adminCookie, DATE);
      const body = await http.json();
      assert(body.canSend === false, "GET STALE canSend false");
      await upsertDraft(DATE, 39);
    }

    section("6-13 recipients");
    {
      await addSub(uCaddy.id, `https://push.example/${tag}/caddy-a`);
      await addSub(uCaddy.id, `https://push.example/${tag}/caddy-b`);
      await addSub(uDual.id, `https://push.example/${tag}/dual`);
      await addSub(uRetired.id, `https://push.example/${tag}/retired`);
      await addSub(uSupport.id, `https://push.example/${tag}/support`);
      await addSub(uCaddy.id, `https://push.example/${tag}/disabled`, false);

      const prev = await previewBoardPush(prisma, DATE);
      assert(prev.counts.assignedCaddies === 5, `assigned 5 got ${prev.counts.assignedCaddies}`);
      assert(prev.counts.noUser === 1, `noUser 1 got ${prev.counts.noUser}`);
      assert(prev.counts.linkedUsers === 3, `linked 3 (exclude retired) got ${prev.counts.linkedUsers}`);
      assert(prev.counts.subscribedUsers === 3, `subscribed 3 got ${prev.counts.subscribedUsers}`);
      assert(prev.counts.subscriptions === 4, `enabled devices 4 got ${prev.counts.subscriptions}`);
      assert(prev.counts.noSubscription === 0, "linked all have enabled sub");
      const ids = uniqueAssignedCaddyIdsFromPublished(
        publishedPayload(DATE, basePlacements, spares)
      );
      assert(!ids.includes(spareOnly.id), "spare-only excluded");
      assert(ids.filter((id) => id === dual.id).length === 1, "multi placement → 1 id");
    }

    section("14 confirm mismatch / bulk ids");
    {
      const bad = await postSend(adminCookie, { date: DATE, confirm: "SEND" });
      assert(bad.status === 400, "confirm mismatch 400");
      const badBody = await bad.json();
      assert(badBody.error === "invalid_confirm", "invalid_confirm");
      assert((await boardPushAudits(DATE)).length === 0, "confirm mismatch: no Audit claim");
      try {
        parseBoardPushSendRequest({
          date: DATE,
          confirm: BOARD_PUSH_CONFIRM,
          userIds: [1, 2],
        });
        assert(false, "userIds rejected");
      } catch (e) {
        assert(
          e instanceof Error && (e as { code?: string }).code === "invalid_target",
          "bulk userIds invalid_target"
        );
      }
    }

    section("15 send freshness recheck");
    {
      await upsertDraft(DATE, 41);
      const sendHttp = await postSend(adminCookie, {
        date: DATE,
        confirm: BOARD_PUSH_CONFIRM,
      });
      assert(sendHttp.status === 409, "STALE send 409");
      const body = await sendHttp.json();
      assert(body.error === "STALE", "STALE code");
      assert(body.message === BOARD_PUSH_STALE_MESSAGE, "STALE message");
      assert(!jsonHasSecrets(body), "STALE response no secrets");
      assert((await boardPushAudits(DATE)).length === 0, "STALE: no Audit claim");
      await upsertDraft(DATE, 39);
    }

    section("6 no subscription / 16-18 send mock");
    {
      const DATE2 = "2099-06-19";
      const key2 = parseYmd(DATE2).start;
      const lonely = await prisma.caddy.create({
        data: { name: `${tag}_무구독`, team: "1조", employmentStatus: "ACTIVE" },
      });
      caddyIds.push(lonely.id);
      const uLonely = await prisma.user.create({
        data: {
          username: `${tag}_lonely`,
          password: hash,
          role: "caddy",
          caddyId: lonely.id,
          sessionVersion: 0,
        },
      });
      userIds.push(uLonely.id);
      await upsertPublished(
        DATE2,
        1,
        publishedPayload(DATE2, [placement({ caddyId: lonely.id, caddyName: "무구독" })])
      );
      await upsertDraft(DATE2, 1);
      const none = await sendBoardPush(
        prisma,
        { date: DATE2, confirm: BOARD_PUSH_CONFIRM },
        { sendFn: async () => {
            throw new Error("should-not-send");
          } }
      );
      assert(none.error === "no_recipients", "0 sub → no_recipients");
      assert(none.sent === 0, "no_recipients sent 0");
      assert(
        (await boardPushAudits(DATE2)).length === 0,
        "no_recipients: no Audit claim (retry allowed if someone later subscribes)"
      );

      const calls: string[] = [];
      const result = await sendBoardPush(
        prisma,
        { date: DATE, confirm: BOARD_PUSH_CONFIRM },
        {
          sendFn: async (sub, json) => {
            calls.push(json);
            const parsed = JSON.parse(json) as { url?: string; title?: string; body?: string };
            if (sub.endpoint.includes("dual")) {
              const err = new Error("gone") as Error & { statusCode: number };
              err.statusCode = 410;
              throw err;
            }
            if (sub.endpoint.includes("support")) {
              throw new Error("network");
            }
          },
        }
      );
      assert(result.ok === true, "send ok");
      assert(result.recipients === 3, `recipients 3 got ${result.recipients}`);
      assert(result.subscriptions === 4, `subs 4 got ${result.subscriptions}`);
      assert(result.sent === 2, `sent 2 (regular 2 devices) got ${result.sent}`);
      assert(result.failed === 1, `failed 1 support got ${result.failed}`);
      assert(result.removedStale === 1, `gone 1 dual got ${result.removedStale}`);
      assert(calls.length === 4, "4 deliver attempts (enabled only)");
      assert(
        calls.every((j) => {
          const p = JSON.parse(j) as { url: string; title: string; body: string };
          return (
            p.title === BOARD_PUSH_TITLE &&
            p.url === `/board?date=${DATE}` &&
            p.body.includes("6월 18일") &&
            !p.body.includes("07:00")
          );
        }),
        "payload title/body/url"
      );
      const gone = await prisma.pushSubscription.findFirst({
        where: { endpoint: `https://push.example/${tag}/dual` },
      });
      assert(!gone, "410 deleted");
      const okSub = await prisma.pushSubscription.findFirst({
        where: { endpoint: `https://push.example/${tag}/caddy-a` },
      });
      assert(okSub?.lastSuccessAt != null, "success lastSuccessAt");
      const failSub = await prisma.pushSubscription.findFirst({
        where: { endpoint: `https://push.example/${tag}/support` },
      });
      assert(failSub?.lastFailureAt != null, "fail lastFailureAt");

      const afterFirst = await boardPushAudits(DATE);
      assert(afterFirst.length === 1, "one Audit row after first send");
      const firstPayload = afterFirst[0]?.payload as Record<string, unknown>;
      assert(firstPayload?.status === "SENT", "claim finished SENT");
      assert(firstPayload?.sourceDraftVersion === 39, "audit version 39");
      assert(!jsonHasSecrets(firstPayload), "Audit payload no secrets");

      let dupCalls = 0;
      try {
        await sendBoardPush(
          prisma,
          { date: DATE, confirm: BOARD_PUSH_CONFIRM },
          { sendFn: async () => {
              dupCalls += 1;
            } }
        );
        assert(false, "duplicate should throw");
      } catch (e) {
        assert(
          e instanceof Error && (e as { code?: string }).code === "already_sent",
          "same version second send already_sent"
        );
      }
      assert(dupCalls === 0, "sequential duplicate: sender 0");
      assert((await boardPushAudits(DATE)).length === 1, "duplicate does not insert second claim");

      await prisma.dailyBoardPublished.deleteMany({ where: { date: key2 } });
      await prisma.dailyBoardDraft.deleteMany({ where: { date: key2 } });
    }

    section("concurrent duplicate + republish newer version");
    {
      const DATE4 = "2099-06-22";
      const concC = await prisma.caddy.create({
        data: { name: `${tag}_동시`, team: "1조", employmentStatus: "ACTIVE" },
      });
      caddyIds.push(concC.id);
      const uConc = await prisma.user.create({
        data: {
          username: `${tag}_conc`,
          password: hash,
          role: "caddy",
          caddyId: concC.id,
          sessionVersion: 0,
        },
      });
      userIds.push(uConc.id);
      await addSub(uConc.id, `https://push.example/${tag}/conc`);
      await upsertPublished(
        DATE4,
        39,
        publishedPayload(DATE4, [placement({ caddyId: concC.id, caddyName: "동시" })])
      );
      await upsertDraft(DATE4, 39);

      let senderCalls = 0;
      const slowSend: Parameters<typeof sendBoardPush>[2] = {
        sendFn: async () => {
          senderCalls += 1;
          await new Promise((r) => setTimeout(r, 250));
        },
      };
      const settled = await Promise.allSettled([
        sendBoardPush(prisma, { date: DATE4, confirm: BOARD_PUSH_CONFIRM }, slowSend),
        sendBoardPush(prisma, { date: DATE4, confirm: BOARD_PUSH_CONFIRM }, slowSend),
      ]);
      const ok = settled.filter(
        (s) => s.status === "fulfilled" && s.value.ok === true && !s.value.error
      );
      const blocked = settled.filter(
        (s) =>
          s.status === "rejected" &&
          s.reason instanceof Error &&
          (s.reason as { code?: string }).code === "already_sent"
      );
      assert(ok.length === 1, `concurrent: 1 success got ${ok.length}`);
      assert(blocked.length === 1, `concurrent: 1 already_sent got ${blocked.length}`);
      assert(senderCalls === 1, `concurrent sender once got ${senderCalls}`);
      const auditsV39 = await boardPushAudits(DATE4);
      assert(auditsV39.length === 1, "concurrent: single Audit claim");
      assert(!jsonHasSecrets(auditsV39[0]?.payload), "concurrent Audit no secrets");

      await upsertPublished(
        DATE4,
        40,
        publishedPayload(DATE4, [placement({ caddyId: concC.id, caddyName: "동시" })])
      );
      await upsertDraft(DATE4, 40);
      const beforeV40 = senderCalls;
      const v40 = await sendBoardPush(
        prisma,
        { date: DATE4, confirm: BOARD_PUSH_CONFIRM },
        { sendFn: async () => {
            senderCalls += 1;
          } }
      );
      assert(v40.ok === true && v40.sent === 1, "republish v40 allowed");
      assert(senderCalls === beforeV40 + 1, "v40 called sender");
      const auditsAll = await boardPushAudits(DATE4);
      assert(auditsAll.length === 2, "v39 + v40 Audit rows");
      const versions = auditsAll.map(
        (r) => (r.payload as Record<string, unknown>)?.sourceDraftVersion
      );
      assert(versions.includes(39) && versions.includes(40), "audits for 39 and 40");

      let v40dup = 0;
      try {
        await sendBoardPush(
          prisma,
          { date: DATE4, confirm: BOARD_PUSH_CONFIRM },
          { sendFn: async () => {
              v40dup += 1;
            } }
        );
        assert(false, "v40 duplicate should throw");
      } catch (e) {
        assert(
          e instanceof Error && (e as { code?: string }).code === "already_sent",
          "v40 second send already_sent"
        );
      }
      assert(v40dup === 0, "v40 duplicate sender 0");
    }

    section("19 secrets + 20 url + UI");
    {
      const http = await getPreview(adminCookie, DATE);
      const body = await http.json();
      assert(!jsonHasSecrets(body), "preview still no secrets after send");
      assert(body.alreadySent === true, "alreadySent true");
      assert(typeof body.counts === "object", "counts object");
      assert(!Array.isArray(body.recipients), "no recipient name list");
    }

    section("PUBLISHED_ONLY");
    {
      const DATE3 = "2099-06-20";
      await upsertPublished(
        DATE3,
        7,
        publishedPayload(DATE3, [
          placement({ caddyId: regular.id, caddyName: "정규" }),
        ])
      );
      await upsertDraft(DATE3, null);
      const prev = await previewBoardPush(prisma, DATE3);
      assert(prev.freshness.status === "PUBLISHED_ONLY", "PUBLISHED_ONLY");
      assert(prev.canSend === true, "PUBLISHED_ONLY canSend");
      await prisma.dailyBoardPublished.deleteMany({
        where: { date: parseYmd(DATE3).start },
      });
    }
  } finally {
    await prisma.audit.deleteMany({
      where: {
        action: BOARD_PUSH_AUDIT_ACTION,
        entity: BOARD_PUSH_AUDIT_ENTITY,
        entityId: { in: [20990618, 20990619, 20990620, 20990622] },
      },
    });
    await prisma.pushSubscription.deleteMany({
      where: { userId: { in: userIds } },
    });
    await prisma.dailyBoardPublished.deleteMany({
      where: {
        date: {
          in: [
            parseYmd(DATE).start,
            parseYmd("2099-06-19").start,
            parseYmd("2099-06-20").start,
            parseYmd("2099-06-22").start,
          ],
        },
      },
    });
    await prisma.dailyBoardDraft.deleteMany({
      where: {
        date: {
          in: [
            parseYmd(DATE).start,
            parseYmd("2099-06-19").start,
            parseYmd("2099-06-20").start,
            parseYmd("2099-06-22").start,
          ],
        },
      },
    });
    if (userIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (caddyIds.length) {
      await prisma.caddy.deleteMany({ where: { id: { in: caddyIds } } });
    }
    process.env.SESSION_SECRET = prevSecret;
    if (prevPub == null) delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    else process.env.WEB_PUSH_VAPID_PUBLIC_KEY = prevPub;
    if (prevPriv == null) delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    else process.env.WEB_PUSH_VAPID_PRIVATE_KEY = prevPriv;
    if (prevSub == null) delete process.env.WEB_PUSH_SUBJECT;
    else process.env.WEB_PUSH_SUBJECT = prevSub;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
