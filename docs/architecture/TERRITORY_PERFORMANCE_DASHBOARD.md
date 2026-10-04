# Territory performance dashboard (`ANA-004`)

Where: web **Reports** (`/analytics`), below the totals. Backend: `packages/backend/convex/analytics/territory.ts` (`list`, `figures`); pure rules in `analytics/territory_model.ts`, mirrored by `apps/web/src/lib/territory-performance.ts` (a test keeps them equal).

Who: people holding `people.read` + `visit.read` + `report.read` — super admin, admin, manager, analyst, viewer — for territories whose **current** owner unit is inside their own organizational scope, never wider. Field `sales` never sees it (the panel is hidden and the server refuses).

Filters: period (last 7 / 14 days, month to date, last 31 days, ending today; at most 31 days per read), unit (a subtree of the caller's scope), territory channel, **Below target only**. Rank by sales, target attainment, coverage, strike rate or distribution gaps.

## Figures (per territory, then totals)

| Column            | Meaning                                                                                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sales             | Orders of the customers linked to the territory's stores, counted when the store belonged to the territory at the moment of sale. DSR rules: not draft/rejected/voided, returns subtract, dated the day written (offline time trusted up to 3 days). An order counts once per territory. |
| Target attainment | Sales ÷ the territory's `sales_value` target for the same days: the daily target when set, otherwise the monthly target spread over the month's selling days (Monday–Saturday). "No target set" when neither exists.                                                                     |
| Coverage          | Distinct planned stores visited and checked out at least once ÷ distinct planned stores. Planned stops are the signed MCP stops whose approved snapshot names this territory (cancelled/replaced excluded).                                                                              |
| Strike rate       | Productive calls ÷ calls. A call is a planned stop visited and checked out (one per stop); productive when any listed activity was recorded (truck-seller rule from the assignee's position standard).                                                                                   |
| Distribution gaps | Active stores assigned to the territory at the end of the period with no sale (positive order) in the period; the first 25 are listed by code. Prospects are excluded.                                                                                                                   |
| Flags             | Below target (attainment under 100%); missed stops (planned stops of a closed day — after the 10 PM close — not visited).                                                                                                                                                                |

Totals sum numerators and denominators, then divide; they never average territory percentages. Percentages are whole numbers rounded down, "—" without a base.

## Limits and open points

- Computed live; there are no stored territory rollups yet (`CVX-032`, SP-0028). Each read covers one territory: at most 300 stores and 900 planned stops; a bigger territory gets "pick a shorter period". When rollups land, `figures` should read them instead.
- Distribution is store-level (buying vs not buying). SKU-level distribution belongs to the SKU distribution dashboard (`ANA-006`).
- A customer account shared by stores in two territories counts its orders in both (orders carry no store).
- Only sales targets are compared; territory call targets (`calls`, `productive_calls`) are not shown yet.
- The KPI definitions are provisional (`KPI_DEFINITIONS.md`): the dashboard says so and must not be used for pay or discipline until Sunpride signs off (memo §6).
