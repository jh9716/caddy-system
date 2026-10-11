// src/prisma.ts
import { PrismaClient } from "@prisma/client";
import { assertAppDatabaseUrl } from "./lib/dbSafety";
import {
  assertIsolatedPreview296DatabaseUrl,
  isPreview296VercelBuild,
} from "./lib/preview296Isolation";

if (isPreview296VercelBuild()) {
  assertIsolatedPreview296DatabaseUrl(process.env.DATABASE_URL);
}
assertAppDatabaseUrl(process.env.DATABASE_URL);

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
