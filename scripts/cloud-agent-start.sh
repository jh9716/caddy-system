#!/usr/bin/env bash
#
# Cloud Agent environment start step for caddy-system.
#
# Per-boot reconciliation that runs every time the environment starts: bring the
# local Postgres cluster online, apply pending Prisma migrations, ensure the
# admin user is seeded, and import the demo caddy roster only when the table is
# empty. Every action is idempotent so repeated boots are safe.
#
# This script mirrors the dashboard-managed environment "start" command. Keep
# the two in sync.
set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use default >/dev/null 2>&1 || true

echo "==> Starting PostgreSQL cluster 16/main (if needed)"
sudo pg_ctlcluster 16 main start 2>/dev/null || true
for _ in $(seq 1 30); do pg_isready -h localhost -p 5432 >/dev/null 2>&1 && break; sleep 1; done

echo "==> Applying database migrations"
npx prisma migrate deploy

echo "==> Seeding admin user"
npm run seed

echo "==> Importing demo caddies (only if table is empty)"
COUNT=$(PGPASSWORD=caddy psql -h localhost -U caddy -d caddy -tAc 'SELECT COUNT(*) FROM "Caddy";' 2>/dev/null | tr -d '[:space:]' || echo 0)
if [ "${COUNT:-0}" = "0" ]; then
  echo "    caddies table empty, importing demo roster from caddies.csv"
  ALLOW_LEGACY_IMPORT=1 node scripts/import-caddies.mjs || true
else
  echo "    caddies table already populated (count=$COUNT), skipping import"
fi

echo "==> start complete"
