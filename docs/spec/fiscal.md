# Fiscal and compliance — F-018, F-019, F-020, F-108, F-109, F-111, F-124, F-511

## F-018 — Authorization, not an accreditation claim

The office question is: “May this branch and handheld issue this kind of document, and which evidence is missing?” Setup → Fiscal & authority holds the register; sample rows say **Sample, not filed**. The company files with BIR. Software cannot turn a demo template into regulatory approval.

Registrations specify organizational branch, registered entity/name/TIN/address, optional registered-device applicability, document type, application/permit/evidence references, filing/acknowledgement dates, effective dates and status. A live `approved` registration requires evidence and a different administrator from its author. Sample registrations cannot be promoted to live approval. A missing, draft, expired or suspended authorization refuses issuance. An approved range is not permission to bypass this gate.

The editor supports branch-wide applicability or a named active handheld from that branch. Device, document type, start date and tax treatment are versioned: changing them requires a new registration. Configure a new effective-dated registration for a different tax treatment. The current candidate supports one inclusive VAT treatment per allocated document, not mixed product tax classes.

## F-019 — Series, reservations and reconciliation

Four document types share one numbering authority: Sales Invoice, Official Receipt, credit memo and delivery receipt. Series have distinct prefixes, approved first/last serials, effective dates and an optional van. `allocateDocumentNumber(tx, {actor,deviceId,seriesId,requestKey,count})` reserves 1–1,000 numbers under a locked series row. Exact retries return the original allocation. Device ownership, series identity and counters cannot be rewritten backwards or deleted by ordinary SQL.

A reservation is not an issue. The office reconciliation separates accounted numbers from numbers still reserved on a handheld. Branch and Manila service-date filters narrow document/tender history; capped lists explicitly refuse to claim a complete reconciliation. Multiple independent devices can hold disjoint ranges; an unsynced reservation must never be described as a proven missing document. Ranges are never recycled after replacement. Before replacing a phone, reconcile every outstanding allocation; unresolved tails remain assigned, not reassigned to another phone.

`issueDocument(tx,input)` consumes only the next number from its allocation in the business transaction. A failed transaction consumes nothing. Issued documents are immutable; voids and spoiled numbers are compensating journal events, never deletions or reuse. The spoil command consumes a number with a recorded reason and authority request. A legacy allocation missing its frozen registration fails closed.

The server freezes the registration and tax treatment at allocation. The H10P counter lives in its encrypted Room database, separately from the replaceable bootstrap snapshot. Checkout allocates the serial, writes the sale, payment, stock deduction, operation and immutable receipt in one transaction. Reopening or re-downloading does not reset the counter. A refused upload keeps its original number and evidence for reconciliation.

## F-108 / F-109 — Sale linkage and 58 mm candidate documents

Every newly accepted van sale must carry `fiscal: {allocationId,serial}`. Its receipt number must equal the controlled invoice number. The server revalidates prices/amounts and freezes source price references, lines, registered identity, inclusive VAT breakdown, customer, tender, seller and truck. Number/receipt/payment/movement writes commit together.

The existing printer-neutral receipt formatter now renders a controlled Sales Invoice with registered name, branch address, TIN, permit, serial, VATable sales, VAT, exempt and zero-rated sections. Sample documents prominently say they are unfiled and not tax documents. The original operational delivery-receipt formatter and disclaimer remain for historical operational receipts. A reprint uses the frozen original facts, the existing REPRINT banner and reason/copy controls.

The H10P offers invoice and REPRINT previews using the same 32-column formatter as the printer. Fiscal checkout does not automatically spend paper. The printer's service connection is not paper confirmation. Lane proof prints zero real receipts unless paper is explicitly reported; an on-screen preview is not evidence of a physical print.

Actual print attempts enqueue an uncertain start and a final outcome, correlated by print ID, into `fiscal.print`. These are two journal facts for one attempt, not two paper copies. The operation depends on the original sale acknowledgement. The existing local print history controls original/reprint/void-copy behavior.

Collections recorded through `payment.record` require an allocated Official Receipt and produce an immutable OR record and posting request. Native collection capture and a separate native OR preview/formatter are not implemented in this slice. Credit memo and delivery receipt series administration exists; their transaction-specific issue/print adapters remain integration work.

### F-108 — SAP seam

`domains/fiscal/transactions.js` contains `SEAM(SAP): enqueueSapPosting`. It appends a durable, immutable `fiscal_posting_requests` row with a stable effect key, fiscal document ID/number, document kind and frozen snapshot. It does not write another domain's integration tables, invent an SAP reference or claim an SAP acknowledgement. The SAP lane must connect this adapter to its `enqueueSapPosting` authority, preserving the document ID/effect key, and return acknowledged posting references through its trace surface.

## F-111 — Tenders and office confirmation

Cash, GCash, Maya, card and the legacy stable code `check` (displayed as Cheque) are accepted. Bank transfer and account credit remain as bonus methods. This is selection among methods, not split tender. Noncash payment records require a provider/terminal reference and remain awaiting independent confirmation. Card capture rejects a card-number-looking value; PAN/CVC are not receipt fields.

The H10P consumes the server's method list, so Maya/card use the existing checkout/reference/payment/receipt path. The office Money page shows net captured totals separately by tender and an independent confirmation form. Canonical collected-money and credit-exposure measures count only independently confirmed noncash rows. A noncash refund needs its own confirmation; a confirmed charge never automatically certifies the refund. A seller cannot confirm their own tender. A declined collection can be replaced without consuming the credit balance twice, but its original OR number and immutable document remain: do not treat rejection as deletion or automatic regulatory void. A void invoice cannot receive another collection. Settlement continues to retain each payment method through its existing trip payment breakdown; money handed to a cashier is not counted again as a customer collection.

