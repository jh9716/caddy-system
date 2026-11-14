#!/usr/bin/env bash
#
# Per-boot startup for the caddy-system Cloud Agent environment.
# Runs on every boot and must be idempotent:
#   - starts the PostgreSQL cluster if it is not already running
#   - applies pending Prisma migrations
#   - seeds the admin user (idempotent)
#   - imports demo caddies from caddies.csv only when the table is empty
#
# Long-running processes (the Next.js dev server) live in `terminals`, not here.
set -euo pipefail

cd "$(dirname "$0")/.."

# Load .env so DATABASE_URL and friends are available to prisma/node below.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

PG_VERSION="$(pg_lsclusters -h | awk 'NR==1{print $1}')"
PG_CLUSTER="$(pg_lsclusters -h | awk 'NR==1{print $2}')"

echo "==> Starting PostgreSQL cluster ${PG_VERSION}/${PG_CLUSTER} (if needed)"
if ! pg_lsclusters -h | awk 'NR==1{print $4}' | grep -q online; then
  sudo pg_ctlcluster "${PG_VERSION}" "${PG_CLUSTER}" start
fi

echo "==> Waiting for PostgreSQL to accept connections"
for _ in $(seq 1 30); do
  if pg_isready -h localhost -p 5432 >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "==> Applying database migrations"
npx prisma migrate deploy

echo "==> Seeding admin user"
node prisma/seed.js

echo "==> Importing demo caddies (only if table is empty)"
CADDY_COUNT="$(node -e "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.caddy.count().then(c=>{console.log(c);return p.\$disconnect();}).catch(()=>{console.log(-1);process.exit(0);});")"
if [ "${CADDY_COUNT}" = "0" ]; then
  node scripts/import-caddies.mjs
else
  echo "    caddies table already populated (count=${CADDY_COUNT}), skipping import"
fi

echo "==> start.sh complete"
