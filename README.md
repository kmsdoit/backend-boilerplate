# backend-boilerplate

A Bun + Hono + MikroORM + MySQL monorepo you can put a real service on top
of today. Extracted from a production control-plane service: the domain was
removed, the load-bearing parts — configuration, auth, error handling,
observability, lifecycle, and the test setup — were kept, along with the
comments explaining why each one is the way it is.

```bash
bun run setup     # install, start MySQL, migrate, seed
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
- [Serverless](#serverless) — AWS Lambda works; Cloudflare Workers needs a driver swap
- [Operating this](#operating-this) — what actually bites in production
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
| **Under load** | `statement_timeout`, pool acquire timeout, indexes matched to the real queries. |
| **Data** | MikroORM entities, reviewable migrations, soft delete, partial unique index. |
| **Scaffolding** | `new:domain` / `remove:domain` generate and reverse a domain across every layer. |
| **Tests** | 93 tests: unit plus real-MySQL integration through the real app. |
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
  database/                entities, migrations, ORM lifecycle, test preflight.
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

bun run db:up / db:down     # dev MySQL (:3307)
bun run db:generate         # migration from the entity diff — READ IT before committing
bun run db:migrate / db:rollback / db:status / db:seed

bun run test                # all 5 projects
bun run test:unit           # no database needed
bun run test:integration    # database + backend
bun run test:db:up          # test MySQL (:3308), separate from dev
```

## Adding a domain

```bash
bun run new:domain order
bun run db:generate     # read the migration before committing it
bun run db:migrate
```

That writes five files and wires them into the index files:

