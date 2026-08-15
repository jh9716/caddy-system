/**
 * LOCAL DB ONLY — fixed-slot phase1 smoke. Never Production.
 * Uses disposable __SLOT_P1__* names.
 */
import { PrismaClient } from "@prisma/client";
import {
  applyRosterImportPayloadV2,
  buildRosterImportPreviewV2,
  parseRosterCsvV2,
} from "../lib/caddyRosterImportV2";

const prisma = new PrismaClient();
const TAG = "__SLOT_P1__";

async function main() {
  const url = process.env.DATABASE_URL || "";
  if (
    !url.includes("localhost") &&
    !url.includes("127.0.0.1") &&
    !url.includes("caddy_local")
  ) {
    throw new Error("Refusing non-local DATABASE_URL");
  }

  await prisma.caddy.deleteMany({ where: { name: { startsWith: TAG } } });

  const a = await prisma.caddy.create({
    data: {
      name: `${TAG}A`,
      team: "11조",
      teamOrder: 1,
      employmentStatus: "ACTIVE",
    },
  });
  const b = await prisma.caddy.create({
    data: {
      name: `${TAG}B`,
      team: "11조",
      teamOrder: 2,
      employmentStatus: "ACTIVE",
    },
  });
  const c = await prisma.caddy.create({
    data: {
      name: `${TAG}C`,
      team: "11조",
      teamOrder: 3,
      employmentStatus: "ACTIVE",
    },
  });

  // 퇴사 → 슬롯 빈자리 (다른 순번 불변)
  await prisma.caddy.update({
    where: { id: b.id },
    data: { employmentStatus: "RETIRED" },
  });
  const afterRetire = await prisma.caddy.findMany({
    where: { name: { startsWith: TAG } },
    orderBy: { id: "asc" },
  });
  const a1 = afterRetire.find((x) => x.id === a.id)!;
  const c1 = afterRetire.find((x) => x.id === c.id)!;
  if (a1.teamOrder !== 1 || c1.teamOrder !== 3) {
    throw new Error("retire changed other teamOrders");
  }

  // LEAVE keeps slot
  await prisma.caddy.update({
    where: { id: c.id },
    data: { employmentStatus: "LEAVE" },
  });

  // 신규 → 빈 슬롯 2
  const n = await prisma.caddy.create({
    data: {
      name: `${TAG}N`,
      team: "11조",
      teamOrder: 2,
      employmentStatus: "ACTIVE",
    },
  });
  if (n.teamOrder !== 2) throw new Error("new not in slot 2");

  // ACTIVE/LEAVE 충돌: C is LEAVE on 3 — cannot put another on 3
  const existing = await prisma.caddy.findMany({
    select: {
      id: true,
      name: true,
      team: true,
      teamOrder: true,
      employmentStatus: true,
      phoneNormalized: true,
    },
  });
  const conflictPreview = buildRosterImportPreviewV2(
    parseRosterCsvV2(
      [
        "id,name,team,teamOrder,employmentStatus,phone",
        `,${TAG}X,11조,3,ACTIVE,`,
      ].join("\n")
    ),
    existing.map((e) => ({
      ...e,
      employmentStatus: String(e.employmentStatus),
    }))
  );
  if (!conflictPreview.summary.applyBlocked) {
    throw new Error("expected LEAVE slot conflict block");
  }

  // RETIRED B's old slot was 2 — now occupied by N; B still has teamOrder 2 in DB but retired
  // Move A: 11조1 → 12조 5 (empty)
  await prisma.caddy.update({
    where: { id: a.id },
    data: { team: "12조", teamOrder: 5 },
  });
  const aMoved = await prisma.caddy.findUnique({ where: { id: a.id } });
  if (aMoved?.team !== "12조" || aMoved.teamOrder !== 5) {
    throw new Error("team move failed");
  }
  const stillN = await prisma.caddy.findUnique({ where: { id: n.id } });
  if (stillN?.teamOrder !== 2 || stillN.team !== "11조") {
    throw new Error("other slots changed on move");
  }

  // Import create into empty 11조1 (A left) — distinct name avoids typo/needsReview
  const preview2 = buildRosterImportPreviewV2(
    parseRosterCsvV2(
      [
        "id,name,team,teamOrder,employmentStatus,phone",
        `,${TAG}신규입사,11조,1,ACTIVE,`,
      ].join("\n")
    ),
    (
      await prisma.caddy.findMany({
        select: {
          id: true,
          name: true,
          team: true,
          teamOrder: true,
          employmentStatus: true,
          phoneNormalized: true,
        },
      })
    ).map((e) => ({ ...e, employmentStatus: String(e.employmentStatus) }))
  );
  if (preview2.summary.applyBlocked) {
    console.error(preview2.needsReview, preview2.teamOrderConflicts);
    throw new Error("create into empty slot should be allowed");
  }
  const applied = await applyRosterImportPayloadV2(
    preview2.applyPayload,
    prisma as any
  );
  if (applied.created !== 1) throw new Error("expected 1 create");

  const y = await prisma.caddy.findFirst({
    where: { name: `${TAG}신규입사` },
  });
  if (!y || y.teamOrder !== 1 || y.team !== "11조") {
    throw new Error("imported Y not in slot 1");
  }

  // same-team empty move: N 2 → 7, slot 2 becomes empty, others unchanged
  const beforeMove = await prisma.caddy.findMany({
    where: { name: { startsWith: TAG }, team: "11조" },
  });
  const ordersBefore = Object.fromEntries(
    beforeMove.map((x) => [x.id, x.teamOrder])
  );
  await prisma.caddy.update({
    where: { id: n.id },
    data: { teamOrder: 7 },
  });
  const afterMove = await prisma.caddy.findMany({
    where: { name: { startsWith: TAG }, team: "11조" },
  });
  const nAfter = afterMove.find((x) => x.id === n.id)!;
  if (nAfter.teamOrder !== 7) throw new Error("same-team move to 7 failed");
  for (const row of afterMove) {
    if (row.id === n.id) continue;
    if (row.teamOrder !== ordersBefore[row.id]) {
      throw new Error(`other teamOrder changed: ${row.name}`);
    }
  }
  if (afterMove.some((x) => x.id !== n.id && x.teamOrder === 2 && x.employmentStatus !== "RETIRED")) {
    // only RETIRED B may still have teamOrder 2 historically
  }
  const holdersOn2 = afterMove.filter(
    (x) =>
      x.teamOrder === 2 &&
      (x.employmentStatus === "ACTIVE" || x.employmentStatus === "LEAVE")
  );
  if (holdersOn2.length !== 0) throw new Error("slot 2 should be empty after move");

  // slot 24 new entry
  const s24 = await prisma.caddy.create({
    data: {
      name: `${TAG}S24`,
      team: "11조",
      teamOrder: 24,
      employmentStatus: "ACTIVE",
    },
  });
  if (s24.teamOrder !== 24) throw new Error("slot 24 create failed");

  // over-capacity create blocked by preview
  const overPreview = buildRosterImportPreviewV2(
    parseRosterCsvV2(
      [
        "id,name,team,teamOrder,employmentStatus,phone",
        `,${TAG}Over,11조,25,ACTIVE,`,
      ].join("\n")
    ),
    (
      await prisma.caddy.findMany({
        select: {
          id: true,
          name: true,
          team: true,
          teamOrder: true,
          employmentStatus: true,
          phoneNormalized: true,
        },
      })
    ).map((e) => ({ ...e, employmentStatus: String(e.employmentStatus) }))
  );
  if (!overPreview.summary.applyBlocked) {
    throw new Error("teamOrder 25 should be blocked");
  }

  console.log("slot-p1 smoke OK", {
    retiredB: b.id,
    leaveC: c.id,
    newN: n.id,
    movedA: a.id,
    createdY: y.id,
    slot24: s24.id,
    sameTeamMove: "2→7",
  });

  await prisma.caddy.deleteMany({ where: { name: { startsWith: TAG } } });
  console.log("cleaned");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
