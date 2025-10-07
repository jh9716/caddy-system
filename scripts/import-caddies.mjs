import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

try {
  const username = 'ghineung';
  const plainPassword = 'lee4378';
  const hashed = await bcrypt.hash(plainPassword, 10);

  const user = await prisma.user.upsert({
    where: { username },
    update: { password: hashed, role: 'admin' },
    create: { username, password: hashed, role: 'admin' },
  });

  console.log(`✅ 관리자 계정 생성 완료: ${user.username}`);
} catch (err) {
  console.error('❌ 오류:', err);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
