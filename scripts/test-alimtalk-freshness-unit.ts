/**
 * 알림톡 Published freshness / stale guard V1
 * 실행: npm run test:alimtalk-freshness-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  ALIMTALK_ASSIGNMENTS_HREF,
  ALIMTALK_BADGE_STALE,
  ALIMTALK_CANNOT_SEND_LABEL,
  ALIMTALK_CONTACT_READY_LABEL,
  ALIMTALK_GO_ASSIGNMENTS_LABEL,
  ALIMTALK_NOT_SENDABLE,
  ALIMTALK_SENDABLE_COUNT_LABEL,
  AlimtalkNotSendableError,
  alimtalkBlockedCountLabel,
  alimtalkReadyCountLabel,
  assertAlimtalkCanSend,
  resolvePublishedFreshness,
} from "../src/lib/alimtalkPublishedFreshness";
import {
  buildAlimtalkWorkNoticePreview,
  emptyAlimtalkWorkNoticePreview,
} from "../src/lib/alimtalkWorkNoticePreview";
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
    teamName: null,
    reservationId: null,
    reservationKey: `${partial.shift}|${partial.course}|${partial.teeTime}|${partial.caddyId}`,
    caddyId: partial.caddyId,
    caddyName: partial.caddyName ?? `캐디${partial.caddyId}`,
    caddyTeam: partial.caddyTeam ?? "1조",
    displayLabel: String(partial.caddyName ?? `캐디${partial.caddyId}`),
    kind: "regular",
    locked: false,
    limousine: false,
    driving: false,
    twoWork: partial.twoWork ?? false,
    chageun: false,
    specialSupport: false,
    sequenceIndex: partial.sequenceIndex ?? 0,
  };
}

/** 9/7 production-like: 209 placements, 168 unique (127×1 + 41×2). */
function productionLike0907Placements(): PublishedPlacementV1[] {
  const rows: PublishedPlacementV1[] = [];
  for (let id = 1; id <= 127; id++) {
    rows.push(
      place({
        caddyId: id,
        shift: "1부",
        teeTime: "06:00",
        course: "OCEAN",
        caddyName: id === 167 ? "신정훈" : `캐디${id}`,
      })
    );
  }
  for (let i = 0; i < 41; i++) {
    const id = 128 + i;
    rows.push(
      place({
        caddyId: id,
        shift: "1부",
        teeTime: "06:10",
        course: "SKY",
        caddyName: id === 167 ? "신정훈" : `캐디${id}`,
      })
    );
    rows.push(
      place({
        caddyId: id,
        shift: "2부",
        teeTime: "12:10",
        course: "LAKE",
        twoWork: true,
        caddyName: id === 167 ? "신정훈" : `캐디${id}`,
      })
    );
  }
  return rows;
}

section("v5 vs v39 → STALE / canSend false");
{
  const out = resolvePublishedFreshness({
    hasPublished: true,
    publishedSourceDraftVersion: 5,
    currentDraftVersion: 39,
  });
  assert(out.status === "STALE", "STALE");
  assert(out.canSend === false, "canSend false");
  assert(out.publishedVersion === 5, "published v5");
  assert(out.currentDraftVersion === 39, "draft v39");
}

section("v39 vs v39 → CURRENT / canSend true");
{
  const meta = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "scripts/fixtures/alimtalk-freshness-current.json"),
      "utf8"
    )
  ) as {
    publishedSourceDraftVersion: number;
    currentDraftVersion: number;
    expectedStatus: string;
    canSend: boolean;
  };
  const out = resolvePublishedFreshness({
    hasPublished: true,
    publishedSourceDraftVersion: meta.publishedSourceDraftVersion,
    currentDraftVersion: meta.currentDraftVersion,
  });
  assert(out.status === meta.expectedStatus, "CURRENT");
  assert(out.canSend === meta.canSend, "canSend true");
}

section("no Published → NO_PUBLISHED / false");
{
  const out = resolvePublishedFreshness({
    hasPublished: false,
    publishedSourceDraftVersion: null,
    currentDraftVersion: 39,
  });
  assert(out.status === "NO_PUBLISHED", "NO_PUBLISHED");
  assert(out.canSend === false, "canSend false");
  assert(out.publishedVersion === null, "publishedVersion null");
  assert(out.currentDraftVersion === 39, "draft version 유지");
}

section("null sourceDraftVersion → UNKNOWN / false");
{
  const out = resolvePublishedFreshness({
    hasPublished: true,
    publishedSourceDraftVersion: null,
    currentDraftVersion: 39,
  });
  assert(out.status === "UNKNOWN", "UNKNOWN");
  assert(out.canSend === false, "canSend false");
}

