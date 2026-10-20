# F-601–F-610 · Commercial control tower

## F-601 · Design authority and source identity

This extends `domains/analytics` and the existing Today, Sales, Coverage, Stores, Stock and Decide cockpit. There is no second dashboard, order writer, inventory ledger, call-flow engine or fraud detector.

`analytics_sales_facts` remains the sole ordinary-order sales definition. A line uses its captured `orders.outlet_id`, otherwise its captured source activity's outlet. Only legacy orders with exactly one currently linked outlet may use an accounting-account fallback. Ambiguous legacy account sales remain unattributed; they never choose the first outlet. Current creator, outlet-owner and source-location authorization still gate historical reads and exports. A captured outlet takes precedence even if its current accounting account has changed.

The conformed commercial fact exposes source line, source revision, outlet/product/rep/Manila-date keys, effective event-time territory and rep assignment versions, captured outlet identity and attribution quality. Accounting customer is separate from outlet. `analytics_commercial_dimensions` supplies the six dimension kinds, including distributor references from source replicas. Effective historical assignment keys are preserved; ordinary master display labels are current unless a source document already froze them. The native van bridge continues to use its exact recorded outlet and frozen sale line facts.

Per-day `analytics_source_versions` invalidate cached sales on order/line insert, update, deletion or date correction. The cache builder holds ordered version locks while projecting; a concurrent writer either precedes that snapshot or invalidates it after commit. Reads compare small revision rows plus the existing current-master fingerprint. They do not scan every historical invoice line on each dashboard request. This preserves authorization and source-change checks rather than trading them for a TTL.

## F-602 · One availability definition

Owner question: which part of the validated outlet universe needs a call or a shelf correction?

`availability-adapter.js` is the local `SEAM(AVAILABILITY)` for F-220. Integration must replace its source/policy adapter with AVAILABILITY's governed reader, not retain two KPI engines.

- Universe: active, currently authorized outlets, not accounting customers.
- Covered: distinct outlets with completed executions; billed: outlets with positive included sales. These remain separate.
- Numeric distribution: outlets with fresh observed stocking of the SKU / validated outlet universe. Incomplete measurement yields an unknown certified percentage, with known stocking and unmeasured counts shown separately.
- Weighted distribution: the same stocking indicator weighted by effective total-outlet-turnover weights. Missing weights or incomplete observations yield unknown. Sunpride product purchases are not assumed to be total store turnover.
- OSA: fresh available/low-stock assigned MSL lines / all effective assigned MSL lines. An unobserved line is not silently removed from the denominator. Until every assigned line is measured, OSA is unknown and completeness is shown separately.
- Freshness is an effective-dated, office-editable policy. There is no hidden operational default when policy is absent. The sample policy is explicitly seven days. Marked sample MSLs and physical observations reuse canonical merchandising tables and only owned completed calls; no real range, call state or stock balance is changed. Incomplete real measurements remain unknown.
- Prior-period comparison, bounded weekly as-of snapshots, territory/person filters, outlet drills and next actions use the same reader.

Buying reach is retained under its own name in Products & stock; it is never labelled stocking distribution.

## F-603 · Primary versus secondary

Owner question: are primary shipments reaching retailers, or accumulating as trade stock?

`analytics_trade_inputs` is a source-replica boundary for `SEAM(SAP)`, `SEAM(DISTRIBUTOR)` and `SEAM(PROGRAMME)`. It does not create business invoices, declarations or campaigns. Each current replica row is unique by system/kind/source key; a source correction updates its revision rather than duplicating the financial fact. It carries effective date, received timestamp, captured quantity scale, source type, exact retailer outlet for secondary sales and original lineage. Frozen cuts retain the prior payload/revision while current authorization follows the current replica. The sample source is explicitly invented and covers all four sample territories/distributors. Marked outlet class/score context covers the sample store universe, with representative assets/incidents/review cases across areas.

The Sales page adds primary shipments, secondary invoice offtake, latest declared stock, DOI, comparisons, trends, distributor/SKU rows and channel/account contributions. Ordinary booked/approved/posted orders are not reclassified as SAP primary shipments. Missing primary, secondary, stock, UOM conversion or turnover facts stay unknown. DOI is declared base stock / observed secondary base-unit daily rate in the selected window; zero or absent offtake has no finite DOI. Stock declaration date is visible. Source quantities are normalized to the product's canonical quantity scale for base-volume/DOI comparisons. Case equivalents are converted per source line at its effective conversion, then summed; changing case packs cannot reuse the first line's factor. Original quantities/scales remain in lineage. Missing conversion makes that case measure unknown. This is an operational signal, never SAP inventory valuation.

