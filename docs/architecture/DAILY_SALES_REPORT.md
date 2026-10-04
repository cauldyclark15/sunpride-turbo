# Daily Sales Report (Annex B, SOP-007)

The DSR is generated from what the field already records. Nobody re-keys it.

- Backend: `packages/backend/convex/dsr/report.ts` (`dsr.report.day`, `dsr.report.salesmen`), rules in `dsr/model.ts`.
- Web: Field → **Daily sales report** (`/daily-sales`). On-screen sheet, CSV export, and an A4 landscape print view with signature lines.

## Who sees what

| Caller                                                                    | Sees                                                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Field `sales`                                                             | Their own sheet only                                                                                                                 |
| Supervisors (`people.read`: super admin, admin, manager, analyst, viewer) | Field salesmen whose current assignment is in their scope                                                                            |
| Other `report.read` roles (operations, approver)                          | The screen opens, but there is no salesman list because they lack `people.read`. The server still allows a scoped read by profile id |

The server checks `report.read` against every unit the day's work belongs to: the salesman's assignment on the day, each visit, and each route-plan stop.

## Column sources

| Annex B column                                 | Source                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SI number                                      | Order numbers the salesman wrote on the day                                                                                                                                                                                                                      |
| Salesman, position                             | Profile, plus the employee assignment on the day                                                                                                                                                                                                                 |
| Area covered                                   | Route names from the day's route plan and visits. Falls back to territory codes, then to the org unit                                                                                                                                                            |
| Today's sale                                   | Sum of the day's orders, returns included (negative). Draft, rejected and voided orders are excluded                                                                                                                                                             |
| Today's target                                 | The daily `sales_value` target when one is set. Otherwise the monthly target ÷ the month's selling days (position standard, Mon–Sat by default). A non-selling day has no derived target                                                                         |
| MTD performance / target / % / balance to sell | Orders from the 1st of the month to the end of the day, against the monthly `sales_value` target. The balance never goes below zero                                                                                                                              |
| Productive calls                               | Same rule as the daily scorecard (`sfa/productive_call.ts`, client call 2 Oct 2026): a call is a route-plan store visited, and it is productive when any one listed activity is recorded                                                                         |
| Customer rows ("Actual coverage")              | Every route-plan stop of the day in MCP order, then unplanned visits, then customers sold to with no store row. Each row shows its call outcome, today's and MTD sales, SI numbers and remarks (what made the call productive, the reason code, and visit notes) |
| Canned / Mixes / Frozen                        | Order lines grouped by product master category. A category is matched case-insensitively ("Canned Goods" goes to Canned). Any other category keeps its own name, so no sale is dropped                                                                           |
| Program block                                  | Promotion checks recorded at the day's visits, counted by program reference and finding                                                                                                                                                                          |
| New product block                              | Placeholder: Sunpride has not sent its new-product list yet                                                                                                                                                                                                      |

Money: orders store pesos and targets store centavos. The report returns centavos throughout.

An order written offline counts on the day the phone recorded it (`offlineCreatedAt`), as long as that time is no more than 3 days before the server received it. Outside that window the server receipt time is used.

## Open with Sunpride

1. The original Annex B Excel template (open question #10, still outstanding after the 2 Oct call). Column labels and order may change once it arrives.
2. Customer-level targets. The scan suggests per-customer target columns, but no per-customer target exists yet. Targets are per salesman, team or territory (CVX-017).
3. The list of "new products" for the NEW PRODUCT block, and how long a product stays "new".
4. Whether MTD productive calls should appear (today only for now).
