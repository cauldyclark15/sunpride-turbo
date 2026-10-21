# Sunpride Sales System

Sunpride runs on a Bun HTTP API and native PostgreSQL 17 with pgvector. The Next.js management web is also the installable office app. Android field sales and van POS keep encrypted local databases and durable outboxes, synchronizing through `/api/sync`. The iOS source is retained but delivery is paused.

## Workspace

| Path | Responsibility |
| --- | --- |
| `apps/api` | Auth, scoped domain commands, sync, media, realtime and jobs |
| `packages/db` | SQL migrations, typed rows and sample-marked seeds |
| `apps/web` | Management cockpit, workflows and installable office app |
| `apps/field-android` | Offline field sales |
| `apps/van-sales-android` | Offline van POS, receipts and settlement |
| `apps/field-ios` | Paused native field client |
| `apps/sap-mock` | Local SAP contract service |
| `apps/pwa` | Retired field-pilot notice; retained local storage is not erased |
| `packages/ui` | Shared presentation |
| `packages/domain-contracts` | Frozen wire fixtures and native interoperability tests |
| `packages/integration-contracts` | SAP payload schemas |

## Local development

Use Bun 1.3.14+, PostgreSQL 17 and the existing workspace UI packages. The API database uses `vector`, `pgcrypto`, `citext` and `btree_gist`. Database sessions use UTC; business days use Manila time. No hosted backend account or container database is needed.

1. Run `bun install`.
2. Run `bun run setup:env` to create the web templates; put real secrets only in ignored local configuration or private environment variables. `.env.example` lists configuration names.
3. Supply `DATABASE_URL` privately and run `bun packages/db/src/migrate.js`.
4. For an isolated demo, run `bun packages/db/seed/run.js`; it adds marked sample rows idempotently. Never reset a shared database.
5. Start `bun run dev:api` (4310), `API_ORIGIN=http://127.0.0.1:4310 bun --cwd apps/web run dev --port 4300`, and optionally `bun run dev:sap` (4435).

The same-origin web proxy sends `/api` and `/ws` to the API. Web auth uses the httpOnly `sp_session` cookie; native auth uses the v2 bearer/device-proof protocol. Invitations and active profiles gate access. The server rechecks capabilities and organizational scope on each operation.

## Verification

Run API `bunx tsc -p jsconfig.json` and `SP_LANE=<your-lane> bun run test` from `apps/api`. The script isolates test files to prevent global mock leakage. Run DB `bunx tsc -p jsconfig.json` and `SP_LANE=<your-lane> bun test` from `packages/db`.

From `apps/web`, run `bunx tsc --noEmit`, `bunx vitest run`, `bun run lint`, and `bunx next build`. Android build/unit/lint checks run separately in each project with Android Studio's JBR. A build is not a physical-device proof. iOS is paused; do not build or install it for this cleanup.

`bun run audit:stack` rejects retired-backend references across tracked and new repository text, including lockfiles, docs and native configuration. Only the two lead-owned v2 architecture contracts and write-protected instructions are exempt. `bun run audit:secrets` checks credential hygiene without printing values.

## References

- [Backend contract](docs/architecture/BACKEND_V2.md) and [analytics contract](docs/architecture/ANALYTICS_V2.md)
- [System overview](docs/architecture/SYSTEM.md), [web data layer](apps/web/docs/DATA_LAYER.md)
- [SAP backbone](docs/spec/sap.md), [release and cutover](docs/spec/release-and-cutover.md)
- [Decisions](docs/decisions/README.md), [client requirements](docs/requirements/)
