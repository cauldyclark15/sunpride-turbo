# Backend v2 contract (read first; do not rename anything; report deviations instead of editing this file)

Owner decision 2026-10-19: Convex leaves the stack. The stack is now:

- PostgreSQL 17 with pgvector.
- A Bun HTTP API in plain JavaScript.
- Local-first SQLite on the phones, with sync.
- The Next.js web app.
- Hosting on the dev Mac at `https://sunpride.cauldnclark.com`.

No data is migrated: the database is fresh and seeded. The detailed inventories are outside the repo:

- `~/cnc/_plans/sunpride-v2/10-backend-inventory.md` covers tables, functions, auth, crons and lanes.
- `~/cnc/_plans/sunpride-v2/20-web-inventory.md` covers web call sites and lanes.
- `~/cnc/_plans/sunpride-v2/30-mobile-inventory.md` covers the native wire contract, sections D1-D8.

## 1. Layout

| Path | What | Owner |
|---|---|---|
| `packages/db/migrations/0001_platform.sql` | Platform tables: users, sessions, devices, challenges, rate limits, op receipts, change log, files, jobs, embeddings. | lane CORE |
| `packages/db/migrations/0100_*.sql` … `0199_*.sql` | All domain tables, one file per domain, in FK order. | lane SCHEMA |
| `packages/db/src/migrate.js` | The migration runner. It applies files in lexical order, once each, inside a transaction, and records them in `schema_migrations`. | lane CORE |
| `packages/db/src/client.js` | `createDb(url)` returns a `Bun.sql` instance, plus `tx(db, fn)`. | lane CORE |
| `packages/db/src/tables/<domain>.js` | JSDoc typedefs for the row shapes of each domain, plus enum constant arrays. These are the single shape source. | lane SCHEMA |
| `packages/db/seed/**` | Seeds. | a later lane |
| `apps/api/src/server.js` | The `Bun.serve` entry point. It reads `PORT` (default 4310) and `DATABASE_URL`. | lane CORE |
| `apps/api/src/core/**` | Router, errors, auth, sessions, capabilities, scope, device proof, idempotent op engine, change log, ws hub, scheduler, files, test harness. | lane CORE |
| `apps/api/src/domains/<domain>/**` | Domain handlers. Each domain exports `install(router, ctx)`. | domain lanes |
| `apps/api/src/domains/index.js` | The registry. It imports every domain's `install`. | lead only |

The code style:

- Everything is ESM `.js` with JSDoc types, checked by `tsc --noEmit --checkJs` through a `typecheck` script.
- `bun test` runs the tests.
- There are no TypeScript source files in `apps/api` or `packages/db`.
- There is no ORM. Queries use `Bun.sql` tagged templates only, and never string-concatenated SQL.

## 2. Database conventions

- IDs are `uuid` primary keys (`id uuid primary key default gen_random_uuid()`). Clients may supply UUIDs for offline-created rows.
- Every table has `created_at timestamptz not null default now()` and `updated_at timestamptz not null default now()`.
- Every table synced to phones also has `deleted_at timestamptz` and `change_seq bigint not null default nextval('change_seq')`. The trigger `bump_change_seq()` (created in 0001) sets `updated_at` and `change_seq` on UPDATE.
- Naming: snake_case tables and columns, with plural table names (for example Convex `plannedVisits` becomes `planned_visits`). Foreign keys are `<thing>_id uuid references <things>(id)`.
- Enums are `text` plus a `CHECK (col in (...))`, keeping the exact Convex literals.
- Money and quantities are `bigint` minor or base units, where Convex used int64 or integer minor units. Where Convex used float money, keep `numeric(14,2)` and note it.
- Manila service dates are `date`. Instants are `timestamptz`. On the wire, instants are epoch-ms integers.
- Nested immutable snapshots, audit diffs and heterogeneous unions are `jsonb`. Line and child facts are child tables with an `ordinal`.
- Each Convex index becomes a btree index. Each Convex search index becomes a `tsvector` generated column plus a GIN index.
- Platform tables come from 0001 and domain lanes must not redefine them: `users(id, email citext unique, password_hash, created_at, disabled_at)`, `sessions`, `access_tokens`, `registered_devices`, `device_challenges`, `rate_limits`, `op_receipts`, `change_log`, `files`, `jobs`, `embeddings(id, owner_table, owner_id, model, dims, embedding vector, …)`.
- `profiles` (domain, lane SCHEMA) has `user_id uuid unique references users(id)`. A profile is the app person, with role, org unit and status. `users` is only the login identity.

