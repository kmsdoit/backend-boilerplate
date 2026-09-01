# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Commands

Bun workspace. Run everything from the repository root.

```bash
bun run setup               # install + ScyllaDB + provision + seed
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
- The list partition is a single key (`gsi1pk = "USER"`), which is a hot
  partition at scale. Shard it before relying on the list endpoint under load.
- `status` is a FilterExpression applied after the index read, so a page can be
  shorter than `limit` while more items remain.
- Adding a workspace package means touching `backend/Dockerfile`, root
  `package.json` (`workspaces`, `typecheck:*`, **and `test:unit`**),
  `vitest.config.ts`, and CI. A project missing from `vitest.config.ts` never runs.
- `database` and `backend` share one test database and both truncate `users` —
  `fileParallelism` is off for that reason.
- zod v4 `.default({})` does not fill inner defaults; write them out fully.
- Bun does not hoist to the root `node_modules`; that is normal.

## Data layer

DynamoDB via the AWS SDK; ScyllaDB's Alternator locally, real DynamoDB in AWS.
Only `dynamo.endpoint` differs.

- **One table per entity, natural keys, declared once.** `packages/database/src/tables.ts`
  holds the row type, the `TableDefinition` and the typed `DdbTable` handle;
  provisioning reads the same definition, so infrastructure and access cannot
  drift. There is no ALTER TABLE -- changing a KEY means rewriting every item --
  so decide access patterns before attributes.
- **No DynamoDB command outside `DdbTable`.** Repositories call `get`/`put`/
  `updateIf`/`queryPage`; they never build a `GetCommand`. Add a method to
  `DdbTable` rather than reaching for the SDK in a repository.
- **Partition by owner where ownership exists** (`{ userId, id }`): that makes
  "this user's X" a plain partition read needing no index.
- **Sparse GSI for soft delete.** An item is in `gsi1` only while it has
  `gsi1pk`/`gsi1sk`; soft delete REMOVEs both, so it leaves every list query
  with no FilterExpression and no wasted reads.
- **Uniqueness is a lock item plus `attribute_not_exists`, not a constraint.**
  `TransactWriteItems` is NOT implemented by Alternator, so the write is two
  conditional puts with a compensating delete. Do not "simplify" it to a
  transaction while Scylla is a target.
- **No `total`, ever.** Counting reads every matching item. Lists return
  `nextCursor`; its absence is the only end-of-list signal.
- **Match SDK errors on `err.name`**, never `instanceof` -- two SDK copies on
  disk make the thrown and imported classes different constructors.
- Pin `scylladb/scylla:latest`; GSI queries crash the server on 6.2.

## Conventions

- Comments explain **why this value, why this decision** — not what the code does.
  Match the existing density; several comments here exist specifically to stop a
  future reader from "simplifying" a load-bearing detail.
- `reportUnusedDisableDirectives` is `error`: a dead `eslint-disable` fails CI.
- Prettier skips YAML, shell scripts, and `packages/database/migrations/`.
- Run `bun run verify` before claiming a change works.
