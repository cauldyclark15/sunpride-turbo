# Van-sales UAT scenarios — Cebu van POS pilot

Tracker: SP-0120 (QSR-002), milestone `16 · Van POS pilot (Cebu)`.

This is the user acceptance test (UAT) script for the van-sales pilot on the Senraise H10P
handheld (`apps/van-sales-android`). It walks one van day end to end: the office plans the
trip and its load sheet, the seller checks the load and starts the trip, sells offline,
prints receipts, takes returns, records damage, voids a sale, counts cash and stock, syncs
and closes the trip, and the warehouse takes the leftovers back.

Client rules come from the 20 January 2026 memo
(`docs/requirements/SALES_OPS_STANDARDS_MEMO_2026-01-20.md`) and the 2 October 2026 call
answers (call answers win). Van-specific rules Sunpride has not answered yet (void and cash
approval, cash tolerance, stock-count reasons, the end-of-day checklist, the receipt layout)
use our documented defaults; each scenario names the runbook that holds them, and the client
refines them later.

## How to use this document

- Each scenario has an ID (`VUAT-<area>-<nn>`), the role that runs it, preconditions, steps
  and the expected result. Testers record Pass / Fail / Blocked and the defect number on the
  sign-off sheet at the end.
- `Automated:` lines name a test that proves the same behaviour on every build:
  - `packages/backend/...test.ts` — server (convex-test), runs in `bun run test`;
  - `apps/web/...test.tsx` — web approval screens, runs in `bun run test`;
  - `apps/van-sales-android/app/src/test/...kt` — handheld rules (JVM), runs in
    `./gradlew testDevDebugUnitTest`;
  - `apps/van-sales-android/app/src/androidTest/...kt` — runs on the H10P itself (encrypted
    database, printer, scanner, screens) through
    `~/.hermes/scripts/sunpride-pos-device-test.sh <worktree>`.
- A green automated test does not replace the UAT run: UAT proves the screens, the handheld,
  the paper and the people's workflow. `Manual only:` marks what no automated test covers.
- `Known gap:` states what the current build does not do yet, so a tester does not log it
  as a defect. `Pending:` names a tracker item that is built but not yet merged; run that
  scenario once the item reaches the pilot build, otherwise mark it Blocked.
- `packages/backend/convex/acceptance/van_uat_catalog.test.ts` fails the build if a scenario
  loses its role, expected result or test marker, or if a referenced test is renamed or
  deleted (server, web, JVM and H10P tests alike).
- The server half of the whole day runs on the beta sample data as one story in
  `packages/backend/convex/acceptance/van_pilot.acceptance.test.ts` (`VUAT-E2E-01`,
  `VUAT-E2E-02`).

## Environment and roles

| Item      | Pilot setting                                                                         |
| --------- | ------------------------------------------------------------------------------------- |
| Handheld  | Senraise H10P, Android 14, built-in 58 mm printer, built-in scanner, 3-button nav bar |
| Van app   | Sunpride Van Sales (Beta) APK (`apps/van-sales-android/docs/beta.md`)                 |
| Web app   | DEV or beta deployment of the management web app (Approvals module)                   |
| Data      | Beta sample data (`docs/runbooks/BETA_SAMPLE_DATA.md`), until Sunpride's real data    |
| Time zone | Asia/Manila; the trip is for today's Manila date                                      |
| SAP       | Not part of this pilot: van sales, returns and loads are not posted to SAP yet        |

| UAT role            | Sample login               | App role     | Used for                                              |
| ------------------- | -------------------------- | ------------ | ----------------------------------------------------- |
| Van seller (PMOT)   | `van@sunpride.test`        | `sales`      | Runs the trip on the handheld (truck `SMP-TRK-01`)    |
| Supervisor          | `supervisor@sunpride.test` | `manager`    | Approves load differences, damage, voids, cash, stock |
| Warehouse / office  | `operations@sunpride.test` | `operations` | Takes the leftovers back and closes the trip          |
| Approver (backup)   | `approver@sunpride.test`   | `approver`   | Second approver; proves approvals are not seller-only |
| Administrator       | `admin@sunpride.test`      | `admin`      | Approves the handheld, plans trips                    |
| Lead (no app login) | deployment admin key       | —            | Seeds sample data and plans the day (`planVanDay`)    |

Use a different person (and login) for each role: the seller can never approve their own
load difference, damage, void, cash count or stock count, and UAT must prove that.

## Entry and exit criteria

Entry:

1. The latest `main` build is deployed and the automated gate is green, including the H10P
   device suite.
2. The beta sample data is seeded and every tester has signed in once (seed run twice, see
   `docs/runbooks/BETA_SAMPLE_DATA.md`).
3. Each test day the lead runs `bunx convex run beta/sample:planVanDay` so the seller has a
   trip on `SMP-TRK-01` / `SMP-R-CBS-1` with a 10-line load sheet. There is no web screen for
   trip planning yet.
4. The H10P has the current beta APK, paper in the printer, and is registered (`VUAT-SET-01`).

Exit (van pilot go/no-go):

