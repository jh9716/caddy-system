/**
 * Local HTTP race for Board Mutation Pipeline v1.
 * Uses 3–8s server delay. caddy_local only.
 */
import { assertLocalFixtureDatabase } from "../src/lib/dbSafety";
assertLocalFixtureDatabase(process.env.DATABASE_URL);

import { prisma } from "../src/lib/prisma";
import { parseYmd } from "../src/lib/availabilityEngine";
import {
  computeAutoAssignmentsV1,
  reservationKey,
  type AutoAssignCaddy,
} from "../src/lib/autoAssignEngine";
import {
  applyLiveResultToDraft,
  createDraftFromAutoResult,
  type AssignmentDraft,
} from "../src/lib/assignmentDraft";
import {
  assignmentDraftToPayload,
  payloadToAssignmentDraft,
} from "../src/lib/dailyBoardDraft";
import { getDailyBoardDraft, saveDailyBoardDraft } from "../src/lib/dailyBoardDraftService";
import {
  makeMoveReservationChange,
} from "../src/lib/assignmentChange";
import {
  makeMutationIntent,
  prepareIntentOnConfirmedDraft,
} from "../src/lib/boardMutationPipeline";
import { buildOffSnapshot, isUsableOffSnapshot } from "../src/lib/offSnapshot";

function withOffSnapshot(draft: AssignmentDraft): AssignmentDraft {
  if (isUsableOffSnapshot(draft.offSnapshot, draft.date)) return draft;
  return {
    ...draft,
    offSnapshot: buildOffSnapshot({ date: draft.date, caddyIds: [] }),
  };
}

const BASE = "http://localhost:3000";
const DATE = "2099-12-21";
const day = parseYmd(DATE).start;
const HOUSE_START = 13;
const PULL = 19;
const RESET_TRAP = 1;
const DELAY_MS = 3500;

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

function parseCookies(res: Response, prev: string): string {
  const getSetCookie = (
    res.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  const list = getSetCookie ? getSetCookie.call(res.headers) : [];
  const raw = list.length ? list : [res.headers.get("set-cookie") || ""];
  const map = new Map<string, string>();
  for (const part of prev
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [k, ...rest] = part.split("=");
    map.set(k, rest.join("="));
  }
  for (const header of raw) {
    if (!header) continue;
    const first = header.split(";")[0];
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    map.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function req(
  cookie: { current: string },
  path: string,
  init: RequestInit = {}
) {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), cookie: cookie.current },
  });
  cookie.current = parseCookies(res, cookie.current);
  return {
    status: res.status,
    json: await res.json().catch(() => null),
    ms: Date.now() - started,
  };
}

function names(draft: AssignmentDraft) {
  return draft.assignments
    .filter((a) => a.shift === "1부" && a.kind === "regular")
    .sort((a, b) => a.sequenceIndex - b.sequenceIndex)
    .map((a) => a.caddy.name);
}

async function persistLiveFromDraft(draft: AssignmentDraft) {
  await prisma.dailyPlacement.deleteMany({ where: { date: day } });
  await prisma.dailyReservation.deleteMany({ where: { date: day } });
  await prisma.dailyCaddyUnavailable.deleteMany({ where: { date: day } });
  await prisma.dailyAssignmentChange.deleteMany({ where: { date: day } });
  await prisma.dailyBoardDraft.deleteMany({ where: { date: day } });
  for (const row of draft.assignments) {
    const created = await prisma.dailyReservation.create({
      data: {
        date: day,
        course: row.reservation.course,
        shift: String(row.shift || row.reservation.shift),
        teeTime: row.reservation.teeTime,
        teamName: row.reservation.teamName ?? null,
        identityKey: reservationKey(row.reservation),
        source: row.reservation.sourceSheet ?? null,
        rawRowIndex: row.reservation.rawRowIndex ?? null,
        status: "ACTIVE",
      },
    });
    await prisma.dailyPlacement.create({
      data: {
        date: day,
        reservationId: created.id,
        caddyId: row.caddy.id,
        kind: row.kind,
        sequenceIndex: row.sequenceIndex,
        pairId: row.pairId ?? null,
        locked: false,
      },
    });
  }
  return saveDailyBoardDraft({
    date: DATE,
    expectedVersion: 0,
    payload: assignmentDraftToPayload(withOffSnapshot(draft)),
    updatedByUserId: null,
  });
}

