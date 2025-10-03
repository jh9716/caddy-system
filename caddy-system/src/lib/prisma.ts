import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'], // 필요시 'query'도
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
