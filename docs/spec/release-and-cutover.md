# Release and cutover v1 — F-023 / BB-01

## F-023 scope and authority

This playbook is for the new Bun API + PostgreSQL 17 + Next web + Android stack. Use the API/SQL deployment steps below; retired hosting instructions have been removed. No legacy backend command, migration or credentials are needed. This document is our release design, not proof that QA/staging/production have already been provisioned or accepted. Public showcase remains unchanged by a lane.

SAP owns prices, credit, inventory value and posting. Contracts are versioned in `sap-interface-catalogue.md`. A QA SAP adapter is a separate certified deployment speaking that contract; point production only at that adapter, never at the sample server.

## F-023 isolated environments and configuration

| Environment | Database/media/identities                                                                                         | SAP                                                                                        | Release purpose                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Dev lane    | own Postgres DB from `pg-lane-ssap-url`; isolated files/session/cursor keys                                       | loopback mock :4435, persistent SQLite outside checkout                                    | unit/contract/kill/replay tests only; API :4430                                          |
| QA          | separate Postgres DB, files root, test organization/users, cookie origin and keys                                 | independent seeded mock by default; separately authorized SAP QA adapter for certification | reproducible functional/wave evidence, never real money                                  |
| Staging     | production-shaped DB/media restored from approved sanitized backup, independent sessions/device keys and hostname | SAP QA adapter, not live SAP                                                               | exact immutable release artifact and additive migrations; restore and rollback rehearsal |
| Production  | separate production DB/media/identity issuer, restricted app DB role, monitored backups/PITR                      | authenticated HTTPS production SAP adapter only                                            | release after wave go/no-go, SAP mapping and fiscal authorization                        |

Pass configuration via a supervisor/secret store, not tracked env files or shell history. Required API values are `DATABASE_URL`, `PORT`, `FILES_DIR`, `SYNC_CURSOR_SECRET`, `BOOTSTRAP_ADMIN_EMAILS`, `SAP_MODE`, `SAP_ORIGIN`, `SAP_TOKEN`, `SAP_TIMEOUT_MS`; other existing auth/device settings remain unchanged. For mock mode, origin must be localhost/127.0.0.1. For real SAP (`SAP_MODE=sap`) the gateway requires HTTPS and a nonempty bearer secret and refuses redirects. Deploy a compatible adapter, not arbitrary SAP OData. Never set SAP_TOKEN as NEXT_PUBLIC_* or place it in an APK.

Mock-only values: `SAP_MOCK_DB`, `SAP_MOCK_TOKEN`, `PORT=4435`. Use a private service account and 0600 key files; read keys inside scripts and never print secrets, headers, password hashes or connection URLs. `SAP_MOCK_TOKEN` and API `SAP_TOKEN` must match. Keep control endpoints inaccessible outside loopback. QA uses different secrets from staging/production.

Web build: `API_ORIGIN` must address the environment's Bun API and `NEXT_PUBLIC_BETA_ENABLE=integration` makes the console visible in the existing Setup group. This public switch is not authorization. Native endpoints are selected at build time; publishing a new binary requires jc's authorization. No iOS release is included.

## F-023 build, verify and promote

1. Record the source SHA and migration manifest; confirm a clean worktree. Do not build artifacts from a moving branch.
2. Run API typecheck and isolated file-runner tests with the correct SP_LANE. Run DB typecheck/tests, contract conformance tests, web typecheck/tests/lint/build and changed-file formatting. Preserve exit codes and actual counts.
3. Run stateful mock acceptance: all interfaces, version/tombstone conflicts, ambiguous prices, within/over/stale credit, changed-key quarantine, concurrent claims, lease expiry, accepted-send/response loss, real process kill/restart and dead-letter replay. Retain hashes and SAP-number readbacks.
4. Build one immutable API/web/native release set. Record source SHA, runtime/lockfile versions, artifact SHA-256, migration filenames, contract v1 identifier and environment-config fingerprint (names/nonsecret endpoints only). Verify artifact hashes at each promotion.
5. Promote the SAME artifacts Dev → QA → Staging → Production. Do not rebuild per environment to change private SAP credentials. Public Next/native build-time endpoints require a separately identified environment build; never pretend their bytes are identical. Retain each artifact's hash and source SHA.
6. On staging, restore backup to a new database/files root, apply additive migrations, start the candidate without public writes, exercise role-authentic analytics, a credit confirmation and the five financial posting families. Confirm counts/control totals and effect-key uniqueness at both ends.
7. Obtain the wave go/no-go and SAP/Controller/fiscal sign-offs. Record external sign-offs separately from software test results. The mock is not SAP QA certification and candidate printing is not a BIR permit.

## F-023 cutover sequence

1. Announce the write window. Stop only this environment's worker and ingestion/scheduler processes; preserve outbox rows, leases, cursors and remote receipts.
2. Capture an encrypted `pg_dump`/PITR restore point and media manifest/checksums. Take a read-only control total pack for orders, centavos, stock base units, AR SAP document balances, pending/dead/completed effects and SAP document references. Prove the backup restores on staging before the window.
3. Apply `packages/db/src/migrate.js` against the intended DB. Migrations 0400–0404 are additive; do not edit previously applied migration files or reset sample/live data.
4. Configure SAP/mock vs QA/prod explicitly. Validate every depot/van plant/storage-location mapping, material/UOM pack, currency/tax and condition validity. Block production posting when certification is missing; do not let an application operator enter a fake SAP document number.
5. Start candidate API, web and workers. Let expired claims be reclaimed through normal fenced leases, never by deleting queue rows. Replay original effect identities. Read back every SAP acknowledgement and its source record.
6. Smoke-test sign-in and default-role Home/Reports, scoped order/van confirmation, master feed/delta and Integration console. Compare control totals and unacknowledged effects. Monitor queue age, rejection/dead-letter count, retry rate, last master feed success, SAP latency and DB/media health.
7. Open writes only when reconciliation is clean. Keep the prior binaries/artifacts and backups through the agreed observation period; record release owner, timestamps and go/no-go evidence.

## F-023 rollback and recovery

Roll back application artifacts first; retain additive DB columns/tables, effect identities, version history and op receipts. Never drop/recreate the integration queue, purge a failed posting, or roll the SAP server back to a receipt-less snapshot. A local DB restore does not undo financial documents already accepted by SAP. After restore, reconcile using effect IDs and SAP lookup before enabling any retry or selling. For an acknowledged incorrect financial document, issue an authorized SAP reversal/credit instruction with its own linked identity; do not mutate the original.

Stop worker/ingestion writes before restoring. Restore database and media together into a new target, verify file hashes and referential integrity, compare remote SAP receipts/control totals, then switch the environment's connection. Retire restored auth/device sessions unless explicitly reauthorized. If an old binary cannot consume the additive schema/contract safely, keep the write window closed and forward-fix. No destructive down migration is part of this lane.

## F-023 evidence and remaining human acceptance

Retain test logs, source/artifact hashes, migration results, restored control totals, SAP trace IDs, the dead-letter/retry screenshots and the outage recovery result together. The lane report distinguishes mock proof from real SAP QA. Named SAP/IT owners must approve interface and mapping certification; Controller approves credit/valuation/posting treatment; Sunpride legal/tax and BIR own permits; CIO and VP Sales own W0 acceptance. No agent can manufacture those approvals. Native route endurance with a removed SIM remains a separate physical acceptance exercise.
