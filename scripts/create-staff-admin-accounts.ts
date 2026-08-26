/**
 * 경기과 직원 관리자 계정 5명 생성 (한 번만).
 *
 * - 동일 username이 하나라도 있으면 전체 중단 (덮어쓰기 금지)
 * - DB에는 bcrypt hash만 저장
 * - 평문 임시 비밀번호는 stdout에 한 번만 출력 (파일/git에 쓰지 말 것)
 *
 * 로컬:
 *   ALLOW_STAFF_ACCOUNT_CREATE=1 DATABASE_URL=postgresql://caddy:caddy@localhost:5432/caddy_local \
 *     npx tsx scripts/create-staff-admin-accounts.ts
 *
 * 운영:
 *   사용자 명시 승인 후
 *   PROD_MAINTENANCE_CONFIRM=CREATE_STAFF_ADMIN_ACCOUNTS ALLOW_STAFF_ACCOUNT_CREATE=1 \
 *     DATABASE_URL=... npx tsx scripts/create-staff-admin-accounts.ts
 */
import { PrismaClient } from "@prisma/client";
import { STAFF_ADMIN_USERNAMES } from "../src/lib/staffAdminAccounts";
import {
  generateDistinctTempNumericPasswords,
  hashPassword,
} from "../src/lib/userPassword";
import {
  assertLocalDatabaseUrl,
  isProductionDatabaseUrl,
} from "./assertLocalDatabaseUrl";
import { requireProdMaintenance } from "./requireProdMaintenance";

async function main() {
  if (process.env.ALLOW_STAFF_ACCOUNT_CREATE !== "1") {
    console.error(
      "ALLOW_STAFF_ACCOUNT_CREATE=1 이 필요합니다. 실수 생성을 막기 위한 가드입니다."
    );
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL 이 없습니다.");
    process.exit(2);
  }
  if (isProductionDatabaseUrl(url)) {
    requireProdMaintenance("CREATE_STAFF_ADMIN_ACCOUNTS");
  } else {
    assertLocalDatabaseUrl(url);
  }

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findMany({
      where: { username: { in: [...STAFF_ADMIN_USERNAMES] } },
      select: { username: true, id: true, role: true },
    });
    if (existing.length > 0) {
      console.error("동일 username User가 이미 있어 생성을 중단합니다 (덮어쓰기 금지).");
      for (const row of existing) {
        console.error(`  exists: ${row.username} id=${row.id} role=${row.role}`);
      }
      process.exit(3);
    }

    const temps = generateDistinctTempNumericPasswords(
      STAFF_ADMIN_USERNAMES.length
    );
    const created: { username: string; temporaryPassword: string }[] = [];

    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < STAFF_ADMIN_USERNAMES.length; i++) {
        const username = STAFF_ADMIN_USERNAMES[i];
        const temporaryPassword = temps[i];
        const password = await hashPassword(temporaryPassword);
        await tx.user.create({
          data: {
            username,
            password,
            role: "admin",
            mustChangePassword: true,
            caddyId: null,
            managedTeams: [],
          },
        });
        created.push({ username, temporaryPassword });
      }
    });

    console.log("직원 관리자 계정 생성 완료. 아래 임시 비밀번호는 지금만 표시됩니다.");
    console.log("이름\t아이디\t임시 비밀번호");
    for (const row of created) {
      console.log(`${row.username}\t${row.username}\t${row.temporaryPassword}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
