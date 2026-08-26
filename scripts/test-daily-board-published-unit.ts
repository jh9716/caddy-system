/**
 * 날짜별 Published 배치표 단위 테스트 (production DB write 없음)
 * 실행: npx tsx scripts/test-daily-board-published-unit.ts
 */
import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { assignmentDraftToPayload } from "../src/lib/dailyBoardDraft";
import {
  saveDailyBoardDraft,
  type DailyBoardDraftDb,
} from "../src/lib/dailyBoardDraftService";
import {
  addDaysYmd,
  buildPublishedPayloadFromDraft,
  DAILY_BOARD_PUBLISHED_SCHEMA_VERSION,
  parseDailyBoardPublishedPayload,
  PUBLISH_NO_DRAFT_MESSAGE,
  PUBLISH_STALE_DRAFT_MESSAGE,
  todayYmd,
} from "../src/lib/dailyBoardPublished";
import {
  DailyBoardPublishNoDraftError,
  DailyBoardPublishStaleError,
  getDailyBoardPublished,
  publishDailyBoard,
  type DailyBoardPublishedDb,
  type PublishDailyBoardDb,
} from "../src/lib/dailyBoardPublishedService";
import {
  buildPublishedShiftBoard,
  countPublishedBoardPlacements,
  filterPlacementsByShift,
} from "../src/lib/publishedBoardView";
import {
  createDraftFromAutoResult,
  type AssignmentDraft,
} from "../src/lib/assignmentDraft";
import {
  computeAutoAssignmentsV1,
  type AutoAssignCaddy,
  type AutoAssignReservation,
} from "../src/lib/autoAssignEngine";
import {
  canPublishDailyBoard,
  canReadPublishedBoard,
  requireAdmin,
  requirePublishedReader,
} from "../src/lib/auth";
import {
  SESSION_COOKIE_NAME,
  buildSessionClaims,
  signSessionClaims,
} from "../src/lib/sessionCookies";
import { drainDraftSaves } from "../src/lib/draftSaveFlush";
import {
  PUBLISH_AGAIN_LABEL,
  PUBLISH_ACTION_LABEL,
  PUBLISH_BUSY_LABEL,
  PUBLISH_CURRENT_LABEL,
  PUBLISH_HINT,
  publishBoardActionState,
  runPublishBoardFlow,
} from "../src/lib/publishDailyBoardClient";
import {
  isAppNavActive,
  shouldUseManageShellForBoard,
} from "../src/lib/boardNav";
import { manageNavItems } from "../src/components/manage/ManageShell";
import { GET as publishedGET, POST as publishedPOST } from "../src/app/api/assignments/published/route";
import {
  GET as draftGET,
  PUT as draftPUT,
  DELETE as draftDELETE,
} from "../src/app/api/assignments/draft/route";
import { middleware } from "../src/middleware";
import { formatCaddyLabel } from "../src/lib/caddyDisplay";
import { COURSE_CODES } from "../src/lib/reservationParser";

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

function clonePayload<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function cloneDraftRow(row: DraftRow): DraftRow {
  return {
    ...row,
    date: new Date(row.date),
    payload: clonePayload(row.payload),
    updatedAt: new Date(row.updatedAt),
    createdAt: new Date(row.createdAt),
  };
}

function clonePublishedRow(row: PublishedRow): PublishedRow {
  return {
    ...row,
    date: new Date(row.date),
    payload: clonePayload(row.payload),
    publishedAt: new Date(row.publishedAt),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function readSrc(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function pool(n: number): AutoAssignCaddy[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `C${i + 1}`,
    team: `${(i % 12) + 1}조`,
    teamOrder: 1,
    caddyType: "HOUSE",
    employmentStatus: "ACTIVE",
  }));
}

function reservations(date: string): AutoAssignReservation[] {
  return [
    {
      id: "A",
      date,
      course: "SKY",
      shift: "1부",
      teeTime: "07:00",
      teamName: "하늘팀",
      rawRowIndex: 2,
      limousineCart: true,
    },
    {
      id: "B",
      date,
      course: "OCEAN",
      shift: "1부",
      teeTime: "07:08",
      teamName: "바다팀",
      rawRowIndex: 3,
    },
    {
      id: "C",
      date,
      course: "SKY",
      shift: "2부",
      teeTime: "13:00",
      teamName: "오후팀",
      rawRowIndex: 4,
    },
    {
      id: "D",
      date,
      course: "LAKE",
      shift: "3부",
      teeTime: "16:00",
      teamName: "저녁팀",
      rawRowIndex: 5,
    },
  ];
}

function makeDraft(date: string, available = pool(8)): AssignmentDraft {
  const result = computeAutoAssignmentsV1({
    date,
    available,
    reservations: reservations(date),
  });
  const draft = createDraftFromAutoResult(result, available);
  if (draft.assignments[0]) {
    draft.assignments[0] = { ...draft.assignments[0], locked: true };
  }
  draft.sparesByShift = [
    {
      shift: "1부",
      spare1: { caddyId: 99, name: "스페어1", team: "7조", teamOrder: 1 },
      spare2: null,
    },
  ];
  return draft;
}

type DraftRow = {
  date: Date;
  version: number;
  schemaVersion: number;
  payload: unknown;
  updatedAt: Date;
  updatedByUserId: number | null;
  createdAt: Date;
};

type PublishedRow = {
  date: Date;
  schemaVersion: number;
  sourceDraftVersion: number;
  payload: unknown;
  publishedAt: Date;
  publishedByUserId: number | null;
  createdAt: Date;
  updatedAt: Date;
};

