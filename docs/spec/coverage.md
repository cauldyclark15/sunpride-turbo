# COVERAGE specification alignment

## F-201 / F-202: class-driven permanent journey plans

Owner question: can the rep serve the outlet universe at its governed frequency without exceeding the working day?

The existing Coverage plans workspace has a Journey plans tab. Effective-dated class policies supply one-, two- or four-week frequency, service minutes and objectives. A reusable template supplies its rep, Monday cycle anchor, effective interval, selling weekdays, daily capacity, provisional travel per stop, outlet roster and optional fixed day/phase. Empty day/phase uses deterministic capacity-aware balancing. Four-week phases continue across calendar-month boundaries; they do not restart on the first of each month.

Simulation shows outlet/visit totals, potential completeness, service/travel time, each day's load against capacity, the existing same-month signed-plan comparison, verified-pin sketch and complete outlet allocation. Travel is explicitly a provisional editable estimate, not a road-routing claim. A class without exactly one applicable policy fails closed. Over 500 outlets/slots is refused explicitly.

Simulation persists a hash of the template, relevant master projections, policies, generated rows and approval snapshots. Generating re-resolves those inputs and refuses stale or overloaded scenarios. It creates the existing monthly coverage plan, roster, slots and assignment, then submits it through the existing writer. A different approver publishes through the existing approval-capacity rules and signed-content hash. The PJP source, policy snapshots, cycle allocation and simulation hash are part of signed content. Due activation remains the existing coverage scheduler. Manual approval endpoints perform the same PJP revalidation; there is no approval bypass. Generated content cannot be manually edited while retaining simulated provenance. A revised effective template/scenario produces another monthly version, with an explicitly named predecessor when replacing a signed plan. Existing execution-preserving activation checks remain in force.

Commands use the existing coverage command ledger, scope checks before replay, live persisted actor reauthorization, transactions and audit events. Discovery checks both stored plan scope and the person's current scope.

Endpoints:

- GET `/api/v1/coverage/pjp`: scoped people, policies, templates, generated publication queue and existing signed-plan choices. Every collection is bounded with explicit overflow refusal.
- POST `/api/v1/coverage/pjp/policy`: `{orgUnitId,classKey,label,intervalWeeks,serviceMinutes,objectives,fromDate,toDate?,sourceRef,replacesPolicyId?,idempotencyKey}`. Requires `masterdata.manage`; replacing closes the previous interval prospectively.
- POST `/api/v1/coverage/pjp/template`: `{assigneeProfileId,name,anchorDate,fromDate,toDate,capacityMinutes,travelMinutes,sellingWeekdays,stops:[{outletId,weekday?,phaseWeek?}],idempotencyKey}`. Immutable versions; requires `mcp.plan`.
- POST `/api/v1/coverage/pjp/simulate`: `{templateId,month,idempotencyKey}` → `{simulationId,hash,result}`. Does not write plans or planned visits.
- POST `/api/v1/coverage/pjp/generate`: `{templateId,simulationId,basedOnPlanId?,reason?,idempotencyKey}` → submitted monthly plan.
- POST `/api/v1/coverage/pjp/publish`: `{planId,idempotencyKey}` → independently approved signed plan. Requires `mcp.approve` and the original approval-routing rules.

Migration: `0450_pjp.sql`, additive only. Tables: `outlet_class_visit_policies`, `pjp_templates`, `pjp_simulations`, `pjp_publications`, `pjp_events`; new nullable `coverage_plans.pjp_source`. No old migration changed.

The additive `seedCoverageSpec` helper is called from the seed CLI and daily continuation. Only already sample-marked outlets with no class receive the explicitly invented `SAMPLE-A` class. Sample policies/templates are marked in `sample_data_rows`. No real class or existing policy is overwritten. No reset is needed. The sample policy is not client approval.

## F-206: four-week adherence review

Owner question: which rep/beat/day/territory missed its commitment, and did every complete pilot week exceed 85%?

GET `/api/v1/coverage/adherence?asOf=YYYY-MM-DD&unitId=&channel=` reads the four complete Monday–Sunday weeks immediately before the selected review week, plus the preceding four weeks. It uses signed slot attribution and the effective suffix of replaced plans, not today's territory name. Current person, stored plan and current outlet authorization still apply. Approved-but-not-yet-activated slots remain in the denominator. Missing activation therefore cannot manufacture perfect adherence.

