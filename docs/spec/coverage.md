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

The Coverage & people cockpit contains the review, prior comparison, four-week trend, rep/beat/day/territory drill-through, outlet frequency and next action. The read refuses over 10,000 source rows explicitly.

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

## F-208 / F-209 / F-210 / F-222 / F-223 / F-613 / F-615: explicitly remaining

This increment does not implement the new productive-policy registry/shared evaluator migration, offline prospect geo/photo/KYC, cycle-based dormancy/recovery, photo attendance/leave/correction approvals, joint-call action carry-forward, collections planning/cheque lifecycle, or reconciled multi-metric target cascade. Existing behavior is preserved; it must not be credited as completion of these specification gaps. In particular location-sharing Start day is not attendance, and the older activity-productivity figure is not the glossary's order strike rate.

## Needs Sunpride — F-201 / F-203 / F-206 / F-224

Class frequency, daily capacity, service duration, travel estimates, objective text and sales potential are invented sample defaults until Sunpride refines them. Class/policy applicability must reconcile with MASTERS. SAP supplies authoritative open-item mapping through the SAP lane. Availability supplies resolved class MSL through its seam. Samples allow development now and never certify client agreement or production pilot acceptance.

## iOS parity later — F-203

Decode/cache the additive agenda context and render objective, prior-outcome, AR provenance, missing/unmeasured MSL and plan-version fields in the existing iOS route cards. iOS is paused and untouched. Van must consume the same context through its existing call-flow/bundle seam rather than a parallel flow.

## Bonus features — F-201 / F-202 / F-206

The existing manual MCP editor, signed approval/backup routing, calendar, exports, location sharing, map, owner cockpit, per-diem, supervision and sample/trial accounts remain. No showcase, tunnel, docs server or production database is changed by this lane.