1. Every scenario is Pass, or Fail with a defect Sunpride and our team accept for the pilot.
2. No open Critical or High defect in load, selling, stock, cash, printing or sync.
3. Sir Francis (or his named delegate) signs the sign-off sheet.

Defect severity: Critical = money or stock wrong or lost, or a sale lost; High = a step of
the van day cannot be completed; Medium = a workaround exists; Low = cosmetic.

## Data Sunpride must provide (the sample data stands in until then)

| Data                                                           | From                 |
| -------------------------------------------------------------- | -------------------- |
| Van sellers, trucks (code, plate), routes and their stores     | Sunpride sales team  |
| Products, units, case sizes and barcodes carried on the trucks | Sunpride / SAP admin |
| Route Sales / PMOT price list and promotions                   | Sunpride             |
| Payment methods allowed on the van, credit terms per store     | Sunpride finance     |
| Receipt layout sample (thermal delivery receipt)               | Sunpride             |
| Void, cash and stock tolerances and who approves them          | Sunpride sales ops   |
| One H10P (or the pilot handheld model) per pilot truck         | Sunpride             |

## Scenarios

### A. Setup

### VUAT-SET-01 · Register the handheld to the van seller

- Role: Van seller, Administrator
- Preconditions: beta APK installed on the H10P.
- Steps: 1) Open the app, tap Test printer & scanner and print a test receipt. 2) Sign in
  as the van seller with a wrong password, then the right one. 3) Read the phone code to the
  administrator, who approves the handheld. 4) Tap Check again.
- Expected: the test receipt prints before sign-in; a wrong password says "Incorrect email
  or password"; the handheld shows its code until approved, then opens Today with the trip.
  A handheld signed for another app or another seller is refused.
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/ui/VanUiDeviceTest.kt` — "printerTestOpensBeforeSignInAndReturnsToSignIn"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/ui/VanUiDeviceTest.kt` — "wrongPasswordAndOfflineShowPlainSignInMessages"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/auth/EnrollmentTest.kt` — "registeredUnboundChallengesSignsBindsAndReadsBack"
- Automated: `packages/backend/convex/van/device_auth.test.ts` — "VAN_ANDROID signs only van bootstrap/push; rejection leaves the nonce usable on its proper path"
- Manual only: the administrator's approval in the web app and the real sign-in on DEV.

### VUAT-SET-02 · The day's trip, customers and prices reach the handheld

- Role: Lead, Van seller
- Steps: 1) Lead runs `planVanDay`. 2) Seller taps Sync now on Today. 3) Open Customers and
  Find product.
- Expected: Today shows the trip number, truck `SMP-TRK-01`, route, driver and helper, and
  "Check the load"; Customers lists the route stores in route order, then other stores in
  the area and walk-ins; each loaded product shows its Route Sales price (or "Priced by the
  office" when no single price exists, never a guess).
- Automated: `packages/backend/convex/beta/sample.test.ts` — "plans the van tester's sample day (trip + load sheet) idempotently, priced on the handheld"
- Automated: `packages/backend/convex/van/workflow.test.ts` — "orders current route customers by sequence, adds covered unplanned customers, excludes expired/inactive/foreign outlets"
- Automated: `packages/backend/convex/acceptance/van_pilot.acceptance.test.ts` — "VUAT-E2E-01 sample van day: download, confirm load, start, record damage, approve codes, unload leftovers and close"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/ui/VanUiDeviceTest.kt` — "homeRendersFixtureAndSafePrimaryBounds"

### B. Load

### VUAT-LOAD-01 · Check the load: every line matches

- Role: Van seller
- Steps: 1) Today → Check the load. 2) Count each line (scan a case barcode on one line,
  type the others). 3) Confirm with every quantity as expected. 4) Sync.
- Expected: a case scan adds the case's pieces (e.g. 24 PC); after sync the load shows
  Loaded, the truck stock equals the load sheet, the depot is lower by the same quantities,
  and Today offers Start trip.
