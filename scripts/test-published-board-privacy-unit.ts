/**
 * Published 배치표 고객명 redaction (엔진/DB write 없음)
 * 실행: npm run test:published-board-privacy-unit
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as { React?: typeof React }).React = React;
import { NextRequest } from "next/server";
import PublishedBoardView from "../src/components/board/PublishedBoardView";
import { canReadPublishedBoard, requirePublishedReader } from "../src/lib/auth";
import type { DailyBoardPublishedPayloadV1 } from "../src/lib/dailyBoardPublished";
import {
  publishedPayloadForReader,
  shouldRedactPublishedGuestNames,
} from "../src/lib/publishedBoardPrivacy";
import { COURSE_CODES } from "../src/lib/reservationParser";
import { normalizeAppRole } from "../src/lib/sessionCookies";

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

function readSrc(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

function samplePayload(): DailyBoardPublishedPayloadV1 {
  return {
    schemaVersion: 1,
    date: "2026-09-16",
    openCourses: [...COURSE_CODES],
    publisherUsername: "admin",
    placements: [
      {
        shift: "1부",
        course: "VERTHILL",
        teeTime: "06:00",
        teamName: "고객홍길동",
        reservationId: "r1",
        reservationKey: "r1",
        caddyId: 11,
        caddyName: "김캐디",
        caddyTeam: "2조",
        displayLabel: "2조 김캐디",
        kind: "regular",
        locked: true,
        limousine: false,
        driving: false,
        twoWork: false,
        chageun: true,
        specialSupport: false,
        sequenceIndex: 0,
      },
    ],
    sparesByShift: [
      {
        shift: "1부",
        spare1: { caddyId: 91, name: "대기갑", team: "3조", displayLabel: "3조 대기갑" },
        spare2: null,
      },
    ],
  };
}

section("권한별 redaction");
{
  const src = samplePayload();
  const admin = publishedPayloadForReader(src, "admin");
  const leader = publishedPayloadForReader(src, "leader");
  const caddy = publishedPayloadForReader(src, "caddy");
  const anon = publishedPayloadForReader(src, null);

  assert(shouldRedactPublishedGuestNames("admin") === false, "admin 미적용");
  assert(shouldRedactPublishedGuestNames("leader") === false, "leader 미적용");
  assert(shouldRedactPublishedGuestNames("caddy") === true, "caddy 적용");
  assert(shouldRedactPublishedGuestNames(null) === true, "미확인 role 적용");
  assert(
    normalizeAppRole("staff") === "caddy" &&
      shouldRedactPublishedGuestNames(normalizeAppRole("staff")) === true,
    "기존 staff alias는 caddy와 동일"
  );

  assert(admin.placements[0].teamName === "고객홍길동", "admin teamName 유지");
  assert(leader.placements[0].teamName === "고객홍길동", "leader teamName 유지");
  assert(admin.placements[0].reservationId === "r1", "admin reservationId 유지");
  assert(leader.placements[0].reservationId === "r1", "leader reservationId 유지");
  assert(admin.placements[0].reservationKey === "r1", "admin reservationKey 유지");
  assert(leader.placements[0].reservationKey === "r1", "leader reservationKey 유지");
  assert(admin === src, "admin은 원본 payload 참조");
  assert(caddy.placements[0].teamName === null, "caddy teamName 제거");
  assert(anon.placements[0].teamName === null, "anonymous helper도 teamName 제거");
  assert(!("reservationId" in caddy.placements[0]), "caddy reservationId omit");
  assert(!("reservationKey" in caddy.placements[0]), "caddy reservationKey omit");
  assert(!("reservationId" in anon.placements[0]), "미확인 role reservationId omit");
  assert(!("reservationKey" in anon.placements[0]), "미확인 role reservationKey omit");
  {
    const staff = publishedPayloadForReader(src, normalizeAppRole("staff"));
    assert(staff.placements[0].teamName === null, "staff teamName 제거");
    assert(!("reservationId" in staff.placements[0]), "staff reservationId omit");
    assert(!("reservationKey" in staff.placements[0]), "staff reservationKey omit");
  }
  assert(src.placements[0].teamName === "고객홍길동", "원본 payload teamName 미변경");
  assert(src.placements[0].reservationId === "r1", "원본 payload reservationId 미변경");
  assert(src.placements[0].reservationKey === "r1", "원본 payload reservationKey 미변경");
  assert(
    !JSON.stringify(caddy).includes("고객홍길동"),
    "caddy JSON에 고객 문자열 없음"
  );
  assert(
    !JSON.stringify(caddy).includes('"reservationId"'),
    "caddy JSON에 reservationId 키 없음"
  );
  assert(
    !JSON.stringify(caddy).includes('"reservationKey"'),
    "caddy JSON에 reservationKey 키 없음"
  );
  assert(
    JSON.stringify(admin).includes("고객홍길동"),
    "admin JSON에 고객명 유지"
  );
  assert(
    JSON.stringify(admin).includes('"reservationId"') &&
      JSON.stringify(admin).includes('"reservationKey"'),
    "admin JSON에 reservation 키 유지"
  );
}

section("캐디 응답 유지 필드 / 제거 필드");
{
  const caddy = publishedPayloadForReader(samplePayload(), "caddy");
  const row = caddy.placements[0];
  assert(row.caddyName === "김캐디", "캐디명 유지");
  assert(row.caddyTeam === "2조", "조 유지");
  assert(row.teeTime === "06:00", "티타임 유지");
  assert(row.course === "VERTHILL", "코스 유지");
  assert(row.caddyId === 11, "캐디 ID 유지");
  assert(row.locked === true && row.chageun === true, "LOCK/찾근 유지");
  assert(!("reservationId" in row), "reservationId 키 자체 omit");
  assert(!("reservationKey" in row), "reservationKey 키 자체 omit");
  assert(caddy.sparesByShift[0].spare1?.name === "대기갑", "스페어 유지");
  assert(!("customerName" in row) && !("reservationName" in row), "추측 필드 없음");
  assert(row.teamName === null, "teamName은 null로 복사");
}

section("레거시 reservationKey composite에 teamName 포함");
{
  const src = samplePayload();
  src.placements[0].reservationKey = "2026-09-16|VERTHILL|1부|06:00|0|고객홍길동|sheet";
  const admin = publishedPayloadForReader(src, "admin");
  const caddy = publishedPayloadForReader(src, "caddy");
  assert(
    admin.placements[0].reservationKey === src.placements[0].reservationKey,
    "admin은 레거시 reservationKey 유지"
  );
  assert(!("reservationKey" in caddy.placements[0]), "caddy는 레거시 reservationKey omit");
  assert(
    !JSON.stringify(caddy).includes("고객홍길동"),
    "caddy JSON에 레거시 key의 teamName 없음"
  );
  assert(
    src.placements[0].reservationKey.includes("고객홍길동"),
    "원본 레거시 reservationKey 미변경"
  );
}

section("teamName이 이미 null이어도 reservation 필드 omit");
{
  const src = samplePayload();
  src.placements[0].teamName = null;
  src.placements[0].reservationKey = "2026-09-16|VERTHILL|1부|06:00|0|고객홍길동|sheet";
  const caddy = publishedPayloadForReader(src, "caddy");
  assert(caddy.placements[0].teamName === null, "teamName null 유지");
  assert(!("reservationId" in caddy.placements[0]), "teamName null이어도 reservationId omit");
  assert(!("reservationKey" in caddy.placements[0]), "teamName null이어도 reservationKey omit");
  assert(
    !JSON.stringify(caddy).includes("고객홍길동"),
    "teamName null이어도 레거시 key의 teamName 미노출"
  );
  assert(src.placements[0].reservationKey.includes("고객홍길동"), "원본 reservationKey 미변경");
}

section("/board redacted payload 렌더 + 관리자 regression");
{
  const adminHtml = renderToStaticMarkup(
    createElement(PublishedBoardView, {
      payload: publishedPayloadForReader(samplePayload(), "admin"),
      shift: "1부",
    })
  );
  const caddyHtml = renderToStaticMarkup(
    createElement(PublishedBoardView, {
      payload: publishedPayloadForReader(samplePayload(), "caddy"),
      shift: "1부",
    })
  );
  assert(adminHtml.includes("고객홍길동"), "관리자 /board에 고객명");
  assert(adminHtml.includes("김캐디") && adminHtml.includes("2조"), "관리자 캐디/조");
  assert(!caddyHtml.includes("고객홍길동"), "캐디 /board에 고객명 없음");
  assert(caddyHtml.includes("김캐디") && caddyHtml.includes("2조"), "캐디 캐디명/조");
  assert(caddyHtml.includes("06:00") && caddyHtml.includes("대기갑"), "캐디 티타임/스페어");
}

section("GET serialization / DB write 없음");
{
  const route = readSrc("src/app/api/assignments/published/route.ts");
  const helper = readSrc("src/lib/publishedBoardPrivacy.ts");
  const getFn = route.split("export async function GET")[1]?.split("export async function POST")[0] || "";
  const postFn = route.split("export async function POST")[1] || "";
  const service = readSrc("src/lib/dailyBoardPublishedService.ts");
  const view = readSrc("src/components/board/PublishedBoardView.tsx");
  const boardPage = readSrc("src/app/board/page.tsx");
  const engine = readSrc("src/lib/autoAssignEngine.ts");
  const persist = readSrc("src/lib/quickBoardMutationApply.ts");

  assert(/publishedPayloadForReader/.test(getFn), "GET이 role 기반 serialization");
  assert(/resolveAuthUser/.test(getFn), "GET이 role을 읽음");
  assert(!/publishedPayloadForReader/.test(postFn), "POST admin 응답은 원본 payload");
  assert(!/prisma\.(create|update|upsert|delete)/.test(getFn), "GET에 prisma write 없음");
  assert(!/publishDailyBoard/.test(getFn), "GET이 publish 하지 않음");
  assert(/getDailyBoardPublished/.test(getFn), "GET은 기존 read helper");
  assert(!/teamName: null/.test(service.split("export async function getDailyBoardPublished")[1]?.split("export async function publish")[0] || ""), "DB read helper는 redaction 없음");
  assert(!/publishedBoardPrivacy/.test(service), "service에 privacy helper 없음");
  assert(!/prisma/.test(helper) && !/publishDailyBoard/.test(helper), "helper는 DB write 없음");
  assert(!/autoAssignEngine/.test(helper), "helper가 engine을 쓰지 않음");
  assert(!/publishedBoardPrivacy/.test(engine), "autoAssignEngine 미변경");
  assert(!/publishedBoardPrivacy/.test(persist), "persist 미변경");
  assert(/row\.teamName/.test(view), "관리자 화면은 payload.teamName 렌더");
  assert(/\/api\/assignments\/published/.test(boardPage), "/board는 기존 published GET");
}

void (async () => {
  section("anonymous는 기존처럼 401 / payload 없음");
  {
    assert(canReadPublishedBoard(null) === false, "anonymous canRead=false");
    const unauth = await requirePublishedReader(
      new NextRequest("http://localhost/api/assignments/published?date=2026-09-16")
    );
    assert(unauth instanceof Response && unauth.status === 401, "GET anonymous 401");
    if (unauth instanceof Response) {
      const body = (await unauth.json()) as { published?: unknown; error?: string };
      assert(body.published === undefined, "401 응답에 published payload 없음");
    }
  }

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
