# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14-slim AS dependencies
WORKDIR /app

# Manifests only, so this layer is cached until a dependency actually changes.
COPY package.json bun.lock ./
COPY backend/package.json backend/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/observability/package.json packages/observability/package.json

RUN bun install --frozen-lockfile

FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    APP_CONFIG_PATH=/etc/app/application.yml

# Bun does not hoist workspace dependencies to the root, so each package's own
# node_modules has to be copied. A missing one fails at runtime, not at build.
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/backend/node_modules ./backend/node_modules
COPY --from=dependencies /app/packages/config/node_modules ./packages/config/node_modules
COPY --from=dependencies /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=dependencies /app/packages/database/node_modules ./packages/database/node_modules
COPY --from=dependencies /app/packages/observability/node_modules ./packages/observability/node_modules

COPY --chown=bun:bun package.json bun.lock ./
# TRAP: every package's tsconfig.json extends this by relative path. Bun
# resolves tsconfig.json from the cwd, so without this file here the container
# silently falls back to bare TS defaults -- no experimentalDecorators -- and
# MikroORM entities fail at runtime with an error that never appears in tests.
COPY --chown=bun:bun tsconfig.base.json ./
COPY --chown=bun:bun backend backend
COPY --chown=bun:bun packages packages

# application.yml is deliberately NOT copied. Mount it (a ConfigMap, a bind
# mount) at APP_CONFIG_PATH, with secrets supplied as ${VAR} environment
# variables -- see config/application.production.yml.
USER bun
EXPOSE 3000

CMD ["bun", "run", "--cwd", "backend", "start"]
