# Van end-of-trip cash count (VAN-022)

At the end of the day the van seller counts the cash on the handheld before handing it in. The handheld already knows every sale it saved, so it works out the cash it should hold; the seller only counts bills and coins.

## How it works

1. On the handheld: Today → **Count cash** (open once the trip is on the road).
2. The screen shows the **expected cash**: the cash payment of every sale saved on this phone for this trip, minus sales that were voided. Cash sales count at the sale total (the change went back to the customer). Check, GCash, bank transfer and credit sales are listed under "Not in the cash bag" with their count and total — they are never expected in cash.
3. The seller types how many of each bill and coin they have (₱1,000 down to 1¢). The change fund is left out. The screen shows the total counted and the difference: **Matches**, **₱X short** or **₱X over**.
4. Any difference needs a reason: counting error, wrong change given, customer paid short, customer overpaid, cash lost or stolen, fake bill or coin, or other (a note is then required).
5. A difference of **more than ₱50.00** either way also needs a supervisor. The seller calls and reads out the **trip number**, **expected cash**, **counted cash** and **reason**. The supervisor opens **Approvals** in the web app, fills in **Van cash count approval** and reads back the 8-digit code. The handheld checks it without signal. Changing an amount or the reason clears the code.
6. The seller taps **Save cash count**. The result stays on screen; the seller hands the cash to the cashier.

The code fits only that trip, both amounts and that reason. If any of them differ, the code fails. A code for a void never works for cash (different key).

## What the handheld writes, in one step

- one cash count per trip: expected, counted, difference, the bill-and-coin count, reason, note, how it was approved (supervisor code or none), time;
- a saved upload record for the office (`cash.reconcile`), kept on the phone like sales until the van upload for sales exists. It also carries the number of cash sales, voided sales and the other payment totals.

If any part fails, nothing is written. Tapping Save twice returns the same count. Before saving, the handheld adds the sales up again; if a sale changed in between, it asks the seller to check the expected cash again.

After the count is saved the trip takes **no more sales and no voids** (the supervisor approved a difference against a fixed expected cash). Customer returns are still allowed: they credit the store and do not move cash.

## Who approves

- Capability `van.cash.approve`: super admin, manager, approver, inside the trip's organizational scope.
- The trip's own seller can never approve their own count.
- Each code issued is recorded in the audit log (who, trip, expected, counted, difference, reason). The code itself is not stored.

## Defaults we chose (Sunpride can change them)

| Setting              | Default                                    | Where                                                          |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Approval above       | ₱50.00 difference either way               | `VAN_POLICY.cashVarianceToleranceMinor`, `convex/van/model.ts` |
| Approval required    | Yes                                        | `VAN_POLICY.cashVarianceRequiresApproval`                      |
| Reasons              | The seven above                            | `CASH_VARIANCE_REASONS`, `convex/van/model.ts`                 |
| Count by             | Bills and coins (Philippine denominations) | handheld `CashDenominations.PHP`                               |
| Change fund          | Not part of the count                      | handheld screen text                                           |
| Recount after saving | Not on the phone; the office corrects it   | —                                                              |

These follow our planned answer to van question 14 ("Salesman counts on the phone, cashier confirms; differences go to the supervisor"). Sunpride has not answered yet; the tolerance and reasons are one edit away.

## Notes and limits

- The handheld receives a per-trip cash key in its bootstrap (`policy.cashReconciliation`), derived from the server's mobile secret (`MOBILE_CURSOR_SECRET`) with its own label `sunpride/van-cash-approval/v1|`. Without that secret no key is sent and counts above the tolerance are refused on the phone. Shared test vectors: `packages/domain-contracts/fixtures/van-v1/cash-approval.json`.
- Expected cash comes from sales saved on **this** phone. Van sales are not uploaded yet, so the office cannot recompute it; when the van sale upload exists, the office should recompute expected cash from the uploaded sales and voids and compare it with the `cash.reconcile` record.
- The cashier's confirmation (Q14 "cashier confirms") and closing the trip are separate issues (VAN-024 close trip). The stock count is VAN-023.
