# Daily execution dashboard (`ANA-002`)

Where: web **Reports** (`/analytics`), below the national totals, for supervision readers (`people.read` + `visit.read`: super admin, admin, manager, analyst, viewer). Backend: `packages/backend/convex/analytics/execution.ts` (`day`, `exceptions`); pure rules in `analytics/model.ts`, mirrored by `apps/web/src/lib/execution-dashboard.ts` (a test keeps them equal).

Filters are the Supervision ones: Manila service date, unit (inside the caller's own scope, never wider), channel, and "My team only". Field `sales` keep their own figures in the Daily Sales Report and DAR/ROAR.

## Figures

| Card               | Meaning                                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sales              | Orders that count as a sale (not draft/rejected/voided), attributed to the day the salesman wrote them (offline time trusted up to 3 days), in PHP. Same rule as the Daily Sales Report.                    |
| Sales attainment   | Sales of people **with** a sales target ÷ the sum of their targets. Target = the person's daily `sales_value` target, else the monthly target spread over the month's selling days (DSR rule).              |
| Call target        | Calls of people with a call standard ÷ the sum of their `dailyCallsTarget` (position standard, selling days only).                                                                                          |
| Productive calls   | Productive ÷ calls. A call = a route-plan store visited and checked out; productive = any one listed activity (call answers 2 Oct 2026; `sfa/productive_call.ts`), judged per visit as the DAR/DSR do.      |
| Coverage           | Distinct planned outlets with a completed visit ÷ distinct planned outlets (off-plan outlets never raise it).                                                                                               |
| Active field force | People who checked in at least once ÷ people with planned stops; plus how many have an open visit now.                                                                                                      |
| Exceptions         | The Supervision exception queue for the same scope/date, counted by kind (location, out of order, unplanned, nonproductive, rescheduled, cancelled, not visited); "to review" = location awaiting decision. |

Every higher-level figure sums numerators and denominators and then divides; it never averages people's percentages. Percentages are whole numbers rounded down, "—" when there is no base.

Per person flags: "Not started" (planned stops, no check-in by 9 AM, provisional like Supervision), call and productive target misses (only after the 10 PM close), unplanned visits, in the field.

## Limits and open points

- Computed live; there are no daily rollups yet (`CVX-031`). People are read in pages of 20 (each its own query); a scope is capped at 80 people like Supervision, with a notice to narrow by unit or channel.
- Repeated visits to the same store on a day count per visit, as in the DAR and DSR. `KPI_DEFINITIONS.md` proposes one call per rep/outlet/day; this stays provisional pending client question 2.
- Month-to-date sales and territory/team targets are not on this daily view (see ANA-004 territory performance).
- The KPI definitions are provisional: the dashboard says so and must not be used for pay or discipline until Sunpride signs off (memo §6).
