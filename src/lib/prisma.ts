import { PrismaClient } from '@prisma/client';
import { assertAppDatabaseUrl } from './dbSafety';
import {
  assertIsolatedPreview296DatabaseUrl,
  isPreview296VercelBuild,
} from './preview296Isolation';

if (isPreview296VercelBuild()) {
  assertIsolatedPreview296DatabaseUrl(process.env.DATABASE_URL);
}
assertAppDatabaseUrl(process.env.DATABASE_URL);

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['query', 'error', 'warn'],
  });

if (!globalForPrisma.prisma) globalForPrisma.prisma = prisma;

export default prisma;
