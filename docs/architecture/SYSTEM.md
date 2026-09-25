# System architecture

## Deployment boundary

Sunpride Turbo plans four user-facing products on one Convex backend: management web, native iOS field, native Android field, and separate Android van POS. Only the web app exists in the target product set today; the native apps are planned at `apps/field-ios`, `apps/field-android` and `apps/van-sales-android` ([ADR-010](../decisions/ADR-010-NATIVE-FIELD-APPS-IOS-AND-ANDROID.md)). The existing `apps/pwa` is frozen legacy code, to be retired after the native pilot ([ADR-004](../decisions/ADR-004-NATIVE-ANDROID-FIELD-AND-POS.md)). The connector runs inside the client network and only initiates outbound HTTPS calls; Convex never opens a connection into the SAP network.

```text
Next.js management web ───────┐
Native iOS field (planned) ─────┤
Native Android field (planned) ─┼──► Better Auth + Convex functions + Convex database
Android van POS (planned) ─────┘                 ▲
             native clients: mobile sync gateway │ signed outbound HTTPS
Local SAP ◄── Bun connector + SQLite queue ─────┘
```

The connector polls/acknowledges via Convex; SAP remains inside the client network. Native clients use the [versioned mobile sync gateway](../decisions/ADR-021-MOBILE-SYNC-GATEWAY.md), not a live PWA connection. The [decision index](../decisions/README.md) and [SFA delivery sequence](../delivery/SFA_DELIVERY_SEQUENCE.md) record the target and rollout.

## Charter module coverage

1. Master Data — products, customers, warehouses, territories, pricing references.
2. Inventory — lot-aware receiving, reservations, transfers, manufacturing, counts, rolling-truck custody, POS issues/reversals, operational balances, and reconciliation.
3. Sales Force Automation — assignments, planned visits, completion and notes.
4. Native Mobile — local encrypted storage, transactional outbox, explicit sync, retry and conflict states (legacy PWA frozen).
5. Orders — idempotent order creation, lines, status lifecycle, SAP document number.
6. SAP Integration — versioned contracts, HMAC authentication, heartbeat, retry, dead letter.
7. Workflow/Approval — workflow instances, decisions, authority checks, comments.
8. Security/Admin — Better Auth identity, application profiles, server-side roles, audit log.
9. Dashboards/Analytics — maintained aggregate metrics rather than unbounded count scans.

The UI additionally exposes Analytics as its own navigation surface, while it remains part of the charter’s dashboard/analytics module.

## Data ownership

- SAP is authoritative for approved ERP master data, accounting/financial inventory outcomes, closed-period policy, and final SAP document identifiers.
- Convex is authoritative for operational physical inventory, exact lot allocation, application identity/profile, approval state, integration tracking, and audit events. See ADR-003.
- Native apps' encrypted local databases and outboxes are device-local working stores, not independent systems of record. The legacy PWA's IndexedDB is likewise only a cache.
- Bun SQLite is connector delivery state. Completed records are retained for deduplication and operations evidence.

## Write paths

- Online web order: authenticated Convex mutation → workflow + approval → outbound integration event.
- Offline rolling-truck sale (planned Android van POS): local database transaction validates/decrements the cached truck projection and writes sale + sequenced outbox → device-bound, idempotent gateway push → authoritative Convex POS order + exact FEFO issue movement on acceptance.
- SAP inbound event: connector queue → signed Convex HTTP action → event-id and payload deduplication → master projection, explicit movement command, or reconciliation snapshot.
- Approved order: Convex event → connector SQLite queue → SAP adapter → signed acknowledgement → order marked `sent_to_sap`.
- Inventory posting: Convex document + movement + allocations + ledger + summaries + command + audit + integration effect in one transaction → connector retry queue → SAP movement acknowledgement.
