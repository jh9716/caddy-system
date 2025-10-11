// scripts/create-admin.mjs
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  // 원하는 계정/비번으로 바꾸세요
  const username = process.env.ADMIN_USERNAME || 'admin';
  const plainPassword = process.env.ADMIN_PASSWORD || '011697';

  const hashed = await bcrypt.hash(plainPassword, 10);

  // upsert: 있으면 갱신, 없으면 생성
  const user = await prisma.user.upsert({
    where: { username },
    update: { password: hashed, role: 'admin' },
    create: { username, password: hashed, role: 'admin' },
  });

  console.log('✅ 관리자 계정 생성/갱신 완료:', user.username);
}

main()
  .catch((e) => {
    console.error('❌ create-admin error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
