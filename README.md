# backend-boilerplate

A Bun + Hono + DynamoDB monorepo you can put a real service on top
of today. Extracted from a production control-plane service: the domain was
removed, the load-bearing parts — configuration, auth, error handling,
observability, lifecycle, and the test setup — were kept, along with the
comments explaining why each one is the way it is.

```bash
bun run setup     # install, start PostgreSQL, migrate, seed
bun run dev       # http://localhost:3000
```

```bash
TOKEN=$(bun run --cwd backend dev:token)
curl -H "Authorization: Bearer $TOKEN" localhost:3000/users
```

Then make it yours:

```bash
./scripts/rename.sh my-service @myorg   # package scope, service name, DB names
bun run remove:domain user              # drop the bundled example
bun run new:domain order                # scaffold your own across all five layers
git init && git add -A && git commit -m "Initial commit"
```

The scaffolding's own tests keep passing with the example deleted. That is not
a hope: CI runs exactly that sequence — `remove:domain user`, `new:domain
order`, then the full suite — on every push, because it is the one promise this
repository makes.

---

## Contents

- [What you get](#what-you-get) · [Layout](#layout) · [Commands](#commands)
- [Adding a domain](#adding-a-domain) · [Removing the example](#removing-the-example)
- [Configuration](#configuration) · [Testing](#testing) · [Deploying](#deploying)
- [Serverless](#serverless) · [Running against real DynamoDB](#running-against-real-dynamodb)
- [Modelling](#modelling) — the key layout, and what it costs to change
- [Traps](#traps) — mistakes this repo has already made for you
- [Growing past this](#growing-past-this)

---

## What you get

| | |
| --- | --- |
| **Config** | One YAML file per environment, `${ENV}` substitution, Zod-validated at startup. No `.env`. |
| **Auth** | JWT (HS256) with `iss`/`aud` enforcement, deny-by-default, an honest 401/403 split. |
| **Routes** | Type-safe route DSL: declare a Zod schema, receive typed `params`/`query`/`body`. |
| **Errors** | Every route throws; one handler formats. Uniform `{error, status, requestId}`. |
| **Observability** | Structured JSON logs, correlation id on every request, Prometheus `/metrics`. |
| **Probes** | `/health` (liveness, no dependencies) and `/ready` (readiness, bounded checks). |
| **Limits** | Body size cap, per-request timeout, per-actor write rate limiter — all from config. |
| **Hardening** | Secure headers, wildcard CORS rejected at load, production refuses example secrets, tokens redacted from logs. |
| **Lifecycle** | Graceful shutdown: stop the listener, drain in-flight, then close the pool. |
| **Under load** | Cursor pagination, no unbounded scans, key layout in one file. |
| **Data** | DynamoDB via the AWS SDK. Sparse GSI for listing, conditional writes for uniqueness, soft delete. |
| **Scaffolding** | `new:domain` / `remove:domain` generate and reverse a domain across every layer. |
| **Tests** | 100 tests: unit plus real-ScyllaDB integration through the real app. |
| **Serverless** | AWS Lambda entrypoint and bundle, tested through a real API Gateway event. |
| **Ship** | Multi-stage Dockerfile, one `verify` gate, CI that proves the example is deletable. |

## Layout

```
config/                    application.{yml,sample,test,production}.yml
scripts/                   setup, rename, new:domain, remove:domain
packages/
  config/                  loads + validates the YAML. No workspace deps.
  contracts/               Zod schemas and enums. No I/O.
  observability/           logger + Prometheus primitives.
  database/                SDK client, key layout, table provisioning, test preflight.
backend/
  src/lib/                 route DSL, hono adapter, db, env, health, metrics.
  src/middleware/          logger, auth, rate limit, error handler.
  src/user/                example domain: repository, response mapper, its tests.
  src/api/routes/          example HTTP surface + error factories.
  src/api/app.integration.test.ts   scaffolding tests — survive deleting the example.
```

Dependencies point one way: `backend` → `database` → `contracts`. `contracts`
depends on nothing, which is what lets both the HTTP layer and the persistence
layer import it without depending on each other.

## Commands

```bash
bun run setup               # one command: install + database + migrate + seed
bun run dev                 # backend with --hot
bun run verify              # lint + format:check + typecheck + test. The gate.

bun run new:domain <name>   # scaffold a domain across all five layers
bun run remove:domain <name>

bun run build:lambda        # -> dist/lambda/index.mjs (AWS Lambda)

bun run db:up / db:down     # dev ScyllaDB, Alternator on :8000
bun run db:provision        # create the table and its index (idempotent)
bun run db:seed

bun run test                # all 5 projects
bun run test:unit           # no database needed
bun run test:integration    # database + backend
bun run test:db:up          # test ScyllaDB on :8001, separate from dev
```

## Adding a domain

```bash
bun run new:domain order
```

There is no migration step: DynamoDB has no schema and the domain shares the
existing table. Adding an *access pattern* is the change that costs — a new
index means editing `packages/database/src/table.ts`.

That writes five files and wires them into the index files:

| | |
| --- | --- |
| `packages/contracts/src/order.ts` | Zod schemas — what a request may contain |
| `packages/database/src/keys.ts` | key helpers for the new domain, appended in place |
| `backend/src/order/order-repository.ts` | every read and write, including the sparse-index soft delete |
| `backend/src/order/order-response.ts` | every field that leaves |
| `backend/src/api/routes/order.ts` | GET / GET :id / POST / PATCH / DELETE |

It is ordinary code you are expected to edit, and nothing regenerates it. The
generator exists because the layering only pays off if every domain follows it:
a README asking people to hand-copy five files is a suggestion, a generator
makes it the default.

New error? Add a factory to `backend/src/api/routes/errors.ts`. New unique constraint that user
input can hit? Add it to `uniqueConstraintErrors` in that same file.

**Naming.** The generator takes a lowercase, singular, kebab-case name
(`order`, `order-item`) and pluralises by appending `s` for the route path and
table name. If English disagrees, fix the two spots it named — they are in the
generated entity and route files.

## Removing the example

```bash
bun run remove:domain user
```

Deletes the five files plus the example's own tests and `.http` scratch file,
unwires every index file, drops its error factories and its
`uniqueConstraintErrors` entry, and resets `packages/database/src/seed.ts` to a working skeleton — so
`bun run verify` is green immediately afterwards rather than failing on a
dangling import.

Migrations are deliberately left alone. One may already be applied here or in
someone else's database, so dropping the table is a decision only you can make:
write a new migration for it.

## Configuration

`packages/config` reads exactly one YAML file, chosen by `APP_CONFIG_PATH`
(default `config/application.yml`), substitutes any value that is entirely
`${SOME_VAR}`, validates the result against a Zod schema, and freezes it at
module load.

The consequences are the point:

- Every setting the service has is in one file, with its default and the
  reasoning beside it.
- A misconfigured process fails at startup, naming the variable and the config
  path that wanted it — not on the first request that reads a bad value.
- `config/application.production.yml` is committed safely: it is all placeholders.
  Secrets arrive as environment variables.
- Grepping this codebase for `process.env` returns nothing outside that loader.

Substitution is whole-value only. `"prefix-${VAR}"` stays a literal, on purpose:
partial interpolation makes it impossible to tell a literal from a placeholder,
and it hides typos like `"${DB_URL"`.

Two rules are enforced at load rather than left to review:

- **Production refuses an example secret.** A `jwtSecret` containing
  `change-me`, `local-development` or `test-only` will not start in production.
  Copying the sample config and deploying it is the most common way a
  boilerplate leaks, and it is silent.
- **Wildcard CORS is rejected.** `"*"` with credentials is refused by browsers,
  but only as a console error in someone else's tab — nothing server-side ever
  reports it.

## Testing

```bash
bun run test:db:up      # test PostgreSQL on :5434, separate from dev
bun run test
```

Pending migrations are applied automatically by
`packages/database/src/test-preflight.ts`, which also refuses to run against a
config whose environment is not `test` — a test command must never migrate a
development or production database. If the database is not running you get one
sentence naming the command, instead of twenty failures saying
`relation "users" does not exist`.

Five projects: `config`, `contracts`, `observability` (no database), plus
`database` and `backend` (real Postgres). Narrow a run:

```bash
APP_CONFIG_PATH=./config/application.test.yml bunx vitest run --project backend
APP_CONFIG_PATH=./config/application.test.yml bunx vitest run -t "soft-deleted"
```

The split matters: `backend/src/api/app.integration.test.ts` tests the
scaffolding and touches no domain route, so it keeps passing after you delete
the example. Domain tests live beside their domain and are deleted with it. The
`scaffolding` job in `.github/workflows/ci.yml` enforces the split by deleting
the example on every push and running the suite against a freshly generated
domain — it has already caught three real bugs in `remove:domain`.

## Deploying

```bash
docker build -f backend/Dockerfile -t backend-boilerplate .
docker run -p 3000:3000 \
  -v $PWD/config/application.production.yml:/etc/app/application.yml:ro \
  -e DATABASE_URL=... -e JWT_SECRET=... -e CORS_ORIGINS=... \
  -e JWT_ISSUER=... -e JWT_AUDIENCE=... \
  backend-boilerplate
```

Point liveness at `/health` and readiness at `/ready`. Keep them separate:
restarting the API does not fix a down database, it just removes the pod that
would have served traffic the moment the database comes back.

`/metrics` is mounted before authentication so a scraper can reach it. Block it
at the ingress, or move it to its own port, before putting this on the public
internet.

Set the orchestrator's grace period above `SHUTDOWN_GRACE_MS` (10s, in
`backend/src/scripts/server.ts`), or SIGKILL arrives before in-flight requests
have drained.

## Serverless

The same `app` serves every target, so routes, middleware and error handling
cannot drift between them. Only the entrypoint differs.

```bash
bun run build:lambda      # -> dist/lambda/index.mjs
```

| | |
| --- | --- |
| Handler | `index.handler` (ESM — name the file `index.mjs` in the zip) |
| Runtime | `nodejs22.x`, or the container image from `backend/Dockerfile` |
| Config | `APP_CONFIG` (the YAML itself) or `APP_CONFIG_PATH`, plus the `${VAR}` secrets it references |

DynamoDB is what makes this comfortable. There is no connection pool to
exhaust, so the usual Lambda-plus-database failure — `pool.max` × concurrent
containers overrunning the server's connection limit — does not exist here. The
SDK client is held at module scope in `packages/database/src/client.ts` so a
warm invocation reuses its keep-alive connections.

Two things still change on Lambda, and both are configuration: the rate limiter
counts per container (use API Gateway throttling), and `/metrics` reports one
container's numbers (ship to CloudWatch EMF instead of scraping).

## Running against real DynamoDB

Local development runs ScyllaDB's Alternator, its DynamoDB-compatible API.
Moving to AWS is a config change, not a code change: drop `dynamo.endpoint` so
the SDK resolves the regional endpoint, and drop the credentials so it uses the
task or instance role. `config/application.production.yml` is already written
that way.

**Compatibility, measured against Alternator with the AWS SDK:**

| | |
| --- | --- |
| CreateTable + GSI, Query, `ScanIndexForward`, `LastEvaluatedKey` | works |
| `ConditionExpression`, `ConditionalCheckFailedException` | works |
| UpdateItem with condition, BatchWriteItem, TTL | works |
| **TransactWriteItems** | **not implemented** |

The gap is the reason `createUserRepository.create` claims the email lock with
a separate conditional write instead of one `TransactWriteItems`. The risk runs
in the useful direction: code written without transactions runs unchanged on
both, whereas code written for DynamoDB first would break when brought back.
Once you are on AWS only, collapse those two writes into a transaction.

**Pin the image tag.** On `scylladb/scylla:6.2` a Query against a GSI crashes
the server (`Tried to build a global schema for view ... with an uninitialized
base info`) even though DescribeTable reports the index ACTIVE. Verified fixed
on 2026.2.x, which `latest` resolves to.

## Modelling

The key layout is the schema. There is no ALTER TABLE to fix a bad choice
later, only a migration that rewrites every item, so decide access patterns
before attributes. Every key string lives in `packages/database/src/keys.ts` so
the whole layout reads in one screen.

```
users             pk = USER#<id>
email uniqueness  pk = EMAIL#<lowercased email>     (a lock item)
list newest-first gsi1: gsi1pk = USER, gsi1sk = <createdAt>#<id>
```

**Sparse index for soft delete.** An item is in `gsi1` only while it has
`gsi1pk` and `gsi1sk`. Soft-deleting REMOVEs both, so the item drops out of
every list query with no FilterExpression, no wasted reads, and `Limit` still
meaning what it says.

**Uniqueness is a lock item, not a constraint.** `EMAIL#<address>` is written
with `attribute_not_exists(pk)`; the loser of a race gets
`ConditionalCheckFailedException`, which becomes the 409. Email is lowercased
into the key, because DynamoDB compares bytes and `A@x.com` would otherwise be
a second user.

**Cursor pagination, and no `total`.** Counting means reading every matching
item. The API returns `nextCursor` and nothing else; its absence is the only
end-of-list signal. This is also simply a better contract — a cursor stays
correct when items are inserted mid-listing, where `?page=3` silently skips or
repeats.

### Known limits, not yet addressed

- **The list partition is a single key** (`gsi1pk = "USER"`), so every user
  lands in one partition. That is fine to a few thousand items and a hot
  partition beyond it. The fix is write sharding — `USER#<0..N>` plus a
  scatter-gather read — which also makes the cursor a composite. Do it before
  you rely on the list endpoint at scale.
- **No free-text search.** DynamoDB cannot serve `name LIKE '%foo%'` without a
  full Scan, so the API deliberately has no `q` parameter. Add a search index
  (OpenSearch fed by DynamoDB Streams) rather than a Scan behind a friendly
  query string.
- **`status` is a FilterExpression**, applied after the index read, so a page
  can come back shorter than `limit` while more items remain. Page until
  `nextCursor` is absent, never until a page looks short. A dedicated GSI is
  the fix if it becomes a hot path.
- The rate limiter is per-process; see `backend/src/middleware/rate-limit.ts`.

## Traps

Each of these produced a real bug here. They are commented at the site as well;
this list is so you know they exist.

**`instanceof` on SDK exceptions silently fails.** Two on-disk copies of the
AWS SDK mean the class thrown and the class imported can be different
constructors, and `instanceof` then returns false. Match on `err.name` — that is
what `isConditionalCheckFailed` does.

**Paths default to `process.cwd()`, not to the file that wrote them.** Anything
loaded from a different cwd (the test preflight, a one-off script, a bundle)
must resolve paths from `import.meta.url` — which is also why a bundled Lambda
must set `APP_CONFIG` or `APP_CONFIG_PATH`.

**Root files do not reach the container.** `backend/Dockerfile` copies each
package explicitly. `tsconfig.base.json` is in that list because without it
Bun's cwd-based lookup falls back to TS defaults, decorators break at runtime,
and no test catches it. Adding a workspace package means touching the
Dockerfile, root `package.json` (`workspaces`, `typecheck:*`, **and
`test:unit`**), `vitest.config.ts`, and CI.

**A vitest project missing from `vitest.config.ts` never runs**, and its tests
look green because nothing reports on them.

**Process-global state leaks between tests.** The rate limiter is one Map for
the process, so tests reusing an actor id inherit each other's spent budget and
fail with a 429 where they expected a 400. The integration suite mints a fresh
actor id per test for exactly this reason.

**zod v4 `.default({})` does not fill inner defaults.** Unlike v3,
`z.object({a: z.number().default(1)}).default({})` yields `{}`. Write nested
defaults out in full — pinned by a test in `packages/config`.

**Bun does not hoist dependencies to the root.** `hono`, `zod` and the AWS SDK
live under each package's own `node_modules`. A missing root
`node_modules/<pkg>` is normal, and a script under `scripts/` cannot import a
workspace package at all — that is why the test preflight lives in
`packages/database`.

## Growing past this

- **Background jobs**: add a `worker/` workspace that polls a queue. Keep the API
  writing only a job row — do the job insert and the queue publish in one
  transaction, never publish after commit, so a crash between the two is
  impossible.
- **More than one replica**: move the rate limiter's state to Redis or Postgres.
- **Tracing**: the correlation id in `AppEnv` is already the seam; swap
  `crypto.randomUUID()` for a W3C traceparent.
- **Search**: add `pg_trgm` and a GIN index, or a dedicated search column,
  before the `q` filter meets a large table.