Numerator: distinct planned visits with completed/checked-out executions, excluding rejected late work. Duplicate executions and unplanned calls cannot inflate it. Frequency is achieved signed scheduled calls per outlet. A missing planned week is unknown, never passed. The exit criterion uses the exact ratio strictly above 85% in each of four weeks, not a rounded percentage or a partial current week. It is a software reading, not evidence that Sunpride has accepted a four-week live pilot.

The Coverage & people cockpit contains the review, prior comparison, four-week trend, rep/beat/day/territory drill-through, outlet frequency and next action. The read refuses over 50,000 source rows explicitly. The complete current-plus-prior eight-week window for the 300-store sample exceeds 10,000 rows; authorization is checked once per distinct stored unit and current outlet, not once per call.

## F-208: published productive-call definitions

Owner question: which calls met our agreed objective, rather than merely containing an order?

The Coverage workspace has Productive call rules. An office author drafts an immutable definition with exact unit/position applicability, future Manila effective dates, qualifying business activities, any/all matching, source/agreement reference and the existing truck-seller inventory condition. Another authorized approver publishes it. Overlapping applicability is refused under a unit advisory lock. A successor closes only its predecessor's future applicability; the immutable definition hash/version is retained. Drafts and publication use an actor-bound full-request command ledger with current persisted role/scope checks before replay. Published policy content, version, applicability and source are hash checked.

The real signed check-in writer resolves the policy at the captured device instant using effective employee assignment history, and stores its complete version, definition, provenance and named approval on the visit. A publication after capture cannot retroactively apply. Publication is strictly future-effective, not backdated to this morning. Checkout, visit detail, DSR/Team and cockpit use the same `visits/productive.js` evaluator, preferring that immutable snapshot. Changing a policy or standard afterward cannot reclassify an already captured visit. The integration regression enters the signed sync writer, changes the live policy, then compares checkout, visit detail, real DSR execution and real cockpit source reads.

Strike rate is separate: completed planned calls with an actual linked, authorized, non-draft/non-rejected/non-voided canonical order divided by completed planned calls. The source order's person, stored unit, current customer/outlet and source-location access all apply. An order intent alone is not that canonical order. The cockpit has separate Productive calls and Order strike rate KPIs, prior readings and row columns; stored `productive_pct` retains the productive percentage rather than accidentally adopting strike rate. Only recorded collections qualify in all evaluators. Explicit nonproductive outcomes are interpreted consistently.

Legacy visits lacking a captured policy remain explicitly provisional; no historical client agreement is invented. Additive sample policies say SAMPLE / not client-agreed and are tracked in `sample_data_rows`. The sample source-order backfill links only uniquely matched, sample-marked orders and activities with identical request, organization, salesperson, outlet and authorized creator. It never guesses a shared-customer link or overwrites a pre-existing link. Database order-intent dedupe remains intact. Repeated seeding is a no-op.

Migration: `0451_productive_policies.sql`, adding `productive_call_policies`, `productive_policy_commands`, `productive_policy_events` and nullable `visit_executions.productive_policy_snapshot`.

Endpoints: GET `/api/v1/coverage/productive-policies`; POST `/api/v1/coverage/productive-policies/draft` and `/publish`. The draft takes `{orgUnitId,positionId?,label,fromDate,toDate?,sourceRef,replacesPolicyId?,definition:{rule,matchMode,requiresPlanned:true,allowedCodes},idempotencyKey}`. Publishing takes `{policyId,idempotencyKey}`. Definitions apply to exact units; there is no implicit inheritance.

Seams: `SEAM(CALLFLOW)` in the central evaluator accepts additional governed activity codes from that lane, never a second evaluator. `SEAM(MASTERS)` reserves channel-specific applicability until effective channel history exists: current profile channel is not a safe historical call fact. Unit and effective-position applicability work now; non-null channel overrides fail closed rather than guessing. No iOS change is needed for the server calculation; later native parity should display the captured definition and refresh the policy context through the common call-flow cache.

## F-203: Android agenda context

The existing `field.bundle.plannedVisits[]` adds `requiredObjectives` and `agenda`. No second call-flow engine or new app is introduced. The existing encrypted visit JSON carries the additive context offline. Android validates it before snapshot promotion; old servers omit it and show a plain missing-context message.

