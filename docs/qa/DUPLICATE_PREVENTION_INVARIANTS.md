# Duplicate-prevention invariants (QSR-004 / SP-0024)

Acceptance: repeated mobile submissions, timeouts and retries must not duplicate visits, orders,
payments, stock movements or SAP documents. Each row below names the key, where it is enforced and
the convex-test that proves it. All tests run in `bun run test` (backend `vitest run`).

Every guard runs inside one Convex mutation, so a refused retry rolls back all of its writes; the
"no rows added" assertions in the tests check exactly that.

## Visits (native field apps → `mobile/push.applyOne`)

| Retry shape                                                                | Guard                                                                         | Result                                                                | Test                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same `clientRequestId`, same payload (lost ack, timeout, re-sent batch)    | `processedMobileOperations` registry, `mobile/idempotency.ts` `findOrExecute` | Original ack returned; no visit, activity, event or change rows added | `mobile/push.test.ts` "replays a batch across calls and clock advance…"; `mobile/http_handlers.test.ts` "identical operation replay over two authenticated HTTP calls…"; `acceptance/sfa_pilot.acceptance.test.ts` UAT-E2E-02 |
| Two concurrent calls with the same key                                     | Same registry; Convex serializes the conflicting transactions                 | One commit, both callers see the same ack                             | `mobile/push.test.ts` "…concurrent same-key calls commit once"                                                                                                                                                                |
| Same key, changed payload or another device/person                         | Payload SHA-256 + device/profile match                                        | `conflict`; nothing written                                           | same test                                                                                                                                                                                                                     |
| New `clientRequestId`, same `clientVisitId` (outbox rebuilt after a crash) | `visitExecutions.by_organizationId_and_clientVisitId`                         | `conflict`; no second visit                                           | `mobile/push.test.ts` "a re-queued visit or order intent under a fresh request key never duplicates it"                                                                                                                       |
| New phone visit for an already executed planned visit                      | `visitExecutions.by_plannedVisitId`                                           | `conflict`                                                            | `visits/commands.test.ts` "rejects wrong date, cancelled plan, duplicate execution…"                                                                                                                                          |
| Rejected operation retried later                                           | Registry row is written only after the domain write succeeds                  | Key stays free; nothing half-applied                                  | `mobile/push.test.ts` "rolls back a domain-rejected check-in…", "rejects missing dependency…"                                                                                                                                 |
| Visit photo re-uploaded after lost response                                | Evidence claim consumed once, storage ID unique                               | Original row returned; mismatched replay refused                      | `visits/commands.test.ts` "AND-016…"; `visits/evidence.test.ts` "consumes once…"                                                                                                                                              |

## Orders

| Path                                                      | Key                                                           | Guard                                                                                                                                                                  | Test                                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order intent captured on a call (`order_intent` activity) | `clientOrderId` per visit                                     | A second intent with the same `clientOrderId` on the same visit, even under a new request key, is `conflict` (`visits/commands.ts`)                                    | `mobile/push.test.ts` "a re-queued visit or order intent…"                                                                                                                                  |
| Web / legacy order (`domains/orders.create`)              | `clientRequestId` (`orders.by_client_request`)                | Same request returns the original order; same ID with different customer/lines is refused ("Request ID was reused with another order"); another person's ID is refused | `domains/orders.test.ts` "creates an order… exactly once"; `domains/orders.scope.test.ts` "…prevents foreign idempotency replay"; `acceptance/sfa_pilot.acceptance.test.ts` `approvedOrder` |
| Order approval                                            | Status must be `pending_approval`                             | A second decision is refused, so the SAP submission event is created once                                                                                              | `acceptance/sfa_pilot.acceptance.test.ts` UAT-E2E-01                                                                                                                                        |
| Outside-call PO (`orders/outside_calls.encode`)           | `clientRequestId` per encoder, plus `outletId + poNumber`     | Replay returns the original; reused ID for another PO or a second live PO number is refused                                                                            | `orders/outside_calls.test.ts` "sales admin encodes a PO…", "refuses … duplicates…"                                                                                                         |
| Van POS sale (`inventory/pos.postSale`)                   | `clientRequestId` + payload hash + contiguous device sequence | Replay returns the original order and movement (`duplicate: true`); changed payload, another person's request ID, or a reused sequence slot is refused                 | `inventory/pos.test.ts` "enforces contiguous device sequence while replaying an acknowledged sale without double posting"                                                                   |
| Van POS return / void                                     | `pos-return:<clientRequestId>`, void `idempotencyKey`         | Replay posts nothing; returns capped at sold quantity                                                                                                                  | `inventory/pos.test.ts` "caps returns…", "marks a full return… each exactly once"                                                                                                           |

