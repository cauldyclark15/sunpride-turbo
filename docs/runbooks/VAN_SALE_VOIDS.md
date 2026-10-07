# Van sale voids (VAN-021)

A van seller can cancel a whole sale on the handheld after the receipt has printed. Nothing is deleted: the sale, its lines, its payment, its stock deduction and its printed receipt stay exactly as they were. The void is a separate record that puts the stock back on the truck and cancels the money.

## How a void works

1. On the handheld: Receipts → the sale → **Void sale**.
2. The seller picks a reason: wrong items, wrong quantity, wrong customer, wrong payment, customer cancelled, or other (a note is then required).
3. When approval is needed, the seller calls a supervisor and reads out the **receipt number**, the **total** and the **reason**.
4. The supervisor opens **Approvals** in the web app, fills in **Van sale void approval** and reads back the 8-digit code.
5. The seller types the code and taps **Void sale**. The handheld checks the code without signal.
6. The handheld prints a **VOID** slip ("VOID - SALE CANCELLED … NOT A VALID RECEIPT"). A voided sale can never print a normal receipt or reprint again.

The code fits only that receipt, that total and that reason. If any of them differ, the code fails.

## What the handheld writes, in one step

- a void record: reason, note, how it was approved (supervisor code or none), time;
- one stock movement per sale line that adds back exactly what the sale took off (available stock on the same trip);
- a saved upload record for the office (`sale.void`), kept on the phone like the sale itself until the van upload for sales exists.

If any part fails, nothing is written. A sale can be voided only once; tapping twice returns the same void. A voided credit sale no longer uses the customer's credit, and a voided check/e-wallet/bank reference can be used again.

## Who approves

- Capability `van.void.approve`: super admin, manager, approver, inside the trip's organizational scope.
- The trip's own seller can never approve their own void.
- Each code issued is recorded in the audit log (who, trip, receipt, total, reason). The code itself is not stored.

## Defaults we chose (Sunpride can change them)

| Setting            | Default                                            | Where                                                    |
| ------------------ | -------------------------------------------------- | -------------------------------------------------------- |
| Approval required  | Yes, for every void                                | `VAN_POLICY.voidRequiresApproval`, `convex/van/model.ts` |
| Approval threshold | ₱0.00 (every amount)                               | `VAN_POLICY.voidApprovalThresholdMinor`                  |
| Reasons            | The six above                                      | `VOID_REASONS`, `convex/van/model.ts`                    |
| Whole sale only    | Yes; part of a sale goes through a customer return | —                                                        |
| Which sales        | Only sales on the trip the handheld is on now      | handheld                                                 |

These follow our planned answer to van question 10 ("Yes, with a reason, and a supervisor approves it"). Sunpride may set a threshold so small voids need no call.

## Notes and limits

- The handheld receives a per-trip approval key in its bootstrap. It is derived from the server's mobile secret (`MOBILE_CURSOR_SECRET`) with its own label, so no new setting is needed. Without that secret no key is sent and approval-required voids are refused on the phone.
- The key lives in the phone's encrypted database. A person who breaks that encryption could make their own codes; every void still reaches the office with its reason and code, where it can be checked against the audit log of issued codes.
- Van sales and voids are not uploaded yet (there is no sale operation on the van gateway). When it exists, the office side must post the void as a reversal of the sale's stock movement (the legacy QSR `inventory/pos.voidSale` already does this for server-posted sales) and check the code against the issued-code audit.
