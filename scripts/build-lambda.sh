#!/usr/bin/env bash
#
# Bundles the Lambda handler:  bun run build:lambda  ->  dist/lambda/index.mjs
#
# knex ships a driver registry that `require`s every dialect it supports, so
# each unused driver has to be marked external or the bundle fails on a package
# that was never installed. They are genuinely unreachable at runtime -- knex
# only loads the dialect named by the connection -- so nothing is lost.
#
# If this list ever fights you, deploy the container image instead: Lambda takes
# an OCI image, backend/Dockerfile already builds one, and that path skips
# bundling altogether at the cost of a slower cold start.
set -euo pipefail

cd "$(dirname "$0")/.."

UNUSED_DRIVERS=(
  better-sqlite3 libsql mariadb mariadb/callback mysql mysql2
  oracledb pg-native pg-query-stream sqlite3 tedious
)

EXTERNALS=()
for driver in "${UNUSED_DRIVERS[@]}"; do
  EXTERNALS+=("--external:${driver}")
done

mkdir -p dist/lambda
bunx esbuild backend/src/scripts/lambda.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --target=node22 \
  --outfile=dist/lambda/index.mjs \
  --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
  "${EXTERNALS[@]}"

printf '\nBuilt dist/lambda/index.mjs (%s)\n' "$(du -h dist/lambda/index.mjs | cut -f1)"
cat <<'NEXT'

Handler:  index.handler        (the file is an ESM bundle, so name it index.mjs in the zip)
Runtime:  nodejs22.x
Env:      APP_CONFIG (the YAML itself) or APP_CONFIG_PATH, plus the ${VAR} secrets it references

Set database.pool.max to 1 and front Postgres with RDS Proxy -- see the notes in
backend/src/scripts/lambda.ts before your first load spike.
NEXT
