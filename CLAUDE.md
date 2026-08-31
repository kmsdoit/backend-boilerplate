# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Commands

Bun workspace. Run everything from the repository root.

```bash
bun run setup               # install + database + migrate + seed
bun run dev                 # backend (:3000)
bun run verify              # lint + format:check + typecheck + test -- the gate

bun run new:domain <name>   # scaffold a domain (contracts, entity, repo, mapper, routes)
bun run remove:domain <name>
bun run build:lambda        # AWS Lambda bundle
```

## Runtime targets

One `app` object, one entrypoint per target -- never a second copy of the
middleware chain. `backend/src/scripts/server.ts` (Bun), `lambda.ts` (AWS).

`packages/config` is split at the platform boundary: `src/core.ts` imports no
`node:*` at all, `src/index.ts` is the only file that reads the filesystem.
**Do not import `node:*` from `core.ts`** -- that single import previously made
the whole application unbundlable for any runtime without a filesystem, even for
code paths that never read a file.

`APP_CONFIG` (the YAML itself) wins over `APP_CONFIG_PATH`. Anything bundled
must set one of them: the default path is resolved relative to the config source
file, which stops being meaningful once `import.meta.url` points into `dist/`.

Cloudflare Workers is blocked by `packages/database` (knex needs `net`/`tls`);
everything above it bundles for `workerd`. That is a data-layer decision, not a
rewrite -- see "Serverless" in README.md.

Tests: `test:unit` needs nothing. `test:integration` needs the test database
running (`bun run test:db:up`); pending migrations are applied automatically by
`packages/database/src/test-preflight.ts`, which also refuses to run against a
non-`test` config.

**Prefer `bun run new:domain` over hand-writing a domain.** It is what keeps the
layering (repository owns queries, mapper owns output, errors are factories)
from drifting.

Vitest projects are `config`, `contracts`, `observability`, `database`, `backend`.

## Architecture

```
request → requestLogger (id + metrics) → cors → bodyLimit
        → /health /ready /metrics (public)
        → authenticate → rateLimiter → route handler
        → errorHandler on any throw
```

| Package | Role |
| --- | --- |
| `packages/config` | Loads `config/application.yml`, `${ENV}` substitution, Zod validation. No workspace deps. |
| `packages/contracts` | Zod schemas and enums. No I/O. |
| `packages/observability` | Structured logger + Prometheus primitives. |
| `packages/database` | MikroORM entities, migrations, ORM lifecycle. |
| `backend` | Hono API. |

Dependencies point one way: `backend` → `database` → `contracts`.

## Invariants

**Config comes from `config/application.yml` only.** No `.env`, no dotenv, no
`process.env` reads outside `packages/config`. `applicationConfig` is built once
at module load, so a bad config kills the process at startup rather than on the
first request that reads it.

**Routes throw; they never format a response.** Domain errors are factories in
`backend/src/api/routes/errors.ts`. Do not construct `new HTTPException(...)`
inside a route — the status for a given failure is decided once, in one file.

**A route never returns an entity.** It returns a response mapper's output. That
is what makes adding a column safe: it stays internal until someone adds it to
the mapper deliberately.

**Every query for an entity lives in its repository.** That is what makes the
soft-delete filter (`deletedAt: null`) enforceable — a route cannot forget a
filter it never writes.

**A pre-check is a nicety; the database constraint is the guarantee.** Any
check-then-insert races. Add the unique index, then map its constraint name in
`uniqueConstraintErrors` so the loser of a race gets the same response the
pre-check would have produced.

**An absent PATCH key means "not touched", never "clear it."** Assign each field
only under `if (body.x !== undefined)`.

## Traps

Each of these has caused a real bug. Full detail is in README.md and at each site.

- `instanceof` on MikroORM exceptions silently fails — match `err.code === "23505"`.
- `db:generate` tries to drop the partial unique index; the `@Index({ expression })`
  on `User` is what stops it. Read every generated migration.
- `migrations/.snapshot-*.json` is committed on purpose -- it is what `db:generate`
  diffs against. Delete it and a fresh clone regenerates the whole schema as a
  duplicate migration. Its filename tracks the database name.
- Shutdown order is load-bearing: stop the listener, drain, THEN close the pool.
  Closing the pool first kills the requests you are draining for.
- Adding a workspace package means touching `backend/Dockerfile`, root
  `package.json` (`workspaces`, `typecheck:*`, **and `test:unit`**),
  `vitest.config.ts`, and CI. A project missing from `vitest.config.ts` never runs.
- `database` and `backend` share one test database and both truncate `users` —
  `fileParallelism` is off for that reason.
- zod v4 `.default({})` does not fill inner defaults; write them out fully.
- Bun does not hoist to the root `node_modules`; that is normal.

## Operational invariants

- **Index the emitted query.** Run `explain (analyze)` on what the repository
  actually sends before adding an index. `GET /users` unfiltered was a seq scan
  (12.2ms/200k rows) until `users_active_created_at_index` matched its real
  shape (0.027ms).
- **An HTTP timeout does not cancel a query** — `statementTimeoutMs` on the
  connection is what does. Keep it above `server.requestTimeoutMs`.
- **Never log a token.** hono's JWT errors embed the token in the message; use
  `redactTokens` before logging anything derived from an auth error.
- **`CREATE INDEX` blocks writes.** Fine on an empty table, an outage on a live
  one. Use `CONCURRENTLY` (and disable the migration's transaction) for a
  populated table.
- `pool.max` × replicas must stay under Postgres `max_connections`.

## Conventions

- Comments explain **why this value, why this decision** — not what the code does.
  Match the existing density; several comments here exist specifically to stop a
  future reader from "simplifying" a load-bearing detail.
- `reportUnusedDisableDirectives` is `error`: a dead `eslint-disable` fails CI.
- Prettier skips YAML, shell scripts, and `packages/database/migrations/`.
- Run `bun run verify` before claiming a change works.
