# F-501–F-511 · Trade promotions, claims and incentives

## F-501 · Owner question and delivery slices

Which campaigns are earning their budget, which claims are unsupported, and which money has SAP actually acknowledged?

The thin W3 campaign slice landed first (stable campaign identity, effective versions, scope and execution checklist). The basic W4 eligibility slice uses the same master. W5 adds integer-centavo budgets and serialized commitments, expected base-unit volume and expected ROI, richer schemes and financial workflows. No parallel campaign, claim, order or mobile call-flow engine is introduced.

Campaign versions cannot overlap. Changes create a prospective version and preserve the stable campaign identity. A budget cannot be lowered below existing commitments. Commitment reservation locks the campaign master so simultaneous requests cannot exceed its budget. Accepted monetary benefits reserve budget in the source order approval transaction. Reservations remain conservative after a source reversal; automatic budget-release accounting is not implemented.

## F-502 · One scheme engine, wire version 1

Authority: `apps/api/src/domains/tpm/engine.js`. The old orders pricing exports delegate to it. The old single-best-candidate evaluator was removed.

Supported mechanics: slabs, combos/bundles, BOGO/buy-X-get-Y, free goods, percentage off, value off, quantity off and basket thresholds. Quantities use explicit selling UOMs and up to three decimal places; required blocks and gifted quantities are positive whole selling units. Catalog conversion remains with the existing UOM resolver.

Evaluation order is ascending precedence, then ordinal code order (not locale-specific order). A scheme declares exclusive or residual-net stacking, an optional mutually exclusive group and explicit excluded scheme codes. Campaign and scheme scopes are ANDed; one cannot widen the other. Percentage rounding is half-up at the centavo. Proportional line allocation uses integer arithmetic and distributes remaining centavos in input-line order. Duplicate product/UOM input lines, unknown engine versions and overflow are refused. Unknown prices never become zero-priced baskets.

`benefit_timing=on_invoice` grants the benefit once on the invoice. `claimable` retains the invoice amount, freezes the separately earned monetary rebate and posts its liability after order acceptance. Deferred and immediate monetary benefits consume residual economic value in the same precedence order, but only immediate discounts reduce invoice line totals. An immediate discount is never accrued as a second payable claim. Deferred free goods are refused until SAP provides governed valuation; their accounting is not silently valued at zero.

Conformance vectors: `packages/domain-contracts/fixtures/tpm/engine-v1.json`. JS tests consume the JSON directly. Field Android and van Kotlin evaluators must adopt these vectors after CALLFLOW integration, including claimable benefits, eligibility facts, stack allocation and exact server re-evaluation. This lane changes no native binaries, sync DTOs or van acceptance rules. The current van server still refuses advanced promotion payloads; this is explicitly unfinished cross-channel adoption, not full F-502 completion.

## F-503 · Eligibility and canonical facts

Six dimensions: outlet, outlet class, channel, territory, geography and distributor, plus effective campaign/scheme periods and optional price-list binding. Includes across dimensions are conjunctive; exclusions always win. A required missing fact denies eligibility. Campaign and scheme scopes are evaluated separately, never merged by overwriting a dimension.

The normal order quote derives outlet/channel/class/territory from authorized persisted records. A caller cannot assert another outlet's classification or owner. `readEligibilityFacts` is the MASTERS/DISTRIBUTOR adapter for canonical class, geography and verified distributor membership. Until wired, missing distributor/geography facts deny restricted schemes. No outlet means a national simulator, not a partner-scope bypass. Outlet inclusion/exclusion and territory selectors display business names in the web editor.

## F-504 · Accrual, reversals and SAP liability reconciliation

Only accepted canonical orders earn deferred rebates. The source is the immutable pricing snapshot; there is no public API accepting a caller's earned amount. Source keys bind order and promotion, and source hashes prevent changed-content replay. The order approval transaction reserves budget, writes an earning and stages a posting instruction atomically. Order voids reverse earnings; a related reserved/approved/settled claim blocks reversal pending Finance reconciliation.

