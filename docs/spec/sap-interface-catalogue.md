# SAP interface catalogue v1 — F-001 / BB-01

## F-001 authority and certification

This is our executable proposed contract, not a signed Sunpride/SAP interface agreement. The client's Phase 1 feature list and delivery deck p34 supersede the earlier locally authoritative pricing/credit/valuation design. SAP owns financial facts; the platform stores operational intent, immutable posting instructions and attributed replicas. The local SAP service is explicitly SAMPLE, not a production SAP implementation. All v1 JSON Schemas and runtime validation are in `packages/integration-contracts/sap/v1/`.

One gateway, `apps/api/src/domains/integration`, mediates every channel. Real SAP needs an adapter exposing the same contract and certified mappings; switching an origin alone cannot make an arbitrary SAP OData installation speak this contract. No browser/device receives SAP credentials.

## F-001 interface inventory and field mapping

All instants are epoch milliseconds, known money is exact integer PHP centavos, quantity is exact integer scaled base units. SAP-valued goods movements, return credit instructions and settlements use explicit null amounts when the financial amount is not yet known, never a manufactured zero or a sum that includes voided invoices. Product `quantityScale` defines scaling. A pack numerator/denominator always converts that pack to BASE; `parentUom` describes hierarchy, not a second conversion. No binary floating-point money crosses this interface.

| Direction relative to SAP | Interface / mock path              | Schema                         | Authority / mapping                                                                                                                                               |
| ------------------------- | ---------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbound                  | GET `/v1/masters/material`         | material                       | SAP material key/version → product code, name, category, base UOM, exact packs, barcodes, tracking, shelf-life days, storage condition, active status             |
| Outbound                  | GET `/v1/masters/condition`        | condition                      | SAP condition key/version → product/UOM, customer or channel or base applicability, precedence, PHP minor-unit price, tax code/rate/inclusion, validity           |
| Outbound                  | GET `/v1/masters/customer`         | customer                       | SAP customer key/version → accounting customer; no inferred organizational grant                                                                                  |
| Outbound                  | GET `/v1/masters/outlet`           | outlet                         | SAP outlet/customer key → existing physical outlet display fields; does not create an unsurveyed outlet or grant access                                           |
| Outbound                  | GET `/v1/masters/ar`               | ar                             | SAP open-item document/customer, due instant and remaining amount; never a new local AR ledger                                                                    |
| Outbound                  | GET `/v1/masters/location`         | location                       | local depot/truck code → SAP plant/storage-location, active status and provenance                                                                                 |
| Outbound                  | GET `/v1/masters/stock`            | stock                          | material × location → SAP on-hand/reserved quantity and authoritative value/cost snapshot; local quantity is not overwritten                                      |
| Inbound                   | POST `/v1/postings/order`          | order                          | local order ID/number and frozen priced/taxed lines → SAP sales order document                                                                                    |
| Inbound                   | POST `/v1/postings/invoice`        | invoice                        | frozen van sale/receipt/price/tax/customer/line facts → SAP billing document; does not assert a BIR permit                                                        |
| Inbound                   | POST `/v1/postings/payment`        | payment                        | captured tender, reference, amount, sale/return link → SAP incoming payment/refund instruction; account credit is not a cash receipt                              |
| Inbound                   | POST `/v1/postings/goods_movement` | goods_movement                 | canonical movement/line/allocation/lot/source/destination facts → SAP material document; valuation remains SAP's                                                  |
| Synchronous               | POST `/v1/credit/check`            | credit-request / credit-result | account + amount + currency + stable request ID + explicit reserve flag → status/exposure/limit, opaque decision token and expiry                                 |
| Inbound                   | POST `/v1/postings/credit_memo`    | credit_memo                    | original sale and captured return/UOM/reason/batch/disposition facts → SAP credit memo request; SAP determines financial credit, not a local zero-value assertion |
| Inbound                   | POST `/v1/postings/settlement`     | settlement                     | trip, counts, tender totals, exact sale/payment references and frozen close manifest → SAP settlement document                                                    |
| Reconciliation            | GET `/v1/postings/:effectId`       | posting-result                 | lookup immutable external transaction key after uncertain sends; same key is retained forever                                                                     |

SAP document types, movement codes, GLs, company codes, plants, storage locations and tax codes need SAP-team certification. `SAMPLE-*` document numbers and `SAMPLE-VAT12` are invented. Required business line detail is frozen in typed common fields plus interface-specific `document.facts`; an SAP adapter must validate its required mappings before accepting the request.

## F-003 identity, pagination, versions and deletion

Master envelopes contain schemaVersion=1, organizationId, kind, SAP key, monotonically increasing source version, source (`sample` or `sap`), effectiveFrom/effectiveTo, deleted, and typed data. The feed is an append-only change stream. `after` is an opaque durable watermark; response `items` has at most 100, `nextCursor` requests another page, and `watermark` also advances the final/empty page. Persist watermark only after every delivered record is durably received (including rejected records). Equal key/version/bytes is a no-op; equal key/version/changed bytes is quarantined. Older versions never overwrite current facts. Source tombstones and future validity remain in retained history. Incompatible posted UOM changes are rejected rather than retroactively changing receipts or allocations.

