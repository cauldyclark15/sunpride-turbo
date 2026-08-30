# ADR-002: Offline synchronization and conflicts

Status: accepted.

- Every local order receives a UUID that is also its Convex `clientRequestId`.
- Order and outbox writes occur in one IndexedDB transaction.
- Synchronization is single-flight per browser tab and resumes on `online` events plus a periodic safety interval.
- Convex enforces idempotency with an indexed `clientRequestId` lookup.
- Retry uses bounded exponential backoff. Five browser failures produce an explicit `conflict` state; connector delivery uses ten attempts before `dead_letter`.
- Server-owned lifecycle fields such as approval status and SAP document number always win. Device-created order intent is immutable after successful synchronization in this initial implementation.
