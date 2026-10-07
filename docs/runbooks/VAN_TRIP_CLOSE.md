# Van trip close (VAN-024)

The last step of the van seller's day, on the handheld. The trip may close only after the cash and stock counts, a check of anything still open, and a check that nothing is waiting to send.

## How it works

1. On the handheld: Today → **Close trip** (open once the trip is on the road).
2. **Before you close** lists what must be done. Each line shows ✓ when done:
   - trip started;
   - signed in on this phone (the phone is not paused);
   - cash counted (VAN-022, `docs/runbooks/VAN_CASH_RECONCILIATION.md`) — a **Count cash** button opens it;
   - truck stock counted (VAN-023, `docs/runbooks/VAN_STOCK_RECONCILIATION.md`) — a **Count stock** button opens it;
   - nothing waiting to send — with signal, tap **Sync now** on this screen;
   - sales match truck stock (every saved sale has its exact stock deduction; if not, the seller calls the office).
3. **Check these** lists the open exceptions. None stops the close by itself, but the seller must tick **I have checked these with my supervisor**:
   - receipts not printed (a **Open receipts** button lets the seller print them first);
   - items the office refused (they wait in "to review");
   - a cash difference (short or over);
   - stock count lines that differed.
4. Optional: the **end odometer** (km, not lower than the start reading) and a note.
5. The seller taps **Close trip**. The handheld shows "Closed on this phone" and how many records of the trip are saved for the office. Today then shows the trip as **Closed on this phone**.

If anything changes between opening the screen and tapping Close trip (for example a refusal arrives during a sync), the handheld asks the seller to check the list again and tick the box again.

## What the handheld writes, in one step

- one close per trip: the exceptions the seller confirmed, whether they were confirmed, the end odometer, the note, how many operations of the trip are saved, the time;
- a saved upload record for the office (`trip.close`), kept on the phone like sales until the van upload exists. It carries the cash count (expected, counted, difference), the stock count (count code, lines that differ, units short and over), the exceptions, and a **manifest of every operation of the trip** (kind, request id, status) so the office can check it received everything before it closes the trip on its side.

If any part fails, nothing is written. Tapping Close trip twice returns the same close.

After closing, the trip takes **no more sales, voids, customer returns, damage, stock changes or counts** on this phone. Receipts can still be reprinted.

## Defaults we chose (Sunpride can change them)

| Setting                                           | Default | Where                                        |
| ------------------------------------------------- | ------- | -------------------------------------------- |
| Cash count required                               | Yes     | `VAN_TRIP_CLOSE_POLICY.requireCashCount`     |
| Stock count required                              | Yes     | `VAN_TRIP_CLOSE_POLICY.requireStockCount`    |
| Everything sent first                             | Yes     | `VAN_TRIP_CLOSE_POLICY.requireUploadsSent`   |
| Exceptions confirmed by the seller                | Yes     | `VAN_TRIP_CLOSE_POLICY.exceptionsNeedReview` |
| Trip started, phone not paused, sales match stock | Always  | handheld `TripCloseRules` (not configurable) |

The policy is `convex/van/model.ts` → `VAN_TRIP_CLOSE_POLICY`, sent to the handheld in the bootstrap as `policy.tripClose` (van-v1, additive). A handheld whose cached policy predates it uses the strictest checks. Work that has no van upload yet (sales, voids, returns, the counts and the close itself) is "parked": it does not count as waiting to send, and it is listed in the close manifest instead.

Sunpride has not told us its end-of-day checklist; these are our own defaults (one edit away). Sample data for testing: the beta sample seed (`docs/runbooks/BETA_SAMPLE_DATA.md`, `beta/sample:planVanDay`).

## Office side and limits

- The office closes the trip in the web app / `van/trips:close` after the leftovers are returned (`van/trips:returnLeftover`); it still checks that the truck holds no stock. The office cannot yet see the handheld's close, because van sales and the parked records are not uploaded. When the van upload exists, the server should accept `trip.close` after every operation in its manifest and refuse the office close until it has arrived (or record an override).
- A trip closed on the phone cannot be reopened on the phone. The office corrects anything after that.
- "Items the office refused" cannot be cleared on the phone; the seller confirms them and the office follows them up from the close record.
