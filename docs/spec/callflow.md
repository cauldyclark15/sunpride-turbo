# CALLFLOW: one configurable engine

## F-006 F-107: authority and surfaces

This is our implementation of the client's shared-engine requirement, not a claim about Sunpride's current operating procedures or production deployment. The Bun API owns call validity and the immutable execution journal. The exact Kotlin source under `packages/callflow-native` is compiled into both existing Android apps; the apps retain their current UX, SQLCipher databases and outboxes. There is no job-title-specific app or second commercial/stock engine.

Definitions contain ordered `{key, adapter, label, required, condition}` steps. Keys and adapters occur once per definition; `condition` is limited to `always`, `has_order`, or `no_order`. Conditions cannot execute expressions. Required earlier steps block progression; optional steps do not become mandatory. The first/last steps are unconditional required check-in/check-out. Definitions have immutable versions and nonoverlapping effective intervals. Publishing is prospective, audited and read back by the office editor. A captured call freezes its definition, radius/class/dwell policy, verified pin and reason list, so later publication cannot rewrite an open or queued call.

Settings → Admin → Call flows edits definitions, radius/dwell policies, shared no-order reasons, and app/channel/class profile bindings. Decide shows independently reviewable exceptions and a seven-day breakdown separating in-sequence, deviated and unplanned calls. The breakdown retains closed exceptions after a decision and gates every historical row by current employee and outlet ownership. Overflow is refused explicitly, never silently reported as complete.

These masters are nationwide. Publication reuses the platform's national-scope gate: super administrators and nationally scoped administrators may publish; an area-only administrator may view but cannot change every other area's rules. Supervisor call-exception decisions remain separately current-scope gated.

## F-006 F-107: existing writers are adapters

| Surface | Adapter                                    | Authoritative fact                                                                                               |
| ------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Field   | check_in                                   | Existing visit check-in and execution event, in the same transaction                                             |
| Field   | stock_check                                | Existing inventory-check or call-sheet activity                                                                  |
| Field   | order_build                                | Existing accepted, non-review field order capture; drafts/rejected/voided orders do not satisfy no-order closure |
| Field   | evidence                                   | Existing validated, uploaded visit evidence attachment                                                           |
| Field   | note                                       | Existing persisted note activity                                                                                 |
| Field   | check_out                                  | Existing visit checkout plus shared call closure                                                                 |
| Van     | check_in / check_out                       | Shared call.start / call.close operations in the existing v2 outbox                                              |
| Van     | stock_check / note                         | Persisted call.step observation/note, not a done checkbox                                                        |
| Van     | order_build / discount / invoice / payment | Existing atomic sale writer after its pricing, receipt and payment validation; all roll back if the flow refuses |
| Van     | return_pickup                              | Existing return writer; original-sale and stock semantics are unchanged                                          |
| Van     | evidence                                   | Existing camera/compression/private capture-file and SHA-256-bound device/trip media-upload adapter              |

The engine does not become financial authority. SAP retains pricing, credit, stock valuation and posting authority. Integration of SAP/FISCAL policy remains in their owning lanes; a completed step is not a claim of SAP posting or fiscal accreditation.

Field evidence remains encrypted by the existing photo store. If evidence is REQUIRED, an offline photo may satisfy local capture and allow End to be queued, but that exact End operation remains queued until the genuine media attachment has reached the server. The uploader wakes the existing sync work afterwards. Optional photos and pre-engine outboxes retain their previous delivery behavior. Van photos reuse the existing evidence-upload stage before the corresponding call.step is pushed. A media reference cannot satisfy two calls.

## F-106: geofence and independent exceptions

Both capture and server validate provider, finite/legal coordinates, accuracy, fix age relative to capture time, the mock/integrity flag, and distance from a verified pin against the frozen policy. Comparing with capture time, not upload time, preserves delayed offline delivery. Missing, inaccurate, stale or mocked fixes cannot be approved as ordinary outside-radius exceptions.

An outside-radius start or end requires a recorded request and a different authorized supervisor's decision BEFORE capture. The grant is bound to person, registered device, store, policy and start/end kind; it expires and is consumed once. A replay of the same accepted operation stays idempotent. The native engine also prevents local grant reuse. A changed policy cannot borrow an approval issued for another policy.

Checkout approval is issued against the open call's frozen policy even after a new policy is published. Refreshed encrypted snapshots carry policy-qualified grants, so either app can use that older policy's checkout approval without authorizing a new-policy start. In-radius operations do not consume unused exceptions.

`SEAM(INTEGRITY)`: `integrityBlocked` consumes the domain/device integrity flag in addition to the supplied location flag. Android's real location adapter also passes the OS mock-location signal. This lane does not attest OS integrity or implement INTEGRITY's risk detection.

## F-120: no order means a governed reason

The shared effective-dated list is snapshotted at check-in. Every no-order close requires an offered reason, regardless of the chosen visit outcome. Optional call evidence remains linked through actual photo attachments. A voided van sale or a rejected/review field order does not turn a call into an order-producing call. Productive-call rules remain separate and are not redefined as order conversion.

## F-204 F-205: sequence, off-route and reporting

