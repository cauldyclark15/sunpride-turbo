# MERCH: merchandising and retail execution

## F-310: one execution-only call configuration

This is our implementation of the client's Phase 1 specification, not a statement about Sunpride's existing operating procedures or a deployment claim. The existing CALLFLOW engine remains authoritative. The sample `merchandiser` configuration uses check-in → availability → planogram → POSM → price check → competitor → issue log → freezer audit → expiry audit → campaign compliance → check-out. The requested core sequence is preserved; the extra audits are optional steps until the office chooses their requirements in the existing Call flows editor. No new app, visit engine, stock engine or order engine exists here.

The effective `MERCH` channel binding opts outlets into this configuration. Existing GT/MT profiles are unchanged. A merchandiser call refuses order-intent capture both in the local configured adapter and on the server. Job title is not a permission check. Existing availability and price activities remain adapters; MSL/OSA authority belongs to AVAILABILITY.

The Android visit form saves `retail.capture` templates in the existing SQLCipher intent/outbox transaction. Local photo references and the check-in reference resolve from durable server acknowledgements before push; unresolved media waits rather than dropping an audit. The stored local template stays unchanged. This is not a claim that server wire bytes or server IDs already exist at initial offline capture. The server rechecks visit ownership, current outlet access, capture time, media ownership and the configured engine before accepting the immutable observation.

## F-311 F-314 F-315: targets, equipment and frozen agreements

The effective-dated retail master registry stores planograms, POSM catalogues, cold policies, equipment agreements, scorecards, expiry policies and incident categories. Office publication creates a new immutable version and closes the prior interval. PostgreSQL exclusion constraints prevent overlapping versions, competing class planograms/scorecards, duplicate SKU expiry policies and duplicate serial/SAP fixed-asset registrations. Generated FK columns protect asset-to-outlet, asset-to-policy and expiry-to-product references. The history trigger compares stored authority fields, not PostgreSQL's unavailable BEFORE-trigger generated values.

Planograms are selected by current outlet class, with an explicit wildcard fallback. Captures freeze the applied target version, product-facing/position targets, actual counts and numeric shelf share. Missing products or inconsistent facing totals are refused. Position/facing and shelf-share attainment constrain the planogram component; over-facing cannot inflate it above 100.

The equipment register includes serial, model, SAP fixed-asset reference, deployment date, custodian, agreement, location and freezer/chiller type. Movement/agreement changes are effective new versions. Service/repair/reconciliation references append to the register; they do not create a second fixed-asset valuation ledger. A deployed agreement pins its cold-policy version: publishing a general replacement policy does not silently rewrite existing asset agreements. Publish an equipment/agreement revision to change that asset's agreed policy.

Android can enter an exact serial or scan it using CameraX and the same offline ZXing core version already used by the van app. Analysis is bounded and throttled; camera frames are not uploaded by the scanner. The audit records the serial, contents photo references, own-product share, deci-Celsius temperature, measurement time and the frozen equipment/policy facts. Purity or temperature breaches create a separate due follow-up case. A manual thermometer reading is not a connected-sensor attestation.

## F-313: POSM custody and recurring audit

A material catalogue version and a physical unit code identify distinct things. Office issue/return/write-off events and field deployment/audit observations preserve custody history. Deployment requires a real visit photo and current issue to that field person. Presence and condition must agree. Write-off requires a different approver. Reissuing a returned unit may adopt a newer version of the same material code without rewriting its prior history.

Current custody is resolved before filtering by store/person. Assignment uses effective employee history, not a stale profile unit. Closed employment does not erase a physical unit: national office can reconcile an orphaned custodian, while new assignments still require an active scoped person. The office register derives next audit due from the last audit/deployment and that unit's catalogue interval.

## F-316 F-318: explainable weekly account scores

Score policies contain all six weighted components: availability, planogram, POSM, price compliance, freezer purity and promotion execution. Weights sum to 100. Not-applicable is permitted only by policy and actual applicability facts. Every applicable deployed POSM unit and registered cold asset needs its own audit; one good asset cannot certify an unaudited second asset. Missing evidence is incomplete, never zero, perfect, or a free N/A.

Availability reads the existing canonical merchandising audit through `SEAM(AVAILABILITY)`. Expected shelf price uses the existing effective pricing resolver through `SEAM(SAP)`, with the source price-list reference and UOM. A phone-supplied compliant flag is not a governed price comparison. Legacy price observations lack a frozen UOM: a later product-master edit makes that comparison unknown rather than inventing historical pack facts.

