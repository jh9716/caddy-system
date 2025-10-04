// prisma/seed.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // 샘플 캐디 데이터
  const caddies = [
    { name: "김철수", team: "1조", status: "근무중" },
    { name: "이영희", team: "2조", status: "휴무" },
    { name: "박민수", team: "3조", status: "병가" },
  ];

  for (const caddy of caddies) {
    await prisma.caddy.create({ data: caddy });
  }

  console.log("✅ 샘플 데이터 입력 완료!");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
