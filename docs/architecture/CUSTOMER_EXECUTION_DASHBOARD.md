# Customer execution dashboard (`ANA-005`)

Where: web **Reports** (`/analytics`) › **Customer execution**, below Daily execution. Backend: `packages/backend/convex/analytics/customer.ts` (`stores` picker, `store` figures); pure rules in `analytics/customer_model.ts`. The web (`apps/web/src/components/analytics/customer-execution.tsx`) only formats.

Who: supervision readers (`people.read` + `visit.read`) who also hold `report.read` — super admin, admin, manager, analyst, viewer — for stores whose **current** owner unit (territory owner, else custodian) is inside their own organizational scope. Field `sales` never sees it.

Filters: **As of** (Manila date, end of the period), **Period** (4, 8, 12 or 13 whole weeks; at most 13 per read), **Unit** (inside the caller's scope) and **Find a store** (code or name).

## Figures (one store)

| Card                  | Meaning                                                                                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visit regularity      | Visit days = Manila dates with a checked-out visit to the store (planned or unplanned, by anyone; several visits a day = one day). Gaps between visit days (including the last visit before the period) are compared with the store's visit cycle. |
| Expected cycle        | Outlet assignment `cycleDays`, else its route's `cycleDays`, else the outlet profile's `visitFrequencyDays`; "No visit cycle set" when none. **Overdue** when days since the last visit day exceed the cycle.                                      |
| Days since last order | Days from the latest order (positive total, counts as a sale) to the As-of date; returns never count as the last order.                                                                                                                            |
| Order trend           | Sales (DSR rule: not draft/rejected/voided, returns subtract, attributed to the day written, offline time trusted up to 3 days) of the latest 4 weeks vs the 4 weeks before. Within ±10% = **Steady** (provisional band).                          |
| Missed planned calls  | Active planned stops (signed MCP; cancelled/replaced excluded) of a closed day (after the 10 PM close) without a checked-out visit to that stop. Open days are "still due". Rate = missed ÷ planned on closed days.                                |
| Distribution          | Required-assortment SKUs (`outletAssortments` in effect now) the customer ordered in the period (positive-quantity order lines) ÷ required SKUs.                                                                                                   |
| On-shelf availability | From the latest merchandising audit up to the As-of date: SKUs found available or low stock ÷ SKUs the audit checked. Gaps = required SKUs neither ordered nor seen on shelf.                                                                      |

The **Week by week** table repeats visit days, planned calls done, missed, orders and sales per week.

## Limits and open points

- Computed live from records; customer rollups (`CVX-032`) do not exist yet. One read covers one store and ≤ 13 weeks (≤ 400 visits / planned stops, ≤ 600 customer orders, lines of ≤ 150 orders); beyond that the dashboard says "Some records were left out".
- Orders are recorded per **customer**, not per store. A customer linked to several outlets shows its orders on each store, flagged "This customer account also buys for other stores".
- Distribution is assortment-based: a store without a required assortment shows only how many SKUs were bought. Merchandising audits are optional per visit, so availability may be stale.
- The 10% steady band and the "last order older than two cycles (else 14 days)" warning are provisional; no client figure exists. The KPI definitions are provisional and must not be used for pay or discipline until Sunpride signs off (memo §6).
- Schema: one additive index `visitExecutions.by_outletId_and_serviceDate`.