Until partner membership/grants land, sales-role users receive no distributor financial replica data. The lead must wire DISTRIBUTOR's current partner authorization before exposing these records to partner users. Current org scope and, when present, current outlet owner are independently enforced today.

## F-604 · Outlet 360

Owner question: what should the next call to this exact outlet fix?

The existing store detail retains purchase/visit history, assortment, suggestions and account AR. It adds assigned-MSL completeness, coverage facts, class/potential context, provided perfect-store score, assets, incidents and competitor observations. Competitor evidence is read from the canonical merchandising source. `analytics_outlet_context` is a labelled read replica for `SEAM(MASTERS/PROGRAMME)`, not another asset or incident master. Every context record is effective-dated and independently org-scoped. AR is explicitly shared accounting-account debt, not an allocation of that debt to each linked outlet.

## F-605 · Published KPI catalogue (commercial/v1)

Owner question: which rep/team converts calls, does useful non-selling work and spends time in stores?

- Strike rate: completed calls with an accepted, persisted, call-linked ordinary order / all completed calls, including off-plan calls. A draft, rejected/voided order, unprocessed order intent, note, collection or merchandising record alone does not convert a call. Multiple orders still convert one call only.
- Productive-call percentage: existing governed objective-based productive planned calls / completed planned calls. Kept independently of strike rate. Off-plan work remains separate from MCP credit.
- Lines per call: accepted call-linked included order lines / all completed calls.
- Drop size: included net sales / included order count; same Sales definition.
- Dwell: sum of valid closed check-in/out intervals. Open, missing or negative intervals are unknown, never travel time. Market span remains a different measure.
- Stocking points gained: net present/absent change for matched fresh outlet/SKU observations attributed to the grouped reps. Unmeasured comparisons are unknown.
- Rank: selected-scope order conversion descending, then label; unknown conversion has no rank. Weekly conversion and productive-call trends remain distinct.

The existing native team summary continues to expose its productive-call figure as productivity; this lane does not relabel it as strike rate or change paused iOS/native binaries. `agent_daily_metrics.productive_pct` continues to store productive-call percentage, not the corrected conversion percentage.

## F-606 · Integrity surface only

Owner question: what evidence deserves independent review?

The Decide page adds a versioned integrity-signals table. `analytics_integrity_findings` is `SEAM(INTEGRITY)`'s read boundary: source key/revision, detector rule/version, severity, evidence, provided review status and review link. The tower implements no detector, guilt classification or disposition writer. Current outlet and person ownership are checked before a finding is returned. Fictional cases are visibly sample cases. Existing operational exceptions remain unchanged.

## F-607 · Demand handoff and lineage

Owner question: which exact version of sell-out, stock, distribution and promotion plans did Supply Chain receive?

`GET /api/v1/analytics/demand-signals` returns source-grained input, completeness and original lineage. `POST /api/v1/planning/demand-signals/prepare` freezes a cut, definition version, cutoff instant and content hash, with caller-scoped idempotency. Publication names a destination. A different authorized planning owner accepts/rejects the published version with an acknowledgement reference. List, snapshot read, publication and acknowledgement recheck current access to every retained commercial source line. Snapshots are not regenerated from changed live values. Snapshot and live exports are actual Excel workbooks.

This is a planning signal, not a model forecast and not evidence that real Supply Chain has adopted the feed. The default UI destination is explicitly a sample review inbox and is editable.

## F-608 · Personal subscriptions and development mail

Owner question: which current threshold breaches merit an interruption?

Personal subscriptions select an authorized team, missed calls / availability / open integrity signals, threshold, cooldown, in-app and email preferences. Rules are persisted, editable and effective-dated. Evaluation locks each subscription, deduplicates instances, enforces cooldown and atomically queues durable delivery. The scheduler evaluates every five minutes; a manual evaluation is available for the caller's own rules.

At delivery, the system reconstructs the active profile, disabled-user state, role, scope and current metric. A resolved breach, disabled rule or lost permission is suppressed before app or mail delivery. The in-app inbox checks current access again. Read acknowledgement is recipient-owned. The existing durable jobs worker supplies bounded retry/backoff; attempts are recorded without raw provider errors.

`devMailAdapter` is the default idempotent database mail sink. It sends no external email. A production adapter is injected at `installAlerts` and must honor alert ID as its provider idempotency key. Do not claim exactly-once external delivery without that provider guarantee. No paid service or mail credentials are required locally.

