# Backend domain and sync test suite (CVX-035)

All backend tests run in `convex-test` (no deployment touched) via `bun run test`.
This page maps each acceptance area of CVX-035 to the tests that guard it, so a
reviewer can see where a behaviour is pinned and where gaps remain.

Run a single area: `cd packages/backend && bunx vitest run convex/<path>`.

## End-to-end acceptance

| Flow                                                                                                                                                                                                                                              | Test                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Foundation: bootstrap, org scope, roles, readers                                                                                                                                                                                                  | `convex/acceptance/foundation.acceptance.test.ts`                                                            |
| Shared foundation exit gate (SFD-019): web CSV templates → opening stock → ledger → web overview and van POS; replay, adjustment retry, count variance, cross-scope denial, audit; frozen client contracts. See `docs/qa/FOUNDATION_EXIT_GATE.md` | `convex/acceptance/foundation_exit_gate.acceptance.test.ts`, `convex/acceptance/foundation_contract.test.ts` |
| Field pilot day: MCP authored → manager signs → activation creates planned visits → phone pushes planned check-in, order intent and End offline → whole-batch retry is a no-op → teammate cannot execute, edit or replay the call                 | `convex/acceptance/field_pilot.acceptance.test.ts`                                                           |

## By acceptance criterion

| Criterion                 | Where it is covered                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State transitions         | MCP lifecycle `coverage/plans.test.ts`, `coverage/same_day_flow.test.ts`, `coverage/activation.test.ts`, `coverage/lock.test.ts`; visit state machine `visits/commands.test.ts`; van route session open → closing → closed `inventory/pos.test.ts`; count lifecycle `inventory/counts.test.ts`; order approval `domains/orders.test.ts`                                                 |
| Authorization             | Capability table `lib/capabilities.test.ts`; org scope `lib/scope.test.ts` and every `*.scope.test.ts`; device identity `mobile/device_auth.test.ts`, `mobile/devices.test.ts`; push reauthorization before replay `mobile/push.test.ts`, `acceptance/field_pilot.acceptance.test.ts`; van seller/device ownership `inventory/pos.test.ts`                                              |
| Idempotency               | Mobile operation registry `mobile/idempotency.test.ts`, `mobile/push.test.ts`, `mobile/http_handlers.test.ts`; inventory commands `inventory/posting.test.ts`; van sale/return replay and payload-reuse refusal `inventory/pos.test.ts`; CSV import chunks `imports/*.test.ts`; MCP activation re-run `coverage/activation.test.ts`; orders `domains/orders.test.ts`                    |
| Offline retry             | Lost-ack batch replay across clock advance `mobile/push.test.ts`, `acceptance/field_pilot.acceptance.test.ts`; dependency ordering `mobile/push.test.ts`; late sync and next-morning delivery `visits/commands.test.ts`; pull cursor and rebootstrap `mobile/pull.test.ts`, `mobile/cursor.test.ts`, `mobile/bootstrap.test.ts`; van contiguous device sequence `inventory/pos.test.ts` |
| MCP generation            | `coverage/activation.test.ts` (signed snapshots, supersession, Manila boundaries), `coverage/plans.test.ts`, `imports/mcp.test.ts`, `acceptance/field_pilot.acceptance.test.ts`                                                                                                                                                                                                         |
| Order / visit integration | Planned visit → order intent → End `acceptance/field_pilot.acceptance.test.ts`; outside-MCP PO encoding and activity `orders/outside_calls.test.ts`; DSR roll-up of calls and order intents `dsr/dsr.test.ts`; per-diem/report forms `field_reports/reports.test.ts`                                                                                                                    |
| Van inventory invariants  | `inventory/pos.test.ts`: ledger sum equals truck available stock, lot balances equal physical stock, never negative, oversell rolls back order/ledger/sequence, returns capped at sold quantity, void/return exactly once, route close checkpoints truck stock. FEFO and reversal details `inventory/posting.test.ts`                                                                   |

## Known gaps and open questions

- A van sale that was partly returned leaves status `partially_voided`, which
  blocks any further return or void of the rest. The per-request return cap is
  not cumulative, so allowing a second return safely needs cumulative tracking
  first. `inventory/pos.test.ts` pins the current behaviour.
- The mobile push gateway rejects `task.complete` and `collection.record` as
  `unsupported_operation`; collections and van sales are not yet synced through
  it, so there is no offline-collection test.
- `order_intent` is a client reference on the visit; no server order is created
  from it yet, so the order/visit link is only as strong as that reference.
- Native app behaviour (Android/iOS outbox, retries) is tested in the native
  projects, not here.