- Automated: `packages/backend/convex/van/workflow.test.ts` — "matched actuals post one van_load with depot/truck ledger entries and command metadata"
- Automated: `packages/backend/convex/acceptance/van_pilot.acceptance.test.ts` — "VUAT-E2E-01 sample van day: download, confirm load, start, record damage, approve codes, unload leftovers and close"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/EncryptedVanStoreTest.kt` — "pendingLoadDoesNotBecomeStockUntilServerPostingAck"
- Manual only: counting the real cases on the truck and scanning their barcodes.

### VUAT-LOAD-02 · Load difference waits for the supervisor

- Role: Van seller, Supervisor
- Steps: 1) Count one line one piece short and try to confirm without a reason. 2) Pick
  "short loaded" and confirm. 3) Sync. 4) Seller tries to approve the load in the web app. 5) Supervisor approves it with a note. 6) Seller syncs.
- Expected: step 1 is refused; after step 3 the load says "Waiting for supervisor approval"
  and no stock moves; the seller cannot approve; after approval the truck holds the counted
  (not the planned) quantity and Start trip is offered.
- Automated: `packages/backend/convex/acceptance/van_pilot.acceptance.test.ts` — "VUAT-E2E-02 sample load discrepancy waits for the Cebu supervisor and posts the counted quantities"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/ui/VanUiDeviceTest.kt` — "changedLoadRequiresReasonAndIsDurablyQueued"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/EncryptedVanStoreTest.kt` — "discrepancyAckHasNoLoadMovementUntilLaterPostedBootstrap"
- Known gap: there is no web screen for load approval yet; the supervisor approves through
  `van/loads:approve` (the lead runs it as the supervisor) until that screen exists.

### VUAT-LOAD-03 · Start the trip

- Role: Van seller
- Steps: 1) Before the load is posted, open Start trip. 2) After it is posted, try Start
  with only one confirmation ticked. 3) Tick truck and route, enter driver, helper and
  odometer, and start.
- Expected: step 1 says "Confirm the load first"; step 2 keeps Start disabled; step 3 puts
  the trip on route and New sale becomes available. A second open trip for the same truck or
  seller on the same day is refused.
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/ui/VanUiDeviceTest.kt` — "startRequiresLoadedTripAndBothChecks"
- Automated: `packages/backend/convex/van/workflow.test.ts` — "refuses start before posting, on the wrong day, without confirmations or with an open session"
- Automated: `packages/backend/convex/van/workflow.test.ts` — "enforces one open trip per truck/day and salesman/day, increments numbers after cancellation"

### C. Selling offline

### VUAT-SELL-01 · Find a product by name, code or scan

- Role: Van seller
- Steps: 1) New sale → pick a route store → Add product. 2) Search `pina`, then `sppj1l`. 3) Scan a piece barcode with the side trigger, then a case barcode, then the camera. 4) Scan an unknown barcode.
- Expected: Piña products are found by name and code without accents or punctuation; a
  piece scan adds the piece, a case scan adds the case unit; the unknown barcode says
  "Barcode not found" and nothing is added; each row shows truck stock and price.
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/ui/VanUiDeviceTest.kt` — "productSearchFindsByNameCodeAndBarcodeWithStockAndPrice"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/ui/VanUiDeviceTest.kt` — "scanningResolvesUnitsFromVendorIntentsAndHandlesNotFoundAndCamera"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/pos/ProductSearchTest.kt` — "nameSearchIsCaseAndAccentInsensitiveWithWordPrefixes"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/pos/BarcodeLookupTest.kt` — "caseBarcodeResolvesTheCaseAndItsBaseQuantity"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/scanning/SenraiseScannerBroadcastTest.kt` — "receivesExportedVendorBroadcast"
- Manual only: physical scans of the printed sample barcodes with the H10P scanner and camera.

### VUAT-SELL-02 · Cash sale with no signal

- Role: Van seller
- Preconditions: airplane mode on.
- Steps: 1) Add three products to a sale for a route store. 2) Enter cash less than the
  total, then more. 3) Complete the sale. 4) Close and reopen the app.
- Expected: short cash is refused in plain words; with enough cash the change is shown; the
  sale is saved on the handheld with a receipt number, survives the restart and says it is on
  this phone and off the truck stock.
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/ui/VanUiDeviceTest.kt` — "checkoutValidatesPricesAndCashThenSavesTheSaleOnThisPhone"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/SaleCheckoutStoreTest.kt` — "saleIsSavedAtomicallyOnThePhoneBeforeAnySync"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/pos/CheckoutRulesTest.kt` — "pricedCashSaleTotalsInCentavosAndGivesChange"
- Manual only: airplane mode and a restart on the real handheld.

### VUAT-SELL-03 · Unpriced product and other checkout refusals

- Role: Van seller
- Steps: 1) Add a product the office has not priced. 2) Add more of a product than the truck
  holds. 3) Try to complete the sale.
