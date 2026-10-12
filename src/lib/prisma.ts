import { PrismaClient } from '@prisma/client';
import { assertAppDatabaseUrl } from './dbSafety';

assertAppDatabaseUrl(process.env.DATABASE_URL);

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['query', 'error', 'warn'],
  });

if (!globalForPrisma.prisma) globalForPrisma.prisma = prisma;

export default prisma;