section("invalid sourceDraftVersion 0 / NaN → UNKNOWN");
{
  const zero = resolvePublishedFreshness({
    hasPublished: true,
    publishedSourceDraftVersion: 0,
    currentDraftVersion: 3,
  });
  assert(zero.status === "UNKNOWN", "0 → UNKNOWN");
  const nan = resolvePublishedFreshness({
    hasPublished: true,
    publishedSourceDraftVersion: Number.NaN,
    currentDraftVersion: 3,
  });
  assert(nan.status === "UNKNOWN", "NaN → UNKNOWN");
}

section("Published + no Draft → PUBLISHED_ONLY / canSend true");
{
  const out = resolvePublishedFreshness({
    hasPublished: true,
    publishedSourceDraftVersion: 5,
    currentDraftVersion: null,
  });
  assert(out.status === "PUBLISHED_ONLY", "PUBLISHED_ONLY");
  assert(out.canSend === true, "확정본만 있으면 발송 허용");
  assert(out.publishedVersion === 5, "published v5");
  assert(out.currentDraftVersion === null, "draft null");
}

section("published > draft (reset 후 재생성) → STALE");
{
  const out = resolvePublishedFreshness({
    hasPublished: true,
    publishedSourceDraftVersion: 5,
    currentDraftVersion: 1,
  });
  assert(out.status === "STALE", "version 불일치 STALE");
  assert(out.canSend === false, "canSend false");
}

section("9/7 production-like stale preview keeps 168");
{
  const meta = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "scripts/fixtures/alimtalk-freshness-2026-09-07.json"),
      "utf8"
    )
  ) as {
    publishedSourceDraftVersion: number;
    currentDraftVersion: number;
    placements: number;
    recipients: number;
    contactReady: number;
    missingPhone: number;
    expectedStatus: string;
    canSend: boolean;
  };
  const placements = productionLike0907Placements();
  assert(placements.length === meta.placements, "209 placements");
  const freshness = resolvePublishedFreshness({
    hasPublished: true,
    publishedSourceDraftVersion: meta.publishedSourceDraftVersion,
    currentDraftVersion: meta.currentDraftVersion,
  });
  const out = buildAlimtalkWorkNoticePreview({
    payload: { date: "2026-09-07", placements },
    caddies: [
      {
        id: 167,
        name: "신정훈",
        team: "7조",
        phoneNormalized: "01012345678",
      },
    ],
    sourceDraftVersion: meta.publishedSourceDraftVersion,
    currentDraftVersion: meta.currentDraftVersion,
    freshness,
  });
  assert(out.freshness.status === meta.expectedStatus, "preview STALE");
  assert(out.freshness.canSend === meta.canSend, "preview canSend false");
  assert(out.counts.recipients === meta.recipients, "recipients 168 유지");
  assert(out.counts.contactReady === meta.contactReady, "contactReady 1");
  assert(out.counts.sendable === meta.contactReady, "sendable alias 1");
  assert(out.counts.missingPhone === meta.missingPhone, "missingPhone 167");
  assert(out.recipients.length === 168, "list 168");
  const json = JSON.stringify(out);
  assert(!json.includes("phoneNormalized"), "raw phone key 없음");
  assert(!json.includes("01012345678"), "raw 번호 없음");
  assert(json.includes("010-****-5678"), "masked only");
}

section("stale여도 recipients preview 유지 / CURRENT counts");
{
  const freshness = resolvePublishedFreshness({
    hasPublished: true,
    publishedSourceDraftVersion: 39,
    currentDraftVersion: 39,
  });
  const out = buildAlimtalkWorkNoticePreview({
    payload: {
      date: "2026-09-07",
      placements: [
        place({
          caddyId: 12,
          shift: "1부",
          teeTime: "06:32",
          course: "OCEAN",
        }),
      ],
    },
    caddies: [
      {
        id: 12,
        name: "김현정1",
        phoneNormalized: "01012345678",
      },
    ],
    sourceDraftVersion: 39,
    currentDraftVersion: 39,
    freshness,
  });
  assert(out.freshness.status === "CURRENT", "CURRENT preview");
  assert(out.freshness.canSend === true, "CURRENT canSend");
  assert(out.counts.recipients === 1, "CURRENT recipients");
  assert(out.counts.contactReady === 1, "CURRENT contactReady");
}

section("no Published empty + freshness");
{
  const freshness = resolvePublishedFreshness({
    hasPublished: false,
    currentDraftVersion: null,
  });
  const empty = emptyAlimtalkWorkNoticePreview("2026-09-07", freshness);
  assert(empty.published === false, "empty published");
  assert(empty.freshness.status === "NO_PUBLISHED", "empty NO_PUBLISHED");
  assert(empty.freshness.canSend === false, "empty canSend false");
  assert(empty.recipients.length === 0, "empty recipients");
}