`tpm_posting_instructions` is operational handoff staging, not a financial ledger. Posting payloads retain `sourceMode: sample|operational` from canonical campaign/promotion/claim-type provenance; SAP adapters must refuse sample-mode instructions on a real financial connection. `enqueueSapPosting` hands the instruction to the SAP lane's outbox. Without it the instruction is visibly `awaiting_seam`; nothing pretends SAP accepted it. The trusted SAP inbox calls `applySapAcknowledgement`. Acknowledgements are idempotent, append an audit record and publish `tpm` after transaction commit.

The liability reader distinguishes operational earned exposure from acknowledged SAP accruals/reversals/releases. An unacknowledged accrual has unknown SAP-open liability. A payment or credit-memo acknowledgement issues a separate release instruction; open SAP liability does not fall until that release is itself acknowledged. Rejected settlement instructions permit a new corrected settlement intent, never rewriting a prior acknowledgement.

Not implemented: valuation/accrual of free goods, automatic source-return quantities, a periodic SAP-ledger reconciliation import, automated recognition/GL/tax mapping, or automatic budget reservation release after reversals.

## F-505 · Shared claims ownership and intake

This lane owns the additive `claims`, `claim_types`, `claim_evidence`, `claim_events`, validation and settlement tables because no F-409/F-309 shared claims object exists on the lane base. Distributor, modern trade and agency are claimant dimensions on ONE object, not separate financial modules. The intake captures reference, type version, claimant, period, amount/currency, optional campaign/earning and outlet. The selected effective type freezes its evidence policy reference. All commands use actor-scoped idempotency and reauthorize before replay.

DISTRIBUTOR consumes `submitClaim` / `claimantClaims` through an effective `authorizeClaimant` membership adapter. MT consumes the same claim IDs and `captureDeduction`; it must not copy these tables or create a second settlement lifecycle. Until membership adapters land, portal operations fail closed to the existing national office boundary. Claimant-filtered list and notification API routes are available, but the distributor/MT/agency portal mounts remain integration work.

## F-506 · Evidence validation

Photo and campaign-checklist readers query the canonical captured sources. Photos must reference stored, digest-matching files, not a supplied URL. Checklist matching uses the actual audit capture instant, not the day's midnight. External POSM, secondary-sale, attendance and document proof must come from each domain's trusted `readEvidence` adapter; caller-entered evidence assertions are never accepted as verified source facts.

Evidence must match the claimed period and outlet, any supplied campaign and claimant facts. Monetary external proof must identify its claimant party and type. An immutable fingerprint prevents the same proof being used on another claim. Required evidence is checked by the frozen type policy, campaign execution must match the claimed campaign, and value must fit the unclaimed earning or authoritative monetary source. Earning locking prevents concurrent claims from over-allocating it. Approval reruns validation and compares the content hash. Evidence, events, and validation runs are append-only; only explicitly sample-marked rows can be deleted by the guarded sample reset path.

The current reader matches captured records and provenance; it does not visually certify what a photo depicts. Source-line quantities, complete POSM/secondary/agency feeds and governed validation overrides are still integration work.

## F-507 · Approval, settlement and claimant notices

Claim approval uses an effective party/value-band rule, existing capabilities, national scope and no self-approval. Ambiguous overlapping bands fail closed. Claim approval is separate from FISCAL's transaction discount authority. Evidence is validated before independent approval. Partial credit-memo/payment instructions cannot exceed approved value, including other pending settlement instructions. Claim settlement status changes only on trusted SAP acknowledgement; rejection does not masquerade as payment.

Lifecycle events create claimant inbox notices. `GET /api/v1/tpm/notifications` is party-authorized through the membership seam. Email/push delivery and an existing portal's notification UI are not implemented here. Policy retirement is prospective; replacements do not rewrite old claim facts.

## F-508 · Directional ROI and uplift

Immutable evaluations freeze baseline method, promoted/control-period volume, SAP margin provenance, metric-definition version, campaign/account/mechanic and earned spend. Uplift is incremental volume over baseline. Gross ROI is incremental margin divided by cost; net ROI subtracts cost before dividing. Zero baseline/spend remains unknown, and negative uplift remains negative. Evaluations are explicitly directional, matching the client's short-history caveat. Source-key/hash replay cannot silently overwrite a prior result.