## Payments / collections

No payment or collection is recorded by software yet. The mobile `collection.record` operation is
refused as `unsupported_operation` **without consuming its key**, so when the writer ships a queued
collection can still be applied once (`mobile/push.test.ts` "rejects missing dependency and unsupported
middle item without consuming keys…"; `visits/commands.test.ts` "rejects forged storage and unsupported
task/collection kinds"). `fieldCollections` has no writer; whoever adds one must key it through the
same `processedMobileOperations` registry and add a replay test here.

## Stock movements

| Path                                              | Key                                                               | Test                                                                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Every movement (`inventory/posting.postMovement`) | `idempotencyKey` + payload hash on `inventoryCommands`            | `inventory/posting.test.ts` "posts an idempotent FEFO truck sale…", "rejects a reused idempotency key with a different payload"      |
| Opening stock import                              | Server `chunkHash`; `duplicate_stock` on any existing quantity    | `imports/openingStock.test.ts` "replaying the same file adds no stock", "refuses to post opening stock twice…"                       |
| Adjustment / count imports                        | Chunk key + source line keys                                      | `imports/adjustments.test.ts`, `imports/counts.test.ts`                                                                              |
| SAP-approved movement (inbound)                   | `integrationEvents.by_event_id`, then `sap:<eventId>` command key | `integration/sap.test.ts` "posts an approved SAP movement…" (re-delivery returns `duplicate: true`, one movement, balance unchanged) |

## SAP documents

| Direction                              | Guard                                                                                            | Test                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Inbound event re-delivery              | `integrationEvents.by_event_id`                                                                  | `integration/sap.test.ts` "deduplicates event ids…", "posts an approved SAP movement…" |
| Outbound sales order                   | One event per order, `eventId = order-<orderId>`, created only on the single approval transition | `acceptance/sfa_pilot.acceptance.test.ts` UAT-E2E-01                                   |
| Connector ack retried or arriving late | `acknowledgeTask`: `completed` is terminal; acks for inbound events are ignored                  | `integration/sap.test.ts` "treats an accepted SAP document as final…"                  |
| SAP failures                           | Backoff, dead letter on the tenth failure; order stays approved                                  | `acceptance/sfa_pilot.acceptance.test.ts` UAT-E2E-03b                                  |

## Residual risks (not provable in convex-test)

- **Connector → SAP.** Convex never requeues an accepted document, but if SAP accepts a document and
  the connector times out before acking, the connector's retry reaches SAP again. Whether SAP rejects
  it depends on the connector sending the stable `eventId` as SAP's external reference (for example
  `NumAtCard`) and SAP checking it. That needs the SAP connector owner and a SAP test system.
- **Native outbox.** The server guards above assume the phone keeps the same `clientRequestId`,
  `clientVisitId` and `clientOrderId` across retries; the iOS/Android outbox tests cover byte-stable
  replay on device. Field retesting on real devices with flaky signal is still a pilot activity.
- `order_intent` uniqueness is per visit. The same `clientOrderId` on a different visit is a separate
  intent; an intent is visit evidence, not an order (the pilot keeps order capture off on mobile).