Expanded Route cards show beat/plan version, objectives, last prior synced call for the same rep, open-AR provenance, observed missing MSL lines and unmeasured count separately. A completed last call is not labelled productive. Downloaded context is not labelled live data.

Seams:

- `SEAM(SAP)` in `coverage/agenda.js`: reads explicitly labelled sample office AR snapshots when present. Otherwise returns unavailable, not zero. It does not create an AR ledger, perform a credit check or claim live SAP. SAP-lane open-item replication must replace this adapter.
- `SEAM(AVAILABILITY)` in `coverage/agenda.js`: uses the existing effective direct outlet assortment and the latest prior audit for that same assortment and rep. Omitted checks remain unmeasured. The availability lane's resolved taxonomy/class MSL projection must replace the adapter. This is not completion of the class-MSL engine.
- `SEAM(MASTERS)` in `coverage/pjp.js`: reads the existing `outlets.classification` key. The MASTERS effective-dated classification resolver is still an integration task.

Agenda context is refreshed on bootstrap and protected by the existing continuation hash. No complete real-time delta is promised for these extra AR/audit facts; the UI explicitly asks for an online refresh. Van and iOS agenda parity are not implemented here.

## F-224: remaining rebalancing scope

The template day/phase editor, workload simulation, potential-completeness warning, pin sketch and comparison provide beat-workload scenarios. They do not implement prospective cross-territory ownership moves or a road-travel engine. F-224 remains partial. ORG assignment writers and their signed-plan locks must own any eventual territory publication; do not write those masters from a separate planning engine.

## F-209: offline prospect acquisition and canonical master review

Owner question: which prospects need review, and are we adding a distinct store rather than a duplicate?

Android Attendance & prospects adds non-call geo/photo/KYC capture on the SAME SQLCipher intents, outbox, sealed photo files, signed device operations, media claims and sync worker. It does not create an invented visit. A separately bounded effective form grant permits these non-call forms after the existing visit day closes, but expires at the policy/day/cache boundary. Required KYC, selection choices, photo/fix freshness and captured policy version/hash are validated locally and again on the server. One Room transaction inserts intent, outbox and photo metadata; retired authority rolls it back. Media is held until aggregate acknowledgement, with cancellation/hold checks around upload awaits.

The server reauthorizes persisted actor/device/scope before replay, checks media owner/purpose/checksum, and enters the existing canonical outlet-enrolment proposal writer. Proposed stores stay provisional. The Workforce tab in Coverage provides captured KYC labels, evidence flags, authorized no-store photo viewing and independent office review. `SEAM(MASTERS)` uses bounded canonical current names/codes, existing links and geo candidates; it does not invent a new taxonomy or accounting customer. A token binds the candidate set; link-existing, approve-distinct and rejection refuse stale or conflicting decisions. Accepted distinct outlets re-enter existing territory assignment and PJP publication, not a second universe.

## F-222: independent attendance evidence, correction and HR adapter

Owner question: who has a clock record, who needs evidence review, and which missing records are actually approved leave or absence?

Geo/photo clock-in and dependent clock-out use that same encrypted queue and signed engine. Raw attendance sessions and original evidence remain intact. Office reports show raw clocks, first/last canonical calls, a labelled closed-clock span, disjoint review/leave/absence/missing counts, roster comparison, prior day and person drill-down. Missing capture is not certified absence; elapsed clock span is not continuous-location proof or payroll. Attendance never enables or disables consented location sharing.

Corrections and leave/absence records are immutable requests with source and reason. A different authorized approver applies them; predecessor checks reject stale approvals, and historical stored attendance scope is rechecked. `SEAM(HR)` is an atomic source-keyed import adapter, not a connected HR or payroll service. The office CSV is `employeeCode,day,kind,reason,externalKey`; exact employee codes preserve leading zeroes and resolve only within authorized workforce. Source/external identity is unique and serialized, so another operator or file-upload key cannot duplicate a source row; changed replay and any refused row roll back the import. Neither an upload nor a request approves itself.

The Field form policies view has plain-label KYC field controls and effective versioning. Address, proposed channel and contact person remain canonical required fields; the office can add fields and edit capture/evidence tolerances. No existing/future client policy is overwritten by sample seeding. The additive seed supplies clearly marked sample policies and is repeatable without reset. Migration `0452_workforce_capture.sql` adds policies, sessions, adjustments/events and nullable enrolment capture/review/resolution columns; no committed migration is edited.

