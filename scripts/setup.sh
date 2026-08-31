#!/usr/bin/env bash
#
# Clone to running API, in one command:  bun run setup
#
# Idempotent -- safe to re-run after pulling, switching branches, or when you
# are not sure what state your local database is in.
set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "Installing dependencies"
bun install

if [ ! -f config/application.yml ]; then
  step "Creating config/application.yml from the sample"
  cp config/application.sample.yml config/application.yml
fi

step "Starting PostgreSQL"
if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop (or point config/application.yml"
  echo "at a database you already have) and re-run: bun run setup"
  exit 1
fi
docker compose up -d --wait postgres

step "Applying migrations"
bun run db:migrate

step "Seeding development data"
bun run db:seed

cat <<'DONE'

Ready.

  bun run dev                          start the API on :3000
  bun run --cwd backend dev:token      mint a token for local requests
  bun run new:domain <name>            scaffold a domain across all layers
  bun run verify                       lint + format + typecheck + test

  curl -H "Authorization: Bearer $(bun run --cwd backend dev:token)" \
       localhost:3000/users
DONE
