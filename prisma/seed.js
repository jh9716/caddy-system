// prisma/seed.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  await prisma.assignment.createMany({
    data: [
      { team: 1, name: '김철수', note: '초보' },
      { team: 2, name: '이영희', note: '오전 가능' },
      { team: 3, name: '박민수', note: null },
    ],
    skipDuplicates: true,
  });
  console.log('Seed done');
}

main().finally(() => prisma.$disconnect());