- Expected: checkout lists each problem in plain words ("Priced by the office", not enough
  stock) and Complete sale stays disabled; nothing is saved and no stock moves.
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/pos/CheckoutRulesTest.kt` — "unpricedProductBlocksTheSaleInsteadOfGuessing"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/pos/CheckoutRulesTest.kt` — "stockIsCheckedAgainstAvailableNeverDamaged"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/SaleCheckoutStoreTest.kt` — "refusedCheckoutWritesNothing"

### VUAT-SELL-04 · Check, GCash, bank transfer and credit sales

- Role: Van seller
- Steps: 1) Sell with Check and its number. 2) Sell with GCash reusing that number. 3) Sell
  on credit to a store with terms, then try credit for more than its credit left, then for a
  walk-in.
- Expected: non-cash methods take the exact total and a reference that has not been used;
  the reused reference is refused; credit shows the terms, credit left and due date and is
  refused above the credit left and for walk-ins; the saved sale says "To be confirmed by
  the office" or "Charged to account".
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/ui/VanUiDeviceTest.kt` — "checkPaymentKeepsItsReferenceAndAwaitsTheOfficeWhileTheSaleIsSaved"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/pos/CheckoutRulesTest.kt` — "otherMethodsTakeTheExactTotalAndNeedAValidUnusedReference"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/SaleCheckoutStoreTest.kt` — "creditSaleIsChargedToTheAccountWithADueDateWithinCreditLeft"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/SaleCheckoutStoreTest.kt` — "walkInCustomerCannotBuyOnCredit"
- Automated: `packages/backend/convex/van/workflow.test.ts` — "sends the office payment methods and each customer's current credit terms (VAN-012)"

### VUAT-SELL-05 · Walk-in customer

- Role: Van seller
- Steps: 1) Customers → Add walk-in without a reason, then with name and reason. 2) Sell to
  the walk-in for cash.
- Expected: a reason is required; the walk-in shows with its Walk-in label and the sale
  keeps that local customer.
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/ui/VanUiDeviceTest.kt` — "walkInRequiresReasonAndAppearsWithSourceLabel"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/SaleCheckoutStoreTest.kt` — "walkInSaleKeepsTheLocalCustomerInTheSavedOperation"

### D. Printing

### VUAT-PRT-01 · The receipt prints right after the sale

- Role: Van seller
- Steps: complete a cash sale (`VUAT-SELL-02`) and read the paper.
- Expected: the original receipt prints at once on the 58 mm printer, fits the paper (no
  cut-off text), and shows the receipt number, customer, items, quantities, prices, total,
  payment and change, seller and truck, and that it is a delivery receipt, not a BIR
  official receipt.
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/printing/SenraisePrinterDeviceTest.kt` — "bindsRealServiceAndPrintsRealTestReceipt"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/printing/ReceiptReprintTest.kt` — "saleReceiptFits58mmAndCarriesTheSaleFacts"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/printing/ReceiptLayoutFormatterTest.kt` — "oversizedValueAndLabelAreNotSilentlyTruncated"
- Manual only: reading the actual paper; comparing it with Sunpride's sample receipt once received.
- Known gap: the receipt layout is our default until Sunpride sends a sample (2 October
  call, question 18).

### VUAT-PRT-02 · Reprint needs a reason and is marked

- Role: Van seller
- Steps: 1) Receipts → the sale → Reprint without a reason, then with one. 2) Reprint until
  the limit.
- Expected: a reason is required; each copy prints "REPRINT" with its copy number; the sale
  itself never changes; after the limit the card says to ask the office.
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/ui/VanUiDeviceTest.kt` — "saleReceiptPrintsOnceThenReprintsOnlyWithAReasonAndMarker"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/ReceiptPrintStoreTest.kt` — "originalThenReasonedReprintsAreRecordedAndNeverChangeTheSale"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/printing/SenraisePrinterDeviceTest.kt` — "diagnosesRealPrinterAndPrintsReprintMarkedSaleReceipt"

### VUAT-PRT-03 · Printer out of paper or off

- Role: Van seller
- Steps: 1) Remove the paper and complete a sale. 2) Load paper and print from Receipts. 3) Open Printer & scanner → Check printer.
- Expected: the sale is saved even when printing fails; the original is still offered as
  the first copy (not counted as a reprint) when nothing reached paper; the printer check
  shows connection and the last receipt result in plain words.
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/ReceiptPrintStoreTest.kt` — "failedBeforePaperKeepsTheOriginalAvailable"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/printing/ReceiptPrintingTest.kt` — "unavailablePrinterKeepsSavedRecord"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/printing/ReceiptReprintTest.kt` — "printerProblemsNeverRecordAFalseOriginal"
- Manual only: removing the paper roll on the real printer.

### VUAT-PRT-04 · Reprint after the office renames a product

- Role: Van seller, Lead
- Steps: 1) Print a sale. 2) The office renames a sold product (or drops it); seller syncs. 3) Reprint the sale.
- Expected: the reprint shows the product name, unit and prices as sold, not the new names.
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/ReceiptPrintStoreTest.kt` — "reprintKeepsTheSaleTimeFactsAfterMasterDataIsRenamedOrRemoved"

### E. Stock decrement

### VUAT-STK-01 · Each sale takes its exact stock off the truck

- Role: Van seller
- Steps: 1) Note Truck stock for two products. 2) Sell 3 PC of one and 1 CS of the other. 3) Open Truck stock again.
- Expected: available stock drops by exactly 3 PC and by the case's pieces; damaged stock is
  untouched; a sale and its stock change are saved together or not at all.
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/SaleCheckoutStoreTest.kt` — "multiLineSaleDeductsEveryLineWithTheSaleItself"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/SaleCheckoutStoreTest.kt` — "failureMidTransactionRollsBackReceiptNumberStockAndSale"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/ledger/StockProjectionTest.kt` — "allSixMovementTypesUseSignedIntegerMath"

### VUAT-STK-02 · Selling down to zero; no double sale

- Role: Van seller
- Steps: 1) Sell a product down to zero. 2) Try to sell one more. 3) Tap Complete sale twice
  quickly on another sale.
