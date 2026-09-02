/**
 * 배치표 PNG export 타깃 테스트 (엔진/DB write 없음)
 * 실행: npm run test:assignment-board-export-unit
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssignmentBoardExportView } from "../src/components/board/AssignmentBoardExportView";
import {
  BOARD_EXPORT_COURSE_LABELS,
  BOARD_EXPORT_SHIFTS,
  assignmentDraftFromPublishedPayload,
  boardExportPngFilename,
  buildBoardExportSlice,
} from "../src/lib/assignmentBoardExport";
import {
  BOARD_EXPORT_MULTI_DOWNLOAD_HINT,
  BOARD_EXPORT_SHARE_UNSUPPORTED,
  canShareBoardPngFiles,
  isAndroidUserAgent,
  makeBoardExportPngFile,
} from "../src/lib/assignmentBoardExportPng";
import type { AssignmentDraft } from "../src/lib/assignmentDraft";
import type { AutoAssignmentRow } from "../src/lib/autoAssignEngine";
import type { DailyBoardPublishedPayloadV1 } from "../src/lib/dailyBoardPublished";
import { COURSE_CODES, type ShiftPart } from "../src/lib/reservationParser";
import { assignmentsByShift } from "../src/lib/assignmentDraft";
import { formatCaddyLabel } from "../src/lib/caddyDisplay";

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

function row(
  shift: ShiftPart,
  teeTime: string,
  course: string,
  id: string,
  extra?: { teamName?: string; caddyName?: string; caddyTeam?: string }
): AutoAssignmentRow {
  return {
    date: "2026-09-07",
    shift,
    sequenceIndex: 0,
    reason: "TEST",
    kind: "regular",
    pairId: null,
    reservation: {
      id,
      date: "2026-09-07",
      course,
      shift,
      teeTime,
      teamName: extra?.teamName ?? id,
      rawRowIndex: 1,
    },
    caddy: {
      id: Number(id.replace(/\D/g, "") || 1),
      name: extra?.caddyName ?? `C${id}`,
      team: extra?.caddyTeam ?? "1조",
      teamOrder: 1,
    },
  } as AutoAssignmentRow;
}

function draftOf(assignments: AutoAssignmentRow[]): AssignmentDraft {
  return {
    date: "2026-09-07",
    status: "DRAFT",
    assignments,
    unassignedReservations: [],
    closedCourseReservations: [],
    openCourses: [...COURSE_CODES],
    caddyPool: [],
    sparesByShift: [
      {
        shift: "1부",
        spare1: { caddyId: 101, name: "스페어갑", team: "3조", teamOrder: 1 },
        spare2: { caddyId: 102, name: "스페어을", team: "4조", teamOrder: 2 },
      },
      {
        shift: "2부",
        spare1: { caddyId: 201, name: "오후갑", team: "5조", teamOrder: 1 },
        spare2: null,
      },
      { shift: "3부", spare1: null, spare2: null },
    ],
    confirmedAt: null,
  };
}

const long1 = Array.from({ length: 18 }, (_, i) => {
  const tee = `0${6 + Math.floor(i / 4)}:${String((i * 7) % 60).padStart(2, "0")}`;
  const course = COURSE_CODES[i % 4];
  return row("1부", tee, course, `L${i + 1}`, {
    teamName: `팀${i + 1}`,
    caddyName: `이름${i + 1}`,
  });
});

const mixed = [
  ...long1,
  row("2부", "11:20", "VERTHILL", "P2A", { teamName: "2부팀A", caddyName: "이진" }),
  row("2부", "11:27", "SKY", "P2B", { teamName: "2부팀B", caddyName: "최씨" }),
  row("3부", "16:00", "OCEAN", "P3A", { teamName: "3부팀", caddyName: "강씨" }),
];

const draft = draftOf(mixed);

section("1부 export에 1부 전체 rows 포함");
{
  const slice = buildBoardExportSlice(draft, "1부");
  const html = renderToStaticMarkup(createElement(AssignmentBoardExportView, { slice }));
  const uiRows = assignmentsByShift(draft, "1부");
  assert(slice.rows.length > 1, "1부 teeTime 여러 줄");
  assert(
    uiRows.every((r) => html.includes(r.reservation.teeTime || "")),
    "1부 모든 teeTime이 export HTML에 있음"
  );
  assert(
    uiRows.every((r) => html.includes(r.caddy.name)),
    "1부 모든 캐디 이름이 export에 있음"
  );
  assert(!html.includes("2부팀A") && !html.includes("3부팀"), "1부 export에 2/3부 팀 없음");
}

section("2부/3부는 해당 shift 데이터만");
{
  const s2 = buildBoardExportSlice(draft, "2부");
  const s3 = buildBoardExportSlice(draft, "3부");
  const h2 = renderToStaticMarkup(createElement(AssignmentBoardExportView, { slice: s2 }));
  const h3 = renderToStaticMarkup(createElement(AssignmentBoardExportView, { slice: s3 }));
  assert(h2.includes("이진"), "2부 캐디");
  assert(!h2.includes("이름1") && !h2.includes("강씨"), "2부에 1/3부 없음");
  assert(h3.includes("강씨"), "3부 캐디");
  assert(!h3.includes("이진"), "3부에 2부 없음");
  assert(s2.shift === "2부" && s3.shift === "3부", "shift 필드");
}

section("해당 shift 스페어 1/2가 UI와 동일");
{
  const s1 = buildBoardExportSlice(draft, "1부");
  const s2 = buildBoardExportSlice(draft, "2부");
  const s3 = buildBoardExportSlice(draft, "3부");
  const ui1 = draft.sparesByShift.find((s) => s.shift === "1부")!;
  assert(s1.spare.spare1Label === formatCaddyLabel(ui1.spare1!), "1부 스페어1");
  assert(s1.spare.spare2Label === formatCaddyLabel(ui1.spare2!), "1부 스페어2");
  assert(s2.spare.spare1Label === formatCaddyLabel(draft.sparesByShift[1].spare1!), "2부 스페어1");
  assert(s2.spare.spare2Label === null, "2부 스페어2 없음");
  const h3 = renderToStaticMarkup(createElement(AssignmentBoardExportView, { slice: s3 }));
  assert(h3.includes("스페어 1") && h3.includes("스페어 2"), "3부도 스페어 칸 표시");
}

section("빈 팀/닫힘 표시 유지");
{
  const d = draftOf([row("1부", "07:00", "VERTHILL", "V1")]);
  d.openCourses = ["VERTHILL", "SKY", "LAKE"];
  const slice = buildBoardExportSlice(d, "1부");
  const html = renderToStaticMarkup(createElement(AssignmentBoardExportView, { slice }));
  assert(slice.rows[0].cells.SKY.kind === "empty", "열린 빈 칸 empty");
  assert(slice.rows[0].cells.OCEAN.kind === "closed", "닫힌 코스 closed");
  assert(html.includes("닫힘"), "export에 닫힘");
  assert(html.includes('class="bx-cell empty"'), "export에 빈칸 셀");
}

section("관리자 UI가 export DOM에서 제외");
{
  const html = renderToStaticMarkup(
    createElement(AssignmentBoardExportView, {
      slice: buildBoardExportSlice(draft, "1부"),
    })
  );
  assert(!html.includes("이미지 저장"), "이미지 저장 버튼 없음");
  assert(!html.includes("추가팀"), "+추가팀 없음");
  assert(!html.includes("목록"), "목록 탭 없음");
  assert(!html.includes("LockToggle") && !html.includes("lock-chip"), "lock 조작 없음");
  assert(!html.includes("수정할 수 있습니다"), "수정 안내문 없음");
  assert(!html.includes("ops-tabs") && !html.includes("미배치"), "탭/미배치 없음");
  assert(html.includes("VERTHILL 배치표") && html.includes("2026-09-07"), "게시용 헤더");
}

section("긴 배치표가 viewport에 잘리지 않음");
{
  const slice = buildBoardExportSlice(draft, "1부");
  const html = renderToStaticMarkup(createElement(AssignmentBoardExportView, { slice }));
  const times = [...new Set(long1.map((r) => r.reservation.teeTime))];
  assert(times.length >= 8, "fixture teeTime 충분히 김");
  assert(
    times.every((t) => html.includes(`data-export-teetime="${t}"`)),
    "모든 teeTime row가 export DOM에 존재"
  );
}

section("파일명이 날짜/부 기준");
{
  assert(
    boardExportPngFilename("2026-09-07", "1부") === "VERTHILL_배치표_2026-09-07_1부.png",
    "1부 파일명"
  );
  assert(
    boardExportPngFilename("2026-09-07", "3부") === "VERTHILL_배치표_2026-09-07_3부.png",
    "3부 파일명"
  );
}

section("export가 Draft/DB write를 발생시키지 않음");
{
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const lib = read("src/lib/assignmentBoardExport.ts");
  const png = read("src/lib/assignmentBoardExportPng.ts");
  const view = read("src/components/board/AssignmentBoardExportView.tsx");
  const menu = read("src/components/board/BoardImageExportMenu.tsx");
  const persist = read("src/lib/quickBoardMutationApply.ts");
  const draftApi = read("src/app/api/assignments/draft/route.ts");
  const engine = read("src/lib/autoAssignEngine.ts");
  const page = read("src/app/manage/assignments/page.tsx");
  for (const [name, src] of [
    ["export lib", lib],
    ["png", png],
    ["view", view],
    ["menu", menu],
  ] as const) {
    assert(!/\/api\/assignments\/draft/.test(src), `${name} draft API 없음`);
    assert(!/prisma/.test(src), `${name} prisma 없음`);
    assert(!/replaceDailyOpsDuties|fetchPublishedOpsDutySheets/.test(src), `${name} ops duty write 없음`);
  }
  assert(!/assignmentBoardExport/.test(persist), "persist에 export 없음");
  assert(!/assignmentBoardExport/.test(draftApi), "draft route에 export 없음");
  assert(!/assignmentBoardExport/.test(engine), "autoAssignEngine 미변경");
  const boardPage = read("src/app/board/page.tsx");
  assert(
    /BoardImageExportMenu/.test(page) &&
      /BoardImageExportMenu/.test(boardPage) &&
      /assignmentDraftFromPublishedPayload/.test(boardPage) &&
      /PNG 다운로드/.test(menu) &&
      /공유하기/.test(menu) &&
      /\{shift\} PNG 다운로드/.test(menu) &&
      /전체 PNG 다운로드/.test(menu) &&
      /전체 공유하기/.test(menu),
    "자동배치·최종 배치표 버튼"
  );
  assert(!/붙여넣을 수 있습니다/.test(menu), "clipboard 안내 없음");
  assert(
    /BOARD_EXPORT_SHARE_UNSUPPORTED/.test(menu) &&
      /BOARD_EXPORT_MULTI_DOWNLOAD_HINT/.test(menu),
    "다운로드/공유 경로 분리"
  );
  assert(/html-to-image/.test(png), "html-to-image 사용");
  assert(BOARD_EXPORT_SHIFTS.join(",") === "1부,2부,3부", "3부 메뉴");
}

section("모바일 폭에서 이미지 생성 가능 (고정 720 export 폭)");
{
  const png = readFileSync(join(process.cwd(), "src/lib/assignmentBoardExportPng.ts"), "utf8");
  assert(/BOARD_EXPORT_WIDTH_PX = 720/.test(png), "viewport가 아닌 고정 720폭");
  assert(/BOARD_EXPORT_PIXEL_RATIO = 2/.test(png), "scale 2");
  assert(/left:-10000px/.test(png), "offscreen DOM");
  assert(isAndroidUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel)") === true, "Android UA");
  assert(isAndroidUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0") === false, "iPhone 아님");
}

section("최종 배치표 최신 board state가 export에 반영");
{
  const payload = (caddyName: string, teeTime: string): DailyBoardPublishedPayloadV1 => ({
    schemaVersion: 1,
    date: "2026-09-07",
    openCourses: [...COURSE_CODES],
    publisherUsername: "admin",
    placements: [
      {
        shift: "1부",
        course: "VERTHILL",
        teeTime,
        teamName: "고객홍길동",
        reservationId: "r1",
        reservationKey: "r1",
        caddyId: 11,
        caddyName,
        caddyTeam: "2조",
        displayLabel: `2조 ${caddyName}`,
        kind: "regular",
        locked: false,
        limousine: false,
        driving: false,
        twoWork: false,
        chageun: false,
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
  });
  const html1 = renderToStaticMarkup(
    createElement(AssignmentBoardExportView, {
      slice: buildBoardExportSlice(
        assignmentDraftFromPublishedPayload(payload("김철수", "06:00")),
        "1부"
      ),
    })
  );
  const html2 = renderToStaticMarkup(
    createElement(AssignmentBoardExportView, {
      slice: buildBoardExportSlice(
        assignmentDraftFromPublishedPayload(payload("박이동", "07:10")),
        "1부"
      ),
    })
  );
  assert(html1.includes("김철수") && html1.includes("06:00"), "첫 payload 반영");
  assert(html2.includes("박이동") && html2.includes("07:10"), "수정 후 최신 payload 반영");
  assert(!html2.includes("김철수") && !html2.includes("06:00"), "이전 배치가 PNG에 남지 않음");
  assert(html2.includes("2조") && html2.includes("대기갑"), "조·스페어 유지");
}

section("PNG에 고객/예약 관련 문자열 없음");
{
  const html = renderToStaticMarkup(
    createElement(AssignmentBoardExportView, {
      slice: buildBoardExportSlice(draft, "2부"),
    })
  );
  assert(!html.includes("2부팀A") && !html.includes("2부팀B"), "예약자/팀명 없음");
  assert(!html.includes("bx-team"), "고객 상단 텍스트 노드 없음");
  assert(html.includes("이진") && html.includes("최씨"), "캐디명 유지");
  const view = readFileSync(join(process.cwd(), "src/components/board/AssignmentBoardExportView.tsx"), "utf8");
  assert(!/reservation\.teamName/.test(view), "export view가 teamName을 렌더하지 않음");
}

section("헤더 베르힐/스카이/오션/레이크 + 시간 확대 CSS");
{
  const html = renderToStaticMarkup(
    createElement(AssignmentBoardExportView, {
      slice: buildBoardExportSlice(draft, "1부"),
    })
  );
  const css = readFileSync(
    join(process.cwd(), "src/components/board/assignmentBoardExportCss.ts"),
    "utf8"
  );
  assert(html.includes("베르힐") && html.includes("스카이"), "베르힐/스카이");
  assert(html.includes("오션") && html.includes("레이크"), "오션/레이크");
  assert(!html.includes(">베<") && !html.includes(">스<"), "단축 헤더 제거");
  assert(
    BOARD_EXPORT_COURSE_LABELS.VERTHILL === "베르힐" &&
      BOARD_EXPORT_COURSE_LABELS.LAKE === "레이크",
    "코스 라벨 상수"
  );
  assert(/\.bx-time[\s\S]*font-size: 16px/.test(css), "티타임 font-size 확대");
  assert(/\.bx-time[\s\S]*font-weight: 800/.test(css), "티타임 font-weight");
  assert(/\.bx-board-head > div[\s\S]*font-size: 12px/.test(css), "헤더 font-size 조정");
}

section("PNG 다운로드 File / Web Share fallback");
{
  const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  const file = makeBoardExportPngFile(blob, boardExportPngFilename("2026-09-07", "1부"));
  assert(file instanceof File, "File 생성");
  assert(file.type === "image/png", "image/png MIME");
  assert(file.name === "VERTHILL_배치표_2026-09-07_1부.png", "다운로드 파일명");
  assert(canShareBoardPngFiles([file]) === false, "Node/미지원 canShare=false");
  assert(
    canShareBoardPngFiles([file], { canShare: () => true }) === true,
    "지원 기기는 share File"
  );
  assert(
    canShareBoardPngFiles([file], {
      canShare: () => {
        throw new Error("no");
      },
    }) === false,
    "canShare 예외는 unsupported"
  );
  assert(
    BOARD_EXPORT_SHARE_UNSUPPORTED.includes("PNG 다운로드를 이용해 주세요"),
    "미지원 fallback 문구"
  );
  assert(BOARD_EXPORT_MULTI_DOWNLOAD_HINT.includes("각 부를 따로"), "다중 다운로드 안내");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