An earlier unfinished planned stop blocks the next stop unless a nonblank sequence-deviation reason is recorded. The call retains the original planned visit/sequence and is tagged `deviated`, not relabeled unplanned. An unplanned store requires its own reason, has no planned-visit identity and is reported separately; it cannot inflate planned-stop adherence. Field bootstrap includes the current authorized territory universe, and configured van bootstrap includes the current owned-unit outlet universe, so an off-route call is a real store selection, not an invented outlet ID. Other-route and unassigned stores are tagged scoped/unplanned, never incorrectly labeled as planned-route stops.

Existing per-operation domain authorization still runs. Reference/manifest checks include effective flow versions, approved unused exceptions and the current outlet universe; reaching a future effective boundary or receiving approval forces a refreshed snapshot. A cached trip or store is never a grant.

## F-207: dwell and Decide

Dwell is the check-out/check-in difference, never first-call-to-last-call market span. Minimum dwell is frozen from the channel/outlet-class policy at check-in. Short calls require a reason and create a separate append-only independently decided review. This is operational evidence review, not payroll/per-diem authorization.

A prior working day's missing checkout, or a call on an already closed/cancelled van trip, cannot permanently block the next legitimate call. At the next accepted start the server marks that old call interrupted, appends a system boundary event and creates a reconciliation review. It does NOT invent a checkout, dwell, outcome or no-order reason; retained phone work remains for supervised reconciliation. A failed new start rolls this housekeeping back as well.

## F-301 F-310 F-407: extension seam, not another engine

`call_flow_channel_bindings` selects a versioned profile by existing app, outlet channel and class. Channel-specific matches outrank class-only matches, then wildcard; default profiles are `field_selling` and `van_selling`. Both bootstrap adapters and server check-in resolve the same binding. Publishing a pre-sell, merchandiser or distributor profile does not create a new app. New domain lanes add real adapter handlers/forms and then configure their steps; unsupported required adapters fail closed.

`SEAM(MASTERS)`: binding keys currently use `outlets.channel` and `outlets.classification`; MASTERS supplies governed taxonomy/class identities. Do not create a second taxonomy here. `SEAM(distributor)`: distributor membership, partner isolation and shared-outlet grants must remain in that lane's authorization boundary. A binding alone does not grant distributor access. Requested/confirmed delivery dates, cutoffs, planogram/POSM/incident forms and distributor ownership are NOT delivered by this foundation.

## F-006 F-107: migration and integration

Apply additive migrations 0410 (definitions/policies/reasons/executions/events/reviews), 0411 (single-use evidence reference), 0412 (effective channel bindings) and 0413 (widen the new CALLFLOW state/review constraints for missing-checkout reconciliation, without deleting rows). Registry installation is one callflow domain entry. The van bundle adds `callFlowCalls` consistently, including empty trips, and customer/outlet snapshots carry callFlow configuration; the native v2 adapter strips these additions before the frozen v1 DTO validator. Existing v1 contracts are unchanged. New starts require the published definition applicable at capture time; a pre-publication queued start remains a legacy call. Already queued bytes are never rewritten to adopt a new definition.

## F-006 F-106 F-107 F-120 F-204 F-205 F-207: Needs Sunpride

The idempotent demo seed adds sample-marked configurations through the existing sample-data manifest without resetting data or overwriting office publications. Defaults are explicitly invented: radius 100 m, accuracy ceiling 50 m, fix age 60,000 ms, dwell 180,000 ms and sample no-order reasons. Only check-in/out are required in the default profiles. Sunpride should confirm class/channel thresholds, required steps, reasons and exception operating procedure. These missing inputs do not block shipping the editable sample configuration. No real SAP credentials or real client master data were used by this lane.

## F-006 F-106 F-107 F-120 F-204 F-205 F-207: iOS parity later

No iOS source was changed. Add the same closed definition semantics and channel bindings, encrypted configuration caching, local required-step/geofence/sequence/no-order/dwell checks, grant consumption and shared outbox adapters. Reuse the existing iOS encrypted-photo and durable intent/ack boundaries. Validate on the authorized iPhone when iOS resumes.

## F-006 F-106 F-107 F-120 F-204 F-205 F-207: proof boundaries

API tests exercise signed operations, prospective publication, binding cutover, required-step bypass refusal, scope-separated reporting, geofence quality/refusal, independent grants, sequence/off-route classification, controlled reasons, dwell and exact replay. Shared JVM tests execute the identical Kotlin engine in both apps. Opt-in instrumentation uses real native auth, Keystore, SQLCipher, UI and the lane API; the only substituted boundary is explicitly marked sample GPS coordinates. Screenshots and actual results belong to the external lane report, not this design document. Neither unit tests nor sample-coordinate instrumentation prove a physical walk, a SIM-removed 12-hour route, GPS integrity certification, battery endurance or real SAP/fiscal operation.

## F-006 F-107: bonus features

Live map/location sharing, cockpit pages, Decide, PWA, issue board, sample/trial access, biometrics and change-password remain. Decide gains call-flow reviews/reporting; the existing queues and financial writers are not replaced.
