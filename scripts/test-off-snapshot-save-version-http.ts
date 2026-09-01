/**
 * Own offSnapshot Draft PUT vs SICK persist version.
 * Same-client: drain/save snapshot then persist at new version → 200, no 409.
 * Other-client: persist at the pre-save version → 409 kept.
 * caddy_local only. Production write forbidden.
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
  createDraftFromAutoResult,
  type AssignmentDraft,
} from "../src/lib/assignmentDraft";
import {
  assignmentDraftToPayload,
  payloadToAssignmentDraft,
} from "../src/lib/dailyBoardDraft";
import { getDailyBoardDraft, saveDailyBoardDraft } from "../src/lib/dailyBoardDraftService";
import {
  makeMutationIntent,
  prepareIntentOnConfirmedDraft,
} from "../src/lib/boardMutationPipeline";
import { persistAfterOwnDraftFlush } from "../src/lib/draftSaveFlush";
import { buildOffSnapshot } from "../src/lib/offSnapshot";

const BASE = "http://localhost:3000";
const DATE = "2099-12-23";
const day = parseYmd(DATE).start;
const HOUSE_START = 13;

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
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), cookie: cookie.current },
  });
  cookie.current = parseCookies(res, cookie.current);
  return { status: res.status, json: await res.json().catch(() => null) };
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
    payload: assignmentDraftToPayload(draft),
    updatedByUserId: null,
  });
}

async function seed() {
  const wanted = [HOUSE_START, 19, 20, 21, 14, 15];
  const caddies = await prisma.caddy.findMany({
    where: { id: { in: wanted }, employmentStatus: "ACTIVE", caddyType: "HOUSE" },
  });
  const byId = new Map(caddies.map((c) => [c.id, c]));
  const pool: AutoAssignCaddy[] = wanted
    .map((id) => byId.get(id))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .map((c, i) => ({
      id: c.id,
      name: c.name,
      team: `${i + 1}조`,
      teamOrder: i + 1,
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
      { date: DATE, course: "OCEAN", shift: "1부", teeTime: "07:00", teamName: "B팀", rawRowIndex: 2, sourceSheet: "예약1부" },
      { date: DATE, course: "LAKE", shift: "1부", teeTime: "07:00", teamName: "C팀", rawRowIndex: 3, sourceSheet: "예약1부" },
    ],
  });
  const draft = {
    ...createDraftFromAutoResult(result, pool),
    offSnapshot: buildOffSnapshot({ date: DATE, caddyIds: [] }),
  };
  const saved = await persistLiveFromDraft(draft);
  return { draft, version: saved.version };
}

async function putSnapshot(
  cookie: { current: string },
  draft: AssignmentDraft,
  version: number
) {
  const next = {
    ...draft,
    offSnapshot: buildOffSnapshot({ date: DATE, caddyIds: [99] }),
  };
  return req(cookie, "/api/assignments/draft", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      date: DATE,
      version,
      payload: assignmentDraftToPayload(next),
    }),
  });
}

async function postSick(
  cookie: { current: string },
  confirmed: AssignmentDraft,
  version: number
) {
  const intent = makeMutationIntent(
    { type: "CADDY_SICK", caddyId: HOUSE_START, shift: "1부" },
    `snap-${Date.now()}`
  )!;
  const prepared = prepareIntentOnConfirmedDraft({
    confirmedDraft: confirmed,
    intent,
  });
  if (!prepared.ok) return { prepared, status: 0, json: null as null };
  const res = await req(cookie, "/api/assignments/reflow/quick-mutation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      previous: prepared.previous,
      regularCaddyPool: confirmed.caddyPool,
      events: prepared.preview.events,
      changeType: prepared.preview.changeType,
      change: intent.change,
      draft: {
        date: DATE,
        version,
        payload: assignmentDraftToPayload(confirmed),
      },
    }),
  });
  return { prepared, ...res };
}

async function main() {
  assert(persistAfterOwnDraftFlush("ok") === "persist", "ok allows persist");
  assert(
    persistAfterOwnDraftFlush("conflict") === "conflict",
    "external conflict blocks persist"
  );

  const cookie = { current: "" };
  const login = await req(cookie, "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin1234" }),
  });
  if (login.status !== 200) throw new Error(`login ${login.status}`);

  console.log("\n== same client: snapshot save then SICK at new version ==");
  {
    const seeded = await seed();
    const staleVersion = seeded.version;
    const snap = await putSnapshot(cookie, seeded.draft, seeded.version);
    assert(snap.status === 200, `own offSnapshot PUT 200 (v${staleVersion}→)`);
    const newVersion = Number(snap.json?.draft?.version);
    assert(newVersion === staleVersion + 1, `own save promoted version ${newVersion}`);
    const withSnap = {
      ...seeded.draft,
      offSnapshot: buildOffSnapshot({ date: DATE, caddyIds: [99] }),
    };
    const sick = await postSick(cookie, withSnap, newVersion);
    assert(sick.status === 200, "SICK persist 200 without 409 after own snapshot save");
    assert(sick.status !== 409, "same-client snapshot save is not external 409");
    const row = await getDailyBoardDraft(DATE);
    const reloaded = payloadToAssignmentDraft(row!.payload);
    assert(row!.version === newVersion + 1, "SICK bumped version after snapshot");
    assert(
      !reloaded.assignments.some((a) => a.caddy.id === HOUSE_START),
      "reload keeps SICK"
    );
  }

  console.log("\n== other client: SICK at stale version after snapshot save ==");
  {
    const seeded = await seed();
    const staleVersion = seeded.version;
    const snap = await putSnapshot(cookie, seeded.draft, seeded.version);
    assert(snap.status === 200, "other-client snapshot write 200");
    const sick = await postSick(cookie, seeded.draft, staleVersion);
    assert(sick.status === 409, "stale version SICK still 409");
    assert(
      String(sick.json?.code || sick.json?.error || "").includes("DRAFT_VERSION_CONFLICT"),
      "409 keeps DRAFT_VERSION_CONFLICT"
    );
    const row = await getDailyBoardDraft(DATE);
    assert(
      payloadToAssignmentDraft(row!.payload).assignments.some(
        (a) => a.caddy.id === HOUSE_START
      ),
      "stale SICK did not overwrite other-client Draft"
    );
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