async function seed() {
  const wanted = [RESET_TRAP, HOUSE_START, PULL, 20, 21, 22, 23, 14, 15];
  const caddies = await prisma.caddy.findMany({
    where: { id: { in: wanted }, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
  });
  const byId = new Map(caddies.map((c) => [c.id, c]));
  const order = new Map(wanted.map((id, i) => [id, i]));
  const pool: AutoAssignCaddy[] = wanted
    .map((id) => byId.get(id))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .map((c) => ({
      id: c.id,
      name: c.name,
      team: `${order.get(c.id) ?? c.teamOrder}조`,
      teamOrder: order.get(c.id) ?? c.teamOrder,
      caddyType: String(c.caddyType),
      employmentStatus: String(c.employmentStatus),
    }));
  const result = computeAutoAssignmentsV1({
    date: DATE,
    available: pool,
    openCourses: ["VERTHILL", "SKY", "OCEAN", "LAKE"],
    houseStartCaddyId: HOUSE_START,
    reservations: [
      { date: DATE, course: "SKY", shift: "1부", teeTime: "07:00", teamName: "A팀", rawRowIndex: 1, sourceSheet: "예약1부" },
      { id: "db-b", date: DATE, course: "OCEAN", shift: "1부", teeTime: "07:00", teamName: "B팀", rawRowIndex: 2, sourceSheet: "예약1부" },
      { date: DATE, course: "LAKE", shift: "1부", teeTime: "07:00", teamName: "C팀", rawRowIndex: 3, sourceSheet: "예약1부" },
      { date: DATE, course: "VERTHILL", shift: "1부", teeTime: "07:08", teamName: "D팀", rawRowIndex: 4, sourceSheet: "예약1부" },
    ],
  });
  const draft = createDraftFromAutoResult(result, pool);
  const saved = await persistLiveFromDraft(draft);
  return { draft, pool, version: saved.version };
}

async function postMutation(
  cookie: { current: string },
  confirmed: AssignmentDraft,
  change: Parameters<typeof makeMutationIntent>[0],
  version: number,
  extra: { testDelayMs?: number; testFailLive?: "error" | null } = {}
) {
  const intent = makeMutationIntent(change, `http-${Date.now()}`)!;
  const prepared = prepareIntentOnConfirmedDraft({
    confirmedDraft: confirmed,
    intent,
  });
  if (!prepared.ok) {
    return { prepared, status: 0, json: null as null, ms: 0 };
  }
  const res = await req(cookie, "/api/assignments/reflow/quick-mutation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      previous: prepared.previous,
      regularCaddyPool: confirmed.caddyPool,
      events: prepared.preview.events,
      changeType: prepared.preview.changeType,
      change,
      draft: {
        date: DATE,
        version,
        payload: assignmentDraftToPayload(withOffSnapshot(prepared.painted)),
      },
      testDelayMs: extra.testDelayMs ?? 0,
      testFailLive: extra.testFailLive ?? null,
    }),
  });
  return { prepared, ...res };
}

async function reload() {
  const row = await getDailyBoardDraft(DATE);
  if (!row) throw new Error("draft missing");
  const placements = await prisma.dailyPlacement.findMany({
    where: { date: day },
    include: { reservation: true },
  });
  const unavail = await prisma.dailyCaddyUnavailable.findMany({
    where: { date: day },
  });
  return {
    version: row.version,
    draft: payloadToAssignmentDraft(row.payload),
    placementNames: placements
      .filter((p) => p.reservation.shift === "1부")
      .sort((a, b) => a.sequenceIndex - b.sequenceIndex)
      .map((p) => `${p.reservation.teamName}:${p.caddyId}`),
    unavailableIds: unavail.map((u) => u.caddyId).sort((a, b) => a - b),
  };
}

