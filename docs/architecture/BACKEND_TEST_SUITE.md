# Backend test suite

## Current execution

From `apps/api`, run `bunx tsc -p jsconfig.json` and `SP_LANE=<lane> bun run test`. The package runner executes each test file in a separate Bun process; running the whole API with bare `bun test` allows process-global mocks to leak across suites. The harness creates and drops throwaway `sunpride_lane_<lane>_t*` PostgreSQL databases using the lane's private URL file. Never print a database URL.

From `packages/db`, run `bunx tsc -p jsconfig.json` and `SP_LANE=<lane> bun test`. Schema tests insert minimally valid rows and exercise index-leading reads and database constraints; migration tests verify rollback and idempotency. Seed tests retain their own teardown.

## Proof sources

| Concern | API test source |
| --- | --- |
| Auth, role grants and device trust | `test/auth.test.js`, `test/capabilities.test.js`, `test/devices.test.js` |
| Org and coverage | `test/org.test.js`, `test/coverage.test.js` |
| Visits and call flow | `test/visits.test.js`, `test/callflow.test.js` |
| Snapshot, delta and retry | `test/sync.test.js`, `test/fieldsync.test.js` |
| Stock and imports | `test/inventory.test.js`, `test/imports.test.js` |
| Van custody and settlement | `test/van.test.js`, `test/vanops.test.js` |
| SAP mediation | `test/sap.test.js`, `test/sap-console.test.js` |
| Cross-domain integration | `test/spec-integration.test.js` |

Frozen v1 JSON/crypto fixtures live in `packages/domain-contracts`; they do not certify compatibility with the current v2 HTTP envelope. Physical-phone, offline route, printer and public deployment proofs remain separate. Repository technology and credential gates are `bun run audit:stack` and `bun run audit:secrets`.