Tender authorizations, names and reference prompts are effective-dated branch masters editable in the fiscal admin. Changes take effect only at future Manila midnight, beyond the current recording lease, and signed offline payments are checked against their capture-time policy. Absent or overlapping policy fails closed. Noncash references/independent confirmation and card-number rejection are nonconfigurable security invariants. Split payment, provider connectivity and cheque lifecycle are not claimed.

## F-124 / F-511 — One authority seam, reason and exact facts

`requestOverride(tx, actor, {id,orgUnitId,kind,channel,amountCentavos,reason,facts})` is exported from `domains/fiscal/authority.js` and the fiscal index. Kinds are price, credit, stock, discount and void. Rules are effective-dated by branch, app role, channel and inclusive value band. The editor takes exact peso amounts, selectable approver-role groups and offline-code eligibility, and can schedule a replacement without editing the past. Exact-channel rules take precedence over `*`; absent or ambiguous matching rules refuse authority. Policy replacement closes the old rule prospectively.

Every request retains its original facts/hash and reason. Above `selfLimitCentavos`, a different authorized approver must decide. Decide shows the queue and reason. `enforceAuthority(tx,actor,{...,overrideId,operationId,facts,offlineCode?})` consumes only an unexpired request for the same person, branch, kind, channel, amount, current rule and exact facts. Approval is reauthorized at consumption, not only at decision. One operation consumes a grant; retries by that operation are stable. Changed facts or another operation are refused.

When a rule permits it, the decision API can issue a random one-use offline preauthorization code; only its hash is stored. This is server validation of an issued code, **not yet a generic on-device offline verifier/UI**. Existing handheld void/stock/cash codes keep their original independently-issued exact-facts behavior.

The van sale writer now uses this authority at the transaction for a manual nonzero discount. It does not override the SAP/price resolver. Unsupported promotion objects and unauthorized price changes still fail closed. The native manual-discount/request/status UI, office/field/distributor transaction adapters and replacement of legacy stock/credit/void policy entry points are not finished. Therefore this is not full F-124/F-511 delivery across every channel.

## F-020 — Immutable audit boundary

Database triggers reject ordinary UPDATE/DELETE on fiscal documents/events, requests/decisions/consumptions, posting requests and the fiscal change journal, and on existing general/van audit events. Existing explicit sample-only reset may delete only previously proven owned general-audit rows; it cannot rewrite audit or delete real evidence. Database owners/retention administrators remain outside the application-role threat model.

Allowlisted before/after facts are appended in the same transaction for master edits, prices/order lines, sale headers/lines and discounts, overrides, voids, returns, tender decisions, cash/stock counts and remittances, damage decisions and inventory adjustments. Core org, order, van and inventory command boundaries stamp the actor. A writer without a stamp is explicitly `system:unattributed`, never attributed to a guessed person. No password/token, raw evidence or GPS is copied into these audit projections.

Remaining audit coverage work: enumerate additional masters added by the other spec lanes, add their triggers/call-site actor stamps, audit their return-approval and settlement-adjustment writers, and provide the full scoped export/archive/retention operator UI. The narrow national audit read endpoint additionally requires van cash and stock approval authority so an ordinary administrator cannot bypass blind-count separation. It is not a complete archive solution.

## Needs Sunpride — F-018 / F-019 / F-109 / F-111 / F-124 / F-511

- Registered legal identities, TINs/addresses, filing acknowledgements, permit scope/evidence and independently verified effective dates.
- Approved branch/van/document ranges; Controller rules for unused tails, spoilage and device replacement.
- BIR review/acceptance of SI/OR layouts and applicable current document/tax rules. The sample inclusive 12% VAT treatment is invented for demonstration, not a client tax determination.
- Tender confirmation evidence, approved additional methods, any split-tender requirement and cheque process.
- Authority value bands, role/channel mappings, offline preauthorization policy and SAP financial approval interface. Sample discount self-limit is ₱5; all other sample manual overrides require independent approval above zero.
- Audit retention, separated database administration and archive/export requirements.

These inputs do not block sample software work; they do block any claim of live regulatory authorization.

## iOS parity later — F-019 / F-108 / F-109 / F-111 / F-124 / F-511

iOS is paused. Port allocation persistence, atomic invoice consumption, frozen tax/registration DTOs, tender references/confirmation states, print journals and the completed authority/approval UI after the Android contract is accepted. No iOS source changed.

## Integration — all fiscal F-IDs

Apply additive migrations 0430–0438 before starting the new API. Install the fiscal domain once. Run `seedFiscal(db)` (also called by the seed CLI and daily advance) after generating trial trucks; it only adds sample-marked idempotent rows. Do not reset issued/sample compliance facts to make a new demo. Rebuild Android before enabling new fiscal series: older clients lack controlled number capture and will safely be refused by the new sale writer. Coordinate the API/native cutover; do not deploy the server-only change as a silent old-client upgrade. Reconcile older queued operational receipts first: do not relabel their uncontrolled numbers as tax invoices. Preserve controlled series, reserved tails and issued evidence when advancing the sample day; do not reset a live fiscal dataset.

No call-flow engine is added. CALLFLOW continues to own progression. Bonus map, biometric sign-in, location, cockpit, PWA, issue board and historical receipts remain.
