// scripts/create-admin.mjs
import 'dotenv/config';                 // .env 로드 (DATABASE_URL)
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

try {
  // ▶ 여기만 바꿔서 사용하세요
  const username = '이기흥';
  const plainPassword = 'lee4378';

  const hashed = await bcrypt.hash(plainPassword, 10);

  // 이미 있으면 갱신, 없으면 생성
  const user = await prisma.user.upsert({
    where: { username },
    update: { password: hashed, role: 'admin' },
    create: { username, password: hashed, role: 'admin' },
  });

  console.log(`✅ 관리자 계정 준비 완료: ${user.username}`);
} catch (err) {
  console.error('❌ create-admin error:', err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