## F-209 / F-222: offline cold reopen

The upgraded v2 client records negotiation in its local snapshot and renews pre-feature or expired caches before reusing a delta cursor. The first physical walk exposed an offline cold-reopen gap: the workspace showed no field-form grant or saved list until an online sync. Cause: the controller's loaded-epoch guard was a plain field and short-circuited the snapshot read, so a screen composed before the encrypted store finished loading never subscribed to the load. The epoch is now snapshot state and both values are read before the guard. A JVM regression test (`F-209_F-222 workforce read before the first load observes the later load`) fails on the previous getter and passes on the fix. Re-proved on the Redmi with Wi-Fi and mobile data off and API forwarding removed: after a cold relaunch the grant, sample policy, saved prospect and clock-in render from the device alone. The SIM was not physically removed; process-death acceptance beyond force-stop relaunch is not separately certified.

## F-210: cycle-based dormancy, recovery and owner actions

A store is dormant after no purchase in the shared analytics sales facts (the same included-order rule every sales screen uses) for `missed_cycles` of its own purchase cycles. The cycle comes from the effective PJP outlet-class visit frequency (F-201), else the outlet's assignment/outlet cadence, else the effective-dated policy's fallback; the source is stored on each case. Stores that have never bought are excluded. Policies are effective-dated per unit (`dormancy_policies`, no-overlap constraint, start today or later, content hash). Detection runs daily at 01:10 Manila, after the 00:30 analytics rebuild, idempotently, and records each detection as an `outlet_dormancy_cases` row (detected, recovered and closed dates are kept on the row; owner actions are append-only rows); a new purchase after detection records recovery; an owner-closed case is not reopened for the same quiet spell. Owner actions (recovery visit, win-back offer, owner review, close with reason) need `dormancy.act` (super admin, admin, manager) inside the caller's persisted store scope and are idempotent (same key + same content replays, changed content 409). Stores shows the panel (open, newly detected vs prior 28 days, recovered vs prior 28 days, weekly trend, exceptions-first cases with "dormant since" vs "detected" and next step); Decide lists each open case as a "Dormant store" item linking back. This is separate from the period-comparison "lost stores" figure and the `dormant_key_store` insight, which are unchanged.

## F-615: target setting and cascade

Targets now cover sales value, sales volume (per product), buying stores (coverage), distribution points (store-SKU), calls and MSL compliance. A cascade allocates one parent's monthly target (company, channel or territory) to its complete child set from the same hierarchy the target book rolls up (company → channel → territory → agent, as the caller's scope sees it). Preview splits additive measures by the prior three complete months of shared analytics sales facts with exact largest-remainder rounding (even split when there is no basis; calls always split evenly until a governed call history basis is chosen); MSL is a rate in basis points carried to every child, never summed. The preparer may edit any child; submission refuses a set that does not reconcile exactly or that misses/adds a child, and is idempotent. A different person with `target.approve` (super admin, manager, approver) publishes against the content hash they reviewed; the child set is re-reconciled at approval, the previous published version and older waiting versions are superseded, and a stale older version cannot be approved over a newer one. Publishing sales value writes the existing explicit monthly `sales_targets` rows for the parent and every child, so the cockpit, Sales & targets and pace read one book. Sales & targets shows the cascade matrix (waiting for approval, published by measure with prior actual, preparation with live reconciliation, earlier versions). The existing per-cell target editor is unchanged.

Remaining for F-615: non-sales measures are published as a cascade bundle but the field apps do not yet receive it, and the per-measure actuals (volume in base UOM, distribution, MSL) are not yet compared against these targets on web, native or van screens. Volume uses order quantity in the ordered UOM until governed base-UOM conversion exists (`SEAM(MASTERS)`). Sample channel keys differ only by letter case (`gt`/`GT`); the cascade shows them as stored rather than guessing a merge (`SEAM(MASTERS)`).

## F-223: joint call follow-up

The joint call stays the existing Work-With session: observation checklist (BCP/PSF), training log, pre-call review and post-call SWOT are unchanged. The trainer now records up to ten agreed actions on the session (agreement, trainee or trainer as owner, due day on or after the call). Every unreviewed action is carried into the next joint call between the same trainer and trainee (sessions on or after the agreeing day; cancelled sessions excluded; another trainer of the same trainee does not inherit them). There the trainer marks each Done or Not done with a note of what was seen; the session cannot be completed until every carried action is reviewed (an extra completion gap per action). An action is never reviewed in the session that agreed it, a review is final (same review replays, a different one is refused), and a session's actions are frozen once any was reviewed. Supervision → Work-With shows the follow-up panel on the session.