section("assertAlimtalkCanSend for future POST");
{
  const stale = resolvePublishedFreshness({
    hasPublished: true,
    publishedSourceDraftVersion: 5,
    currentDraftVersion: 39,
  });
  let threw = false;
  try {
    assertAlimtalkCanSend(stale);
  } catch (e) {
    threw = e instanceof AlimtalkNotSendableError;
    assert(
      e instanceof AlimtalkNotSendableError && e.code === ALIMTALK_NOT_SENDABLE,
      "STALE throws ALIMTALK_NOT_SENDABLE"
    );
    assert((e as AlimtalkNotSendableError).status === 409, "409");
  }
  assert(threw, "STALE 거부");
  assertAlimtalkCanSend(
    resolvePublishedFreshness({
      hasPublished: true,
      publishedSourceDraftVersion: 39,
      currentDraftVersion: 39,
    })
  );
  assert(true, "CURRENT 통과");
}

section("UI wording helpers");
{
  assert(
    alimtalkReadyCountLabel(false) === ALIMTALK_CONTACT_READY_LABEL,
    "stale: 연락처 준비"
  );
  assert(
    !alimtalkReadyCountLabel(false).includes("발송 가능"),
    "stale에 발송 가능 없음"
  );
  assert(
    alimtalkReadyCountLabel(true) === ALIMTALK_SENDABLE_COUNT_LABEL,
    "CURRENT: 발송 가능"
  );
  assert(
    alimtalkBlockedCountLabel("STALE") ===
      `${ALIMTALK_BADGE_STALE} · ${ALIMTALK_CANNOT_SEND_LABEL}`,
    "stale 발송 불가 문구"
  );
  assert(alimtalkBlockedCountLabel("CURRENT") === null, "CURRENT 차단문구 없음");
  assert(alimtalkBlockedCountLabel("PUBLISHED_ONLY") === null, "PUBLISHED_ONLY 차단문구 없음");
  assert(ALIMTALK_ASSIGNMENTS_HREF === "/manage/assignments", "배치표 이동은 assignments");
  assert(ALIMTALK_GO_ASSIGNMENTS_LABEL === "배치표로 이동", "이동 버튼 문구");
}

section("source / 안전장치");
{
  const helper = readSrc("src/lib/alimtalkPublishedFreshness.ts");
  const api = readSrc("src/app/api/notifications/alimtalk/preview/route.ts");
  const page = readSrc("src/app/manage/alimtalk/page.tsx");
  const previewLib = readSrc("src/lib/alimtalkWorkNoticePreview.ts");
  const schema = readSrc("prisma/schema.prisma");
  const pkg = readSrc("package.json");

  assert(/resolvePublishedFreshness/.test(helper), "helper export");
  assert(/assertAlimtalkCanSend/.test(helper), "future send assert");
  assert(/PUBLISHED_ONLY/.test(helper), "PUBLISHED_ONLY");
  assert(/getDailyBoardDraftVersion/.test(api), "API reads draft version");
  assert(!/getDailyBoardDraft\(/.test(api), "Draft payload fallback 없음");
  assert(/resolvePublishedFreshness/.test(api), "API uses helper");
  assert(/export async function GET/.test(api), "GET only");
  assert(!/export async function POST/.test(api), "POST/send 없음");
  assert(!/solapi|aligo|nhn-toast/i.test(api), "provider 없음");
  assert(!/solapi|aligo|nhn-toast/i.test(pkg), "provider dep 없음");
  assert(!/publishDailyBoard/.test(page), "알림톡 화면 publish 없음");
  assert(!/saveDailyBoardDraft/.test(page), "알림톡 화면 draft 저장 없음");
  assert(/ALIMTALK_STALE_TITLE/.test(page), "stale title");
  assert(/ALIMTALK_STALE_PREVIEW_NOTE/.test(page), "stale preview note");
  assert(/ALIMTALK_STALE_REPUBLISH_HINT/.test(page), "republish hint");
  assert(/ALIMTALK_GO_ASSIGNMENTS_LABEL/.test(page), "배치표로 이동");
  assert(/ALIMTALK_ASSIGNMENTS_HREF/.test(page), "assignments href");
  assert(/alimtalkReadyCountLabel/.test(page), "count wording helper");
  assert(!/model NotificationSend/.test(schema), "send 테이블 없음");
  assert(/contactReady/.test(previewLib), "counts.contactReady");
  assert(!/phoneNormalized/.test(page), "UI raw phone 키 없음");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
