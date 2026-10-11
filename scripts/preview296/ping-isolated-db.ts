import { PrismaClient } from "@prisma/client";
import { assertIsolatedPreview296DatabaseUrl } from "../../src/lib/preview296Isolation";

const url = assertIsolatedPreview296DatabaseUrl(
  process.env.PREVIEW296_DATABASE_URL || process.env.DATABASE_URL
);
if (new URL(url).hostname === "localhost" || new URL(url).hostname === "127.0.0.1") {
  throw new Error("preview296 ping refused localhost DATABASE_URL");
}
const prisma = new PrismaClient({ datasources: { db: { url } } });

async function main() {
  const users = await prisma.user.findMany({
    select: { id: true, username: true, role: true, caddyId: true },
    orderBy: { id: "asc" },
  });
  const host = new URL(url).hostname;
  console.log(JSON.stringify({ ok: true, host, users }));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
