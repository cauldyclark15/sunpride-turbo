# Sunpride Van Sales — operating guide (Cebu van pilot)

For truck sellers (PMOT, PMOT Extruck, RDS) using the **Sunpride Van Sales** app on the Senraise H10P handheld, for the supervisors who approve their exceptions, and for the warehouse, cashier and office staff who load and close the truck. Tracker: QSR-018 (SP-0121).

The guide follows one selling day: get the handheld ready, check the load, start the trip, sell, print, take returns, record damage, void a sale, count cash and stock, and close the trip. Words in **bold** are the exact words on the handheld or in the web app.

**Contents:** [Rules in one minute](#the-rules-in-one-minute) · [Who does what](#who-does-what) · [1. The handheld](#1-the-handheld) · [2. First sign-in](#2-first-sign-in-once-per-handheld) · [3. Morning: download the trip](#3-morning-download-the-trip) · [4. Check the load](#4-check-the-load) · [5. Start the trip](#5-start-the-trip) · [6. Customers](#6-customers) · [7. Find and scan products](#7-find-and-scan-products) · [8. Make a sale](#8-make-a-sale) · [9. Printer and receipts](#9-printer-and-receipts) · [10. Customer returns](#10-customer-returns) · [11. Damage on the truck](#11-damage-and-spoilage-on-the-truck) · [12. Void a sale](#12-void-a-sale) · [13. Sync and working offline](#13-sync-and-working-without-signal) · [14. Count cash](#14-end-of-trip-count-cash) · [15. Count stock](#15-end-of-trip-count-stock) · [16. Close the trip](#16-close-the-trip) · [17. Office close](#17-office-and-warehouse-close) · [18. Supervisor approvals](#18-supervisor-approvals) · [19. When to escalate](#19-when-to-escalate) · [Quick reference](#quick-reference) · [For trainers](#for-trainers-what-the-pilot-build-does-and-does-not-do) · [Defaults we chose](#defaults-we-chose-sunpride-can-change-them)

---

## The rules in one minute

1. **Sync at the depot every morning.** The handheld downloads your trip, the load sheet, your customers, the price list and the approval keys. Without that download you cannot sell.
2. **Count the load before you leave.** Every line you confirm is what the truck carries. A difference needs a reason and waits for your supervisor.
3. **Selling works without signal.** Each sale is saved on the handheld first, then the receipt prints. A sale is never lost because the printer or the signal failed.
4. **Prices come from the office.** You cannot type a price or a discount. A product that says **Priced by the office** cannot be sold until the office sends its price.
5. **Never sell twice to fix a mistake.** Wrong sale: **Void sale** with a supervisor code. Goods coming back: **Record return**.
6. **One count each at the end of the day.** Count cash once, count stock once. After a count is saved the trip takes no more sales.
7. **Never uninstall the app, clear its data or sign in as someone else** while anything is saved on the handheld. Sales, returns, voids and counts of the pilot live only on the handheld until the van upload ships (see [For trainers](#for-trainers-what-the-pilot-build-does-and-does-not-do)).

## Who does what

| Step                                 | Seller (handheld)                   | Supervisor                                       | Warehouse / cashier / office                              |
| ------------------------------------ | ----------------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| Register the handheld (once)         | Sends the **Phone code**            | —                                                | System team registers it (no web screen yet)              |
| Plan the trip and load sheet (daily) | —                                   | Agrees the load                                  | System team plans it (no web screen yet; see section 17)  |
| Load the truck                       | Counts every line, **Confirm load** | Approves a load difference                       | Warehouse loads from the load sheet                       |
| Start the trip                       | **Start trip**                      | —                                                | —                                                         |
| Sell, print, return, damage          | On the handheld                     | Approves voids, big damage records, held returns | Office confirms check/GCash/bank payments later           |
| Count cash                           | **Count cash**                      | Code when the difference is above ₱50.00         | Cashier receives the cash                                 |
| Count stock                          | **Count stock**                     | Code for any difference                          | Warehouse checks the leftovers                            |
| Close the trip                       | **Close trip**                      | Checks the open items with the seller            | Office returns leftovers and closes the trip (section 17) |

Approvers in the web app are the super admin, sales manager and approver of the seller's area. A seller can never approve their own void, damage, cash count or stock count.

---

## 1. The handheld

- **Senraise H10P**, Android 14, built-in 58 mm thermal printer, built-in barcode scanner (trigger buttons on the sides), camera, 3-button navigation bar (Back, Home, Recents) at the bottom.
- App name: **Sunpride Van Sales** (pilot testers may have **Sunpride Van Sales (Beta)**).
- Charge it every night. Carry spare 58 mm thermal paper rolls (no cutter: tear the paper against the printer's teeth).
- One seller, one handheld. Do not lend it: the work on it belongs to the signed-in seller and that handheld.

## 2. First sign-in (once per handheld)

1. Open the app. Before signing in you can tap **Test printer & scanner** and print a test receipt to check a new handheld.
2. Enter the **email and password** you were given and tap **Sign in**. The eye button shows the password while you type.
3. The first time, the screen says **Register phone** and shows a **Phone code**. Send the whole code to your supervisor, who passes it to the system team.
4. Keep the app open. When the handheld is added, the app moves on by itself; you can also tap **Check again**.
5. If the screen says **Phone removed**, the handheld was taken off your account. Your saved work is not deleted. Call your supervisor.

Sign-in messages say what went wrong in plain words (wrong email or password, no signal). If the screen shows **Setup needed**, the app was built without its server address: hand the handheld back to the system team.

## 3. Morning: download the trip

1. At the depot, with signal, open the app and tap **Sync now** on **Today**.
2. **Your trip** shows the trip number, **Truck** code and plate, **Route**, your name and the driver and helper.
3. The big button at the bottom is always the next step: **Check the load**, then **Start trip**, then **Customers**.
4. **No trip assigned for today. Ask your supervisor.** means no trip was planned for you: call your supervisor, then **Sync now** again.

The trip status reads, in order: **Planned**, **Loading**, **Load sent — waiting for sync**, **Load waiting for supervisor**, **Loaded — ready to start**, **Starting… waiting for sync**, **On route**.

## 4. Check the load

The warehouse loads the truck from the load sheet. You check every line before the truck leaves.

1. Today → **Check the load**.
2. Each line shows the product, code, lot and the **expected** quantity. Count what is really on the truck and type it, or use the minus and plus buttons.
3. You can scan: pressing the side trigger on a product adds one selling unit; scanning a case barcode adds the whole case (for example 24 PC). If the screen says to count by hand, type the number.
4. A line that differs from the load sheet needs a reason: **Short loaded**, **Over loaded**, **Damaged at loading**, **Wrong item** or **Other**.
5. Tap **Confirm load**, then **Sync now** while you still have signal.
6. The load shows:
   - **Sent — waiting for sync**: not yet received by the office. Sync again.
   - **Waiting for supervisor approval**: a line differs. Call your supervisor; the load is approved in the office.
   - **Loaded**: the stock is on your truck. You can start the trip.

Fix a wrong load at the depot, before you leave. Once confirmed, the load cannot be changed on the handheld.

## 5. Start the trip

1. Today → **Start trip** (only after the load says **Loaded**).
2. Tick both confirmations: **This is truck …** and **This is the … route**.
3. Fill in the **Driver**, the **Helper (optional)**, the **Odometer km (optional)** and a **Note (optional)**.
4. Tap **Start trip**. The trip is **On route** (or **Starting… waiting for sync** without signal; you can already sell).
5. The first time, the handheld explains **Sharing the truck's location** (what is shared, only during the trip, who sees it, kept 90 days). Tap **Turn on location sharing** and allow location, or **Not now** — the trip starts either way.
6. While the trip is on the road, Today shows **Location sharing on** and Android shows a notification. It stops by itself when you close the trip or sign out. If Today shows **Location sharing off**, tap it to turn it on (or **Turn off location sharing** to stop).

## 6. Customers

Today → **Customers**.

- **Today's route** lists your stores in route order, numbered. **Other stores in your area** are stores you may also serve. **Walk-in** lists stores added on this handheld.
- Search by name or code.
- A store that is not in the list: tap **Add walk-in**, type the **Customer name** and why you are serving it, then **Save customer**. It is marked **Walk-in** for the office. If the screen says **Ask your supervisor to allow walk-in customers.**, walk-ins are switched off for you.
- Tap a store to open **Customer**: **Start sale** or **Record return**.

## 7. Find and scan products

Today → **Find product**. It works without signal.

- Type in the field at the bottom (**Name, code or barcode**). Code without dashes works (`sppj1l` finds `SP-PJ-1L`), and accents do not matter.
- Each row shows the product, code and unit, how many are on the truck (or **Not on truck**) and the price per unit, or **Priced by the office** when the office has sent no single price.
- **Scanning:** press the side trigger, or tap **Camera** (shown while the field is empty). A **Scanned** card names the product and unit (`PC`, or `CS · 24 PC` for a case barcode).
- **Barcode not found**: the code is not in the product list on the handheld. Tap **Search by name**, or **Use camera** if the scanner misread it. Tell the office the barcode.
- **Check the product**: one barcode belongs to several products. Pick by name and tell the office.

## 8. Make a sale

1. Customers → the store → **Start sale** (or Today → **New sale** → choose the store). An unfinished sale shows on Today as **Continue sale**.
2. Tap **Add product**, search or scan, tap the product (or **Add to sale** after a scan) and enter the quantity.
3. Each line shows quantity × price and the line total. Tap a line to change it; **Enter 0 to remove it from the sale.**
4. Tap **Checkout** and choose how the customer pays:

   | Payment                        | What you enter                                                        | Payment state on the receipt      |
   | ------------------------------ | --------------------------------------------------------------------- | --------------------------------- |
   | **Cash**                       | **Cash received (₱)**; the screen shows the change                    | **Paid**                          |
   | **Check**                      | The check number; the amount is the full total, no change             | **To be confirmed by the office** |
   | **GCash**                      | The GCash reference number; the full total                            | **To be confirmed by the office** |
   | **Bank transfer**              | The bank reference number; the full total                             | **To be confirmed by the office** |
   | **Credit (charge to account)** | Nothing; the screen shows the terms, the credit left and the due date | **Charged to account · due …**    |

5. **Before you can finish** lists every problem in plain words. The common ones:
   - _… is priced by the office_: remove the product, or sync and try again later.
   - _… not enough on the truck_: lower the quantity.
   - _Cash received is less than the total._
   - _This reference number is already on another sale._ Check the number with the customer.
   - _This customer has no credit terms from the office._ / _This sale is more than the customer's credit left._ Take cash or another payment.
6. Tap **Complete sale**. **Sale saved** shows the **Receipt number**, the items, the total and the **Payment**. The sale is saved on the handheld and taken off the truck stock, even with no signal.
7. The receipt prints by itself. Hand it to the customer (see section 9 if it did not print).

Wrong sale? Do not sell again to correct it: [void it](#12-void-a-sale). Goods coming back later: [record a return](#10-customer-returns).

## 9. Printer and receipts

**Every morning:** Today → **Printer & scanner** → **Check printer**, then **Print test receipt**. Check that the text is dark and readable.

- The H10P cannot tell the app whether paper is loaded. The check says **Not reported by this printer**: look at the paper yourself. When paper runs out, the handheld shows its own no-paper message.
- Amounts print with `P` (for example `P374.50`), not the peso sign.
- The receipt is a **delivery receipt, not a BIR official receipt**. It shows the receipt number, date, customer, seller, trip, truck, items, total, payment and a QR code of the receipt number.

**When a receipt did not print:**

1. Fix the paper or printer.
2. Today → **Receipts**. Each sale of this trip shows the time, customer, total, receipt number and **Not printed** or **Printed · N reprints left**.
3. **Not printed** → **Print receipt** prints the original.
4. Printed, but the copy is lost, faded or jammed → **Reprint**, choose the reason (**Customer needs another copy**, **Paper jammed or ran out**, **Print is faded or hard to read**, **Copy for the office**) and tap **Print copy N**. A reprint is marked **REPRINT** with the time and reason.
5. At most 3 reprints per sale, only for sales of the current trip. After that the card says to ask the office.

If the print stopped half way, the app counts it as printed (it may be on paper). Check the paper; use **Reprint** if needed. It never prints a receipt twice by itself.

**Bluetooth printer (only for handhelds without a built-in printer):** pair it once in Android Bluetooth settings (PIN usually `0000` or `1234`), then **Printer & scanner** → **Use a Bluetooth printer**, allow _Nearby devices_, choose the paper width and the printer. **Use the built-in printer** switches back.

## 10. Customer returns

For goods a store gives back. Open it only once the trip is **On route**.

1. Customers → the store → **Record return**.
2. **Bought on**: pick the receipt the goods came from, or **Not from a receipt on this phone**. Linking to a receipt is better: the handheld will not take back more than was sold.
3. **Add returned product**: search or scan (a case barcode picks the case), choose **Counted in** (piece or case), the quantity, and answer:
   - **Why is it returned?** Damaged (crushed, dented, leaking), Expired, Spoiled, Near expiry, Quality complaint, Wrong item delivered, Not selling / overstock.
   - **What happens to the goods?** Only the choices that reason allows:

     | Choice                            | Truck stock                                |
     | --------------------------------- | ------------------------------------------ |
     | **Good stock — sell again**       | Back into sellable stock                   |
     | **Bad order — back to warehouse** | On the truck with the damaged stock        |
     | **Thrown away at the store**      | Nothing comes back (always needs approval) |

   - **Batch / lot number**: required for expired, spoiled, near expiry and quality complaint. Copy it from the pack. Add the expiry date if printed.
4. **Office approval needed** lists why the return waits for the office (thrown away at the store, quality complaint, near-expiry resale, not from a receipt on this handheld, or a walk-in store). Goods waiting for approval stay with the damaged stock and cannot be sold.
5. Tap **Save return**. **Return saved** shows the **Return number**, the approval state and the items.

A return credits the store's account; it does not pay out cash. The handheld does not print a return slip yet.

## 11. Damage and spoilage on the truck

For stock that breaks or spoils on the truck (not a store return).

1. Today → **Truck stock** → the product → **Record damage**.
2. Quantity and reason: **Crushed**, **Leaking**, **Expired**, **Spoiled**, **Other**. Add a note if useful.
3. Take a photo when asked (**Take photo**, **Retake** if blurred). A photo is needed for crushed, leaking, spoiled and other, and for every record that needs approval.
4. **Save damage**. The quantity leaves sellable stock at once.
5. One record of 12 selling units or more (about a case) waits for the supervisor. **This trip's damage records** shows each record: recorded, waiting, approved, or rejected and returned to sellable stock.

You cannot record more than the truck holds (**Not enough stock on the truck**).

## 12. Void a sale

Cancel a whole sale, even after its receipt printed. Part of a sale is a [return](#10-customer-returns) instead.

1. Today → **Receipts** → the sale → **Void sale**.
2. Choose the reason: wrong items, wrong quantity, wrong customer, wrong payment, customer cancelled, or other (a note is then required).
3. Call your supervisor. Read out the **receipt number**, the **total** and the **reason**. Type the **8-digit code** they read back. It works without signal.
4. Tap **Void sale**. The goods go back into truck stock and a **VOID - SALE CANCELLED** slip prints. Keep it with the trip papers; it is not a receipt.

A voided sale is never deleted and can never print a normal receipt again. You cannot void a sale that already has a return, or any sale after the cash is counted. Changing the reason clears the code. **Supervisor approval is not set up on this phone. Sync, then try again.** means the morning download did not finish.

## 13. Sync and working without signal

- Everything you do is saved on the handheld first. Sync sends what the office can already receive (load check, trip start, damage) and downloads changes.
- The handheld syncs by itself when it has signal. Tap **Sync now** on Today any time.
- The Today footer shows how many items are **waiting**, **to review** and **paused**, how many sales and returns are **saved on this phone**, and the **Last sync** time. With SP-0119 (same pilot release) a **Sync & posting** screen lists the latest items with their phone, office and SAP state.
- **Waiting**: not sent yet. Find signal and sync.
- **To review**: the office refused it. Do not redo it; tell your supervisor.
- **Paused**: you signed out or the handheld was suspended. Sign in again as the same seller on the same handheld and sync. Another seller can never send your work.
- **Saved on this phone**: sales, voids, returns and counts of the pilot stay on the handheld until the van upload is ready. This is expected (see [For trainers](#for-trainers-what-the-pilot-build-does-and-does-not-do)).

Sign out only at the end of the day, after the trip is closed. Never uninstall the app or clear its data.

## 14. End of trip: count cash

After the last store, before handing in the cash.

1. Today → **Count cash**.
2. **Expected cash** is the cash of every sale of this trip on the handheld, minus voided sales. Check, GCash, bank transfer and credit sales are listed under **Not in the cash bag**.
3. **Count bills and coins**: type how many pieces of each bill and coin (₱1,000 down to 1¢). Leave the change fund out.
4. **Difference** shows Matches, ₱X short or ₱X over. Any difference needs a reason: counting error, wrong change given, customer paid short, customer overpaid, cash lost or stolen, fake bill or coin, or other (with a note).
5. More than ₱50.00 short or over: **Supervisor approval**. Call your supervisor, read out the **trip number**, **expected cash**, **counted cash** and **reason**, and type the 8-digit code.
6. Tap **Save cash count**, show the saved result to the cashier and hand over the cash with the check slips and credit receipts.

Count once: after saving, the trip takes **no more sales and no voids** (Today shows **Cash counted — no more sales on this trip**). Returns are still possible. A wrong count is corrected by the office, not on the handheld.

## 15. End of trip: count stock

> Arrives with SP-0117 (VAN-023), in the same pilot release. Runbook: `docs/runbooks/VAN_STOCK_RECONCILIATION.md` once merged.

1. Today → **Count stock**.
2. Every product on the truck is listed in its own unit, with the **expected** sellable and damaged quantity (the office stock plus every sale, void, return and damage on the handheld).
3. Count what is on the truck with the warehouse checker. Type the sellable and damaged count, or tap **Same as expected**.
4. A line that differs needs a reason: missing / short, extra found on truck, damage not recorded, sale or return not recorded, free goods or sample given, loaded wrong, or other (with a note).
5. Any difference needs the supervisor: read out the **trip number**, the 12-character **count code**, how many lines differ, the units short and the units over, and type the 8-digit code.
6. Tap **Save stock count**. Truck stock on the handheld now matches your count.

After the stock count, the trip takes no more sales, voids, returns or damage. Count cash and stock in either order.

## 16. Close the trip

> Arrives with SP-0118 (VAN-024), in the same pilot release. Runbook: `docs/runbooks/VAN_TRIP_CLOSE.md` once merged.

1. Today → **Close trip**.
2. **Before you close** ticks off: trip started, signed in, cash counted, stock counted, nothing waiting to send, sales matching truck stock. Each open step has its own button (**Count cash**, **Count stock**, **Sync now**).
3. **Check these** lists what the office should know: receipts not printed (**Open receipts** to print them now), items the office refused, a cash difference, stock lines that differed. Go through them with your supervisor and tick **I have checked these with my supervisor**.
4. Type the end odometer (optional) and a note, then tap **Close trip**. Today shows **Closed on this phone**.
5. Sync once more with signal, hand the handheld for charging, and sign out only after that.

A closed trip takes nothing more on the handheld; receipts can still be reprinted.

**End-of-day hand-in (pilot):** the seller hands the cashier the cash, check slips, the VOID slips and the handheld showing the saved cash count; the warehouse receives the leftover and damaged stock against the stock count.

## 17. Office and warehouse close

The office side of the van day has **no web screens yet** in the pilot. The Sunpride system team runs these steps on request (functions in brackets, for the team):

| Step                             | When                                                        | Function                                                                   |
| -------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| Add a truck                      | Once                                                        | `van/vehicles:create`                                                      |
| Register a handheld              | Once per seller                                             | `mobile/devices:register`                                                  |
| Plan the trip and its load sheet | The day before, or each pilot morning                       | `van/trips:plan`, `van/loads:plan` (sample data: `beta/sample:planVanDay`) |
| Approve a load difference        | When the handheld shows **Waiting for supervisor approval** | `van/loads:approve` (never the seller who confirmed)                       |
| Cancel a trip that never loaded  | Before the load is confirmed                                | `van/trips:cancel` (reason required)                                       |
| Return leftovers to the depot    | Evening, after the warehouse counts                         | `van/trips:returnLeftover`                                                 |
| Close the trip                   | After leftovers are returned (truck empty)                  | `van/trips:close`                                                          |

**Important for the pilot:** sales, voids, returns and counts are not uploaded yet, so the office's truck stock still includes everything the seller sold. Do **not** run "return leftovers" for a trip with sales on the handheld until the van upload exists: it would move the sold goods back into the depot on paper. Until then, the warehouse records the physical leftover against the handheld's **Count stock** result, the cashier records the cash against **Count cash**, and the system team closes the trip on the server after the upload ships.

## 18. Supervisor approvals

Open **Approvals** in the web app (`/workflows`). The seller calls you and reads out the facts; you enter them and read back the 8-digit code. Each code fits only those exact facts and is recorded in the audit log.

| Panel                                  | Seller reads out                                                 | Rule (default)           |
| -------------------------------------- | ---------------------------------------------------------------- | ------------------------ |
| **Van sale void approval**             | Trip number, receipt number, total, reason                       | Every void               |
| **Van cash count approval**            | Trip number, expected cash, counted cash, reason                 | Difference above ₱50.00  |
| **Van stock count approval** (SP-0117) | Trip number, count code, lines that differ, units short and over | Any difference           |
| **Truck damage**                       | Nothing; the record and photo arrive by sync                     | 12 selling units or more |

Before reading back a code, ask: does the story match? A void with "customer cancelled" late in the day, a large cash shortage or repeated damage deserves a question first.

Returns that need approval are saved on the handheld for now; the office approval screen for returns comes with the return upload.

## 19. When to escalate

| Problem                                                   | Who                 | What to say                                   |
| --------------------------------------------------------- | ------------------- | --------------------------------------------- |
| No trip, wrong truck or route, load sheet wrong           | Supervisor          | Trip number, what is wrong                    |
| Load difference waiting                                   | Supervisor          | Trip number, products and quantities          |
| **Priced by the office** on a product you must sell       | Supervisor / office | Product code                                  |
| **Barcode not found** or **Check the product**            | Office              | The barcode and product                       |
| Void, cash difference above ₱50.00, stock difference      | Supervisor (code)   | The facts the screen tells you to read out    |
| Anything **to review**                                    | Supervisor          | What the item is (sale, damage, load)         |
| **Phone removed**, lost or broken handheld                | Supervisor at once  | Your name; do not reset or uninstall          |
| Printer does not print after a paper change and a restart | Supervisor          | Use **Receipts** later to print the originals |

A lost handheld: the supervisor suspends it (web **Phones**, see the supervisor guide section 13). Work not yet synced cannot be recovered from the web; in the pilot that includes the day's sales, so tell the supervisor which stores were served.

---

## Quick reference

| I want to…             | Tap                                                                       |
| ---------------------- | ------------------------------------------------------------------------- |
| Download today's trip  | Today → **Sync now**                                                      |
| Check the load         | Today → **Check the load** → **Confirm load**                             |
| Leave the depot        | Today → **Start trip**                                                    |
| Sell                   | **Customers** → store → **Start sale** → **Checkout** → **Complete sale** |
| Print a missed receipt | Today → **Receipts** → **Print receipt**                                  |
| Reprint                | **Receipts** → **Reprint** → reason → **Print copy N**                    |
| Take back goods        | **Customers** → store → **Record return** → **Save return**               |
| Record breakage        | **Truck stock** → product → **Record damage**                             |
| Cancel a sale          | **Receipts** → **Void sale** → supervisor code                            |
| Count cash             | Today → **Count cash** → **Save cash count**                              |
| Count stock            | Today → **Count stock** → **Save stock count**                            |
| End the day            | Today → **Close trip**                                                    |
| Check the printer      | Today → **Printer & scanner** → **Check printer**                         |

## For trainers: what the pilot build does and does not do

- **Works offline:** load check, start, customers, product search and scanning, sales with cash/check/GCash/bank/credit, receipt print and reprint, returns, damage, voids, cash count (and stock count and close trip once SP-0117/SP-0118 merge).
- **Saved only on the handheld for now:** sales, voids, returns, cash and stock counts and the trip close. They are kept, encrypted, and will upload when the van sale upload ships. Until then the office cannot see them, credit left is reduced only by the credit sales on that handheld, and check/GCash/bank payments are confirmed from the paper slips.
- **Sent to the office now:** the load check, the trip start and damage records (with photos).
- **Not built:** web screens for trucks, trips, load sheets and load approval; a printed return slip; office approval of held returns; promotions on the handheld; SAP posting of van sales.
- **Practice data:** the beta sample seed (`docs/runbooks/BETA_SAMPLE_DATA.md`) gives a Cebu van seller `van@sunpride.test`, trucks `SMP-TRK-01`/`SMP-TRK-02`, route `SMP-R-CBS-1`, 30 invented stores and 40 invented products with peso prices. Each training day, plan the day's trip with `beta/sample:planVanDay`. No real customer data.
- **Suggested training run (about 1 hour per seller):** sign in and register; sync; check a load with one changed line; start; one cash sale, one GCash sale, one credit sale; reprint; one linked return and one unlinked return; one damage with photo; one void with a supervisor code; count cash with a small difference; count stock; close.

## Defaults we chose (Sunpride can change them)

Sunpride has not answered the van questions yet (`_handoffs/sunpride-van-sales-questions.md`); these are our planned answers. Each is one setting in the backend and reaches the handheld by sync.

| Rule                     | Default                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| Trips                    | One trip a day per truck, no top-ups                                                              |
| Load                     | Warehouse loads, seller confirms each line, a difference waits for a supervisor                   |
| Crew                     | One seller, one handheld; driver and helper names are free text                                   |
| Walk-in stores           | Allowed, marked walk-in with a reason                                                             |
| Prices and discounts     | From the price list only; no price or discount typed on the handheld                              |
| Payments                 | Cash, check, GCash, bank transfer, credit (credit only with office terms and credit left)         |
| Negative truck stock     | Off by default: a sale cannot take more than the truck holds (the office can allow it per truck)  |
| Receipt                  | Delivery receipt, not a BIR official receipt; up to 3 reprints marked REPRINT                     |
| Voids                    | Whole sale only, reason required, supervisor code for every void                                  |
| Damage approval          | 12 selling units or more in one record; photo for crushed, leaking, spoiled, other                |
| Returns needing approval | Thrown away at the store, quality complaint, near-expiry resale, not linked to a receipt, walk-in |
| Cash count               | Bills and coins; reason for any difference; supervisor above ₱50.00                               |
| Stock count              | Every difference needs a reason and a supervisor                                                  |
| Close                    | Cash and stock counted, nothing waiting, open items checked with the supervisor                   |

Open questions for Sunpride: the real receipt layout and printer models, the void threshold, the cash tolerance, return rules and who approves them, the end-of-day reports they need, and whether rejected damage is charged to the seller.
