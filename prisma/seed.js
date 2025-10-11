import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const adminUsername = process.env.ADMIN_USERNAME || "admin";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin1234";
  const caddyUsername = process.env.CADDY_USERNAME || "caddy";
  const caddyPassword = process.env.CADDY_PASSWORD || "caddy1234";

  // Admin
  const adminHash = await bcrypt.hash(adminPassword, 10);
  await prisma.user.upsert({
    where: { username: adminUsername },
    update: { password: adminHash, role: "ADMIN" },
    create: { username: adminUsername, password: adminHash, role: "ADMIN" },
  });

  // Staff
  const caddyHash = await bcrypt.hash(caddyPassword, 10);
  await prisma.user.upsert({
    where: { username: caddyUsername },
    update: { password: caddyHash, role: "STAFF" },
    create: { username: caddyUsername, password: caddyHash, role: "STAFF" },
  });

  console.log("Seed complete ✅");
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => { console.error(e); return prisma.$disconnect(); });
