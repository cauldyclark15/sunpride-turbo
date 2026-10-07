# Van end-of-trip stock count (VAN-023)

At the end of the day the van seller counts what is left on the truck on the handheld. The handheld already knows the load, every sale, void, customer return and damage it saved, so it works out the stock the truck should hold; the seller only counts.

## How it works

1. On the handheld: Today → **Count stock** (open once the trip is on the road).
2. The screen lists every product on the truck (the load sheet plus the truck stock in the bootstrap) in the product's own unit (SKU/UOM), with the **expected** sellable and damaged quantity. Expected = the office's truck stock plus every change saved on this phone (sales, voids, returns, damage) that the office has not yet taken in.
3. The seller types the **sellable counted** and **damaged counted** for each product (or taps **Same as expected**). Quantities are exact in the product's unit (decimals only where the unit allows them, never rounded). Each line shows **Matches**, **N short** or **N over**.
4. Every line that differs needs a reason: missing / short, extra found on truck, damage not recorded, sale or return not recorded, free goods or sample given, loaded wrong, or other (a note is then required).
5. Any difference also needs a supervisor. The seller calls and reads out the **trip number**, the **count code** (12 characters, `XXXX-XXXX-XXXX`), how many **lines differ**, the **units short** and the **units over**, and the reason for each line. The supervisor opens **Approvals** in the web app, fills in **Van stock count approval** and reads back the 8-digit code. The handheld checks it without signal.
6. The seller taps **Save stock count**. The handheld shows the saved count and "Truck stock now matches your count".

The count code is a fingerprint of the whole count — every product, sellable/damaged, expected, counted and reason. Changing any quantity or reason changes the count code, and the supervisor's code then fails. A void or cash code never works for stock (different key).

## What the handheld writes, in one step

- one stock count per trip: every line (product, sellable/damaged, expected, counted, reason), the count code, lines that differ, units short and over, note, how it was approved (supervisor code or none), time;
- one **reconciliation movement** (`ADJUSTMENT`) per line that differs, for exactly counted − expected, with the line's reason. After saving, the truck stock on the phone equals the count;
- a saved upload record for the office (`stock.reconcile`), kept on the phone like sales until the van upload for sales exists. It freezes the whole count, the approval and the movements' quantities.

If any part fails, nothing is written. Tapping Save twice returns the same count. Before saving, the handheld works out the expected stock again; if anything changed in between (a sale, a return, damage), it asks the seller to check again.

After the count is saved the trip takes **no more sales, voids, customer returns or damage** — each would change the stock the supervisor approved. A count with no difference needs no supervisor and writes no movement.

## Who approves

- Capability `van.stock.approve`: super admin, manager, approver, inside the trip's organizational scope.
- The trip's own seller can never approve their own count.
- Each code issued is recorded in the audit log (who, trip, count code, lines that differ, units short and over). The code itself is not stored.

## Defaults we chose (Sunpride can change them)

| Setting              | Default                                                 | Where                                                             |
| -------------------- | ------------------------------------------------------- | ----------------------------------------------------------------- |
| Approval required    | Yes, for any difference (no tolerance)                  | `VAN_POLICY.stockVarianceRequiresApproval`, `convex/van/model.ts` |
| Reasons              | The seven above, per line                               | `STOCK_VARIANCE_REASONS`, `convex/van/model.ts`                   |
| Count by             | Product's own unit, sellable and damaged apart          | handheld Count stock screen                                       |
| Products counted     | Every product on the load sheet or in truck stock       | handheld `StockReconciliationRules.expectedLines`                 |
| Recount after saving | Not on the phone; the office corrects it                | —                                                                 |
| Stock after count    | Frozen: no sales, voids, returns or damage on that trip | handheld stores                                                   |

Sunpride has not told us its tolerance, its variance reasons or who signs off a short truck; these are our own defaults (one edit away). A single tolerance would mix units (pieces, packs, cases), so there is none for now. Sample data for testing: the beta sample seed (`docs/runbooks/BETA_SAMPLE_DATA.md`, `beta/sample:planVanDay`).

## Notes and limits

- The handheld receives a per-trip stock key in its bootstrap (`policy.stockReconciliation`), derived from the server's mobile secret (`MOBILE_CURSOR_SECRET`) with its own label `sunpride/van-stock-approval/v1|`. Without that secret no key is sent and counts with a difference are refused on the phone. Shared test vectors (count code and approval code): `packages/domain-contracts/fixtures/van-v1/stock-approval.json`.
- The reconciliation movements are written to the handheld's truck-stock ledger. The office's truck stock (`inventoryBalances` for the truck location) does not include van sales yet, because van sales are not uploaded; the server therefore posts nothing now. When the van sale upload exists, the server should post the `stock.reconcile` adjustments through `postMovement` (ADR-003/007), after the sales, voids, returns and damage it carries, so the office truck stock matches the count before leftovers are returned (`van/trips:returnLeftover`) and the trip closes (VAN-024).
- The cash count (VAN-022) and the stock count can be done in either order; both stop selling.
