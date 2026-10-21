# Duplicate-prevention invariants

V2 commands use stable idempotency keys and payload hashes. `apps/api/src/core/sync.js` stores operation receipts by subject/device/client operation ID, and domain writers use transactional receipt/constraint guards. An identical retry returns the original result; changed content, caller or sequence must not be silently accepted.

Test lost response, same-key concurrent calls, uncertain partial batch, changed payload, revoked caller before replay, and dependency sent before its check-in acknowledgement. Count domain documents, movements, allocations, audit and receipt rows before/after; comparing only returned IDs is insufficient. Postgres uniqueness/locking and the business transaction must agree.

Run `test/sync.test.js`, `visits.test.js`, `inventory.test.js`, `orders.test.js`, `van.test.js` and `sap.test.js` with the isolated API runner and a private lane database. Native outboxes retain exact bytes and durable acknowledgements; a successful backend retry test does not prove phone process-death persistence or SAP-side idempotency. Those require separate evidence.