`SEAM(TPM)` reads the exact `campaigns`/`campaign_versions` thin-master schema from the TPM branch and its include/exclude dimensions. Each field checklist freezes display, price, POSM, stock and the campaign's own checklist. A missing TPM relation or unresolved restricted geography/distributor fact remains unknown. It is not evidence that no campaign applies. The local adapter does not create another campaign master or edit TPM's tables.

The first server-accepted retail observation freezes the applied scorecard, class and channel for that visit; later reclassification cannot regrade its facts. A generated FK protects the pinned score policy during sample resets. Account/branch rollups compare the selected completed week with its prior week. Current outlet scope and each canonical source visit are checked independently, including stored publications. Office publication freezes a revision and content hash. Identical facts reuse the revision. A daily 00:15 Asia/Manila catch-up queues one account per transaction for the last completed week; the daily job key allows late facts to produce a new revision without duplicating unchanged results. The office screen separates the live preview from frozen publications and shows missing components and branch targets.

## F-317 F-320 F-321: field facts and action queues

Competitor observations have structured price/promotion/new-SKU/display/share-of-shelf forms. An explicit "none observed" is a recorded negative observation, not photographic proof. Expiry audits capture defined SKU, batch, real calendar expiry, base-unit quantity and evidence. SKU-specific near-expiry rules create pull-out or markdown cases before returns. Field incidents bind category, severity/SLA, outlet, visit, capture-time geo and photo references; the QA Issues board remains separate.

Office users can assign, approve/reject and resolve cases with append-only history. `SEAM(SAP)` must acknowledge a pull-out/markdown instruction before it can be resolved. The standalone adapter leaves it waiting for SAP. This lane does not post financial markdowns, credits, returns or inventory value; the lead must connect the canonical SAP/returns workflow.

## F-614: which outlets received a batch

The trace starts from a canonical lot, expands bounded descendant lots and reads linked component genealogy, explicit delivered-batch confirmations and canonical van-sale allocations. Confirmed physical receipt, sample confirmation and inferred FEFO allocation remain separately labelled. A voided source is retained as a trace fact, not silently erased. Unknown delivery sources are disclosed as incomplete, never reported as proof that no outlet received the lot.

Recall cases retain notices, acknowledgement, pickup/recovery and disposition references. Recovery cannot exceed confirmed unrecovered quantities. Non-national readers see only currently authorized outlets and independently authorized source locations; unrelated descendant identities and backward genealogy are withheld. The office view supports batch selection, impact review and recall action. Real SAP delivery ingestion, offline delivered-lot capture in the van/delivery lane, stock holds and deeper production-chain acceptance require their owning integrations; no completeness claim is made for those missing source feeds.

## F-310–F-321 F-614: office surfaces and bounds

The existing shell gains Retail execution with weekly scores, equipment/service history, shelf-action queues, planograms, POSM custody, policy editors, batch recall and observations. Opaque IDs remain API keys, not visible labels. Historical source authorization is separate from current master ownership. The observation/action/equipment lists disclose a bounded page, with a store filter, rather than asserting prefix counts are complete totals. Canonical calculations refuse overflow rather than silently calculating on a truncated source. Bounds are 500 per supported source/list, 5,000 receipt/event rows and master-manifest entries where explicitly indicated. This is not an unlimited-history export.

## F-310–F-321 F-614: Needs Sunpride

All seeded demonstration masters/observations are additive and marked through `sample_data_rows`; office versions are never overwritten and existing demo data is never reset. Invented sample defaults include frozen -25 to -18 °C, chilled 0 to 5 °C, 90% own-product share, a four-hour cold follow-up, weekly POSM audit, a 30-day near-expiry window, a 90% score target and weights 25/20/10/15/20/10. Policies and required steps are editable and versioned. Sunpride should confirm class planograms, asset/agreement extracts and SAP keys, cold bands, shelf-expiry actions, incident categories/SLA, score weights/applicability and campaign checklist requirements. Missing real client data does not block the marked samples.

## F-310–F-321 F-614: seams and parity

INTEGRITY owns watermark validation: the existing uploaded-photo ownership/hash checks call `SEAM(INTEGRITY)` but this lane does not claim watermark attestation. AVAILABILITY owns governed MSL/OSA. TPM owns campaign publication. SAP owns expected-price replicas, lot/delivery replicas and financial/return effects. MASTERS owns taxonomy, class/geography and distributor membership facts. CALLFLOW owns the common engine.

No iOS source or van POS source changed. When iOS resumes, add the same cached target/asset/checklist forms, encrypted capture/outbox adapters, media dependency handling and component feedback. Van/delivery adoption should add delivered-batch capture through the existing engine and SAP source adapters, not fork another recall or ledger engine. Existing live map, cockpit, Decide, PWA, issue board, sample/trial access, biometric sign-in and change-password remain.
