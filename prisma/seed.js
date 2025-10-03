// prisma/seed.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  await prisma.assignment.deleteMany();

  await prisma.assignment.createMany({
    data: [
      { caddyName: '김지훈', team: 'TEAM_1', status: 'AVAILABLE', notes: '' },
      { caddyName: '박수민', team: 'TEAM_1', status: 'LEAVE', notes: '병가' },
      { caddyName: '이현우', team: 'TEAM_2', status: 'AVAILABLE', notes: '1부 첫근' },
      { caddyName: '최다은', team: 'TEAM_3', status: 'AVAILABLE', notes: 'VIP' },
      { caddyName: '정가영', team: 'TEAM_4', status: 'NOTICE', notes: '54홀(1)' },
      { caddyName: '한서준', team: 'TEAM_5', status: 'AVAILABLE', notes: '외국어' },
      { caddyName: '오유진', team: 'TEAM_6', status: 'AVAILABLE', notes: '' },
      { caddyName: '강민호', team: 'TEAM_7', status: 'LEAVE', notes: '연차' },
      { caddyName: '윤서현', team: 'TEAM_8', status: 'AVAILABLE', notes: '' },
    ],
  });

  console.log('Seed done!');
}

main().finally(async () => {
  await prisma.$disconnect();
});