`readPromotionPerformance` supplies the conformed baseline/volume/SAP margin projection. Without it a new evaluation is refused, not filled with zeroes. Sample-marked synthetic evaluations are persisted for the demonstration. A close-plus-30-day recurring report job and live account/mechanic aggregation across evaluations remain unfinished.

## F-509 · Deduction and dispute control

One shared `deductions` object captures source, account, type, underlying invoice/remittance, optional claim link, opening/due date, amount and a mandatory active owner. Commands assign, dispute, record a bounded reconciled recovery and resolve fully recovered cases. Every decision appends an event. Ageing is calculated on Manila dates. MT F-309 should call `captureDeduction`, not maintain an independent deduction balance.

Recovery is operational tracking, not cash creation or a SAP write-off. Unrecovered write-offs cannot be closed through this API without the appropriate SAP treatment. Classification currently accepts an office-entered business label rather than a governed reason-code master.

## F-510 · Incentives, immutable source facts and adjustments

Effective plans configure weights, directions, caps and base awards for targets, coverage, distribution, availability, collection and settlement variance. All six governed actuals/positive targets and definition versions are required. Calculations freeze line explanations, source keys/hashes and original facts. Recalculation with changed facts refuses rather than rewriting a statement. An independent approver decides a statement, and adjustments need a separate authorized approver, cannot go negative, and retain their reasons. A disputed statement can be independently reconsidered. No payroll or bank payment is executed.

`readIncentiveMetrics` belongs to the governed KPI owner (TOWER, with COVERAGE/AVAILABILITY/VANOPS inputs). Missing feeds fail closed. The seed includes a clearly fictional balanced plan and statement. The Finance web screen reads explanations and can request a source-backed calculation; native rep/DSR statements, complete adjustment UI and payout integration remain later work.

## F-511 · Fiscal authority seam

`requestOverride(ctx, exactQuoteFacts)` is FISCAL-owned. Governed campaign quotes fail closed unless the adapter returns `status: authorized`. The facts include channel/outlet, subtotal/total and the full applied campaign benefits. No second discount authority matrix was built. Existing unlinked legacy schemes keep their prior access behavior; enforcement across legacy office orders and all native/distributor paths remains FISCAL/CALLFLOW integration work.

## F-501–F-511 · Web and sample data

`/trade-promotions` mounts Trade Marketing in Setup. `/finance-claims` mounts Claims & Finance under Work. Existing pages and bonus features remain. The pages show budget commitments, prior-period claim intake, a trend, labelled campaign/claim drill, evidence/approval next actions, open liability reconciliation, deduction owners/ageing, directional ROI and incentive explanations. Read-only roles do not receive write controls. National boundary restrictions are enforced server-side.

Seed extension: `packages/db/seed/tpm.js`, called by the initial seed and daily advance. Existing companies receive additive sample-marked rows without a reset. There are three sample campaigns, inactive illustrative schemes (so live demo order prices do not unexpectedly change), three cross-channel claims needing evidence, assigned deductions, synthetic ROI evaluations and one provisional incentive plan/statement. Sample-only reset preserves external dependencies and immutable production history.

## F-501–F-511 · Needs Sunpride

These do not block sample software delivery: ratify recognition and liability treatment, GL/tax/valuation mappings, claim types and evidence policy, actual approval/value bands, scheme stacking/exclusion rules, budgets and volume targets, baselines and margin source, distributor/agency identities and incentive/HR compensation policy. Current settings/data are our labelled provisional defaults, not observations of Sunpride's actual practice.

## F-502/F-503/F-506/F-510 · iOS parity later

iOS is paused and unchanged. Later work adopts engine-v1 vectors and immutable offline bundles, typed eligibility/exclusion explanations, campaign execution references, governed claim proof links and earned incentive statements. Android field and van adoption must follow CALLFLOW first; no device proof or release APK is claimed for this lane.
