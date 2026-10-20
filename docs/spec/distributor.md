# F-401–F-416 Distributor portal and secondary sales

## F-402 Architecture and authorization

This is an extension of the existing Postgres/Bun API and Next.js web app, not another application. Office users open Work → Distributors; distributor accounts use `/distributor` with minimal partner-only chrome. Distributor sign-in always routes to that portal. `/account` remains available.

A distributor profile has no employee capabilities. Every read, write, private download, CSV export and signed sync projection resolves an effective `distributor_users` membership and its grants. Employee organization-tree access is not partner authorization. An office reader must separately have the integration capability in the distributor's supervising Sunpride unit. Command execution re-resolves the actor and authorization inside the transaction before idempotent replay. A distributor row lock serializes stock/credit confirmation and revisions.

`distributor_users` grants are `read`, `order`, `stock`, `secondary`, `claim`, `finance`, `documents`, `dsr` and `settlement`. Membership changes retire the profile scope epoch. A private leaf device unit isolates each partner from employees and other partners. An employee login cannot be adopted as a distributor login; a current distributor login cannot be assigned to a second partner.

Partner API reads are deliberately excluded from the shared PWA service-worker cache. This portal is online-only; it does not claim offline selling. Native work uses the signed shared sync system, not this web cache.

## F-401 Accreditation

An office administrator creates the supervising organization and invites its applicant. The partner submits its legal application and supporting documents. Another person validates required evidence and invokes the SAP-credit seam. The partner signs the exact latest published agreement hash; the office then requests the SAP business-partner code. The application is immutable after submission except for the controlled review transitions, and an accredited partner cannot resubmit itself into applicant status.

The sample accreditation/SAP acknowledgements are expressly fictional. An actual `source=sap` replica cannot manufacture a credit approval or SAP acknowledgement.

## F-402 Master synchronization

`master/sync` accepts an immutable full replica with source, source key, monotonic version, SHA-256 hash, effective window and received time. Products and outlets reference the existing shared universe. Scoped office writers must be authorized for the referenced current outlet/territory owners. There is no duplicate retailer master or inference from an accounting customer code.

Master fields include selling UOM, frozen pack definition, prices, available stock, terms, eligible promotion references and credit-replica facts. `priceListId`, when supplied, is the existing pricing engine's list reference. Retrying an identical version is stable; an altered or older version conflicts.

## F-403/F-404 Primary orders, credit and exposure

The portal quotes stock, prices and the existing promotion evaluator, then rechecks inside serialized confirmation. It writes the SAME `orders` and `order_lines` tables, extended with `purchasing_distributor_id`, partner PO reference, acknowledgement and promised delivery. There is no second order ledger. Pending commitments count against both stock and credit across master refreshes. Free goods also reserve stock.

`sapCreditCheck` and `enqueueSapPosting` are local SEAM(SAP) contracts awaiting the integration owner's mock/live adapter. Only explicitly sample-tagged masters simulate successful decisions; missing, stale and real-but-unconnected credit refuse confirmation. Sending remittance advice never reduces SAP-authoritative debt.

## F-405 Stock declarations

A complete declaration covers every authorized SKU at every partner warehouse/van, including explicit zeros. Multiple batches and expiry dates are retained. A correction is a new numbered revision, never an edit to earlier quantities. The portal exposes batch rows and current stock in cases plus pieces; the system adapter accepts physical base quantities.

## F-406/F-412 Secondary capture and connector

CSV, flat JSON, nested distributor invoices and the DSR adapter stage the same invoice-line facts. Each line retains source bytes/fields, source ordinal, received time, explicit shared outlet, SKU, warehouse, invoice/line identity, revision, UOM, frozen pack and quantity. Mapping failures and rejected rows stay visible and can be reprocessed without rewriting raw input. Deduplication is independent of file/API adapter or file name.

Corrections require the next revision and the prior payload hash. Returns link to an unambiguous original sale for that retailer, use its frozen pack, and cannot exceed its unreturned quantity. Facts and declaration lines are append-only in the database.

Complete-feed periods must be explicitly declared and fully processed. Missing records are not evidence of zero sales. See [F-412 connector samples](distributor-connector-samples.md); downloadable fictional CSV and JSON live at `/samples/distributors/secondary-sales.csv` and `/samples/distributors/secondary-invoices.json`.

## F-407 Shared call-flow server contract

`callflow-config` and the signed `distributor.bundle` projection expose partner grants, current shared outlets, the authorized selling catalog and bounded validity. Credit is omitted from the native bundle. Profile, membership, device status, bound subject, device scope and scope epoch are rechecked. Empty deltas conservatively require rebootstrap rather than silently renewing authorization. Lease expiry is capped by service-day close and membership expiry.

SEAM(CALLFLOW) consumes this configuration in its ONE engine. This lane does not install another visit writer or native app; `nativeReady` remains false until integration.

## F-408 Shared van settlement contract

`van-context` exposes only this distributor's owned van locations. SEAM(VANOPS) must bind those locations to the existing engine's partner-authorized loading and settlement operations. `ready` is deliberately false; no second settlement ledger or fake successful settlement is created. Executable settlement remains partial until that adapter is wired and proved.

