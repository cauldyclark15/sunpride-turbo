# Modern trade — F-306, F-307, F-309, F-611

## F-306 — owner question and purchase-order intake

Which account purchase orders need review before they can become sales orders?

The Work → Modern trade → PO intake console accepts a bounded original document, previews its normalized header and lines, shows validation exceptions, saves corrections with a revision check, and confirms through the existing `orders/service.js:createOrder`. It does not create an outside-call order or a second sales-order object. A store already in today's route is not refused by this intake path. The trusted internal intake option uses `order.encode`; it is not accepted as an HTTP order-create permission override.

Supported adapters:

- CSV / a retailer portal's downloaded CSV export. Default headers are `po_number,delivery_date,sku,uom,quantity,price_centavos`; the last field is optional. Account-specific column mappings are effective-dated and editable in Account setup.
- Explicit sample EDI-like `PO|number|date~LINE|SKU|unit|quantity|centavos~`. This is not an assertion of X12 or EDIFACT interoperability.
- Structured email with `PO-Number:`, `Delivery-Date:`, then `Lines:` and a CSV block.
- Pluggable `ocrStub.extract(bytes)`: retains the scan and returns an explicit manual-review exception. It never invents recognized text. A connected OCR service is not shipped.

Concrete fixtures are in `apps/api/test/fixtures/mt/`. Their P1 product is a test fixture, not a real Sunpride SKU. In the seeded office app, substitute an actual marked sample product code and selling unit.

Files are limited to 450 KB and one PO with 1–100 lines. Original bytes, format, filename, receipt time and SHA-256 live in immutable `mt_po_documents`; downloads require office encoding permission and current store scope. Corrections change only the intake projection and its normalized lines, never the original. Invalid dates, unknown/inactive products, invalid quantities/conversions, duplicate SKU/unit pairs, missing approved prices and PO-price mismatches become review exceptions. An omitted PO price means use the approved account price, not zero. Confirmation requires a saved, exception-free revision and revalidates current prices and masters. Each saved preview shows product names, approved unit prices and gross before offers, using the canonical integer-money primitives. Unknown previews are not zero. Changed prices refuse confirmation until corrections are saved; an in-transaction check also compares the canonical frozen line prices before commit. Final promotions and credit remain in Orders. Old drafts must be explicitly revalidated rather than inventing price history.

Office queues require report.read and at least one of order.encode, order.approve or people.read, matching navigation; field sales cannot bypass that boundary with a direct HTTP request. Confirming a PO enqueues the canonical order day for analytics refresh after commit. Its link opens that exact canonical order drawer.

Replay uses a per-user request key and content hash inside the same transaction. Authorization is checked before replay. Content dedupe is binding + actual document hash; confirmed business identity is branch key + case-insensitive PO number, also unique across binding versions. Conflicting confirmation rolls back the canonical order, lines and workflow too. Changes audit and invalidate the office topic; the original order pricing snapshot remains frozen.

## F-307 — trade conditions and the SAP boundary

Which account conditions are approved, when do they apply, and who approved them?

Trade terms have chain/account, banner or branch scope; an effective interval; source key/version/receipt time; optional immutable uploaded contract source or existing original-document reference; ordered condition lines; and an append-only approval history. Conditions cover SKU/selling-unit prices in integer centavos, listing fees, rebates and logistics allowances in centavos or basis points. New proposals are explicitly sample SAP change requests, not locally authored production financial masters.

Contract uploads (up to 450 KB) are captured atomically with the proposal in `mt_term_documents`, not as artificial POs. They retain exact bytes and SHA-256; office readers download only after the full terms scope is rechecked. The database refuses updates/deletion. The shared byte codec also handles PO originals.

Workflow: draft → submit → independent approve/reject. The requester cannot approve their own conditions. PostgreSQL excludes overlapping approved terms at the same account level/key. A separate approver can schedule a future end to an approved sample version before approving its replacement. Previously captured order prices remain unchanged. The web puts commercial allowances first and collapses the longer SKU price list.

`orders/pricing.js:resolvePrice` calls the MT condition adapter first for a bound account: branch → banner → account, using only approved and effective conditions. For a shared accounting customer, the canonical order quote supplies its outlet context to resolve the right branch; missing or mismatched branch context fails closed. Ambiguity, an unavailable SAP adapter or a missing account price fails closed; a generic channel list cannot silently override an account contract. Unbound accounts retain the existing channel/default resolver. Approved sample conditions use the local mock-SAP adapter, retain explicit sample provenance and never claim real SAP authorization. SAP-sourced rows return unavailable until the SAP owner's adapter is connected.

