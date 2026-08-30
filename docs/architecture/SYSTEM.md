# System architecture

## Deployment boundary

Sunpride Turbo has three technical deployables and two user-facing applications. The web app and PWA connect directly to the same Convex deployment. The connector runs inside the client network and only initiates outbound HTTPS calls; Convex never opens a connection into the SAP network.

```text
Next.js web ───────┐
                   ├── Better Auth + Convex functions + Convex database
React/Vite PWA ────┘                         ▲
                                             │ signed outbound HTTPS
Local SAP ◄── Bun connector + SQLite queue ──┘
```

## Charter module coverage

1. Master Data — products, customers, warehouses, territories, pricing references.
2. Inventory — warehouse balances and available-to-promise snapshots.
3. Sales Force Automation — assignments, planned visits, completion and notes.
4. Mobile/PWA — offline storage, transactional outbox, retry and conflict states.
5. Orders — idempotent order creation, lines, status lifecycle, SAP document number.
6. SAP Integration — versioned contracts, HMAC authentication, heartbeat, retry, dead letter.
7. Workflow/Approval — workflow instances, decisions, authority checks, comments.
8. Security/Admin — Better Auth identity, application profiles, server-side roles, audit log.
9. Dashboards/Analytics — maintained aggregate metrics rather than unbounded count scans.

The UI additionally exposes Analytics as its own navigation surface, while it remains part of the charter’s dashboard/analytics module.

## Data ownership

- SAP is authoritative for ERP master data, stock, and final SAP document outcomes.
- Convex is authoritative for application identity/profile, field drafts after sync, approval state, integration tracking, and audit events.
- IndexedDB is a device-local working store. It is not an independent system of record.
- Bun SQLite is connector delivery state. Completed records are retained for deduplication and operations evidence.

## Write paths

- Online web order: authenticated Convex mutation → workflow + approval → outbound integration event.
- Offline PWA order: IndexedDB transaction writes order + outbox → authenticated idempotent Convex mutation → same workflow.
- SAP inbound event: connector queue → signed Convex HTTP action → event-id deduplication → domain upsert.
- Approved order: Convex event → connector SQLite queue → SAP adapter → signed acknowledgement → order marked `sent_to_sap`.