Posting envelopes carry schemaVersion=1, kind, effectId, correlationId and immutable document facts. Default effect ID is `kind:sourceType:sourceId`; callers must never generate a new effect ID to recover a timeout. Canonical SHA-256 hashes bind complete requests. SAP must enforce unique effect ID + exact hash, retain the prior response and support lookup by that ID. Changed input under an existing effect key is a conflict, never a second document. A successful result echoes effect ID, correlation and request hash plus SAP document number, postedAt and source. Gateway rejects mismatched acknowledgements.

## F-002/F-003 delivery and errors

Gateway inbox/outbox is the existing Postgres `integration_events`, not the legacy connector's SQLite ledger. Business writer + outbox INSERT share the same transaction. Workers claim with row locks/SKIP LOCKED and fenced UUID leases, heartbeat every 10s, lease 30s. An expired claim can be taken over; a stale worker cannot acknowledge or heartbeat another worker's claim. SAP lookup precedes POST on every attempt.

F-119 dependency identities are immutable queue metadata. Payments wait for their invoice; return/void refunds wait for their credit instruction, and settlement waits for the trip's preceding instructions. A failed or missing parent holds dependents for resolution rather than posting out of sequence. Approved sale voids create a separately linked credit instruction; they never erase an accepted invoice. The mock refuses goods movements for unmapped/inactive depots or vans; publishing the missing SAP mapping allows exact replay without changing the instruction.

F-015/F-016 mock and real SAP modes both refuse the legacy local master/price editors. Source changes enter through the SAP feed, not a browser-authored replica upload. Sample source maintenance is only on the protected loopback mock controls.

Timeout/connection/5xx are `transport`; 429 is `throttle`. Backoff is 1s, 2s, 4s, 8s, capped at 5 min; fifth unsuccessful attempt is dead letter. 422 business rejection, 409 hash conflict, invalid response/schema and authentication/configuration failures go directly to operator review. No raw remote response, credential or URL is logged. Retried bytes and effect identity never change. A successful SAP result and local document-number update are committed atomically. A failure after SAP acceptance but before local acknowledgement is recovered by lookup.

The current queue is a transactional operational instruction journal. Existing quantity/value ledger columns are retained for historical operational reconciliation; management stock value reads `sap_value_minor`, never the locally rolling estimate. Missing SAP value is unknown, not zero.

## F-112/F-404 credit semantics

Both existing and projected exposure are SAP response fields. The stable `creditCheck` seam copies SAP's projected exposure; it never sums local orders/AR or adds the requested amount itself. Confirmation snapshots retain SAP's committed exposure.

F-016 a positive-tax, tax-exclusive condition is retained with provenance but is not a complete selling amount. Resolution reports `sap_tax_quote_required` instead of certifying credit on its net subtotal. The SAP adapter must publish the complete tax-inclusive selling quote; no local tax engine is introduced. The marked demo uses inclusive example prices.

Quotes call SAP without reservation; confirmation calls with `reserve:true` and a stable document-bound request ID. A decision is usable only for the exact customer, complete amount, currency and source document while live. Confirmation binds its local decision row to the order/van sale. Local order totals are never substituted for SAP exposure. An unknown or expired SAP decision blocks financial confirmation; offline capture remains pending. A cached snapshot is labelled stale/unknown and cannot approve new credit. A credit exception request is a request for independent FISCAL/SAP handling, not a locally fabricated financial approval.

## F-001/F-005 running and failure controls

Start the mock with `bun apps/sap-mock/src/server.js` (127.0.0.1:4435); store its SQLite path via `SAP_MOCK_DB` outside the repo. It defaults to a small marked sample master/account set. `/control/masters` accepts a bounded versioned fixture batch; `/control/credit` sets a sample exposure/limit. These are loopback-only mock operations and never production gateway routes. Set `SAP_MOCK_TOKEN` to protect them from other local clients; match it with API `SAP_TOKEN`.

POST `/control/fault` with target (posting kind, master kind, `check`, or `all`), mode (`fail`, `slow`, `reject`, `accept_drop`, `none`), count and delayMs. `accept_drop` commits the SAP receipt and returns 503: it is deliberately the ambiguous accepted-send window. `/control/receipts` is a readback for sample acceptance. A process kill with persistent SQLite preserves receipts and master feed. The gateway console is `/sap-integration` (enable beta feature `integration`); retry/reassign/escalate require integration management and national scope. The complete immutable resolution history and changed-payload quarantine are inspectable without exposing raw business payloads.

## F-001/F-015/F-016/F-101/F-112 Needs Sunpride

SAMPLE material/customer codes, 12% inclusive example tax, 365-day default shelf life, ambient/frozen example storage text, plant/storage mappings, account limits/exposure and document series are invented source fixtures. They are not observations of Sunpride's operations. Replace them at the SAP source and ingest a new effective-dated version; do not edit the replica or regenerate an already posted instruction. The sample bridge copies current demo amounts so existing order control totals remain unchanged.

SAP/IT must certify production interface paths, authentication, company/document/movement/GL/tax mappings, condition precedence/UOM semantics, reservation expiry/cancellation treatment and reconciliation. Controller must certify credit exceptions, returns, valuation and settlement treatment. These are production sign-offs, not blockers to the working marked mock. FISCAL's independent approval request is an integration seam; the fallback never grants credit. Android master-subscription/offline exposure presentation and the physical SIM-out route proof remain integration work, not proof supplied by this server catalogue.
