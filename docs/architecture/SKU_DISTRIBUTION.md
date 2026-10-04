# SKU distribution dashboard (`ANA-006`)

Backend: `packages/backend/convex/analytics/sku.ts` (queries `territory` and `gaps`) and `analytics/sku_model.ts` (pure rules). Web: Reports → **SKU distribution** (`apps/web/src/components/analytics/sku-distribution.tsx`, rules mirrored in `apps/web/src/lib/sku-distribution.ts` and kept equal by a test).

## What it shows

For a period of up to 31 days, one row per SKU sold or audited in the caller's territories, with a territory split and a channel split for the selected SKU and its gap stores.

| Figure        | Rule                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active stores | Active stores assigned to the territory at the end of the period (the denominator of every store count)                                                       |
| Buying stores | Active stores with a positive order line of the SKU in the period, while the store belonged to the territory (DSR sale rules)                                 |
| Distribution  | buying ÷ active stores (numeric distribution)                                                                                                                 |
| Gaps          | Active stores that did not buy the SKU. The gap list shows up to 25 per territory, out-of-stock first                                                         |
| Sales         | The SKU's order lines folded exactly as the SKU rollups (`orderFigures`); returns subtract                                                                    |
| Shelf signals | The SKU's status in each active store's **latest** merchandising audit of the period: on shelf (available or low stock), low stock, out of stock, not carried |
| On shelf      | on-shelf stores ÷ stores whose latest audit recorded the SKU. Stores not audited in the period give no signal                                                 |
| Channel       | The territory's channel (as ANA-004); territories without one are "No channel"                                                                                |

Totals and splits sum territories first and divide afterwards; a SKU absent from a territory has no buyers there, so all of that territory's active stores are gaps.

## Access and limits

- Supervision readers (`people.read` + `visit.read`) who also hold `report.read`, inside their own organizational scope (`super_admin` and `analyst` see everything). Field `sales` never sees it. Territories come from `analytics/territory:list`; the web subscribes one `analytics/sku:territory` per territory and, for the selected SKU, one `analytics/sku:gaps` per territory.
- One read covers one territory: at most 300 stores, 1,000 orders per customer, 6,000 order lines and 400 SKUs (`truncated`).
- Computed live from orders, order lines, store assignments and merchandising audits. `dailySkuMetrics` (CVX-032) has no store dimension, so it cannot count buying stores; nothing needs backfilling after deploy.

## Provisional points (for Sunpride to confirm)

- "Buying" means at least one sale line in the selected period; Sunpride may want a fixed window (e.g. the last 3 months) for distribution.
- Channel follows the territory's channel, not the customer master's channel field.
- These figures are provisional until the KPIs are signed off (memo §6); not for pay or discipline.