Remaining for F-223: the offline native supervisor editor (Android/iOS) is not built; supervisors record actions in the web office app. Talk Sheets remain the separate partner-meeting form.

## F-613: collections plan in Money

Money now carries a collections plan on AR open items. `SEAM(SAP)`: open items are read from the labelled sample office AR snapshot (latest `ar_balance` row per customer, invoices with a remaining amount) until the SAP open-item replica exists; promises, cheques and routes plan and track the work and never post or reduce a balance. A promise-to-pay names a customer (optionally one open item), amount and day (today to 60 days), cannot exceed that item's remaining amount or, with the customer's other open promises, the whole open balance, and is settled once as kept, broken (only after its day) or cancelled with a note. Cheques are recorded with bank, number (unique per bank), amount and cheque date; the lifecycle is received → deposited → cleared or bounced (bounce needs a reason) → replaced by a new cheque of the same customer, with an append-only event per step; a post-dated cheque cannot be deposited before its date. A collector route is an ordered list of up to 60 stops for one active field collector for today or the next 14 days, each with a reason; it is suggested from the exception list (bounced cheques, overdue promises, cheques ready to deposit, over-60-day balances with no promise). The office screen leads with those exceptions and shows overdue vs owed, promised this week, kept rate for the last 28 days vs the prior 28 days, post-dated cheques held and bounced cheques awaiting replacement. Writes need `collections.plan` (super admin, admin, manager) at the customer's current owning unit; reads follow the analytics store scope.

Remaining for F-613: the route order is the priority order (no road-travel optimisation); collectors do not yet receive the route or record promise/cheque evidence on the Android field app or van; kept promises are confirmed by the office, not yet by SAP clearing. The feature list's dependency `F-11` is malformed (no such ID); it was not silently corrected.

## Needs Sunpride — F-210

The three-missed-cycle threshold and 28-day fallback cycle are invented SAMPLE defaults, editable per team. Which order statuses count as a purchase once SAP invoices are authoritative (`SEAM(SAP)`) and which win-back offers are allowed are open questions. The three "SAMPLE Dormant Store" outlets and their orders are additive sample rows.

## Needs Sunpride — F-209 / F-222

The KYC choices, 24-hour non-call capture window, 250 m accuracy review flag, five-minute evidence freshness, 18-hour span review flag and 50 m candidate radius are invented SAMPLE defaults, editable and effective-dated, not client policy or agreement. HR needs a stable source reference and employee/external row codes. No live HR, payroll, official absence determination or geolocation attestation is claimed.

## iOS and van parity later — F-209 / F-222

iOS is paused and unchanged. Port the optional form grant and non-call templates into the existing native encrypted intent/photo pipeline, preserving scope retirement, dependent clock-out and acknowledgement-bound media cleanup. The van client has not been changed; any future equivalent must consume the common signed engine rather than another attendance or acquisition service.

## Needs Sunpride — F-201 / F-203 / F-206 / F-208 / F-224

Class frequency, daily capacity, service duration, travel estimates, objective text and sales potential are invented sample defaults until Sunpride refines them. Class/policy applicability must reconcile with MASTERS. SAP supplies authoritative open-item mapping through the SAP lane. Availability supplies resolved class MSL through its seam. Samples allow development now and never certify client agreement or production pilot acceptance. F-208 needs Sales and Trade Marketing to refine/agree the provisional definition; invented sample publication proves the software workflow, not their sign-off.

## iOS parity later — F-203

Decode/cache the additive agenda context and render objective, prior-outcome, AR provenance, missing/unmeasured MSL and plan-version fields in the existing iOS route cards. iOS is paused and untouched. Van must consume the same context through its existing call-flow/bundle seam rather than a parallel flow.

## Bonus features — F-201 / F-202 / F-206

The existing manual MCP editor, signed approval/backup routing, calendar, exports, location sharing, map, owner cockpit, per-diem, supervision and sample/trial accounts remain. No showcase, tunnel, docs server or production database is changed by this lane.