## F-409/F-410 Claims and schemes

Claims require the configured type and minimum partner-owned evidence, with independent office review and visible tracking. Scheme eligibility references existing promotions with explicit distributor, channel and validity constraints. Benefits are evaluated by the shared `orders/pricing.js` evaluator, not a duplicate engine. Sample distributor promotions are bound to dedicated distributor-channel price lists so they cannot silently discount ordinary employee orders.

## F-411/F-413 Health and scorecard

DOI uses current declared stock and complete net-secondary-sales periods, with returns subtracted. Missing, stale, incomplete and zero-offtake conditions remain unknown rather than asserting a healthy stock position. Views include expiry exceptions, stock targets, prior-period comparison, daily trend, warehouse/batch drill-down and next actions.

The effective partner policy controls DOI/freshness/expiry bands, thresholds, scoring weights and the secondary-sales target. Scorecard inputs cover timeliness, outlet coverage, growth, stock, payment, infrastructure and manpower. Missing capability audit/source inputs remain incomplete. The lowest measured component is named and stock exceptions have a direct drill-down.

## F-414 Documents

Private PDF/PNG/JPEG documents are retained as immutable bytes with SHA-256, kind, version, publisher and receive time. Downloads reauthorize the partner. Read receipts bind actor and the exact document version/hash; publishing another version does not inherit an old acknowledgement. Office readers see the named receipt actors, not raw user IDs. The initial file cap is 600 KB.

## F-415 AR and remittance

AR is a versioned SAP replica. The portal shows ageing, credit/exposure, the statement, remittance advice, evidence, matching and disputes. Matching needs a different office reviewer. SAP acknowledgement is tracked separately from advice and matching; only refreshed SAP open items change debt.

## F-416 Reconciliation

The immutable bridge is opening + primary shipments/returns ± transfers/adjustments − net secondary = expected closing, compared to a complete closing declaration. Both primary and secondary period coverage are required. Variances use an editable tolerance. Reviewed explanations bind the exact bridge hash and become stale when its facts change. It is not labelled balanced merely because a feed is empty or absent.

## F-401/F-402/F-405/F-406/F-411/F-413/F-415/F-416 Sample data and operation

`seed/distributors.js` extends the existing marked sample seed and daily advance. It creates two fictional distributors, shared-universe grants, a warehouse and van each, channel prices/schemes, 56 days of explicit feed coverage, invoice lines, declarations, primary movements, a balanced example and a variance example, AR, documents and a capability audit. JSON is explicitly cast through text at the generic seed boundary to avoid doubly encoded JSONB. Rerunning adds no duplicates and never resets the live database.

Portal passwords are generated, never printed, and written to `~/.sunpride-keys/distributor-portal-logins.json` with mode 0600, partitioned by database name. Preserve this record across seeding; deleting it would rotate sample passwords on the next run. Isolated tests use their own scratch credential record instead.

Migrations are additive `0500`–`0507`. Run the ordinary migration/seed commands with the target database URL supplied privately. Lane tests use `SP_LANE=sdistributor` and the lane URL key; no showcase server or real device is touched.

## F-401–F-416 Needs Sunpride

These are our provisional, editable/sample defaults, not confirmed client policy:

- Net 30 payment terms and two-day delivery lead time; fictional prices, credit limit/ageing and a 5% sample scheme.
- 28-day DOI window; one-day declaration freshness; 30-day near-expiry band; 7/45-day under/overstock thresholds.
- Registration/tax/credit evidence; damage, promotion, freight and shortage claims with one evidence item minimum.
- Seven scorecard weights (15% each except manpower at 10%), the secondary target, 24-piece reconciliation tolerance and the sample capability audit.
- Actual distributor accreditation authority/agreement wording, legal documents, warehouse/van codes, sell-in and secondary connector mappings, source completeness semantics and settlement rules.
- SAP mock/live credentials and adapter wiring are integration work, not a reason to block delivery for client answers.

## F-407/F-408 iOS parity later

No native source or binary changes belong to this server/web-first lane. After the shared Android engine consumes partner configuration, iOS would need equivalent partner enrollment, authorized bundle bootstrap/lease renewal, shared call-flow configuration, owned-van settlement and offline recovery proofs. iOS remains paused.

## F-401–F-416 Integration seams and bonus features

The lead connects SEAM(SAP), SEAM(TPM), SEAM(CALLFLOW), SEAM(VANOPS) and SEAM(ORG), preserves the single domain-registry import/install, and runs the seed with the target database's private login record. The TPM seam currently reuses the existing basic evaluator; advanced TPM schemes stay with its owner. Do not enable a live `source=sap` confirmation path until its online credit/ack adapter is connected.

Existing owner dashboards, map, issue board, change password, trial accounts and ordinary employee PWA are retained. Only partner routes are excluded from PWA caching. The partner role is also added to the three existing role constraints needed by profiles/invitations/assignment history; it acquires no employee capabilities.
