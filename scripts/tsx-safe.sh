#!/usr/bin/env bash
# Load production-DB abort hook, then run tsx.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export NODE_OPTIONS="--require ${ROOT}/scripts/guard-prod-db.cjs${NODE_OPTIONS:+ ${NODE_OPTIONS}}"
cd "$ROOT"
exec npx tsx "$@"
