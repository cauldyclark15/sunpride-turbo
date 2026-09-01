# ADR-002: Offline synchronization and conflicts

Status: accepted.

- Every local order receives a UUID that is also its Convex `clientRequestId`.
- Order and outbox writes occur in one IndexedDB transaction.
- Synchronization is single-flight per browser tab and resumes on `online` events plus a periodic safety interval.
- Convex enforces idempotency with an indexed `clientRequestId` lookup.
- Retry uses bounded exponential backoff. Five browser failures produce an explicit `conflict` state; connector delivery uses ten attempts before `dead_letter`.
- Server-owned lifecycle fields such as approval status and SAP document number always win. Device-created order intent is immutable after successful synchronization in this initial implementation.

ADR-003 extends this policy for rolling-truck POS: a new sale also carries the truck location, route session, stable device ID, monotonic device sequence, scaled quantity, and cached conservative stock projection. Older version-1 outbox records retain the legacy order endpoint so an application upgrade does not discard already captured work.
