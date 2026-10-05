# Supervisor productivity dashboard (`ANA-003`)

Where: web **Supervision → Productivity** tab. Backend: `packages/backend/convex/analytics/productivity.ts` (`roster`, `person`); pure rules in `analytics/productivity_model.ts`, mirrored by `apps/web/src/lib/supervisor-productivity.ts` (a test keeps them equal).

Who: supervision readers (`people.read` + `visit.read`) who also hold `report.read` — super admin, admin, manager, analyst, viewer — inside their own organizational scope, never wider. Field `sales` never sees it.

Filters: the Supervision header (date = end of the period, unit, channel, **My team only** = the caller's direct reports by employee-assignment supervisor) plus a period (last 7 / 14 days, month to date, last 31 days; at most 31 days per read).

## Figures (per person, then team totals)

| Column           | Meaning                                                                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planned calls    | Active planned stops from the signed MCP (cancelled/rescheduled stops excluded).                                                                                                                          |
| Actual calls     | Route-plan stores visited and checked out (call answers 2 Oct 2026; `sfa/productive_call.ts`). Unplanned visits are not calls. Shown against the position's daily call standard summed over selling days. |
| Productive       | Actual calls where any one listed activity was recorded (truck-seller rule applies), ÷ actual calls; compared with the position's productive-call target.                                                 |
| Order conversion | Actual calls where the salesman wrote an order that counts as a sale (positive total) the same Manila day for that store's customer, or the visit's own order intent matched an order, ÷ actual calls.    |
| Sales / call     | All the person's sales in the period (DSR rule: not draft/rejected/voided, returns subtract, attributed to the day written, offline time trusted up to 3 days) ÷ actual calls.                            |
| Missed           | Planned stops of a closed day (after the 10 PM close) without a completed visit. Stops of a day still open are "still due", never missed. Rate = missed ÷ planned on closed days.                         |
| Exception rate   | Visits with at least one exception — check-in/out outside the radius or unreliable, out of MCP order, unplanned — ÷ all visits.                                                                           |

Team totals sum numerators and denominators, then divide; they never average people's percentages. Percentages are whole numbers rounded down, "—" without a base.

Flags: missed calls; productive below the position target; exception rate at or above 20% (**provisional threshold**, no client figure yet).

## Limits and open points

- Computed live; there are no stored daily rollups yet (`CVX-031`). The web subscribes one bounded `person` query per row (≤ 31 days of one person); the roster is capped at 80 people like Supervision, with a notice to narrow by unit.
- Repeated visits to the same store on one day count per visit, as in the DAR and DSR (`KPI_DEFINITIONS.md` client question 2).
- Conversion matches orders to calls by salesman + customer + Manila day; an order with no customer link to the visited store cannot be matched. Nonproductive calls can still convert if an order exists for that store that day.
- The KPI definitions are provisional: the dashboard says so and must not be used for pay or discipline until Sunpride signs off (memo §6).