- Expected: step 2 is refused ("Not enough stock on the truck"); the double tap saves one
  sale and takes the stock once.
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/SaleCheckoutStoreTest.kt` — "sellingDownToZeroThenRefuses"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/SaleCheckoutStoreTest.kt` — "completingTheSameSaleTwiceDoesNotSellTwice"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/SaleCheckoutStoreTest.kt` — "twoSalesRacingForTheLastStockSellItOnce"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/EncryptedVanStoreTest.kt` — "negativeStockRefusesUnlessPolicyExplicitlyAllowsIt"
- Open item: the 2 October call allows negative stock in distributor operations; the van keeps
  it off until Sunpride confirms it for the trucks.

### F. Customer returns

### VUAT-RET-01 · Return linked to a sale on this handheld

- Role: Van seller
- Steps: 1) Customer → Record return → Bought on: a sale from this trip. 2) Return one good
  piece (wrong item, back to stock) and one damaged piece. 3) Try to return more than the
  sale sold. 4) Save; tap Save again.
- Expected: good stock returns to sellable stock without approval; damaged goes to damaged
  stock; more than sold is refused; the return saves once with a return number.
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/ReturnStoreTest.kt` — "goodStockFromAReceiptGoesBackToSellableStockWithoutApproval"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/pos/ReturnRulesTest.kt` — "aLinkedReturnNeverExceedsWhatTheSaleSold"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/ReturnStoreTest.kt` — "savingTheSameReturnTwiceRecordsItOnce"

### VUAT-RET-02 · Expired goods need a batch; held goods need the office

- Role: Van seller
- Steps: 1) Return an expired case without a batch number, then with batch and expiry. 2) Choose a disposition that needs approval. 3) Save.
- Expected: batch is required for expired, spoiled, near-expiry and quality reasons; the case
  is recorded in cases and pieces; goods waiting for approval are held, never sellable, and
  the return shows "Office approval needed".
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/ui/VanUiDeviceTest.kt` — "customerReturnCapturesUnitBatchReasonAndDispositionAndHoldsStockForApproval"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/pos/ReturnRulesTest.kt` — "batchIsRequiredForDateAndQualityReasonsAndExpiryMustBeADate"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/pos/ReturnRulesTest.kt` — "goodsWaitingForApprovalAreHeldNeverSellable"
- Known gap: returns stay on the handheld (no van return upload yet); the office approval of a
  held return happens after that upload exists.

### G. Damage

### VUAT-DMG-01 · Record damage found on the truck

- Role: Van seller
- Steps: 1) Truck stock → Record damage: one expired piece. 2) Record more than the truck
  holds. 3) Record a crushed piece without a photo, then with a photo. 4) Sync.
- Expected: the piece moves from sellable to damaged at once; too much is refused; a crushed
  piece needs a photo; after sync the office truck stock shows the same damaged quantity.
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/ui/VanUiDeviceTest.kt` — "damageBeyondStockIsRefusedAndValidDamageUpdatesProjection"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/data/DamageRulesTest.kt` — "requiredReasonNeedsPhotoBelowApprovalAndExpiredDoesNot"
- Automated: `packages/backend/convex/van/workflow.test.ts` — "requires an uploaded photo of the same seller for visible-damage reasons"
- Automated: `packages/backend/convex/acceptance/van_pilot.acceptance.test.ts` — "VUAT-E2E-01 sample van day: download, confirm load, start, record damage, approve codes, unload leftovers and close"
- Manual only: taking the photo with the H10P camera.

### VUAT-DMG-02 · Large damage waits for the supervisor

- Role: Van seller, Supervisor
- Steps: 1) Record 12 or more pieces damaged with a photo; sync. 2) Seller opens Approvals in
  the web app. 3) Supervisor opens Approvals → van damage, rejects one record without a
  note, then with a note, and approves another.
- Expected: the record waits for approval with its photo; the seller cannot decide; reject
  needs a note and puts the stock back through a separate reversal; the handheld shows the
  decision after sync.
- Automated: `packages/backend/convex/van/workflow.test.ts` — "holds records at the approval threshold for a supervisor, with a photo, and shows them on the device"
- Automated: `packages/backend/convex/van/workflow.test.ts` — "lets only an in-scope supervisor who is not the recorder decide"
- Automated: `packages/backend/convex/van/workflow.test.ts` — "rejects with a reason through a separate reversal movement, never editing the original"
- Automated: `apps/web/src/components/van-damage-approvals.test.tsx` — "never rejects without a note, and sends the note when given"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/ui/VanUiDeviceTest.kt` — "approvalBoundaryRequiresPhotoRetakeAndShowsSupervisorHistory"

### H. Voids

### VUAT-VOID-01 · Void a sale with the supervisor's code

- Role: Van seller, Supervisor
- Steps: 1) Receipts → the sale → Void sale, pick a reason. 2) Read the receipt number,
  total and reason to the supervisor. 3) Supervisor enters them in Approvals → Van sale void
  approval and reads back the code. 4) Seller types a wrong code, then the right one; change
  the reason after typing it.
- Expected: the seller cannot issue their own code; a wrong code or a changed reason refuses
  the void; the right code voids the sale with no signal, puts the stock back exactly and
  prints a VOID slip; the voided sale never prints a normal receipt again.
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/ui/VanUiDeviceTest.kt` — "voidDialogRequiresSupervisorCodeClearsItOnReasonChangeAndPrintsOnlyVoidSlips"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/SaleVoidStoreTest.kt` — "voidRestoresExactlyTheSaleAndLeavesEveryOriginalFactByteIdentical"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/SaleVoidStoreTest.kt` — "wrongCodeWritesNothingInAnyTable"
- Automated: `packages/backend/convex/van/workflow.test.ts` — "issues the code a supervisor in scope reads to the seller, audited without the code"
- Automated: `apps/web/src/components/van-void-approval.test.tsx` — "offers exactly the backend's void reasons"
- Automated: `packages/backend/convex/acceptance/van_pilot.acceptance.test.ts` — "VUAT-E2E-01 sample van day: download, confirm load, start, record damage, approve codes, unload leftovers and close"
- Manual only: the phone call between seller and supervisor.

