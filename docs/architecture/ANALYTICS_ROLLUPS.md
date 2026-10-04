# Territory, customer and SKU daily rollups (`CVX-032`)

Backend: `packages/backend/convex/analytics/rollups.ts` (writer, hooks, readers) and `analytics/rollups_model.ts` (pure counting rules). Tests: `analytics/rollups.test.ts`. Consumers: the territory, customer and SKU dashboards (`ANA-004`, `ANA-005`, `ANA-006`) and the admin report pack. The per-person daily rollup is `CVX-031` (separate).

## Tables

| Table                   | One row per                               | Figures                                                                                                                                                                                 |
| ----------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dailyTerritoryMetrics` | territory × Manila date × owning unit     | planned stops / planned stops done, visits, completed and off-plan visits, calls, productive calls, collections (count, centavos), sale orders and sales, returns, **buying customers** |
| `dailyCustomerMetrics`  | customer code × date × unit × territory   | the same figures as territories, without buying customers                                                                                                                               |
| `dailySkuMetrics`       | product code × date × unit                | sale orders containing the SKU, quantity, sales; return orders, return quantity, returns                                                                                                |
| `rollupContributions`   | source document (order, visit, plan stop) | what that document currently adds, and to which rows                                                                                                                                    |
| `rollupRefreshes`       | pending source refresh                    | debounce marker, deleted when the refresh runs                                                                                                                                          |

All figures are additive, so a region, a channel or a month is a sum of rows; ratios (productive %, plan completion %) are computed after summing, never averaged. `rollupHeadline` gives net sales, productive % and plan completion % for a summed set.

`orgUnitId` on every row is the scope key: the territory's owner at Manila noon of the date, else the outlet custodian (orders) or the visit's unit, else the seller's unit, else the national root.

## Counting rules (same as the DSR and the daily execution dashboard; 2 Oct 2026 call answers win)

- Sale: an order not draft/rejected/voided, dated the day the salesman wrote it (offline time trusted up to 3 days). A negative total is a return (POS returns post as negative orders); the original order keeps counting, the return nets it off. Money is PHP centavos.
- Customer → territory: order customer code → customer → outlet linked on that day (`outletCustomerLinks`, latest wins) → the outlet's territory assignment on that day. Visits use their outlet; planned stops use the signed `approvedSnapshot` territory and customer.
- Call: a route-plan visit checked out or completed; productive when any one listed activity was recorded, with the truck-seller rule from the person's position standard on the day (`sfa/productive_call.ts`). Off-plan visits count as visits, never calls. Rejected collections never count.
- Planned stop: a planned visit still `planned` (cancelled/replaced drop out); done when any visit for it is checked out or completed.
- SKU quantity is in the order line's own selling unit as entered (orders do not store a UOM yet).

## Freshness

Every order write (`domains/orders` create/decide, `inventory/pos` sale/void/return) and every visit execution event (`visits/events.append`: visit, activity, collection) queues a refresh of that source; `refresh` runs 10 s later, so a burst of phone operations costs one recompute. A visit refresh also refreshes the planned stop it fulfils. Plan activation queues `refreshPlan` for the new plan and the plan it supersedes. A refresh subtracts the old contribution and adds the new one, so it is exact and idempotent; a pending marker older than 10 minutes is re-armed by the next write.

## After deploy

Run once per source (pages of 25, self-scheduling, safe to repeat):

```bash
bunx convex run analytics/rollups:backfill '{"source":"order"}'
bunx convex run analytics/rollups:backfill '{"source":"visit"}'
bunx convex run analytics/rollups:backfill '{"source":"planned"}'
```

Re-run after changing `ROLLUP_VERSION` (any counting-rule change). A nightly reconcile cron is recommended (`CVX-034`) but not added here.

## Readers

`report.read` inside the caller's scope (`super_admin`/`analyst` see all); field `sales` are refused and keep their own figures in the DSR and DAR/ROAR.

- `territoryDays`, `customerDays`, `skuDays`: one territory/customer/SKU over at most 62 days, at most 500 rows (`truncated` says when cut).
- `territoriesForDay`, `customersForDay`, `skusForDay`: one date, paginated. Pass `orgUnitId` to read one unit directly (must be in scope); without it, rows outside scope are dropped per page, so a short or empty page with `isDone: false` means keep paging.

## Limits and open points

- Distinct counts across SKUs (numeric distribution: how many customers bought a SKU) are not additive and are not stored; `ANA-006` needs a per-SKU-customer presence table or a bounded scan.
- A customer linked to several outlets on the same day is attributed to the most recently linked outlet.
- Orders for customers without an outlet link have no territory row; they still appear in customer and SKU rows under the seller's unit.
- Outside-call POs (`outsideCallOrders`) carry no prices and are not sales here, as in the DSR.
- KPI definitions remain provisional until Sunpride signs off (memo §6).
