# Route/coverage compliance analytics (`ANA-008`)

Backend: `packages/backend/convex/analytics/compliance.ts` (query) and `analytics/compliance_model.ts` (pure rules). Web: Reports → **Coverage compliance** (`apps/web/src/components/analytics/coverage-compliance.tsx`, rules mirrored in `apps/web/src/lib/coverage-compliance.ts` and kept equal by a test).

## What it shows

The approved Master Coverage Plan (MCP) compared with the visits actually closed, week by week (Monday to Sunday, the last week cut at today), by **employee**, **territory** and **customer (store)**, worst first, with persistent under-coverage flagged.

| Figure          | Rule                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Planned         | Approved MCP stops still `planned` (cancelled and replaced stops drop out)                                             |
| Done            | Planned stops with a visit checked out or completed **on the planned day**                                             |
| Missed          | Planned stops of a closed day (after the 10 PM close) with no completed visit                                          |
| Pending         | Planned stops of a day still open, not yet done                                                                        |
| Compliance      | done ÷ (done + missed); pending stops are not due yet. KPI sheet "Plan completion %"                                   |
| Off-plan visits | Employee only: visits outside the plan. Shown for context, never raise compliance (KPI sheet, off-plan rule)           |
| Under-covered   | A closed week with stops due and compliance under **90%**                                                              |
| Persistent      | **3 or more** under-covered closed weeks in a row up to the latest judged week; weeks with nothing planned are skipped |

Attribution follows the signed MCP snapshot (territory, store and linked customer), never the live projections, so a later reassignment does not rewrite history. A territory or store served by several people is one row whose weekly figures are the sum of theirs; percentages are always computed after summing.

## Access and limits

- Supervision readers (`people.read` + `visit.read`) who also hold `report.read`, inside their own organizational scope (`super_admin` and `analyst` see everything). Field `sales` never sees it. The roster is `analytics/productivity:roster`; the web subscribes one `analytics/compliance:person` query per person.
- One read covers one person over 2 to 8 weeks (two indexed reads per day). At most 400 stores per person are itemised; totals stay complete beyond that (`outletsTruncated`).
- Computed live from `plannedVisits` and `visitExecutions`; no stored rollups are needed and nothing needs backfilling after deploy.

## Provisional points (for Sunpride to confirm)

- The 90% threshold and the 3-week run are our proposal; the memo and the 2 Oct 2026 call give no compliance threshold. Both are constants in `compliance_model.ts`.
- A stop visited on a different day than planned counts as missed for that day (the plan said that day).
- These figures are provisional until the KPIs are signed off (memo §6); not for pay or discipline.
