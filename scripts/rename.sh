#!/usr/bin/env bash
#
# Rebrand the boilerplate:  ./scripts/rename.sh my-service @myorg
#
#   arg 1  service name  (default: my-service)  -> package names, container and
#                                                  database names, process title
#   arg 2  package scope (default: @app)        -> the @app/* workspace scope
#
# Review the diff afterwards, then run `bun install` to refresh the lockfile.
set -euo pipefail

SERVICE="${1:-my-service}"
SCOPE="${2:-@app}"
SCOPE="${SCOPE#@}"

cd "$(dirname "$0")/.."

if [[ ! "$SERVICE" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "service name must be lowercase kebab-case: $SERVICE" >&2
  exit 1
fi

# Skip node_modules and .git, and the lockfile (bun install regenerates it).
FILES=$(find . \
  -type d \( -name node_modules -o -name .git -o -name dist -o -name coverage \) -prune -o \
  -type f \( -name '*.ts' -o -name '*.json' -o -name '*.yml' -o -name '*.yaml' \
             -o -name '*.md' -o -name '*.mjs' -o -name '*.http' -o -name Dockerfile \) -print)

# shellcheck disable=SC2086
perl -pi -e "s{\@app/}{\@${SCOPE}/}g; s{backend-boilerplate}{${SERVICE}}g" $FILES

# The container config path is derived from the scope-free service name.
perl -pi -e "s{/etc/app/}{/etc/${SERVICE}/}g" backend/Dockerfile README.md

echo "Renamed to ${SERVICE} (scope @${SCOPE})."
echo "Next: review the diff, then 'bun install'."