async function main() {
  const cookie = { current: "" };
  const login = await req(cookie, "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin1234" }),
  });
  if (login.status !== 200) throw new Error(`login ${login.status}`);

  console.log("\n== Case A: MOVE in flight → SICK ==");
  {
    const seeded = await seed();
    const a = seeded.draft.assignments.find((x) => x.reservation.teamName === "A팀")!;
    const moveChange = makeMoveReservationChange({
      reservationKey: reservationKey(a.reservation),
      to: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
    });
    const moveP = postMutation(cookie, seeded.draft, moveChange, seeded.version, {
      testDelayMs: DELAY_MS,
    });
    const t0 = Date.now();
    const sickPrepared = prepareIntentOnConfirmedDraft({
      confirmedDraft: seeded.draft,
      intent: makeMutationIntent(
        { type: "CADDY_SICK", caddyId: HOUSE_START, shift: "1부" },
        "sick-while-move"
      )!,
    });
    assert(sickPrepared.ok === true, "SICK projects while MOVE is in flight");
    assert(Date.now() - t0 < 100, `SICK optimistic prepare <100ms (${Date.now() - t0}ms)`);
    const move = await moveP;
    assert(move.status === 200, `MOVE 200 after ${move.ms}ms delay`);
    assert(move.ms >= 3000, "MOVE held for artificial delay");
    if (!move.prepared.ok || !move.json?.draft) throw new Error("move");
    const confirmed = applyLiveResultToDraft(
      move.prepared.painted,
      move.json.preview.after
    );
    const sick = await postMutation(
      cookie,
      confirmed,
      { type: "CADDY_SICK", caddyId: HOUSE_START, shift: "1부" },
      Number(move.json.draft.version)
    );
    assert(sick.status === 200, "SICK 200 on latest confirmed");
    const live = await reload();
    const aRow = live.draft.assignments.find((x) => x.reservation.teamName === "A팀");
    assert(aRow?.reservation.course === "VERTHILL", "A move kept");
    assert(!names(live.draft).includes("서승희"), "서승희 gone");
    assert(names(live.draft)[0] === "김하나1", "김하나1 pulled forward");
    assert(!names(live.draft).includes("이영진"), "no 1조 reset");
    assert(live.unavailableIds.includes(HOUSE_START), "unavailable matches Draft");
    assert(
      !live.placementNames.some((row) => row.endsWith(`:${HOUSE_START}`)),
      "Placement has no 서승희"
    );
  }

  console.log("\n== Case B: SICK in flight → MOVE ==");
  {
    const seeded = await seed();
    const sickP = postMutation(
      cookie,
      seeded.draft,
      { type: "CADDY_SICK", caddyId: HOUSE_START, shift: "1부" },
      seeded.version,
      { testDelayMs: DELAY_MS }
    );
    const sick = await sickP;
    assert(sick.status === 200, `SICK 200 after ${sick.ms}ms delay`);
    if (!sick.prepared.ok || !sick.json?.draft) throw new Error("sick");
    const confirmed = applyLiveResultToDraft(
      sick.prepared.painted,
      sick.json.preview.after
    );
    const a = confirmed.assignments.find((x) => x.reservation.teamName === "A팀")!;
    const move = await postMutation(
      cookie,
      confirmed,
      makeMoveReservationChange({
        reservationKey: reservationKey(a.reservation),
        reservationId: a.reservation.id,
        to: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
      }),
      Number(sick.json.draft.version)
    );
    assert(move.status === 200, "MOVE 200 after SICK");
    const live = await reload();
    const aRow = live.draft.assignments.find((x) => x.reservation.teamName === "A팀");
    assert(aRow?.reservation.course === "VERTHILL", "MOVE kept");
    assert(!names(live.draft).includes("서승희"), "SICK kept");
  }

  console.log("\n== Case C: MOVE 200 then SICK 500 ==");
  {
    const seeded = await seed();
    const a = seeded.draft.assignments.find((x) => x.reservation.teamName === "A팀")!;
    const move = await postMutation(
      cookie,
      seeded.draft,
      makeMoveReservationChange({
        reservationKey: reservationKey(a.reservation),
        to: { course: "VERTHILL", shift: "1부", teeTime: "07:00" },
      }),
      seeded.version
    );
    assert(move.status === 200, "MOVE 200");
    if (!move.prepared.ok || !move.json?.draft) throw new Error("move");
    const confirmed = applyLiveResultToDraft(
      move.prepared.painted,
      move.json.preview.after
    );
    const sick = await postMutation(
      cookie,
      confirmed,
      { type: "CADDY_SICK", caddyId: HOUSE_START, shift: "1부" },
      Number(move.json.draft.version),
      { testFailLive: "error" }
    );
    assert(sick.status === 500, "SICK forced 500");
    const live = await reload();
    const aRow = live.draft.assignments.find((x) => x.reservation.teamName === "A팀");
    assert(aRow?.reservation.course === "VERTHILL", "MOVE kept after SICK 500");
    assert(names(live.draft).includes("서승희"), "SICK not applied; no snapshot rollback");
  }

  console.log("\n== Case D: SICK 200 then MOVE dest collision ==");
  {
    const seeded = await seed();
    const sick = await postMutation(
      cookie,
      seeded.draft,
      { type: "CADDY_SICK", caddyId: HOUSE_START, shift: "1부" },
      seeded.version
    );
    if (!sick.prepared.ok || !sick.json?.draft) throw new Error("sick");
    const confirmed = applyLiveResultToDraft(
      sick.prepared.painted,
      sick.json.preview.after
    );
    const b = confirmed.assignments.find((x) => x.reservation.teamName === "B팀")!;
    const a = confirmed.assignments.find((x) => x.reservation.teamName === "A팀")!;
    const move = await postMutation(
      cookie,
      confirmed,
      makeMoveReservationChange({
        reservationKey: reservationKey(b.reservation),
        reservationId: b.reservation.id,
        to: {
          course: a.reservation.course,
          shift: "1부",
          teeTime: a.reservation.teeTime,
        },
      }),
      Number(sick.json.draft.version)
    );
    assert(move.prepared.ok === false || move.status >= 400, "MOVE dest blocked");
    const live = await reload();
    assert(!names(live.draft).includes("서승희"), "SICK kept after blocked MOVE");
  }

  console.log("\n== Case E: two sicks serial ==");
  {
    const seeded = await seed();
    const first = await postMutation(
      cookie,
      seeded.draft,
      { type: "CADDY_SICK", caddyId: HOUSE_START, shift: "1부" },
      seeded.version,
      { testDelayMs: DELAY_MS }
    );
    assert(first.status === 200, "first SICK 200");
    if (!first.prepared.ok || !first.json?.draft) throw new Error("s1");
    const confirmed = applyLiveResultToDraft(
      first.prepared.painted,
      first.json.preview.after
    );
    const second = await postMutation(
      cookie,
      confirmed,
      { type: "CADDY_SICK", caddyId: PULL, shift: "1부" },
      Number(first.json.draft.version)
    );
    assert(second.status === 200, "second SICK 200 on latest queue");
    const live = await reload();
    assert(!names(live.draft).includes("서승희"), "first sick stays gone");
    assert(!names(live.draft).includes("김하나1"), "second sick stays gone");
    assert(live.version > first.json.draft.version, "version monotonic");
  }

  await prisma.$disconnect();
  console.log(`\nHTTP DONE: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