## 3. HTTP

- JSON in and JSON out. Paths:
  - `/api/v1/<domain>/<action>`, where GET means read and POST means command.
  - `/api/auth/*`
  - `/api/me`
  - `/api/sync/*`
  - `/api/media/*`
  - `/ws`
  - `/healthz`
- The error envelope is `{"error":{"code":"snake_code","message":"Plain words","retryable":false}}`. Status codes: 400 invalid, 401 unauthenticated, 403 forbidden or out of scope, 404, 409 conflict, 422 business rule, 429, 500.
- Auth for web: the httpOnly cookie `sp_session`, `SameSite=Lax`, `Secure` behind the tunnel. Web and API share an origin through the tunnel (`/api` and `/ws` go to :4310, the rest to :4300). In local dev, Next rewrites `/api/*` and `/ws` to :4310.
- Auth for native: `Authorization: Bearer <accessToken>`. The exact native shapes for sign-in, refresh, sign-out, me, device challenge and bind, sync pull and push, and media claims and uploads are in mobile inventory sections D1-D6. They are adopted as-is (protocol `version: 2`).
- Handlers get `ctx = { db, actor, req, url, body, now, publish(topic), enqueue(job) }`. `actor` is `{ userId, profileId, role, orgUnitId, capabilities:Set }` or null.
- Authorization works through `requireCapability(ctx, 'cap.name', targetUnitId?)`. It is ported 1:1 from Convex `lib/capabilities.ts`, with the 51 grants and the super_admin and analyst rules (backend inventory §3). Scope helpers are ported from `lib/scope.ts`.
- Writes run inside `tx()`. Any write that other viewers must see calls `ctx.publish(topic)` after commit.

## 4. Realtime

`/ws` is authenticated by the cookie or bearer.

- The client sends `{"type":"subscribe","topics":["issues","issue:142"]}`.
- The server sends `{"type":"invalidate","topic":"issues","seq":123}`.
- The server checks the topic grant on subscribe.
- Fan-out uses Postgres `LISTEN/NOTIFY` on channel `sp_events`, so several API processes stay correct.

## 5. Mobile sync

The mobile wire contract (D2-D6) is authoritative:

- `POST /api/sync/pull` handles projections `field.bundle`, `van.bundle`, `field.sales`, `team.summary` and `suggested-order`, with snapshot, delta and cursor handling.
- `POST /api/sync/push` handles per-op idempotency through `op_receipts`, keyed on subject, device and clientOpId plus a payload hash.
- Device proof is ECDSA P-256 over `METHOD|path|sha256(body)|nonce|timestamp`.

The op engine lives in CORE. Each domain registers its op types and projections with `registerOp(opType, handler)` and `registerProjection(name, handler)`.

## 6. Jobs and scheduler

The in-process scheduler replaces Convex crons:

- every 1 min: coverage activation
- 00:15 Manila: expire due lots
- 19:40 Manila: location purge
- 22:00 Manila: day close

The `jobs` table carries `run_at` and coalescing keys for deferred work. Rollup refreshes and scheduled projections use it.

## 7. Ports and processes (dev Mac)

| Port | Use |
|---|---|
| 5432 | Postgres. The URL is in `~/.sunpride-keys/pg-dev-url`. Never print it. |
| 4310 | API |
| 4300 | Web |

Lane databases are `sunpride_lane_<lane>`. Never use other ports, and never touch other projects' containers.