## F-601–F-608 · Real Excel export

The existing export tools now request `format=xlsx`; CSV remains supported as a bonus compatibility API, not the default workbook format. The header exports the main report using its measured period and resolved grouping, not different API defaults behind a URL preset; each add-on panel has its own Excel link for its complete authorized source view. The writer emits ZIP/OOXML with separate sheets for every page table, filters, freshness and definition metadata. Nested cockpit tables at every depth are separate sheets with workbook-local parent-row references and a full path-to-sheet index. ISO source dates and frozen planning status/content hash are retained. Long text is continued in numbered columns on Unicode-safe boundaries, never silently cut. Numeric values and booleans retain types; text is an inline string, never an Excel formula, macro or external link. Unicode/XML characters round-trip. Excel exports use the same server authorization and filters as JSON. Stores/Decide exports include all matching rows, not only the visible first page. Visible new tables page locally in groups of 50; workbook overflow fails explicitly above 100,000 rows per table, 16,384 columns or 2,000,000 cells.

## F-609 · Shelf AI preparation only

The machine-readable examples in `docs/spec/tower-ai-prep.json` describe the two annotation shapes, source dimensions and a received-after-cutoff exclusion. They are explicitly invented examples, not database rows or real shelf evidence. Real use must bind the nullable outlet/product references and apply the approved consent/retention policy.

`analytics_ai_dataset_items` reserves purpose, exact outlet/product/source reference, observed instant, consent reference, retention deadline, annotations and train/validation/temporal-holdout split. A shelf ground-truth annotation should identify SKU, facing count, planogram slot, occlusion, reviewer and reviewed instant. Retain original photo/evidence provenance; do not copy unconsented images into a dataset. Purge/retention operations must go through the future dataset owner, not silently bypass immutable field evidence.

No image inference, trained model, model quality score or automated facing claim ships here. Manual capture remains authoritative until an approved model and a representative real holdout pass business acceptance.

## F-610 · Ordering AI preparation only

Use event-time purchase/offtake quantities, observed/declared stock, assigned distribution, source promotion plans, Manila day/week/month/holiday seasonality and completeness/lag indicators. Retain source revisions and cutoff timestamps. Split temporally before feature computation, exclude facts received after the cutoff, compare against the existing deterministic rule baseline and report error/stockout/override metrics by channel and outlet class. Synthetic sample history tests plumbing only, never production lift. No training or serving pipeline is claimed.

## F-601–F-610 · Needs Sunpride

Ratify the fictional four-SKU MSLs, stocking freshness, total-outlet-turnover source, MSL completeness presentation, call denominator, conversion ranking and DOI window. Provide real source master IDs and partner grants, primary shipment/secondary invoice/stock interfaces, campaign plans, governed score/asset/incident readers, INTEGRITY review links, planning cadence/destination and Supply Chain acceptance owner. Choose an email provider only for production; the local sink already works. Confirm dataset consent/retention and supply representative labelled images/clean longitudinal history before AI work. None of these prevents the labelled sample software from operating.

## F-601–F-610 · Integration and iOS parity later

Apply additive 0520–0528 after this branch's base migrations. Migration 0525 unwraps only this lane's owned sample JSON representations and adds object-shape checks; it never resets or changes real/foreign source rows. Migration 0526 coalesces source invalidation per date/transaction; the projection boundary clears coalescing so a later source write in the same outer transaction invalidates the newly built cache. Migration 0527 uses statement transition sets to invalidate distinct old/new event days without per-line trigger overhead. Migration 0528 captures source quantity encoding and labels only our existing sample feed as whole-base-unit scale 1; raw quantities and amounts are preserved. Rebuild rolling sales caches after the attribution correction; reads fall back to current facts until verified. Source revisions add AFTER triggers to orders/lines and must remain alongside existing change-sequence triggers. Wire source adapters rather than introducing new transaction writers. Reconcile AVAILABILITY's F-220 policy and source contracts to this single reader; do not merge independent OSA/ND formulas. Wire INTEGRITY/PROGRAMME/DISTRIBUTOR/SAP replicas to current partner authorization and provide their real review links.

No Android or iOS binary is changed, built, installed or touched. The office PWA receives the web views. Native parity later needs explicit conversion/dwell labels, notification inbox/preferences and handoff/source-version contracts; iOS remains paused. Live map, PWA, issue board, biometrics, trial accounts, Decide and other bonus features remain.
