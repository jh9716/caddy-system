/**
 * 알림톡 근무안내 미리보기 V1 (DB 없음, 실제 발송 없음)
 * 실행: npx tsx scripts/test-alimtalk-preview-unit.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  ALIMTALK_PREVIEW_EMPTY_MESSAGE,
  buildAlimtalkWorkNoticePreview,
  emptyAlimtalkWorkNoticePreview,
  formatWorkNoticeDateKo,
  formatWorkNoticeMessage,
  type AlimtalkCaddyContact,
} from "../src/lib/alimtalkWorkNoticePreview";
import { assignmentDraftToPayload } from "../src/lib/dailyBoardDraft";
import { buildPublishedPayloadFromDraft } from "../src/lib/dailyBoardPublished";
import type { AssignmentDraft } from "../src/lib/assignmentDraft";
import type { PublishedPlacementV1 } from "../src/lib/dailyBoardPublished";

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
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

function place(
  partial: Partial<PublishedPlacementV1> & {
    caddyId: number | null;
    shift: PublishedPlacementV1["shift"];
    course: string;
    teeTime: string;
  }
): PublishedPlacementV1 {
  return {
    shift: partial.shift,
    course: partial.course,
    teeTime: partial.teeTime,
    teamName: partial.teamName ?? null,
    reservationId: partial.reservationId ?? null,
    reservationKey: partial.reservationKey ?? `${partial.shift}|${partial.course}|${partial.teeTime}|${partial.caddyId}`,
    caddyId: partial.caddyId,
    caddyName: partial.caddyName ?? "김현정",
    caddyTeam: partial.caddyTeam ?? "7조",
    displayLabel: partial.displayLabel ?? "김현정",
    kind: partial.kind ?? "regular",
    locked: partial.locked ?? false,
    limousine: partial.limousine ?? false,
    driving: partial.driving ?? false,
    twoWork: partial.twoWork ?? false,
    chageun: partial.chageun ?? false,
    specialSupport: partial.specialSupport ?? false,
    sequenceIndex: partial.sequenceIndex ?? 0,
    ...("houseRequest" in partial ? { houseRequest: partial.houseRequest } : {}),
    ...("supportKind" in partial ? { supportKind: partial.supportKind } : {}),
    ...("supportWorkPattern" in partial
      ? { supportWorkPattern: partial.supportWorkPattern }
      : {}),
  };
}

function payload(placements: PublishedPlacementV1[], date = "2026-09-17") {
  return { date, placements };
}

const KIM_PHONE = "01012345678";
const kimContact: AlimtalkCaddyContact = {
  id: 12,
  name: "김현정1",
  team: "7조",
  caddyType: "HOUSE",
  phoneNormalized: KIM_PHONE,
};

section("A. 캐디 1명 / placement 1개 → 메시지 1건");
{
  const out = buildAlimtalkWorkNoticePreview({
    payload: payload([
      place({
        caddyId: 12,
        caddyName: "김현정1",
        shift: "1부",
        teeTime: "06:32",
        course: "OCEAN",
      }),
    ]),
    caddies: [kimContact],
    sourceDraftVersion: 3,
  });
  assert(out.published === true, "published");
  assert(out.recipients.length === 1, "recipient 1");
  assert(out.recipients[0]?.placements.length === 1, "placement 1줄");
  assert(out.recipients[0]?.messagePreview.includes("1부 06:32 오션"), "한 줄 메시지");
  assert(
    (out.recipients[0]?.messagePreview.match(/1부 /g) || []).length === 1,
    "메시지 1건"
  );
}

section("B. 같은 캐디 1부+2부 → 메시지 1건, placement 2줄");
{
  const out = buildAlimtalkWorkNoticePreview({
    payload: payload([
      place({
        caddyId: 12,
        shift: "2부",
        teeTime: "12:11",
        course: "LAKE",
      }),
      place({
        caddyId: 12,
        shift: "1부",
        teeTime: "06:32",
        course: "OCEAN",
      }),
    ]),
    caddies: [kimContact],
  });
  assert(out.recipients.length === 1, "묶여서 1명");
  assert(out.recipients[0]?.placements.length === 2, "2줄");
  const msg = out.recipients[0]?.messagePreview ?? "";
  assert(msg.includes("1부 06:32 오션"), "1부 줄");
  assert(msg.includes("2부 12:11 레이크"), "2부 줄");
  assert(msg.indexOf("1부") < msg.indexOf("2부"), "1부 먼저");
}

section("C. 1·2 / 2·3 / 1·3 / 54홀 → caddyId별 1건");
{
  const rows = [
    place({ caddyId: 1, kind: "oneTwo", shift: "1부", teeTime: "06:00", course: "OCEAN" }),
    place({ caddyId: 1, kind: "oneTwo", shift: "2부", teeTime: "12:00", course: "LAKE" }),
    place({ caddyId: 2, kind: "twoThree", shift: "2부", teeTime: "12:10", course: "SKY" }),
    place({ caddyId: 2, kind: "twoThree", shift: "3부", teeTime: "16:00", course: "VERTHILL" }),
    place({ caddyId: 3, kind: "oneThree", shift: "1부", teeTime: "06:20", course: "OCEAN" }),
    place({ caddyId: 3, kind: "oneThree", shift: "3부", teeTime: "16:10", course: "LAKE" }),
    place({
      caddyId: 4,
      kind: "fiftyFourHole",
      shift: "1부",
      teeTime: "06:30",
      course: "OCEAN",
    }),
    place({
      caddyId: 4,
      kind: "fiftyFourHole",
      shift: "2부",
      teeTime: "12:20",
      course: "LAKE",
    }),
    place({
      caddyId: 4,
      kind: "fiftyFourHole",
      shift: "3부",
      teeTime: "16:20",
      course: "SKY",
    }),
  ];
  const out = buildAlimtalkWorkNoticePreview({ payload: payload(rows) });
  assert(out.recipients.length === 4, "caddyId 4명");
  assert(out.recipients.find((r) => r.caddyId === 1)?.placements.length === 2, "1·2 2줄");
  assert(out.recipients.find((r) => r.caddyId === 2)?.placements.length === 2, "2·3 2줄");
  assert(out.recipients.find((r) => r.caddyId === 3)?.placements.length === 2, "1·3 2줄");
  assert(out.recipients.find((r) => r.caddyId === 4)?.placements.length === 3, "54홀 3줄");
}

section("D. specialSupport 포함");
{
  const out = buildAlimtalkWorkNoticePreview({
    payload: payload([
      place({
        caddyId: 27,
        caddyName: "손지연",
        kind: "specialSupport",
        specialSupport: true,
        shift: "1부",
        teeTime: "08:10",
        course: "SKY",
      }),
    ]),
  });
  assert(out.recipients.length === 1, "specialSupport recipient");
  assert(out.recipients[0]?.caddyId === 27, "caddy 27");
  assert(out.recipients[0]?.messagePreview.includes("1부 08:10 스카이"), "지원 줄 포함");
}

section("E. phone 있음 → sendable + maskedPhone만");
{
  const out = buildAlimtalkWorkNoticePreview({
    payload: payload([
      place({ caddyId: 12, shift: "1부", teeTime: "06:32", course: "OCEAN" }),
    ]),
    caddies: [kimContact],
  });
  assert(out.counts.sendable === 1, "sendable +1");
  assert(out.counts.contactReady === 1, "contactReady +1");
  assert(out.counts.missingPhone === 0, "missing 0");
  assert(out.recipients[0]?.hasPhone === true, "hasPhone");
  assert(out.recipients[0]?.maskedPhone === "010-****-5678", "masked");
  const json = JSON.stringify(out);
  assert(!json.includes("phoneNormalized"), "phoneNormalized key 없음");
  assert(!json.includes(KIM_PHONE), "raw 번호 없음");
  assert(!json.includes("telPhone"), "telPhone 없음");
}

section("F. phone 없음 → missingPhone +1");
{
  const out = buildAlimtalkWorkNoticePreview({
    payload: payload([
      place({ caddyId: 14, caddyName: "원다빈", shift: "1부", teeTime: "07:00", course: "OCEAN" }),
    ]),
    caddies: [{ id: 14, name: "원다빈", team: "1조", phoneNormalized: null }],
  });
  assert(out.counts.sendable === 0, "sendable 0");
  assert(out.counts.missingPhone === 1, "missing +1");
  assert(out.recipients[0]?.hasPhone === false, "hasPhone false");
  assert(out.recipients[0]?.maskedPhone === null, "masked null");
}

section("G. raw phone key/value가 response/message에 없음");
{
  const out = buildAlimtalkWorkNoticePreview({
    payload: payload([
      place({ caddyId: 12, shift: "1부", teeTime: "06:32", course: "OCEAN" }),
    ]),
    caddies: [kimContact],
  });
  const json = JSON.stringify(out);
  const msg = out.recipients[0]?.messagePreview ?? "";
  assert(!json.includes("phoneNormalized"), "response key");
  assert(!json.includes("01012345678"), "response value");
  assert(!msg.includes("010"), "message에 번호 없음");
  assert(!msg.includes("김현정"), "message에 이름 없음");
  assert(!msg.includes("7조"), "message에 조 없음");
}

section("H. Published 없음 empty state");
{
  const empty = emptyAlimtalkWorkNoticePreview("2026-09-07");
  assert(empty.published === false, "published false");
  assert(empty.recipients.length === 0, "recipients []");
  assert(empty.sourceDraftVersion === null, "no draft version");
  assert(empty.freshness.status === "NO_PUBLISHED", "empty freshness");
  assert(empty.freshness.canSend === false, "empty canSend false");
  assert(empty.counts.contactReady === 0, "contactReady 0");
  assert(
    ALIMTALK_PREVIEW_EMPTY_MESSAGE.includes("게시된 배치표가 없습니다"),
    "empty copy"
  );
}

section("I. 미배치/caddyId 없음 제외");
{
  const out = buildAlimtalkWorkNoticePreview({
    payload: payload([
      place({
        caddyId: null,
        caddyName: "",
        shift: "1부",
        teeTime: "06:00",
        course: "OCEAN",
      }),
      place({
        caddyId: 12,
        shift: "1부",
        teeTime: "06:32",
        course: "LAKE",
      }),
    ]),
  });
  assert(out.recipients.length === 1, "null caddy 제외");
  assert(out.recipients[0]?.caddyId === 12, "실제 배치만");
}

section("J. course 한글 변환");
{
  assert(formatWorkNoticeDateKo("2026-09-17") === "9월 17일", "날짜 9월 17일");
  assert(formatWorkNoticeDateKo("2026-09-07") === "9월 7일", "날짜 9월 7일");
  const out = buildAlimtalkWorkNoticePreview({
    payload: payload([
      place({ caddyId: 1, shift: "1부", teeTime: "06:00", course: "VERTHILL" }),
      place({ caddyId: 2, shift: "1부", teeTime: "06:01", course: "SKY" }),
      place({ caddyId: 3, shift: "1부", teeTime: "06:02", course: "OCEAN" }),
      place({ caddyId: 4, shift: "1부", teeTime: "06:03", course: "LAKE" }),
    ]),
  });
  const lines = out.recipients.map((r) => r.messagePreview);
  assert(lines[0]?.includes("베르힐"), "VERTHILL");
  assert(lines[1]?.includes("스카이"), "SKY");
  assert(lines[2]?.includes("오션"), "OCEAN");
  assert(lines[3]?.includes("레이크"), "LAKE");
}

section("K. shift/teeTime 정렬");
{
  const out = buildAlimtalkWorkNoticePreview({
    payload: payload([
      place({ caddyId: 12, shift: "3부", teeTime: "16:00", course: "LAKE" }),
      place({ caddyId: 12, shift: "1부", teeTime: "06:40", course: "OCEAN" }),
      place({ caddyId: 12, shift: "1부", teeTime: "06:32", course: "SKY" }),
      place({ caddyId: 12, shift: "2부", teeTime: "12:11", course: "VERTHILL" }),
    ]),
  });
  const shifts = out.recipients[0]?.placements.map((p) => `${p.shift} ${p.teeTime}`);
  assert(
    shifts?.join("|") === "1부 06:32|1부 06:40|2부 12:11|3부 16:00",
    "1부 teeTime 오름차순 후 2·3부"
  );
}

section("L. duplicate placement 제거");
{
  const dup = place({
    caddyId: 12,
    shift: "1부",
    teeTime: "06:32",
    course: "OCEAN",
    reservationKey: "a",
  });
  const dup2 = place({
    caddyId: 12,
    shift: "1부",
    teeTime: "06:32",
    course: "OCEAN",
    reservationKey: "b",
  });
  const out = buildAlimtalkWorkNoticePreview({ payload: payload([dup, dup2]) });
  assert(out.recipients.length === 1, "1명");
  assert(out.recipients[0]?.placements.length === 1, "중복 1줄");
}

section("메시지 템플릿");
{
  const msg = formatWorkNoticeMessage("2026-09-17", ["1부 06:32 오션", "2부 12:11 레이크"]);
  assert(msg.startsWith("[베르힐CC 근무안내]"), "제목");
  assert(msg.includes("9월 17일 근무 일정입니다."), "날짜 문장");
  assert(msg.trim().endsWith("근무일정을 확인해 주세요."), "맺음말");
}

section("9/7 fixture Published grouping");
{
  const raw = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "scripts/fixtures/board-export-2026-09-07.json"),
      "utf8"
    )
  ) as AssignmentDraft;
  const published = buildPublishedPayloadFromDraft(assignmentDraftToPayload(raw));
  const withCaddy = published.placements.filter(
    (row) => Number.isInteger(row.caddyId) && Number(row.caddyId) > 0
  );
  const uniqueIds = new Set(withCaddy.map((row) => row.caddyId));
  const out = buildAlimtalkWorkNoticePreview({
    payload: published,
    caddies: [],
    sourceDraftVersion: 1,
  });
  assert(published.date === "2026-09-07", "fixture date");
  assert(out.counts.recipients === uniqueIds.size, "unique caddy count");
  assert(out.counts.sendable === 0, "fixture 연락처 없이 sendable 0");
  assert(out.counts.missingPhone === uniqueIds.size, "전부 연락처 없음");
  const placementLines = out.recipients.reduce((n, r) => n + r.placements.length, 0);
  assert(placementLines <= withCaddy.length, "줄 수 ≤ caddy 있는 placement");
  assert(placementLines > 0, "placement 줄 있음");
  const oneTwo = out.recipients.find((r) => r.caddyId === 8);
  assert(Boolean(oneTwo), "1·2 임형규 포함");
  assert((oneTwo?.placements.length ?? 0) >= 2, "1·2 묶여 2줄 이상");
  const support = out.recipients.find((r) => r.caddyId === 27);
  assert(Boolean(support), "specialSupport 손지연 포함");
  const json = JSON.stringify(out);
  assert(!json.includes("phoneNormalized"), "9/7 response raw phone key 없음");
  console.log(
    "  · 9/7 recipients",
    out.counts.recipients,
    "placementLines",
    placementLines,
    "published placements",
    published.placements.length
  );
}

section("source / 안전장치");
{
  const previewLib = readSrc("src/lib/alimtalkWorkNoticePreview.ts");
  const api = readSrc("src/app/api/notifications/alimtalk/preview/route.ts");
  const page = readSrc("src/app/manage/alimtalk/page.tsx");
  const shell = readSrc("src/components/manage/ManageShell.tsx");
  const schema = readSrc("prisma/schema.prisma");
  const pkg = readSrc("package.json");
  const published = readSrc("src/lib/dailyBoardPublished.ts");
  const board = readSrc("src/app/board/page.tsx");
  const publishedView = readSrc("src/components/board/PublishedBoardView.tsx");

  assert(/getDailyBoardPublished/.test(api), "API Published source");
  assert(!/getDailyBoardDraft\(/.test(api), "Draft payload fallback 없음");
  assert(/getDailyBoardDraftVersion/.test(api), "freshness draft version");
  assert(/resolvePublishedFreshness/.test(api), "freshness helper");
  assert(/requireAdmin/.test(api), "requireAdmin");
  assert(api.indexOf("requireAdmin") < api.indexOf("getDailyBoardPublished"), "admin first");
  assert(/export async function GET/.test(api), "GET only");
  assert(!/export async function POST/.test(api), "POST 없음");
  assert(!/solapi|aligo|nhn-toast|axios\.post|fetch\([^)]*kakao/i.test(api), "provider 호출 없음");
  assert(!/solapi|aligo|nhn-toast/i.test(pkg), "provider dependency 없음");
  assert(!/model NotificationSend/.test(schema) && !/model AlimTalk/.test(schema), "send 테이블 없음");
  assert(/미리보기 전용/.test(page), "미리보기 전용 문구");
  assert(!/실제 발송/.test(page) || /발송되지 않습니다/.test(page), "발송 버튼 없음");
  assert(!/<button[^>]*>\s*발송/.test(page), "발송 submit 없음");
  assert(/href: "\/manage\/alimtalk"/.test(shell), "nav 알림톡");
  assert(!/phoneNormalized/.test(page), "UI source raw phone 키 없음");
  assert(!/phoneNormalized/.test(publishedView), "published view 전화 없음");
  assert(!/phoneNormalized/.test(board), "/board 전화 없음");
  assert(!/phoneNormalized/.test(published.split("PublishedPlacementV1")[1]?.slice(0, 800) || "x"), "placement 타입에 phone 없음");
  assert(/sparesByShift/.test(previewLib) === false, "spare를 수신자에 넣지 않음");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
