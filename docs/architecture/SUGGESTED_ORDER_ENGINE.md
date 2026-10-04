# Suggested order (ICO) engine v1

ANA-009 · SP-0068. Code: `packages/backend/convex/analytics/suggested_order_model.ts` (rules),
`analytics/suggested_orders.ts` (reads and API), web panel
`apps/web/src/components/analytics/suggested-order.tsx` (under Reports → Customer execution).

## What the client said

2 Oct 2026 call (answer 3): ICO means Inventory Control Order, in effect a suggested order:

    store's daily demand × (days until the next visit + delivery lead time)
    − the stock the store already has

Today some teams keep it in Excel, others on paper. The standard ICO form is still to come.
Blueprint §15: start with deterministic rules, not an LLM.

## The rule, term by term

For each SKU the store bought in the last 84 days, plus every SKU in its required assortment:

| Term                 | v1 source                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Historical velocity  | Quantity of the SKU on the store's customer orders that count as a sale (DSR rule: not draft, rejected or voided; returns excluded), Manila day written, last 84 days, ÷ days of history. Days of history run from the customer's first order in the window, never fewer than 28.                                                                                                                |
| Active promotion     | A `suggestedOrderPromotions` uplift active at the order instant multiplies daily demand by (1 + uplift %). Stock still runs down at the ordinary rate.                                                                                                                                                                                                                                           |
| Days to next visit   | Next signed MCP stop for the store; else the visit cycle (outlet assignment → route → outlet profile); else 7 days.                                                                                                                                                                                                                                                                              |
| Lead time            | 1 day, **provisional**; callers may pass 0–30.                                                                                                                                                                                                                                                                                                                                                   |
| Store stock          | The latest store observation on or after the last purchase: an inventory-check count (only when its unit is the SKU's selling unit), or "none" from an inventory check or from the latest merchandising audit (out of stock / not carried). Run down by daily demand since the observation. Without one: the last purchase quantity less daily demand × days since last purchase. Never below 0. |
| Current availability | When a selling location is chosen, its available balance caps the suggestion (only when the balance unit is the selling unit). None available → "Not available".                                                                                                                                                                                                                                 |

Suggested = round(daily demand × cover days − store stock), floored at 0, capped by
availability. Each line carries the plain-language reasons the salesperson sees.

Line statuses: `suggest`, `unavailable` (would suggest but nothing to sell), `enough_stock`,
`no_history` (required SKU never bought in the window: nothing to compute velocity from).

## Access

`forOutlet`: `outlet.read` on the store (a salesperson only for stores in a territory they are
currently assigned to) and `report.read` in its current owner unit. A selling location also
needs `inventory.read` in the location's unit; an unmapped location is super admin / analyst
only. Promotion uplifts are national: `schedulePromotion` / `endPromotion` need a national
master-data manager (super admin, admin, operations at the root unit); future-effective only,
no overlaps per SKU.

## Limits

One store per call; reads at most 400 of the customer's orders, 150 orders' lines, 150 visits
and 200 SKUs. `truncated` reports anything cut short. Quantities are in each SKU's selling unit
(`products.uom`) as written on order lines; no unit conversion in v1.

## Open questions (for Sunpride)

1. The standard ICO form / Excel (promised on the 2 Oct call): confirms rounding, columns, and
   whether the store count is taken every call.
2. Delivery lead time per channel / depot (v1 uses 1 day).
3. Promotion master (ARCH-006 / SP-0033 samples): v1 keeps a per-SKU national uplift until real
   promotions exist; it will read from the promotion master once it lands.
4. Which depot or truck sells to each store, so availability can be chosen automatically.