| | |
| --- | --- |
| `packages/contracts/src/order.ts` | Zod schemas — what a request may contain |
| `packages/database/src/entities/order.ts` | entity, with a partial index for the list query |
| `backend/src/order/order-repository.ts` | every query, including the soft-delete filter |
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
bun run test:db:up      # test MySQL on :3308, separate from dev
bun run test
```

Pending migrations are applied automatically by
`packages/database/src/test-preflight.ts`, which also refuses to run against a
config whose environment is not `test` — a test command must never migrate a
development or production database. If the database is not running you get one
sentence naming the command, instead of twenty failures saying
`relation "users" does not exist`.

Five projects: `config`, `contracts`, `observability` (no database), plus
`database` and `backend` (real MySQL). Narrow a run:

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

The same `app` object serves every target, so routes, middleware and error
handling cannot drift between them. Only the entrypoint differs.

### AWS Lambda — supported

```bash
bun run build:lambda      # -> dist/lambda/index.mjs
```

| | |
| --- | --- |
| Handler | `index.handler` (ESM — name the file `index.mjs` in the zip) |
| Runtime | `nodejs22.x`, or the container image from `backend/Dockerfile` |
| Config | `APP_CONFIG` (the YAML itself) or `APP_CONFIG_PATH`, plus the `${VAR}` secrets it references |

Verified end to end: the built bundle was invoked under plain Node 22 with a
real API Gateway v2 event against a real MySQL — `/health` 200, `/ready` 200
with a live database check, `/users` 401 through the auth gate.
`backend/src/scripts/lambda.test.ts` runs the same path in CI.

Three things change when you run here, and all three are configuration, not
code — `backend/src/scripts/lambda.ts` documents each at the site:

- **Connections.** Every warm container holds its own pool, so the real count is
  `pool.max` × concurrent containers. At the default `max: 10` and 100
  concurrent invocations that is 1000 connections against a MySQL whose
  default `max_connections` is 151. Set `database.pool.max` to 1 and put RDS
  Proxy in front. This is the usual way a Lambda + relational-database
  deployment falls over on its first load spike.
- **No shutdown hook.** The container is frozen and may be destroyed without
  warning, so the pool is never closed politely. That is fine, and it is why the
  graceful shutdown in `server.ts` is absent here rather than merely unused.
- **In-memory state is per container.** The rate limiter counts per container
  (use API Gateway throttling instead) and `/metrics` reports one container's
  numbers. Ship to CloudWatch EMF or an OTLP collector rather than scraping.

### Cloudflare Workers — needs a different data layer

Measured, not guessed. `packages/database` uses MikroORM's MySQL driver, which
is `@mikro-orm/knex` + `mysql2`. Bundling it pulls in `net`, `tls`, `dns`,
`child_process` and `fs`; Workers offers none of them — a TCP socket there comes
from `cloudflare:sockets`, which knex cannot use. knex's dialect registry also
`require`s eleven database drivers you never installed, each needing a stub.
Size is *not* the problem (0.9 MB gzipped, inside the 3 MB free limit).

Everything above the data layer is portable: the route DSL, the hono adapter,
the auth middleware and the contracts bundle for `workerd` at **175 KB
gzipped**. `packages/config` is split so that `src/core.ts` (schema,
validation, `${ENV}` substitution) imports no `node:*` at all and `src/index.ts`
is the only file that touches the filesystem — so an edge entry point would be
one small file next to it, not a refactor.

A Workers port is therefore a data-layer decision, not a rewrite:

- **Hyperdrive** — keeps MySQL and your SQL, pooling connections at the edge.
- **Drizzle** with the Neon or Hyperdrive driver — closest to the current shape.
- **D1** or **DynamoDB** — a different database, and the reason serverless is
  easy there: no connection pool to exhaust in the first place.

The repositories in `backend/src/<domain>/` are the seam. They take an
EntityManager and return plain objects, so routes and response mappers do not
change when the driver underneath them does.

### Choosing

If serverless is a hard requirement, pick the database first — that single
choice, not the HTTP layer, decides how hard the rest is. MySQL plus a
connection pooler works on Lambda and is what this repo ships. A
connectionless store (DynamoDB, D1) is what makes an edge runtime
straightforward, at the cost of the relational model this boilerplate's
migrations, partial indexes and transactions are built around.

## Operating this

The things that actually bite in production, and what this repo does about
them. Numbers were measured on a 200k-row table, not estimated.

**MySQL has no partial indexes, and the soft-delete design depended on one.**
The Postgres original kept email unique among live rows with
`create unique index ... where deleted_at is null`. That is a syntax error on
MySQL (verified on 8.4). The replacement is a STORED generated column,
`email_active`, holding the address while the row is live and NULL once it is
soft-deleted: a UNIQUE index treats every NULL as distinct, so live addresses
collide and deleted ones do not. Verified end to end — duplicate live email is
409, and the address is reusable after a soft delete. STORED rather than
VIRTUAL because MySQL cannot build a UNIQUE index over a virtual column.

**Case-insensitive search is a property of the collation, not the query.**
There is no `ILIKE` on MySQL; the repository uses `LIKE`, and
`utf8mb4_0900_ai_ci` (pinned in compose.yaml) is what makes it
case-insensitive. Move the table to a `_bin` or `_cs` collation and search
silently becomes case-sensitive with no code change to notice.

**Timestamps need the session forced to UTC.** MySQL has no `timestamptz`, and
a fresh server reports `@@session.time_zone = SYSTEM`, so `datetime` columns
read back in whatever zone the host is in. `createMikroOrmConfig` sets
`time_zone = '+00:00'` on every connection. The columns are `datetime(3)`
because MySQL's default precision is whole seconds, which quietly makes
`createdAt` a poor tiebreaker.

**Index the query you actually run, not the columns you happen to filter on.**
`GET /users` with no filter was a full sequential scan (12.2ms, 200k rows read
and sorted to return 20) because the only index required a `status` value.
`users_active_created_at_index` matches the real query shape and takes it to
**0.027ms**. When you add a domain, run `explain (analyze)` on the query your
repository emits before assuming an index helps.

**An HTTP timeout does not stop a query, and MySQL can only half-fix that.**
Aborting the request stops us *waiting*; the server keeps executing, holding
its locks. `statementTimeoutMs` sets `max_execution_time` on every connection,
which does cut off a row-returning SELECT — measured: `ER_QUERY_TIMEOUT` at
501ms against a query whose baseline was 8.2s.

But `max_execution_time` applies to **read-only SELECTs only**. A slow UPDATE
or DELETE has no server-side ceiling at all: measured, an UPDATE ran 15.8s
against a 500ms setting, untouched. Postgres `statement_timeout` covered every
statement; nothing here does. Bound long writes with `innodb_lock_wait_timeout`
and by batching them, not by this setting.

**A saturated pool must fail, not hang.** `acquireTimeoutMs` (default 5s) turns
pool exhaustion into a visible error you can alert on instead of requests that
wait forever.

**Connection budget is per process.** `pool.max` × replicas must stay under
MySQL `max_connections` (default 151), leaving room for migrations, a client
session and monitoring. 10 replicas × `max: 10` is already the whole budget. Use a pooler
(PgBouncer) before raising either number.

**`CREATE INDEX` locks the table.** Every migration here uses plain
`CREATE INDEX`, correct for a table that is empty at that point in history and
an outage on a populated one — it holds ACCESS EXCLUSIVE and blocks all writes.
For a live table use `CREATE INDEX CONCURRENTLY`, which cannot run inside a
transaction, so the migration must disable its wrapping transaction.

**Bearer tokens must never reach the log stream.** hono's JWT errors embed the
token in their message, so logging `err.message` verbatim writes live
credentials into logs that are retained and indexed. `redactTokens` in
`backend/src/middleware/auth.ts` strips them and keeps the error class name, which is the
part that helps. Pinned by a test.

**Known limits, not yet addressed** — decide before you rely on them:

- `GET /users?q=` is `LIKE '%term%'`, which no btree index can serve: 200k rows
  scanned twice per request (rows + count), ~100ms, growing linearly. Needs a
  `pg_trgm` GIN index or a real search column.
- Pagination is `OFFSET`-based, so page depth costs linearly (offset 100000 read
  all 200k rows). Keyset pagination fixes it but changes the API contract.
- The rate limiter is per-process; see `backend/src/middleware/rate-limit.ts`.

## Traps

Each of these produced a real bug here. They are commented at the site as well;
this list is so you know they exist.

**`instanceof` on ORM exceptions silently fails.** Two on-disk copies of
`@mikro-orm/core` mean the class thrown and the class imported are different
constructors, and `instanceof` returns false. Match on `err.errno === 1062` —
that is what `isUniqueViolation` does.

**MySQL does not tell you which constraint was violated.** Postgres exposes a
`constraint` field; MySQL puts the index name only inside the message
(`Duplicate entry 'a@x.com' for key 'users.users_active_email_unique'`), so
`uniqueViolationIndexName` parses it back out. The table qualifier is optional
in that pattern because 5.7 omitted it and 8.0 added it.

**`db:generate` wants to drop partial unique indexes.** MikroORM cannot express
a `WHERE` clause from an entity, so it reads the index as "should not exist".
The `@Index({ expression })` declarations on `User` exist only to stop that. Do
not remove them, and read every generated migration. They carry no trailing `;`
— MikroORM emits the string verbatim, and a trailing semicolon produces `...;;`.

**`migrations/.snapshot-*.json` must be committed.** It is the reference
`db:generate` diffs against. Without it MikroORM diffs your entities against
whatever the connected database currently contains, so running `db:generate`
before `db:migrate` on a fresh clone emits a second migration that recreates
every table you already have. Verified both ways: with the snapshot deleted,
adding one column produced a full `create table "users" (...)`; with it
committed, the same change against a completely empty database produced
`alter table "users" add column "phone"`.

**The snapshot's filename tracks the database name** (`.snapshot-app.json` for a
database called `app`). Rename the database and the snapshot is orphaned,
silently restoring the behaviour above. Rename the snapshot to match, or
regenerate it with `bunx mikro-orm migration:create --blank` and delete the
blank migration it also writes.

**Paths default to `process.cwd()`, not to the file that wrote them.** The
database package's `migrationsPath` defaults to `"./migrations"`, resolved
against wherever you launched the process — from the repository root it finds
zero migrations and reports nothing pending. Anything loaded from a different
cwd (the test preflight, a one-off script) must resolve paths from
`import.meta.url`.

**Root files do not reach the container.** `backend/Dockerfile` copies each
package explicitly. `tsconfig.base.json` is in that list because without it
Bun's cwd-based lookup falls back to TS defaults, decorators break at runtime,
and no test catches it. Adding a workspace package means touching the
Dockerfile, root `package.json` (`workspaces`, `typecheck:*`, **and
`test:unit`**), `vitest.config.ts`, and CI.

**A vitest project missing from `vitest.config.ts` never runs**, and its tests
look green because nothing reports on them.

**Shared test database.** `database` and `backend` both truncate `users`, so
`fileParallelism` is off — see the comment in `vitest.config.ts`.

**Process-global state leaks between tests.** The rate limiter is one Map for
the process, so tests reusing an actor id inherit each other's spent budget and
fail with a 429 where they expected a 400. The integration suite mints a fresh
actor id per test for exactly this reason.

**zod v4 `.default({})` does not fill inner defaults.** Unlike v3,
`z.object({a: z.number().default(1)}).default({})` yields `{}`. Write nested
defaults out in full — pinned by a test in `packages/config`.

**Bun does not hoist dependencies to the root.** `hono`, `zod` and
`@mikro-orm/*` live under each package's own `node_modules`. A missing root
`node_modules/<pkg>` is normal, and a script under `scripts/` cannot import a
workspace package at all — that is why the test preflight lives in
`packages/database`.

## Growing past this

- **Background jobs**: add a `worker/` workspace that polls a queue. Keep the API
  writing only a job row — do the job insert and the queue publish in one
  transaction, never publish after commit, so a crash between the two is
  impossible.
- **More than one replica**: move the rate limiter's state to Redis or a shared table.
- **Tracing**: the correlation id in `AppEnv` is already the seam; swap
  `crypto.randomUUID()` for a W3C traceparent.
- **Search**: add `pg_trgm` and a GIN index, or a dedicated search column,
  before the `q` filter meets a large table.