MT credit is deliberately unknown until the SAP credit-call seam is connected. Locally captured open orders are not certified as SAP AR or available credit. This lane does not post money, issue credit memos, alter stock value, or create a settlement ledger.

## F-309 — deductions, claims and follow-up

Which deductions are overdue or unlinked, who owns them, and what action is next?

A remittance records its accounting reference, account branch, receipt date, gross amount, cash received and positive deduction lines. Cash + deductions must reconcile exactly to gross centavos. An invoice link must belong to the same branch. Effective-dated, editable deduction types carry the follow-up SLA; each deduction freezes its owner and due date. Owners must be active and within the office user's area.

The queue shows open amount, past-SLA count (target zero), missing claim/dispute count, owner, age, due date, claim and invoice references, dispute details, next actions and append-only work history. The eight weekly receipt-value buckets compare the last 28 days with the prior 28 days. They are explicitly not a reconstruction of historical open balances. Dates/ageing use Manila. Office CSV exports are BOM/RFC-4180 quoted and formula-prefix protected, omit raw IDs, and export the already authorized visible projection; printing uses the same visible data.

Office encoders capture, classify, link and assign. Approvers independently respond to customer disputes and resolve cases; open disputes must receive a response before resolution. Accepting a dispute leaves it under review, says that SAP settlement review is pending, and does not create a credit memo or let the customer duplicate an accepted dispute. Full W5 claims/settlement can extend these records rather than replacing them.

## F-611 — external customer portal

Customer entry: `/portal/login`; account view: `/portal`. This is a minimal layout inside the existing Next app, not an employee dashboard or a new application.

The explicit `external_customer` identity type is an effective-dated `mt_portal_memberships` record against the existing login user, with no employee profile or office capabilities. Every portal request rechecks the session, user status, current membership and current effective account path. Queued writes reload the office actor after the workflow lock, and portal checks use a fresh PostgreSQL wall-clock instant rather than the transaction-start clock, so withdrawal or expiry while waiting cannot authorize a stale command. Scope is chain, banner or branch. Customers see only their own PO milestones, customer-safe canonical order facts, SAP invoice replicas, deduction summaries and their account's disputes/responses. Internal owners, generic audit payloads, original documents and employee APIs are not exposed.

The delivery boundary reads `mt_delivery_status_replicas`: a customer-safe feed projection, not a scheduling/drop/ePOD writer. Sample feed milestones are explicitly labeled invented demonstration data. An absent feed says delivery status has not been received; a canonical accounting `fulfilled` state is not relabeled as physical delivery proof. The CALLFLOW/delivery owner should replace this reader with the canonical customer-safe drop projection at integration.

Customers submit a referenced deduction dispute; the server checks that exact deduction against the membership before replay as well as before insertion. A different chain cannot submit against a guessed deduction ID. Office responses are read back through the same account projection. Accepted disputes await SAP settlement review, rather than silently disappearing or becoming a local credit memo.

Portal HTML/RSC and `/api/v1/portal/*` / `/api/v1/mt/*` are excluded from the production service worker's data/page caches. A refused refresh hides retained in-memory portal data. Session changes retain the existing global cache clearing. Employee PWA/offline behavior outside these new financial surfaces is unchanged.

## F-305 / F-307 / F-611 — integration seams

- MASTERS: `mt/hierarchy.js` reads effective adapter bindings (`account_key`, `banner_key`, `branch_key`, canonical customer/outlet IDs). These are temporary upstream mappings, not a second chain/banner/branch master and never the employee organization tree. Replace with F-305's canonical current path; preserve existing PO/order identities. Current versioned bindings are fail-closed: expired bindings do not grant access to their historical documents. Integrating the canonical stable hierarchy must preserve authorized historical visibility without restoring transferred-account access.
- SAP: `mt/sap.js:sapConditionPrice` / `resolveAccountCredit` and the invoice replica feed. Connect the SAP lane's actual mock-service contract and later production configuration. Never turn local sample data into production authority.
- CALLFLOW/delivery: `mt/delivery.js:deliveryStatus` supplies read-only milestones. Replace with the shared delivery engine's projection. No alternate flow or native app was created.
- W5 TPM: reuse `mt_deductions` / `mt_disputes` for the thin W3 slice. F-611 does not wait for the later F-509 implementation; financial settlement stays outside this slice.

## F-306 / F-307 / F-309 / F-611 — schema, seed and HTTP contracts

Migrations: `0490_modern_trade.sql`, `0491_mt_po_identity.sql`, `0492_mt_delivery_replica.sql`, `0493_mt_contract_originals.sql`, `0494_mt_validated_price_preview.sql`. Existing migrations and the lead-owned architecture contracts are unchanged.

