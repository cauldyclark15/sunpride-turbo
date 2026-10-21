# ADR-018: SAP and Sunpride source-of-truth boundary

Status: accepted, updated to the client's Phase 1 manner rules.

SAP remains the system of record for pricing, credit, inventory value and posting. Sunpride captures field execution and keeps provenance-bearing replicas and pending business intent. Neither a local movement nor a printed delivery receipt is proof of final ERP or fiscal acceptance.

| Data | Authority and local behavior |
| --- | --- |
| Customer/product/pricing replicas | Retain SAP key, source/version, effective dates and received time; marked samples are development data |
| Credit | Use the SAP mediation decision; offline capture is provisional, unknown is not within limit |
| Physical stock/custody | SQL movement ledger records execution; snapshots reconcile and do not blindly replace newer execution |
| Field/van intent | Stable client operation ID and immutable payload; current device/scope reauthorized at acceptance |
| Accounting documents/value | SAP result and identifiers, retained independently from local capture and approval |
| Route, visit, evidence and plan | API-owned operational facts with scope, audit and frozen approval snapshots |

One gateway in `apps/api/src/domains/integration` serves all channels. `apps/sap-mock` supplies local contracts until real access exists. Configure `SAP_MODE`, `SAP_ORIGIN` and private `SAP_TOKEN`; a production switch still needs service/auth/idempotency acceptance. Durable outbox retries keep the same event key, payload hash and correlation references. Never duplicate local stock posting because of a timeout or financial rejection.

See [SAP backbone](../spec/sap.md) and [operational ledger](ADR-003-OPERATIONAL-INVENTORY-AUTHORITY.md).
