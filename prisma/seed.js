// prisma/seed.js
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin1234';

  const exists = await prisma.user.findUnique({ where: { username }});
  if (!exists) {
    const hash = await bcrypt.hash(password, 10);
    await prisma.user.create({
      data: { username, password: hash, role: 'admin' }
    });
    console.log(`✔ Admin user created: ${username}/${password}`);
  } else {
    console.log('✔ Admin user already exists');
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
