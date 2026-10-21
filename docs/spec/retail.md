# Track R retail POS — current implementation

## F-R01 — One configurable POS

The existing `apps/van-sales-android` APK has office-assigned Van/Store mode per registered device. Store mode replaces trip/load/route navigation with register workflows; Van mode uses its existing paths. Optional online manager-PIN switching requires an explicit office allowance, a register supervisor PIN, no open shift/live trip and all local uploads synchronized. There is no unlocked local switch.

A store is a canonical `inventory_locations.type='store'`, with registers and effective-dated cashier assignments and policies. A linked commercial outlet/account supplies pricing context and analytics identity. Current physical AND commercial ownership are rechecked. The additive sample seed creates two marked Cebu stores, three stocked sample SKUs each and an editable daily sample target, without assigning any real handheld or changing office-edited masters. Sample supply uses the existing inventory movement/allocation/ledger/balance tables, not a second stock book.

Cashier opening float and blind declaration are immutable. Cash expectation comes from the opening float plus the shared store tender journal, including approved reversals. A declaration contains no expected amount or variance. Only a different cash approver sees the comparison and decides an over/short beyond the captured policy tolerance in Decide. Close and mode changes cannot overwrite an open acknowledged session.

## F-R03 — Shared commercial authorities

Store sales have a cashier-session context, not fabricated trips or trucks. The ORDERS adapter creates canonical `orders` and `order_lines`; `orders/service.quote` remains the server pricing/TPM authority. Prices are cached SAP condition replicas with source price-list identities and effective intervals. There is no retail price-list editor or table. Stock changes use `inventory.postMovement`; fiscal numbering uses `allocateDocumentNumber` / `issueDocument`; SAP posting stays a durable pending request until acknowledged by the existing SAP seam.

Native checkout extends the existing pure `CheckoutRules` / `PromotionEngine` with TPM v1 evaluation. Legacy Van contexts select the unchanged evaluator. Governed Store contexts use the canonical precedence, exclusions, residual stacking, half-up centavos and proportional allocation. Server-generated golden fixtures cover the native evaluator. Campaigns requiring the TPM/Fiscal finance-authority seam fail closed when that upstream seam returns `needs_setup`; no cashier can manufacture authorization.

Cash, GCash, card and their split are captured with references, exact totals, cash received/change and independent non-cash confirmation status. Receipt-linked full refunds and original-session voids require a different office approver. Refunds create canonical negative commercial facts and a credit memo, preserving the original invoice; returned goods enter quality hold. Frozen local receipt facts remain primary for reprints, independent of later master-data changes. A print attempt is reserved before printer I/O and uncertain outcomes are never automatically retried. Real permits are independently verified by the fiscal authority; sample receipts explicitly say SAMPLE SERIES, not a BIR tax invoice.

`SEAM(ORDERS)` is the small Store-to-canonical-order writer in `storepos/commercial.js`; the integrator can move its adapter into the ORDERS owner without changing the wire. It already writes the shared commercial fact source, never an isolated retail-sales measure.

## F-R02 — Register-day reads

X reads are mid-day snapshots. A Z read freezes all shifts' sales/tenders/VAT/journal for the register's Manila day and prevents further sales or shift opening that day. Sequences are transactionally allocated per register and read type and are never returned to a pool or reset by download. Immutable reads and fiscal audit retain issued/voided/refunded documents. Offline read capture is explicitly provisional until its office sequence is received. The website exports the e-journal, tender totals and VAT as an Excel-readable SpreadsheetML workbook.

## F-R04 — One inventory ledger

Store receiving delegates to canonical warehouse/van transfer receiving or PO-referenced goods receipts. A store cashier can receive its approved shipment without being granted general access to the upstream warehouse. Product batch, expiry and quality policies remain authoritative. Full and cycle counts create the existing blind count sessions/lines and require independent canonical variance approval/posting. An explicit product subset is recorded on a canonical cycle-count snapshot; older snapshots retain their existing full-roster guards. Changed stock versions refuse stale offline counts rather than posting an invented variance. Sync/refresh after outstanding stock operations before counting.

## F-R05 — Replenishment

Office users configure effective-dated SKU/store reorder points and target stock. Sales and manual refresh create idempotent low-stock suggestions. Warehouse staff prepare the canonical transfer; a different authorized approver approves it. The suggestion itself never moves stock. Shipping and receipt use the existing warehouse transfer workflow.

## F-R06 — Deposits

Deposit capture takes a bounded JPEG slip into app-private noBackup evidence storage, an amount, bank/reference and a Z-read. Existing signed media claims/uploads bind the image to its cashier/device/register. A durable deposit matches cash tender proceeds, excluding opening float; a mismatch appears in the Retail POS queue and Decide for independent acceptance/investigation. Count the drawer before depositing that day's proceeds. A slip is captured evidence, not invented bank confirmation.

## F-R07 — Loyalty and employee verification

Customer identification is exact normalized phone lookup. Registration and sale capture can queue offline; verified lookup is cached with the authorization epoch. Points are configurable and off by default. The server serializes redemption against the actual balance; stale/concurrent redemptions refuse and retain the local evidence. Approved refunds/voids reverse earned/redeemed points.

Employee discount uses a dated register rate and a supervisor PIN. PIN derivation is PBKDF2-HMAC-SHA256 (160,000 rounds), with a one-way downloaded verifier. A command-bound HMAC proves knowledge of the derived secret; possession of the downloaded verifier alone cannot sign a discount. Raw PINs never enter an outbox, receipt or audit. Online mode-switch guesses reserve a 30-second attempt budget outside the failure transaction.

## F-R08 — Owner reporting

Stores → Retail POS answers which store is behind and the next action. Daily sales, equal prior period, dated targets, average basket, daily/category trend, category mix and approved posted shrink drill down to the register's receipts/reads and exception/replenishment queues. Amounts are ₱; display and Excel exports use human names and document numbers, not internal IDs. Sales are read from the same `analytics_sales_facts` source as the rest of the estate, with current source/person/store authorization. Blind-count shrink is hidden from non-approvers. Stock/count/target administration remains in the existing shell.

## F-R01–F-R08 — Offline and boundaries

Store operations use the existing scoped SQLCipher Room outbox and `/api/sync/push`, including exact-byte retries, dependencies and core idempotency. Receipt/fiscal counters and local deduction are committed atomically. Download never resets counters or reopens a submitted local close. Expired/withdrawn scope stops new work; refused operations remain for review. Bank photos use the existing bounded evidence transport and are removed only after acknowledgement.

Advanced campaign finance authorization remains the existing `tpm.seams.requestOverride` → FISCAL integration seam; `needs_setup` is not treated as permission. Live SAP and BIR permit/accreditation are external configuration/evidence, not simulated acknowledgements.

## F-R01–F-R08 — Needs Sunpride

Cebu stores, opening stock/cost, targets, cash tolerance and all sample series are invented and ownership-marked. Confirm store/account links, cashiers, tolerances, bank deposit practice, supervisor/loyalty rules, actual SAP conditions and BIR/PTU evidence. None of those missing inputs blocks sample operation. Manager PINs are configured by the office, not hard-coded in a seed.

## F-R01–F-R08 — iOS parity later

No iOS or field-Android changes. iOS remains paused. Later parity must reuse the same mode, cashier-session, shared quote, fiscal, ledger, evidence and push contracts; never a new retail app or ledger.
