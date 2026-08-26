/**
 * LOCAL DB ONLY — disposable __IMPORT_V2_TEST__ rows. Never Production.
 */
import { PrismaClient } from "@prisma/client";
import {
  applyRosterImportPayloadV2,
  buildRosterImportPreviewV2,
  parseRosterCsvV2,
} from "../lib/caddyRosterImportV2";
import { assertLocalFixtureDatabase } from "./assertLocalDatabaseUrl";

const prisma = new PrismaClient();
const TAG = "__IMPORT_V2_TEST__";

async function main() {
  assertLocalFixtureDatabase(process.env.DATABASE_URL);

  await prisma.caddy.deleteMany({ where: { name: { startsWith: TAG } } });

  const a = await prisma.caddy.create({
    data: {
      name: `${TAG}A`,
      team: "9조",
      teamOrder: 1,
      employmentStatus: "ACTIVE",
      phoneNormalized: null,
    },
  });
  const b = await prisma.caddy.create({
    data: {
      name: `${TAG}B`,
      team: "9조",
      teamOrder: 2,
      employmentStatus: "ACTIVE",
      phoneNormalized: "01088887777",
    },
  });

  const beforeAssign = await prisma.assignment.count();
  const beforeSched = await prisma.schedule.count();

  const csv = [
    "id,name,team,teamOrder,employmentStatus,phone",
    `${a.id},${TAG}A,10조,1,ACTIVE,01012345678`,
    `${b.id},${TAG}B,9조,2,LEAVE,`,
    `,${TAG}C,10조,2,ACTIVE,`,
  ].join("\n");

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
  const preview = buildRosterImportPreviewV2(
    parseRosterCsvV2(csv),
    existing.map((e) => ({
      ...e,
      employmentStatus: String(e.employmentStatus),
    }))
  );
  console.log("preview", JSON.stringify(preview.summary));
  if (preview.summary.applyBlocked) {
    console.error(
      "blocked",
      preview.needsReview,
      preview.teamOrderConflicts,
      preview.phoneIssues
    );
    process.exit(1);
  }

  const result = await applyRosterImportPayloadV2(
    preview.applyPayload,
    prisma,
    {
      existingForGuard: existing.map((e) => ({
        ...e,
        employmentStatus: String(e.employmentStatus),
      })),
    }
  );
  console.log("apply", result);

  const a2 = await prisma.caddy.findUnique({ where: { id: a.id } });
  const b2 = await prisma.caddy.findUnique({ where: { id: b.id } });
  const c = await prisma.caddy.findFirst({ where: { name: `${TAG}C` } });
  console.log("a", {
    id: a2?.id,
    team: a2?.team,
    phone: a2?.phoneNormalized,
  });
  console.log("b", {
    id: b2?.id,
    team: b2?.team,
    emp: b2?.employmentStatus,
    phone: b2?.phoneNormalized,
  });
  console.log("c", { id: c?.id, team: c?.team, order: c?.teamOrder });

  const afterAssign = await prisma.assignment.count();
  const afterSched = await prisma.schedule.count();
  console.log("relations", {
    beforeAssign,
    afterAssign,
    beforeSched,
    afterSched,
    assignOk: beforeAssign === afterAssign,
    schedOk: beforeSched === afterSched,
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