### VUAT-VOID-02 · A returned sale cannot be voided; a voided sale takes no return

- Role: Van seller
- Steps: 1) Record a return linked to sale A, then try to void sale A. 2) Void sale B, then
  try to record a return linked to sale B.
- Expected: both are refused, so stock never comes back twice.
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/SaleVoidStoreTest.kt` — "aReturnedSaleCannotBeVoidedAndAVoidedSaleCannotTakeAReturn"

### I. Cash and stock reconciliation

### VUAT-CASH-01 · Count cash: matches or a small difference

- Role: Van seller
- Steps: 1) After cash, check and credit sales and one void, open Today → Count cash. 2) Count
  bills and coins to match; save. (On a second trip: count ₱20 short, pick a reason, save.)
- Expected: expected cash is the cash of the sales not voided; check/GCash/bank/credit are
  listed apart under "Not in the cash bag"; a match saves with no reason; a difference within
  ₱50.00 needs only a reason; after saving, New sale and voids are closed for the trip.
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/pos/CashReconciliationTest.kt` — "expectedCashIsCashPaymentsOfSalesNotVoidedAndOtherMethodsAreListedApart"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/CashReconciliationStoreTest.kt` — "withinToleranceNeedsOnlyAReason"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/CashReconciliationStoreTest.kt` — "oneCountPerTripReplaysTheSameTapAndThenSellingAndVoidingStop"
- Manual only: counting the real bills and coins; the cashier's hand-over.

### VUAT-CASH-02 · Cash difference above ₱50 needs the supervisor

- Role: Van seller, Supervisor
- Steps: 1) Count ₱70 short, pick a reason. 2) Read trip number, expected, counted and reason
  to the supervisor, who enters them in Approvals → Van cash count approval. 3) Seller types
  the code, then changes the counted amount and tries again.
- Expected: the seller cannot issue their own code; the code works only for that trip, both
  amounts and that reason (a void code never works); changing an amount clears the code.
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/ui/VanUiDeviceTest.kt` — "cashCountShowsExpectedCashNeedsAReasonAndAboveToleranceTheSupervisorCodeThenStopsSelling"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/CashReconciliationStoreTest.kt` — "aDifferenceAboveToleranceNeedsTheExactCodeAndRefusalsWriteNothing"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/pos/CashReconciliationTest.kt` — "aVoidCodeForTheSameTripNeverApprovesCash"
- Automated: `packages/backend/convex/van/workflow.test.ts` — "refuses the seller, roles without the capability, other regions, bad input, trips not on the road and a missing secret"
- Automated: `apps/web/src/components/van-cash-approval.test.tsx` — "sends the trimmed trip number, centavos and reason; refuses an incomplete or matching form"
- Open item: the ₱50.00 tolerance and the reasons are our default (`docs/runbooks/VAN_CASH_RECONCILIATION.md`).

### VUAT-SCNT-01 · Count the stock left on the truck

- Role: Van seller, Supervisor
- Pending: SP-0117 (VAN-023 stock count), in QA.
- Steps: 1) Today → Count stock. 2) Tap Same as expected on all lines but one; count that
  one one piece short and pick a reason. 3) Read the trip number, count code, lines that
  differ and units short/over to the supervisor, who issues the code in Approvals → Van stock
  count approval. 4) Save.
- Expected: expected stock is the office truck stock plus the sales, voids, returns and damage
  saved on the handheld; sellable and damaged are counted apart; any difference needs a
  reason per line and the supervisor's code; after saving the truck stock on the handheld
  equals the count and sales, voids, returns and damage stop.
- Manual only: the physical count on the truck. Automated tests arrive with SP-0117 (store,
  rules, H10P screen and server code tests); add them here when it merges.
- Known gap: the server does not receive the count until the van sale upload exists
  (`docs/runbooks/VAN_STOCK_RECONCILIATION.md` on SP-0117).

### J. Sync

### VUAT-SYNC-01 · Work saved offline survives and syncs once

- Role: Van seller
- Steps: 1) In airplane mode confirm the load, record damage and make sales. 2) Restart the
  handheld. 3) Turn the network on and tap Sync now twice.
- Expected: nothing saved is lost on restart; each operation reaches the office once, in
  order; the second sync sends nothing new; Today shows waiting/review/paused counts and the
  last successful sync.
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/sync/VanSyncTest.kt` — "pushesAtMost20InOrderAndPersistsAckBeforeDone"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/sync/VanSyncTest.kt` — "transportFailureResetsSendingAndReplaysOriginalIdsAndBytes"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/EncryptedVanStoreTest.kt` — "processRestartResetsPersistedSendingWithoutChangingOperationBytes"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/EncryptedVanStoreTest.kt` — "bootstrapPreservesOutboxSalesWalkInsAndScopes"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/sync/SyncWorkTest.kt` — "connectedUniqueWorkUsesExponentialBackoffAndSeparateStubInput"
- Manual only: airplane mode, restart and reconnect on the real handheld.
- Known gap: only load checks, trip start and damage are sent to the office today. Sales,
  returns, voids and the cash count stay on the handheld ("N sales saved on this phone") until
  the van sale upload exists; nothing is posted to SAP this phase.