Office reads: `GET /api/v1/mt/options`, `/intake[?id]`, `/intake/document?id=…`, `/terms`, `/terms/document?id=…`, `/deductions`, `/settings`. Collection views fail explicitly at their supported bounds, rather than claim a truncated list is complete.

Office commands, all requiring a stable `idempotencyKey`:

- `POST /api/v1/mt/intake/preview` `{bindingId, filename, format, contentBase64}` → `{id,duplicate}`.
- `POST /api/v1/mt/intake/fix` `{id,revision,poNumber,serviceDate,lines:[{productCode,uom,quantity,requestedPriceCentavos|null}]}` → `{id,revision}`.
- `POST /api/v1/mt/intake/confirm` `{id,revision}` → `{id,orderId,orderNumber}`.
- `POST /api/v1/mt/terms/save` `{name,scopeKind,scopeKey,effectiveFrom,effectiveTo?,conditions:[{kind,productCode?,uom?,amountCentavos?|rateBps?}],attachment?:{filename,contentBase64},contractDocumentId?}` → `{id}`. Submit/approve/reject take `{id,note?}`; end takes `{id,effectiveTo,note}`.
- `POST /api/v1/mt/remittances/capture` `{bindingId,reference,receivedOn,grossCentavos,paidCentavos,deductions:[{typeId,invoiceId?,amountCentavos,claimReference?,ownerProfileId?}]}` → `{id}`.
- `POST /api/v1/mt/deductions/update` `{id,ownerProfileId?,typeId?,claimReference?,note,resolve?}` → `{id}`.
- `POST /api/v1/mt/disputes/respond` `{id,deductionId,status:'accepted'|'rejected',response}` → `{id}`.
- Settings commands: `/settings/parser`, `/settings/deduction-type`, `/bindings/save`, `/portal/access`, with effective periods and explicit scope validation.

Portal reads: `GET /api/v1/portal/session` → external type/name/authorized branches; `GET /api/v1/portal/overview` → `{purchaseOrders,invoices,deductions}`. Portal command: `POST /api/v1/portal/disputes/submit` `{deductionId,reference,message,idempotencyKey}` → `{id}`.

`seed/modern-trade.js:seedModernTrade` adds marked sample branches, terms, PO documents/normalized lines linked to existing canonical orders, invoices, deduction types, remittances/deductions and mock delivery feed events. The existing seed/daily CLI calls it additively; no reset is used. It has its own `sunpride-mt-v1` ownership batch and refuses to overwrite existing business data.

`bun packages/db/seed/portal-accounts.js [private-record-path] [handout-path]` creates two sample customer chains using a database-keyed 0600 record, like employee trial accounts. Re-runs preserve passwords and mark tester-changed credentials instead of resetting them. Default outputs are `~/.sunpride-keys/mt-portal-accounts.json` and `~/Downloads/sunpride-customer-portal-accounts.txt`. Passwords never go to stdout or the repository. Lane proof uses separate private scratch outputs.

## F-306 / F-307 / F-309 / F-611 — Needs Sunpride

No client input blocked implementation. These are assumptions to refine, not claims about current Sunpride operations:

- Real retailer files, mapping rules, EDI standard, mailbox/portal access and approved OCR provider. The sample EDI-like and structured-email formats are our explicit defaults. The W3 80%-of-MT-volume automation gate still needs account coverage and production-volume measurement.
- Canonical chain/banner/branch SAP keys, especially shared accounting customers and authorized historic access after hierarchy changes.
- Approved SAP condition/credit/invoice interfaces and final commercial contract values, UOM keys, rebates/allowances, VAT and settlement rules. Sample conditions are invented.
- Final deduction taxonomy, SLA/ownership rules and authority for accepting claims. The editable sample default is a seven-day delivery-shortage follow-up, not Sunpride policy.
- Production customer invitations and the real delivery/status feed. Local proof does not establish live retailer, OCR, real SAP, physical delivery, ePOD or financial settlement acceptance.

## F-307 / F-611 — iOS parity later and bonus preservation

No iOS or Android source/binary was changed. iOS remains paused. Existing field/van bundle pricing still uses the shared resolver; canonical master-path and pricing-manifest wiring belong in integration before native account-condition parity is claimed. There is no new MT native call flow.

Live map, cockpit, issue board, trial accounts, biometric sign-in, password change, docs and non-MT office PWA behavior remain. The only deliberate bonus adjustment is withholding offline caching for new customer/MT financial surfaces, to preserve strict customer isolation.