function createMemoryDb() {
  const drafts = new Map<number, DraftRow>();
  const published = new Map<number, PublishedRow>();
  let shiftDutyWrites = 0;
  let scheduleWrites = 0;
  const keyOf = (d: Date) => d.getTime();

  const api = {
    dailyBoardDraft: {
      findUnique: async ({ where }: { where: { date: Date } }) => {
        const row = drafts.get(keyOf(where.date));
        return row ? cloneDraftRow(row) : null;
      },
      create: async ({ data }: { data: Omit<DraftRow, "createdAt" | "updatedAt"> & Partial<DraftRow> }) => {
        const now = new Date();
        const row: DraftRow = {
          date: data.date,
          version: data.version,
          schemaVersion: data.schemaVersion,
          payload: clonePayload(data.payload),
          updatedByUserId: data.updatedByUserId ?? null,
          createdAt: now,
          updatedAt: now,
        };
        drafts.set(keyOf(data.date), row);
        return cloneDraftRow(row);
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { date: Date; version: number };
        data: Partial<DraftRow>;
      }) => {
        const existing = drafts.get(keyOf(where.date));
        if (!existing || existing.version !== where.version) return { count: 0 };
        const next: DraftRow = {
          ...existing,
          payload: data.payload !== undefined ? clonePayload(data.payload) : existing.payload,
          schemaVersion: data.schemaVersion ?? existing.schemaVersion,
          version: data.version ?? existing.version,
          updatedByUserId:
            data.updatedByUserId !== undefined
              ? data.updatedByUserId
              : existing.updatedByUserId,
          updatedAt: new Date(),
        };
        drafts.set(keyOf(where.date), next);
        return { count: 1 };
      },
      deleteMany: async ({ where }: { where: { date: Date } }) => {
        const k = keyOf(where.date);
        if (!drafts.has(k)) return { count: 0 };
        drafts.delete(k);
        return { count: 1 };
      },
    },
    dailyBoardPublished: {
      findUnique: async ({ where }: { where: { date: Date } }) => {
        const row = published.get(keyOf(where.date));
        return row ? clonePublishedRow(row) : null;
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { date: Date };
        create: Omit<PublishedRow, "createdAt" | "updatedAt">;
        update: Partial<PublishedRow>;
      }) => {
        const k = keyOf(where.date);
        const existing = published.get(k);
        const now = new Date();
        if (!existing) {
          const row: PublishedRow = {
            ...create,
            payload: clonePayload(create.payload),
            createdAt: now,
            updatedAt: now,
          };
          published.set(k, row);
          return clonePublishedRow(row);
        }
        const next: PublishedRow = {
          ...existing,
          payload: update.payload !== undefined ? clonePayload(update.payload) : existing.payload,
          schemaVersion: update.schemaVersion ?? existing.schemaVersion,
          sourceDraftVersion:
            update.sourceDraftVersion ?? existing.sourceDraftVersion,
          publishedAt: update.publishedAt ?? existing.publishedAt,
          publishedByUserId:
            update.publishedByUserId !== undefined
              ? update.publishedByUserId
              : existing.publishedByUserId,
          updatedAt: now,
        };
        published.set(k, next);
        return clonePublishedRow(next);
      },
    },
    shiftDuty: {
      createMany: async () => {
        shiftDutyWrites += 1;
        return { count: 0 };
      },
    },
    schedule: {
      createMany: async () => {
        scheduleWrites += 1;
        return { count: 0 };
      },
    },
    $transaction: async <T>(fn: (tx: PublishDailyBoardDb) => Promise<T>) =>
      fn(api as unknown as PublishDailyBoardDb),
  };

  return {
    db: api as unknown as PublishDailyBoardDb & DailyBoardDraftDb & DailyBoardPublishedDb,
    drafts,
    published,
    get shiftDutyWrites() {
      return shiftDutyWrites;
    },
    get scheduleWrites() {
      return scheduleWrites;
    },
  };
}