### VUAT-SYNC-02 · Lost acknowledgement and changed replays

- Role: Van seller
- Steps: 1) Confirm the load with weak signal so the reply is lost. 2) Sync again.
- Expected: the office keeps one load, one stock movement and gives the same answer; a
  different body under the same request is refused as a conflict and kept for review, never
  retried silently.
- Automated: `packages/backend/convex/van/workflow.test.ts` — "VAN-013 replay returns identical ack once, changed payload conflicts, ownership and operate capability fail closed"
- Automated: `packages/backend/convex/van/workflow.test.ts` — "replays trip starts and damage with stable acknowledgements, no duplicate sessions or movements"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/sync/VanSyncTest.kt` — "rejectedAndConflictAreNeverRetried"
- Automated: `packages/backend/convex/acceptance/van_pilot.acceptance.test.ts` — "VUAT-E2E-01 sample van day: download, confirm load, start, record damage, approve codes, unload leftovers and close"

### VUAT-SYNC-03 · Suspended or removed handheld keeps its work

- Role: Administrator, Van seller
- Steps: 1) Administrator suspends the handheld. 2) Seller records damage and syncs.
- Expected: the office refuses the work and changes nothing; the handheld keeps it on the
  phone (paused for review, never deleted, never retried by itself) and says the phone is
  paused. Recovery of paused work goes through the office
  (`docs/runbooks/MOBILE_DEVICE_INCIDENT.md`).
- Automated: `packages/backend/convex/van/workflow.test.ts` — "the production HTTP push refuses a suspension committed after proof verification"
- Automated: `apps/van-sales-android/app/src/androidTest/java/com/sunpride/van/storage/EncryptedVanStoreTest.kt` — "holdAndReviewNeverAutomaticallyRetry"
- Automated: `apps/van-sales-android/app/src/test/java/com/sunpride/van/auth/EnrollmentTest.kt` — "revokedOrSuspendedStops"
- Manual only: suspending the real handheld in the web app.

### VUAT-SYNC-04 · Sync and posting health on the handheld

- Role: Van seller
- Pending: SP-0119 (VAN-025 sync and posting health), in QA.
- Steps: open Today → Sync & posting after `VUAT-SYNC-01`.
- Expected: three separate answers — on this phone, office, SAP — read from the handheld's
  own records; parked sales/returns/voids/cash count are listed as on this phone; every item
  reads "Not posted to SAP yet"; no raw server codes are shown.
- Manual only: reading the screen on the H10P. Automated tests arrive with SP-0119.

### K. Trip close

### VUAT-CLOSE-01 · Close the trip on the handheld

- Role: Van seller
- Pending: SP-0118 (VAN-024 close van trip), in QA.
- Steps: 1) Today → Close trip before counting cash and stock. 2) Count cash and stock, sync. 3) With an unprinted receipt, open Close trip, tick "I have checked these with my
  supervisor", enter an end odometer lower than the start, then a valid one, and close.
- Expected: the checklist blocks the close until cash and stock are counted and nothing waits
  to send; open exceptions (unprinted receipts, refusals, cash or stock differences) need the
  tick; the end odometer cannot be below the start; after closing, no sales, voids, returns,
  damage or counts are possible and Today says "Closed on this phone"; receipts can still be
  reprinted.
- Manual only: the close on the H10P. Automated tests arrive with SP-0118.

### VUAT-CLOSE-02 · Warehouse takes the leftovers back and the office closes the trip

- Role: Warehouse / office, Van seller
- Steps: 1) Office tries to close the trip while the truck still holds stock. 2) Seller tries
  to return leftovers. 3) Warehouse counts and records the leftovers (sellable and damaged),
  then closes the trip. 4) Seller syncs.
- Expected: step 1 is refused ("return leftovers first"); the seller cannot do the warehouse
  step; the leftovers go back to the depot in one movement, damaged kept apart; the truck is
  empty; the trip closes and leaves the handheld.
- Automated: `packages/backend/convex/van/workflow.test.ts` — "starts with crew/odometer/device, sells through existing POS, damages, unloads both statuses and closes"
- Automated: `packages/backend/convex/van/workflow.test.ts` — "gates return and close by capability, stored trip scope and lifecycle"
- Automated: `packages/backend/convex/acceptance/van_pilot.acceptance.test.ts` — "VUAT-E2E-01 sample van day: download, confirm load, start, record damage, approve codes, unload leftovers and close"
- Known gap: there is no web screen for returning leftovers or closing the trip yet; the lead
  runs `van/trips:returnLeftover` and `van/trips:close` as the operations tester. Because van
  sales are not uploaded yet, the office truck stock does not include the day's sales, so the
  leftovers it returns are the loaded quantity less damage; treat that as expected for this
  build, not a defect.

### L. Full van day (end to end)

### VUAT-E2E-01 · One van day, start to finish

- Role: all
- Steps: run `VUAT-SET-02`, `VUAT-LOAD-01`, `VUAT-LOAD-03`, `VUAT-SELL-02`, `VUAT-PRT-01`,
  `VUAT-STK-01`, `VUAT-RET-01`, `VUAT-DMG-01`, `VUAT-VOID-01`, `VUAT-CASH-02`,
  `VUAT-SCNT-01`, `VUAT-SYNC-01`, `VUAT-CLOSE-01` and `VUAT-CLOSE-02` in order on one trip.
- Expected: every step succeeds with the same data flowing through; at the end the cash in
  the bag equals the counted cash, the truck is empty and the trip is closed on the handheld
  and in the office.
- Automated: `packages/backend/convex/acceptance/van_pilot.acceptance.test.ts` — "VUAT-E2E-01 sample van day: download, confirm load, start, record damage, approve codes, unload leftovers and close"
- Manual only: the handheld half of the day (selling, printing, counts) on the H10P.

### VUAT-E2E-02 · Load difference day

- Role: Van seller, Supervisor
- Steps: run `VUAT-LOAD-02`, then `VUAT-LOAD-03` and `VUAT-E2E-01` from the first sale.
- Expected: as in those scenarios; the day's stock starts from the counted load.
- Automated: `packages/backend/convex/acceptance/van_pilot.acceptance.test.ts` — "VUAT-E2E-02 sample load discrepancy waits for the Cebu supervisor and posts the counted quantities"

## Open items for Sunpride (affect expected results)

- Handheld and printer model for the pilot trucks, and a sample receipt layout (call Q18).
- Whether negative truck stock is allowed on the vans (call Q17 allows it for distributors).
- Batch/expiry products and whether expired stock is blocked from sale (call Q17).
- Void approval rule (every void needs a supervisor, today), cash tolerance (₱50.00), stock
  count reasons and who signs off a short truck, and the end-of-day checklist.
- Who records leftovers and closes the trip in the office (warehouse, cashier or supervisor).

## Sign-off sheet

| Scenario      | Tester | Date | Pass / Fail / Blocked | Defect | Notes |
| ------------- | ------ | ---- | --------------------- | ------ | ----- |
| VUAT-SET-01   |        |      |                       |        |       |
| VUAT-SET-02   |        |      |                       |        |       |
| VUAT-LOAD-01  |        |      |                       |        |       |
| VUAT-LOAD-02  |        |      |                       |        |       |
| VUAT-LOAD-03  |        |      |                       |        |       |
| VUAT-SELL-01  |        |      |                       |        |       |
| VUAT-SELL-02  |        |      |                       |        |       |
| VUAT-SELL-03  |        |      |                       |        |       |
| VUAT-SELL-04  |        |      |                       |        |       |
| VUAT-SELL-05  |        |      |                       |        |       |
| VUAT-PRT-01   |        |      |                       |        |       |
| VUAT-PRT-02   |        |      |                       |        |       |
| VUAT-PRT-03   |        |      |                       |        |       |
| VUAT-PRT-04   |        |      |                       |        |       |
| VUAT-STK-01   |        |      |                       |        |       |
| VUAT-STK-02   |        |      |                       |        |       |
| VUAT-RET-01   |        |      |                       |        |       |
| VUAT-RET-02   |        |      |                       |        |       |
| VUAT-DMG-01   |        |      |                       |        |       |
| VUAT-DMG-02   |        |      |                       |        |       |
| VUAT-VOID-01  |        |      |                       |        |       |
| VUAT-VOID-02  |        |      |                       |        |       |
| VUAT-CASH-01  |        |      |                       |        |       |
| VUAT-CASH-02  |        |      |                       |        |       |
| VUAT-SCNT-01  |        |      |                       |        |       |
| VUAT-SYNC-01  |        |      |                       |        |       |
| VUAT-SYNC-02  |        |      |                       |        |       |
| VUAT-SYNC-03  |        |      |                       |        |       |
| VUAT-SYNC-04  |        |      |                       |        |       |
| VUAT-CLOSE-01 |        |      |                       |        |       |
| VUAT-CLOSE-02 |        |      |                       |        |       |
| VUAT-E2E-01   |        |      |                       |        |       |
| VUAT-E2E-02   |        |      |                       |        |       |

Signed for Sunpride: ______________________ Date: __________

Signed for the delivery team: ______________________ Date: __________