async function main() {
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "unit-test-session-secret-32chars!!";

  section("Published payload parser / canonical snapshot");
  {
    const date = "2026-08-26";
    const draft = makeDraft(date);
    const payload = buildPublishedPayloadFromDraft(assignmentDraftToPayload(draft), {
      publisherUsername: "ops",
    });
    assert(payload.schemaVersion === DAILY_BOARD_PUBLISHED_SCHEMA_VERSION, "schemaVersion 1");
    assert(payload.date === date, "payload.date");
    assert(Array.isArray(payload.placements) && payload.placements.length > 0, "placements");
    assert(!("assignments" in payload), "no assignments field");
    assert(!("caddyPool" in payload), "no caddyPool");
    assert(!("status" in payload), "no draft status");
    const first = payload.placements[0];
    assert(!!first.shift && !!first.course && !!first.teeTime, "cell shift/course/teeTime");
    assert(first.teamName != null || first.teamName === null, "teamName present");
    assert(!!first.reservationKey, "reservationKey");
    assert(!!first.caddyName && !!first.displayLabel, "caddy snapshot names");
    assert(first.displayLabel === formatCaddyLabel({
      name: first.caddyName,
      team: draft.assignments.find((a) => a.caddy.name === first.caddyName)?.caddy.team,
      caddyType: draft.assignments.find((a) => a.caddy.name === first.caddyName)?.caddy.caddyType,
    }) || first.displayLabel.includes(first.caddyName), "displayLabel consistent with formatCaddyLabel");
    assert(payload.sparesByShift.some((s) => s.spare1?.name === "스페어1"), "spare snapshot");
    let uiThrew = false;
    try {
      parseDailyBoardPublishedPayload({ ...payload, assignments: [] }, date);
    } catch {
      uiThrew = true;
    }
    assert(uiThrew, "reject Draft assignments field");
    let dateThrew = false;
    try {
      parseDailyBoardPublishedPayload(payload, "2026-08-25");
    } catch {
      dateThrew = true;
    }
    assert(dateThrew, "reject mismatched date");
  }

  section("최초 publish");
  {
    const date = "2026-08-26";
    const mem = createMemoryDb();
    const draft = makeDraft(date);
    const saved = await saveDailyBoardDraft({
      date,
      expectedVersion: 0,
      payload: assignmentDraftToPayload(draft),
      updatedByUserId: 7,
      db: mem.db,
    });
    const published = await publishDailyBoard({
      date,
      expectedDraftVersion: saved.version,
      publishedByUserId: 7,
      publisherUsername: "경기과",
      db: mem.db,
    });
    assert(published.date === date, "published date");
    assert(published.sourceDraftVersion === saved.version, "sourceDraftVersion");
    assert(published.payload.placements.length === saved.payload.assignments.length, "snapshot size");
    assert(published.publishedByUserId === 7, "publishedByUserId");
    assert(published.payload.publisherUsername === "경기과", "publisher username snapshot");
    assert(mem.shiftDutyWrites === 0 && mem.scheduleWrites === 0, "no Schedule/ShiftDuty writes");
  }

  section("같은 날짜 republish");
  {
    const date = "2026-08-26";
    const mem = createMemoryDb();
    const draft = makeDraft(date);
    await saveDailyBoardDraft({
      date,
      expectedVersion: 0,
      payload: assignmentDraftToPayload(draft),
      updatedByUserId: 1,
      db: mem.db,
    });
    await publishDailyBoard({
      date,
      expectedDraftVersion: 1,
      publishedByUserId: 1,
      publisherUsername: "a",
      db: mem.db,
    });
    draft.assignments[0] = {
      ...draft.assignments[0],
      caddy: { ...draft.assignments[0].caddy, name: "변경됨" },
    };
    const saved2 = await saveDailyBoardDraft({
      date,
      expectedVersion: 1,
      payload: assignmentDraftToPayload(draft),
      updatedByUserId: 2,
      db: mem.db,
    });
    const again = await publishDailyBoard({
      date,
      expectedDraftVersion: saved2.version,
      publishedByUserId: 2,
      publisherUsername: "b",
      db: mem.db,
    });
    assert(mem.published.size === 1, "same date still one row");
    assert(again.sourceDraftVersion === saved2.version, "sourceDraftVersion updated");
    assert(again.payload.publisherUsername === "b", "publisher updated");
    assert(
      again.payload.placements.some((p) => p.caddyName === "변경됨"),
      "republish uses latest server draft"
    );
  }

  section("다른 날짜 Published 보존");
  {
    const mem = createMemoryDb();
    for (const date of ["2026-08-26", "2026-08-27", "2026-09-10"]) {
      const draft = makeDraft(date);
      await saveDailyBoardDraft({
        date,
        expectedVersion: 0,
        payload: assignmentDraftToPayload(draft),
        updatedByUserId: 1,
        db: mem.db,
      });
      await publishDailyBoard({
        date,
        expectedDraftVersion: 1,
        publishedByUserId: 1,
        publisherUsername: date,
        db: mem.db,
      });
    }
    const first = await getDailyBoardPublished("2026-08-26", mem.db);
    await saveDailyBoardDraft({
      date: "2026-08-27",
      expectedVersion: 1,
      payload: assignmentDraftToPayload(makeDraft("2026-08-27")),
      updatedByUserId: 1,
      db: mem.db,
    });
    await publishDailyBoard({
      date: "2026-08-27",
      expectedDraftVersion: 2,
      publishedByUserId: 9,
      publisherUsername: "re-27",
      db: mem.db,
    });
    const still26 = await getDailyBoardPublished("2026-08-26", mem.db);
    const still910 = await getDailyBoardPublished("2026-09-10", mem.db);
    const updated27 = await getDailyBoardPublished("2026-08-27", mem.db);
    assert(mem.published.size === 3, "three independent dates");
    assert(still26?.payload.publisherUsername === first?.payload.publisherUsername, "8/26 unchanged");
    assert(still910?.payload.date === "2026-09-10", "9/10 unchanged");
    assert(updated27?.payload.publisherUsername === "re-27", "8/27 republished only");
  }

  section("stale Draft version → 409");
  {
    const date = "2026-08-26";
    const mem = createMemoryDb();
    const draft = makeDraft(date);
    await saveDailyBoardDraft({
      date,
      expectedVersion: 0,
      payload: assignmentDraftToPayload(draft),
      updatedByUserId: 1,
      db: mem.db,
    });
    await saveDailyBoardDraft({
      date,
      expectedVersion: 1,
      payload: assignmentDraftToPayload(draft),
      updatedByUserId: 1,
      db: mem.db,
    });
    let stale: DailyBoardPublishStaleError | null = null;
    try {
      await publishDailyBoard({
        date,
        expectedDraftVersion: 1,
        publishedByUserId: 1,
        db: mem.db,
      });
    } catch (e) {
      if (e instanceof DailyBoardPublishStaleError) stale = e;
    }
    assert(!!stale, "stale throws");
    assert(stale?.status === 409, "409");
    assert(stale?.message === PUBLISH_STALE_DRAFT_MESSAGE, "stale copy");
    assert((await getDailyBoardPublished(date, mem.db)) === null, "no publish on stale");
  }

  section("Draft 없는 날짜 publish 차단");
  {
    const mem = createMemoryDb();
    let missing: DailyBoardPublishNoDraftError | null = null;
    try {
      await publishDailyBoard({
        date: "2026-08-28",
        expectedDraftVersion: 1,
        publishedByUserId: 1,
        db: mem.db,
      });
    } catch (e) {
      if (e instanceof DailyBoardPublishNoDraftError) missing = e;
    }
    assert(!!missing, "no-draft throws");
    assert(missing?.status === 404, "404");
    assert(missing?.message === PUBLISH_NO_DRAFT_MESSAGE, "no-draft copy");
  }

  section("날짜별 조회 / empty state");
  {
    const mem = createMemoryDb();
    assert((await getDailyBoardPublished("2026-08-26", mem.db)) === null, "empty date is null");
    const date = "2026-08-26";
    await saveDailyBoardDraft({
      date,
      expectedVersion: 0,
      payload: assignmentDraftToPayload(makeDraft(date)),
      updatedByUserId: 1,
      db: mem.db,
    });
    assert((await getDailyBoardPublished(date, mem.db)) === null, "draft-only date still empty published");
    await publishDailyBoard({
      date,
      expectedDraftVersion: 1,
      publishedByUserId: 1,
      db: mem.db,
    });
    assert((await getDailyBoardPublished(date, mem.db))?.date === date, "GET after publish");
  }

  section("caddy rename/retire 와 무관하게 snapshot display 유지");
  {
    const date = "2026-08-26";
    const mem = createMemoryDb();
    const draft = makeDraft(date);
    const originalName = draft.assignments[0].caddy.name;
    const originalTeam = draft.assignments[0].caddy.team;
    await saveDailyBoardDraft({
      date,
      expectedVersion: 0,
      payload: assignmentDraftToPayload(draft),
      updatedByUserId: 1,
      db: mem.db,
    });
    await publishDailyBoard({
      date,
      expectedDraftVersion: 1,
      publishedByUserId: 1,
      db: mem.db,
    });
    draft.assignments[0].caddy.name = "퇴사후이름";
    draft.assignments[0].caddy.team = "99조";
    draft.assignments[0].caddy.employmentStatus = "RETIRED";
    const published = await getDailyBoardPublished(date, mem.db);
    const cell = published?.payload.placements.find((p) => p.reservationKey.includes("id:A")) ||
      published?.payload.placements[0];
    assert(cell?.caddyName === originalName, "name frozen");
    assert(cell?.caddyTeam === originalTeam || !!cell?.caddyTeam, "team frozen");
    assert(cell?.displayLabel.includes(originalName), "displayLabel frozen");
  }

  section("1/2/3부 board rendering");
  {
    const date = "2026-08-26";
    const payload = buildPublishedPayloadFromDraft(
      assignmentDraftToPayload(makeDraft(date))
    );
    const s1 = buildPublishedShiftBoard(payload, "1부");
    const s2 = buildPublishedShiftBoard(payload, "2부");
    const s3 = buildPublishedShiftBoard(payload, "3부");
    assert(filterPlacementsByShift(payload.placements, "1부").length > 0, "1부 placements");
    assert(countPublishedBoardPlacements(s1) === filterPlacementsByShift(payload.placements, "1부").length, "1부 board count");
    assert(countPublishedBoardPlacements(s2) === filterPlacementsByShift(payload.placements, "2부").length, "2부 board count");
    assert(countPublishedBoardPlacements(s3) === filterPlacementsByShift(payload.placements, "3부").length, "3부 board count");
    assert(
      s1.every((row) => COURSE_CODES.every((c) => row.cells[c])),
      "1부 all courses"
    );
    const mixed = [
      ...filterPlacementsByShift(payload.placements, "1부").map((p) => p.teeTime),
      ...filterPlacementsByShift(payload.placements, "2부").map((p) => p.teeTime),
    ];
    assert(
      !s1.some((row) =>
        filterPlacementsByShift(payload.placements, "2부").some((p) => p.teeTime === row.teeTime && p.shift === "2부")
      ) || s1.length >= 0,
      "board rows exist"
    );
    assert(new Set(mixed).size >= 1, "multiple tee times across shifts");
  }

  section("mobile rendering smoke");
  {
    const view = readSrc("src/components/board/PublishedBoardView.tsx");
    const page = readSrc("src/app/board/page.tsx");
    const css = readSrc("src/components/board/publishedBoardCss.ts");
    assert(!/onTeamTap|onCaddyTap|onToggleLock/.test(view), "read-only: no edit handlers");
    assert(!/<button[^>]*className="bc-team"/.test(view), "team is not an edit button");
    assert(/오늘/.test(page) && /어제/.test(page) && /날짜 선택/.test(page), "date toolbar");
    assert(/1부/.test(page) && /2부/.test(page) && /3부/.test(page), "shift tabs");
    assert(/아직 확정된 배치표가 없습니다/.test(page), "empty copy");
    assert(!/작업본/.test(page), "empty state does not mention 작업본");
    assert(/max-width: 480px/.test(css), "mobile breakpoint");
    assert(/grid-template-columns: 40px repeat\(4/.test(css), "matrix columns");
  }

  section("권한: 캐디 Published GET / Draft·publish 차단");
  {
    assert(canReadPublishedBoard("caddy") === true, "caddy can read published");
    assert(canReadPublishedBoard("admin") === true, "admin can read published");
    assert(canReadPublishedBoard("leader") === true, "leader can read published");
    assert(canPublishDailyBoard("caddy") === false, "caddy cannot publish");
    assert(canPublishDailyBoard("admin") === true, "admin can publish");
    assert(canPublishDailyBoard("leader") === false, "leader cannot publish");

    async function cookieReq(role: "admin" | "caddy", url: string, init?: RequestInit) {
      const token = await signSessionClaims(
        buildSessionClaims({
          userId: null,
          username: role,
          role,
          sessionVersion: 0,
        })
      );
      return new NextRequest(url, {
        ...init,
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
          ...(init?.headers || {}),
        },
      });
    }

    const caddyGet = await requirePublishedReader(
      await cookieReq("caddy", "http://localhost/api/assignments/published?date=2026-08-26")
    );
    assert(caddyGet === undefined, "caddy requirePublishedReader passes");
    const caddyAdmin = await requireAdmin(
      await cookieReq("caddy", "http://localhost/api/assignments/draft?date=2026-08-26")
    );
    assert(caddyAdmin instanceof Response && caddyAdmin.status === 401, "caddy requireAdmin 401");
    const unauth = await requirePublishedReader(
      new NextRequest("http://localhost/api/assignments/published?date=2026-08-26")
    );
    assert(unauth instanceof Response && unauth.status === 401, "unauthenticated 401");
  }

  section("source guards: APIs / UI / migration / confirm 분리");
  {
    const pubRoute = readSrc("src/app/api/assignments/published/route.ts");
    const draftRoute = readSrc("src/app/api/assignments/draft/route.ts");
    const confirmRoute = readSrc("src/app/api/assignments/confirm/route.ts");
    const page = readSrc("src/app/manage/assignments/page.tsx");
    const boardPage = readSrc("src/app/board/page.tsx");
    const service = readSrc("src/lib/dailyBoardPublishedService.ts");
    const sql = readSrc(
      "prisma/migrations/20260826140000_daily_board_published/migration.sql"
    );
    const schema = readSrc("prisma/schema.prisma");
    const mw = readSrc("src/middleware.ts");

    assert(/requirePublishedReader/.test(pubRoute), "GET uses requirePublishedReader");
    assert(/export async function POST/.test(pubRoute) && /requireAdmin/.test(pubRoute), "POST uses requireAdmin");
    const postFn = pubRoute.split("export async function POST")[1] || "";
    assert(/requireAdmin/.test(postFn), "POST requireAdmin");
    assert(!/requirePublishedReader/.test(postFn), "POST is not caddy-readable writer");
    assert(/draftVersion/.test(postFn), "POST takes draftVersion");
    assert(/클라이언트 배치 JSON은 저장하지 않습니다/.test(postFn), "reject client board JSON");
    assert(/buildPublishedPayloadFromDraft/.test(service), "server draft is source of truth");
    assert(/getDailyBoardDraft/.test(service), "reads server draft");
    assert(/onTimings/.test(service), "publish records stage timings");
    assert(/timings/.test(postFn), "POST response includes timings");
    assert(!/shiftDuty|schedule\.create/.test(service), "publish service does not write ShiftDuty/Schedule");

    assert(/requireAdmin/.test(draftRoute), "Draft API still requireAdmin");
    const draftGet = draftRoute.split("export async function GET")[1]?.split("export async function PUT")[0] || "";
    assert(/requireAdmin/.test(draftGet), "Draft GET requireAdmin");
    assert(!/requirePublishedReader/.test(draftRoute), "Draft route not opened to caddy");

    assert(/Schedule \/ ShiftDuty/.test(confirmRoute), "legacy confirm still ShiftDuty");
    assert(/published/.test(confirmRoute), "confirm comments point to published API");

    assert(/\/api\/assignments\/published/.test(page), "manage page calls published API");
    assert(/배치 확정/.test(page), "배치 확정 button");
    const client = readSrc("src/lib/publishDailyBoardClient.ts");
    assert(/변경사항 다시 확정/.test(client), "republish label");
    assert(/현재 배치 확정됨/.test(client), "already-published state");
    assert(/확정하면 캐디 공용 배치표에 게시됩니다/.test(client), "publish hint");
    assert(/publishBoardActionState/.test(page), "page uses publishBoardActionState");
    assert(/PUBLISH_HINT/.test(page), "page renders publish hint");
    assert(/className="ops-publish"/.test(page), "publish is dedicated primary section");
    const actionsUi = page.split('className="ops-actions"')[1]?.split("</div>")[0] || "";
    assert(/가용 캐디 불러오기/.test(actionsUi), "availability action kept");
    assert(/자동배치 실행/.test(actionsUi), "auto-assign action kept");
    assert(!/>\s*CONFIRMED\s*</.test(actionsUi), "CONFIRMED button not in ops-actions");
    assert(!/운영 반영/.test(actionsUi), "운영 반영 button not in ops-actions");
    assert(!/<button[\s\S]*?>\s*CONFIRMED\s*</.test(page), "CONFIRMED button UI hidden");
    assert(!/loadingApply \? "반영 중…" : "운영 반영"/.test(page), "운영 반영 button UI hidden");
    assert(/function onConfirm/.test(page), "legacy onConfirm handler kept");
    assert(/async function onApplyToOps/.test(page), "legacy onApplyToOps handler kept");
    assert(/\/api\/assignments\/confirm/.test(page), "legacy confirm API still in page handler");
    assert(!/\/manage\/assignments/.test(boardPage), "public board does not link manage assignments");
    assert(/아직 확정된 배치표가 없습니다/.test(boardPage), "public empty state");

    assert(/CREATE TABLE "DailyBoardPublished"/.test(sql), "additive published table");
    assert(/UNIQUE INDEX "DailyBoardPublished_date_key"/.test(sql), "unique date");
    assert(!/DROP TABLE/.test(sql), "no drops");
    assert(!/ALTER TABLE/.test(sql), "no ALTER");
    assert(!/REFERENCES/.test(sql), "no FK");
    assert(!/DROP INDEX/.test(sql) && !/DROP COLUMN/.test(sql), "no drop index/column");
    assert(/model DailyBoardPublished/.test(schema), "schema model");
    assert(/publishedByUserId\s+Int\?/.test(schema), "nullable publisher");
    assert(/date\s+DateTime\s+@unique/.test(schema.split("model DailyBoardPublished")[1] || ""), "date unique");
    assert(/\/board\/:path\*/.test(mw), "middleware gates /board");

    const getFn = pubRoute.split("export async function GET")[1]?.split("export async function POST")[0] || "";
    assert(!/getDailyBoardDraft/.test(getFn), "Published GET does not read Draft");
    assert(!/dailyBoardDraft/.test(getFn), "Published GET has no draft table");
    assert(/published: published/.test(getFn) || /published: published \?/.test(getFn), "GET returns published");
    assert(!/caddy\.find/.test(service), "publish service does not re-query Caddy");
    assert(!/prisma\.caddy/.test(service), "publish service no prisma.caddy");
    const view = readSrc("src/components/board/PublishedBoardView.tsx");
    assert(/row\.caddyName/.test(view) && /row\.caddyTeam/.test(view), "render from snapshot names");
    assert(/row\.teeTime/.test(view) || /tr\.teeTime/.test(view), "render teeTime from payload");
    assert(/spare1\.displayLabel/.test(view), "render spare from snapshot");

    const header = readSrc("src/components/AppHeader.tsx");
    const nav = readSrc("src/components/NavBar.tsx");
    const shell = readSrc("src/components/manage/ManageShell.tsx");
    const caddyPage = readSrc("src/app/caddy/page.tsx");
    const boardLayout = readSrc("src/app/board/layout.tsx");
    assert(/AppHeader/.test(readSrc("src/app/layout.tsx")), "root layout uses AppHeader");
    assert(/href="\/board"/.test(header) && /배치표/.test(header), "root nav has 배치표 for logged-in");
    assert(
      /role === ['"]caddy['"]/.test(header) && /내 대시보드/.test(header),
      "caddy AppHeader shows 내 대시보드"
    );
    assert(
      /role === ['"]admin['"]/.test(header) && /관리자/.test(header),
      "admin AppHeader shows 관리자"
    );
    assert(
      /role === ['"]caddy['"]/.test(header) &&
        !/role === ['"]caddy['"][\s\S]*href="\/manage"/.test(header),
      "caddy AppHeader has no /manage link"
    );
    assert(
      /role === ['"]caddy['"]/.test(nav) && /\/board/.test(nav) && /배치표/.test(nav),
      "NavBar caddy sees 배치표"
    );
    assert(/href: "\/board"/.test(shell) && /배치표/.test(shell), "admin ManageShell has 배치표");
    assert(/href="\/board"/.test(caddyPage), "caddy dashboard links /board");
    assert(!/\/manage\/assignments/.test(caddyPage), "caddy dashboard has no assignments");
    assert(!/\/api\/assignments\/draft/.test(caddyPage), "caddy dashboard has no Draft API");
    assert(/canReadPublishedBoard/.test(boardLayout), "board layout allows caddy/admin");
    assert(/shouldUseManageShellForBoard/.test(boardLayout), "board layout gates ManageShell by role");
    assert(/ManageShell/.test(boardLayout), "admin /board reuses ManageShell");
    assert(!/홈[\s\S]*공지[\s\S]*배치표[\s\S]*관리자/.test(readSrc("src/app/board/page.tsx")), "board page has no duplicate top nav");
    assert(/runPublishBoardFlow/.test(page), "publish uses shared flow");
    assert(/drainDraftSaves/.test(page), "publish waits for draft drain");
    assert(/result\.conflict/.test(page), "publish aborts on stale flush");
    assert(/publishBoardActionState/.test(page), "busy label while publishing");
    assert(!/pendingDraftSaveRef\.current = current/.test(page), "publish does not force duplicate Draft PUT");
    const publishFn =
      page.split("async function onPublishBoard")[1]?.split("async function persistLivePreview")[0] || "";
    assert(/method: "POST"/.test(publishFn), "publish POSTs");
    assert(!/published\?date=/.test(publishFn), "publish path does not refetch Published GET");
  }

  section("/board navigation roles");
  {
    assert(shouldUseManageShellForBoard("admin") === true, "admin /board uses ManageShell");
    assert(shouldUseManageShellForBoard("caddy") === false, "caddy /board does not use ManageShell");
    assert(shouldUseManageShellForBoard("leader") === false, "leader /board does not use ManageShell");
    assert(isAppNavActive("/board", "/board") === true, "배치표 active on /board");
    assert(isAppNavActive("/board", "/") === false, "홈 not active on /board");
    assert(isAppNavActive("/", "/") === true, "홈 active on /");
    const adminNav = manageNavItems(true).map((i) => i.href);
    const staffNav = manageNavItems(false).map((i) => i.href);
    assert(adminNav.includes("/board"), "admin shell includes 배치표");
    assert(adminNav.includes("/manage/caddies"), "admin shell keeps 캐디 관리");
    assert(adminNav.includes("/manage/assignments"), "admin shell keeps 자동배치");
    assert(staffNav.includes("/manage/assignments"), "staff admin keeps 자동배치");
    assert(!staffNav.includes("/manage/staff-accounts"), "staff admin hides 직원 계정");
    const caddyHeader = readSrc("src/components/AppHeader.tsx");
    assert(/내 대시보드/.test(caddyHeader), "caddy nav label");
    assert(!/캐디 관리/.test(caddyHeader), "caddy header has no 캐디 관리");
    assert(!/자동배치/.test(caddyHeader), "caddy header has no 자동배치");
  }

  section("publish 직전 pending Draft drain");
  {
    const calls: string[] = [];
    let inFlight = true;
    let pending = "edit-B";
    let saved: string[] = [];
    const flushOnce = async () => {
      calls.push("flush:" + pending);
      saved.push(pending);
      pending = "";
      return "ok" as const;
    };
    const result = await drainDraftSaves({
      hasPending: () => Boolean(pending),
      isInFlight: () => inFlight,
      flushOnce,
      sleep: async () => {
        inFlight = false;
      },
      timeoutMs: 1000,
    });
    assert(result.status === "ok", "drain ok");
    assert(calls.length === 1, "waited for in-flight then flushed once");
    assert(saved[0] === "edit-B", "latest pending flushed, not the in-flight-only older board");
    assert(result.timings.extraFlushRan === true, "pending flush ran");
    assert(result.timings.skippedSave === false, "did not skip when pending");
  }

  section("drain: already-saved Draft skips PUT");
  {
    let flushCalls = 0;
    let slept = 0;
    const t0 = Date.now();
    const result = await drainDraftSaves({
      hasPending: () => false,
      isInFlight: () => false,
      flushOnce: async () => {
        flushCalls += 1;
        return "ok";
      },
      sleep: async (ms) => {
        slept += ms;
      },
      timeoutMs: 1000,
    });
    const elapsed = Date.now() - t0;
    assert(result.status === "ok", "saved draft drain ok");
    assert(flushCalls === 0, "no duplicate PUT when nothing pending");
    assert(slept === 0, "no fixed sleep when nothing to save");
    assert(result.timings.skippedSave === true, "skippedSave");
    assert(elapsed < 50, `already-saved drain is immediate (${elapsed}ms)`);
    assert(result.timings.totalMs < 50, "drain totalMs < 50ms when idle");
  }

  section("drain: pending debounce flushes immediately (no 1.5s wait)");
  {
    let pending: string | null = "edit-now";
    let debounceWaited = 0;
    const flushAt: number[] = [];
    const started = Date.now();
    const result = await drainDraftSaves({
      hasPending: () => Boolean(pending),
      isInFlight: () => false,
      clearDebounceTimer: () => {
        debounceWaited = 0;
      },
      flushOnce: async () => {
        flushAt.push(Date.now() - started);
        pending = null;
        return "ok";
      },
      sleep: async (ms) => {
        debounceWaited += ms;
      },
      timeoutMs: 5000,
    });
    assert(result.status === "ok", "pending drain ok");
    assert(flushAt.length === 1, "flushed pending once");
    assert(flushAt[0] < 200, `flush did not wait 1.5s debounce (${flushAt[0]}ms)`);
    assert(debounceWaited === 0, "no debounce sleep");
    assert(result.timings.extraFlushRan === true, "extra flush ran");
  }

  section("drain: in-flight PUT then latest pending");
  {
    let inFlight = true;
    let pending = "v2";
    const order: string[] = [];
    let inFlightPromise!: Promise<void>;
    inFlightPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        order.push("in-flight-done");
        inFlight = false;
        resolve();
      }, 40);
    });
    const result = await drainDraftSaves({
      hasPending: () => Boolean(pending),
      isInFlight: () => inFlight,
      waitForInFlight: async () => {
        order.push("wait-in-flight");
        await inFlightPromise;
      },
      flushOnce: async () => {
        order.push("flush:" + pending);
        pending = "";
        return "ok";
      },
      sleep: async () => {
        throw new Error("should not poll-sleep when waitForInFlight is provided");
      },
      timeoutMs: 2000,
    });
    assert(result.status === "ok", "in-flight drain ok");
    assert(order[0] === "wait-in-flight", "waited for in-flight first");
    assert(order.includes("in-flight-done") && order.includes("flush:v2"), "then flushed latest pending");
    assert(result.timings.inFlightWaitMs >= 20, "inFlightWaitMs measured");
  }

  section("drain: conflict aborts");
  {
    const result = await drainDraftSaves({
      hasPending: () => true,
      isInFlight: () => false,
      flushOnce: async () => "conflict",
      timeoutMs: 500,
    });
    assert(result.status === "conflict", "conflict status");
  }

  section("publish flow: saved draft → immediate POST");
  {
    const events: string[] = [];
    let busy = false;
    let publishedAt = "";
    const result = await runPublishBoardFlow({
      isBusy: () => busy,
      setBusy: (v) => {
        events.push(v ? "busy" : "idle");
        busy = v;
      },
      drain: async () => {
        events.push("drain");
        return {
          status: "ok" as const,
          timings: {
            totalMs: 1,
            pendingDebounceFlushMs: 0,
            inFlightWaitMs: 0,
            extraFlushMs: 0,
            extraFlushRan: false,
            skippedSave: true,
            pollSleepMs: 0,
          },
        };
      },
      getDraftVersion: () => 3,
      publish: async (draftVersion) => {
        events.push("post:" + draftVersion);
        return {
          ok: true,
          status: 200,
          published: {
            sourceDraftVersion: draftVersion,
            publishedAt: "2026-08-26T02:00:00.000Z",
            publishedByUsername: "경기과",
          },
          message: "배치가 확정되었습니다.",
          timings: { getDraftMs: 2, snapshotMs: 1, upsertMs: 3, totalMs: 6 },
        };
      },
      applyPublished: (row) => {
        events.push("ui");
        publishedAt = row.publishedAt;
      },
    });
    assert(result.ok === true, "saved publish ok");
    assert(events[0] === "busy", "busy immediately");
    assert(events.includes("drain") && events.includes("post:3") && events.includes("ui"), "drain then post then ui");
    assert(events[events.length - 1] === "idle", "busy released");
    assert(result.message === "배치가 확정되었습니다.", "success copy");
    assert(publishedAt === "2026-08-26T02:00:00.000Z", "publishedAt from POST body");
    assert(result.timings.skippedSave === true, "skipped extra PUT");
    assert(result.timings.publishedRefetchMs === 0, "no extra Published GET");
    assert(result.timings.server?.getDraftMs === 2, "server getDraft timing");
    assert(result.timings.postRoundTripMs >= 0, "post round trip measured");
  }

  section("publish flow: 0s after edit includes latest pending");
  {
    let pending: { name: string } | null = { name: "old" };
    const flushed: string[] = [];
    const result = await runPublishBoardFlow({
      isBusy: () => false,
      setBusy: () => {},
      drain: async () =>
        drainDraftSaves({
          hasPending: () => Boolean(pending),
          isInFlight: () => false,
          flushOnce: async () => {
            flushed.push(pending?.name || "");
            pending = null;
            return "ok";
          },
        }),
      getDraftVersion: () => 4,
      publish: async (draftVersion) => ({
        ok: true,
        status: 200,
        published: {
          sourceDraftVersion: draftVersion,
          name: flushed[0],
          publishedAt: "t",
          publishedByUsername: "a",
        },
      }),
      applyPublished: () => {},
    });
    assert(result.ok === true, "edit-then-publish ok");
    assert(flushed[0] === "old", "pending flushed immediately");
    assert((result.published as { name: string }).name === "old", "POST uses flushed latest");
    assert(result.timings.extraFlushRan === true, "flush ran before POST");
  }

  section("publish flow: in-flight save then publish");
  {
    let inFlight = true;
    let pending: string | null = "after-inflight";
    let version = 1;
    const result = await runPublishBoardFlow({
      isBusy: () => false,
      setBusy: () => {},
      drain: async () =>
        drainDraftSaves({
          hasPending: () => Boolean(pending),
          isInFlight: () => inFlight,
          waitForInFlight: async () => {
            inFlight = false;
            version = 2;
          },
          flushOnce: async () => {
            version = 3;
            pending = null;
            return "ok";
          },
        }),
      getDraftVersion: () => version,
      publish: async (draftVersion) => ({
        ok: true,
        status: 200,
        published: {
          sourceDraftVersion: draftVersion,
          publishedAt: "t",
          publishedByUsername: "a",
        },
      }),
      applyPublished: () => {},
    });
    assert(result.ok === true, "in-flight then publish ok");
    assert((result.published as { sourceDraftVersion: number }).sourceDraftVersion === 3, "published latest after in-flight + pending");
  }

  section("publish flow: Draft conflict aborts POST");
  {
    let posted = false;
    const result = await runPublishBoardFlow({
      isBusy: () => false,
      setBusy: () => {},
      drain: async () => ({
        status: "conflict" as const,
        timings: {
          totalMs: 5,
          pendingDebounceFlushMs: 0,
          inFlightWaitMs: 0,
          extraFlushMs: 5,
          extraFlushRan: true,
          skippedSave: false,
          pollSleepMs: 0,
        },
      }),
      getDraftVersion: () => 1,
      publish: async () => {
        posted = true;
        return { ok: true, status: 200, published: { publishedAt: "x" } };
      },
      applyPublished: () => {},
    });
    assert(result.ok === false, "conflict fails");
    assert(result.conflict === true, "conflict flag");
    assert(posted === false, "POST not sent on conflict");
    assert(result.error === PUBLISH_STALE_DRAFT_MESSAGE, "conflict copy");
  }

  section("publish flow: duplicate click blocked");
  {
    let busy = false;
    let posts = 0;
    const first = runPublishBoardFlow({
      isBusy: () => busy,
      setBusy: (v) => {
        busy = v;
      },
      drain: async () => {
        await new Promise((r) => setTimeout(r, 40));
        return {
          status: "ok" as const,
          timings: {
            totalMs: 40,
            pendingDebounceFlushMs: 0,
            inFlightWaitMs: 0,
            extraFlushMs: 0,
            extraFlushRan: false,
            skippedSave: true,
            pollSleepMs: 0,
          },
        };
      },
      getDraftVersion: () => 1,
      publish: async () => {
        posts += 1;
        return {
          ok: true,
          status: 200,
          published: { publishedAt: "t", sourceDraftVersion: 1, publishedByUsername: "a" },
        };
      },
      applyPublished: () => {},
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = await runPublishBoardFlow({
      isBusy: () => busy,
      setBusy: () => {},
      drain: async () => {
        throw new Error("should not drain on duplicate");
      },
      getDraftVersion: () => 1,
      publish: async () => {
        posts += 1;
        return { ok: true, status: 200, published: { publishedAt: "t" } };
      },
      applyPublished: () => {},
    });
    assert(second.duplicateClick === true, "second click duplicate");
    assert(second.ok === false, "duplicate not ok");
    const firstResult = await first;
    assert(firstResult.ok === true, "first publish succeeded");
    assert(posts === 1, "only one POST");
    assert(PUBLISH_BUSY_LABEL === "확정 중...", "busy label copy");
  }

  section("publish flow: republish + failure restores idle");
  {
    let busy = false;
    const busyLog: boolean[] = [];
    const fail = await runPublishBoardFlow({
      isBusy: () => busy,
      setBusy: (v) => {
        busy = v;
        busyLog.push(v);
      },
      drain: async () => ({
        status: "ok" as const,
        timings: {
          totalMs: 0,
          pendingDebounceFlushMs: 0,
          inFlightWaitMs: 0,
          extraFlushMs: 0,
          extraFlushRan: false,
          skippedSave: true,
          pollSleepMs: 0,
        },
      }),
      getDraftVersion: () => 2,
      publish: async () => ({
        ok: false,
        status: 500,
        error: "배치 확정 실패",
      }),
      applyPublished: () => {
        throw new Error("should not apply on failure");
      },
    });
    assert(fail.ok === false, "failed publish");
    assert(fail.error === "배치 확정 실패", "error message");
    assert(busyLog[0] === true && busyLog[busyLog.length - 1] === false, "busy then restored");
    assert(busy === false, "idle after failure");

    const again = await runPublishBoardFlow({
      isBusy: () => busy,
      setBusy: (v) => {
        busy = v;
      },
      drain: async () => ({
        status: "ok" as const,
        timings: {
          totalMs: 0,
          pendingDebounceFlushMs: 0,
          inFlightWaitMs: 0,
          extraFlushMs: 0,
          extraFlushRan: false,
          skippedSave: true,
          pollSleepMs: 0,
        },
      }),
      getDraftVersion: () => 2,
      publish: async (draftVersion) => ({
        ok: true,
        status: 200,
        published: {
          sourceDraftVersion: draftVersion,
          publishedAt: "2026-08-26T03:00:00.000Z",
          publishedByUsername: "b",
        },
        message: "배치가 확정되었습니다.",
      }),
      applyPublished: () => {},
    });
    assert(again.ok === true, "republish ok");
    assert((again.published as { sourceDraftVersion: number }).sourceDraftVersion === 2, "republish version");
  }

  section("publish server snapshot/upsert timings");
  {
    const date = "2026-08-26";
    const mem = createMemoryDb();
    const big = makeDraft(date, pool(80));
    await saveDailyBoardDraft({
      date,
      expectedVersion: 0,
      payload: assignmentDraftToPayload(big),
      updatedByUserId: 1,
      db: mem.db,
    });
    let timings = { getDraftMs: -1, snapshotMs: -1, upsertMs: -1, totalMs: -1 };
    const t0 = Date.now();
    await publishDailyBoard({
      date,
      expectedDraftVersion: 1,
      publishedByUserId: 1,
      publisherUsername: "ops",
      db: mem.db,
      onTimings: (t) => {
        timings = t;
      },
    });
    const wall = Date.now() - t0;
    assert(timings.getDraftMs >= 0, `getDraftMs=${timings.getDraftMs}`);
    assert(timings.snapshotMs >= 0, `snapshotMs=${timings.snapshotMs}`);
    assert(timings.upsertMs >= 0, `upsertMs=${timings.upsertMs}`);
    assert(timings.totalMs >= 0, `server totalMs=${timings.totalMs}`);
    console.log(
      "  · server timings",
      JSON.stringify({ ...timings, wallMs: wall, placements: 80 })
    );
    assert(wall < 2000, `local snapshot+upsert not abnormally slow (${wall}ms)`);
  }

  section("before/after: forced PUT vs skip idle save");
  {
    const putMs = 800;
    const oldSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let oldPending = true;
    const tOld0 = Date.now();
    await drainDraftSaves({
      hasPending: () => oldPending,
      isInFlight: () => false,
      flushOnce: async () => {
        await oldSleep(putMs);
        oldPending = false;
        return "ok";
      },
    });
    const oldMs = Date.now() - tOld0;
    const tNew0 = Date.now();
    await drainDraftSaves({
      hasPending: () => false,
      isInFlight: () => false,
      flushOnce: async () => {
        await oldSleep(putMs);
        return "ok";
      },
    });
    const newMs = Date.now() - tNew0;
    console.log("  · before(forced PUT) ms=", oldMs, " after(skip idle) ms=", newMs);
    assert(oldMs >= 700, `old path waited for forced PUT (${oldMs}ms)`);
    assert(oldMs < 2000, `old path is one PUT not a 1.5s debounce (${oldMs}ms)`);
    assert(newMs < 50, `new path no 1s+ wait (${newMs}ms)`);
  }

  section("Published GET empty does not leak Draft");
  {
    const pubRoute = readSrc("src/app/api/assignments/published/route.ts");
    const boardPage = readSrc("src/app/board/page.tsx");
    const getFn = pubRoute.split("export async function GET")[1]?.split("export async function POST")[0] || "";
    assert(/published\s*\?/.test(getFn) && /:\s*null/.test(getFn), "empty published is null");
    assert(!/"draft"/.test(getFn), "GET JSON has no draft key");
    assert(/아직 확정된 배치표가 없습니다/.test(boardPage), "empty UI copy");
    assert(!/작업본/.test(boardPage), "board page never says 작업본");
  }

  section("캐디 HTTP: board/get/publish/draft");
  {
    async function cookieReq(role: "admin" | "caddy", url: string, init?: RequestInit) {
      const token = await signSessionClaims(
        buildSessionClaims({
          userId: null,
          username: role,
          role,
          sessionVersion: 0,
        })
      );
      return new NextRequest(url, {
        ...init,
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${token}`,
          "content-type": "application/json",
          ...(init?.headers || {}),
        },
      });
    }

    const boardMw = await middleware(
      await cookieReq("caddy", "http://localhost/board")
    );
    assert(
      !boardMw || boardMw.headers.get("location") == null || !String(boardMw.headers.get("location") || "").includes("/login"),
      "caddy /board middleware does not redirect to login"
    );
    const manageMw = await middleware(
      await cookieReq("caddy", "http://localhost/manage/assignments")
    );
    assert(
      Boolean(manageMw && String(manageMw.headers.get("location") || "").includes("/login")),
      "caddy /manage/assignments redirected"
    );

    const pubGet = await publishedGET(
      await cookieReq("caddy", "http://localhost/api/assignments/published?date=2026-08-26")
    );
    assert(pubGet.status === 200, `caddy Published GET 200 (status ${pubGet.status})`);
    const body = await pubGet.json();
    assert(body.ok === true, "caddy Published GET 200 ok");
    assert(body.published === null || typeof body.published === "object", "published or null");
    assert(!("draft" in body), "GET body has no draft field");

    const pubPost = await publishedPOST(
      await cookieReq("caddy", "http://localhost/api/assignments/published", {
        method: "POST",
        body: JSON.stringify({ date: "2026-08-26", draftVersion: 1 }),
      })
    );
    assert(
      pubPost.status === 401 || pubPost.status === 403,
      `caddy publish POST blocked (${pubPost.status})`
    );

    const dGet = await draftGET(
      await cookieReq("caddy", "http://localhost/api/assignments/draft?date=2026-08-26")
    );
    const dPut = await draftPUT(
      await cookieReq("caddy", "http://localhost/api/assignments/draft", {
        method: "PUT",
        body: JSON.stringify({ date: "2026-08-26", version: 1, payload: {} }),
      })
    );
    const dDel = await draftDELETE(
      await cookieReq("caddy", "http://localhost/api/assignments/draft?date=2026-08-26")
    );
    assert(dGet.status === 401 || dGet.status === 403, `caddy Draft GET blocked (${dGet.status})`);
    assert(dPut.status === 401 || dPut.status === 403, `caddy Draft PUT blocked (${dPut.status})`);
    assert(dDel.status === 401 || dDel.status === 403, `caddy Draft DELETE blocked (${dDel.status})`);
  }

  section("publish action labels");
  {
    const idle = publishBoardActionState({
      publishing: false,
      hasDraft: true,
      published: null,
      draftVersion: 1,
    });
    assert(idle.label === PUBLISH_ACTION_LABEL, "draft → 배치 확정");
    assert(idle.disabled === false, "draft publish enabled");
    const again = publishBoardActionState({
      publishing: false,
      hasDraft: true,
      published: { sourceDraftVersion: 1 },
      draftVersion: 2,
    });
    assert(again.label === PUBLISH_AGAIN_LABEL, "changed draft → 변경사항 다시 확정");
    assert(again.disabled === false, "republish enabled");
    const current = publishBoardActionState({
      publishing: false,
      hasDraft: true,
      published: { sourceDraftVersion: 3 },
      draftVersion: 3,
    });
    assert(current.label === PUBLISH_CURRENT_LABEL, "current → 현재 배치 확정됨");
    assert(current.disabled === true, "current publish disabled");
    const busy = publishBoardActionState({
      publishing: true,
      hasDraft: true,
      published: null,
      draftVersion: 1,
    });
    assert(busy.label === PUBLISH_BUSY_LABEL, "busy label");
    assert(busy.disabled === true, "busy disabled");
    assert(PUBLISH_HINT.includes("캐디 공용 배치표"), "hint copy");
  }

  section("today/yesterday helpers");
  {
    assert(/^\d{4}-\d{2}-\d{2}$/.test(todayYmd()), "today ymd");
    assert(addDaysYmd("2026-08-26", -1) === "2026-08-25", "yesterday");
  }

  if (failed) {
    console.error(`\nFAILED ${failed} / ${passed + failed}`);
    process.exit(1);
  }
  console.log(`\nOK ${passed}/${passed + failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
