# Controlled Cebu field-sales pilot

Tracker: SP-0014 (QSR-019).

Status: preparation only; the field pilot has not run. This pack contains no
participant confirmation, release approval, field results or Sunpride sign-off.
A sample rehearsal, automated test or successful sign-in cannot complete this issue.

## Scope and owners

Our recommended first session is one Cebu salesperson, one existing route and
six planned stores over one selling day, with a different supervisor approving
and observing. This is a proposed controlled start, not Sunpride's confirmed team,
schedule or a change to the client's wider rollout scope. If fewer stores are
available, record the reduced coverage; do not claim the six-store end-to-end
scenario passed. iOS, van/store POS, printing and fleet-wide rollout are outside
this field-sales session.

| Owner                                               | Responsibility                                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Sunpride sales lead (Sir Francis or named delegate) | Names participants, confirms the day and route, owns the go/no-go and signs the result.                                             |
| Sunpride salesperson                                | Carries out genuine calls on the agreed Cebu route using their own assigned account and phone.                                      |
| Sunpride supervisor                                 | Independently approves the plan, observes the route, reconciles the office results and decides exceptions.                          |
| Sunpride administrator / sales admin                | Confirms role, unit, phone registration, stores and account links; owns the existing-business fallback.                             |
| Sunpride SAP administrator / order approver         | Controls any test-company integration and independently verifies order approval and SAP documents.                                  |
| Delivery lead                                       | Supplies the accepted deployed build and APK identity, verifies readiness evidence, supports defects and records the final handoff. |

No pilot people, date, store list or release candidate have been supplied in this
issue. Do not fill those gaps with fictional participants or label sample stores
as real field activity.

## Preparation references

- [Full SFA UAT scenarios](../SFA_UAT_SCENARIOS.md): required business coverage and sign-off, not proof that a candidate passed.
- [Offline fault catalogue](../OFFLINE_CHAOS_TESTS.md): invariants and historical cases, not a current physical-phone result.
- [Field-sales user guide](../../guides/FIELD_SALES_USER_GUIDE.md): seller training, including separate call-sheet and order actions.
- [Supervisor/admin guide](../../training/SUPERVISOR_ADMIN_GUIDE.md): office training and independent approvals.
- [Field order pricing](../../runbooks/FIELD_ORDER_PRICING.md): sample pricing and office/SAP distinctions.
- [Run record](RUN_RECORD.md) and [visit reconciliation template](VISIT_RECONCILIATION.csv): copy into an access-controlled pilot evidence location before filling them.

These documents include historical limitations and screenshots. Before training,
the delivery lead must check the exact accepted candidate's capabilities and
screen wording. In particular, verify visit recording is enabled in the supplied
APK; do not infer it from a package name or an older guide. Do not work around a
missing capability by treating a note, call sheet or office entry as a phone order.

## Inputs for the actual session

These are operational requests for this pilot, not a claim that each input is a
separate client-spec deliverable. Missing inputs do not block software preparation
or clearly marked sample rehearsals; actual field execution requires real people.

| Needed from                                 | Exact handoff                                                                                                                                                                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sunpride sales lead                         | Named salesperson, independent supervisor, delegate signing the result, agreed Cebu route/date and a way to contact them during the session.                                                                            |
| Sunpride supervisor / sales admin           | Ordered store codes and account links, current approved plan/version, genuine call objectives, store access and permission for location/photo evidence.                                                                 |
| Sunpride salesperson / administrator        | Assigned supported Android phone, availability on the route, working account, confirmed registration and a safe way to remain contactable during an offline leg. No passwords in the issue.                             |
| Sunpride SAP administrator / order approver | Test-company target and permitted test orders if SAP is included; otherwise record SAP as not tested and leave end-to-end posting acceptance incomplete. Transfer credentials only through the approved secret channel. |
| Delivery lead                               | Deployed web/API revision, exact APK version and checksum, readiness/UAT evidence and support contact. A lane build is not evidence of the deployed release.                                                            |

Use clearly marked sample accounts/products/prices for a rehearsal while real
commercial data is unavailable. Keep rehearsal results separate from real-route
results. Do not send invented orders into production SAP or describe a mock SAP
response as a real SAP document. No purchase or paid service is required by this
preparation pack.

## Entry checklist: complete before anyone leaves

Record each item in the run record with its evidence. A blank or Not run entry is
not a pass.

1. Name the participants, independent approvers, route/date, support contacts and Sunpride go/no-go owner.
2. Identify the actual deployed web/API revision and installed APK version/checksum; confirm the candidate's scoped automated/UAT, security, device and offline evidence. Carry forward open defects, not old green totals.
3. Demonstrate sign-in, today's complete plan download, Start, required forms, order review/send where included, End and sync on the candidate. Verify current offline access/lease before leaving signal.
4. Compare the approved plan's date, version, stores and sequence on phone and office. Confirm roles/units and separate approvers with each person's own account.
5. Agree the data mode (sample rehearsal or real field), permitted photographs/location collection, restricted evidence location and normal-business fallback. Do not replace Sunpride's existing sales/order record on the strength of this pilot alone.
6. Confirm the genuine store/account/product/UOM/pricing context for any real order. Mark unknown prices and credit as unknown, not zero or approved; office receipt does not mean office approval or SAP posting.
7. Record baseline planned stops, existing visit/order references and phone pending/review/held/photo counts so later comparisons isolate this session. Reconcile any existing queue before starting; do not delete it.
8. Confirm charge, available storage, normal battery-saver setting, network restoration plan and an independent way to call support. Offline testing happens while stationary, never while driving.
9. Check the current UAT sign-off and remaining exceptions. Do not start with an unresolved Critical/High data-loss, authorization, approval, check-in, sync, order or SAP defect. Record other accepted exceptions with both Sunpride and delivery owners.
10. Record explicit Go from the Sunpride owner and delivery lead. Otherwise keep the session Not started.

Revocation, scope transfers, time changes, connector outages and destructive fault
injection belong in a separate isolated rehearsal, not on an active route phone
with unsent work. Never permanently revoke a pilot phone merely to prove recovery.

## Field-day sequence

1. Before departure on signal, capture the agreed plan on phone and office, current queue counts and lease expiry in Manila time.
2. At the first genuine planned store, record Start, the activities actually performed and End. Send any genuine order through its review/send flow before ending the call; saving a call sheet is not sending an order.
3. At a safe stationary point, make the agreed next two planned calls without connectivity. A SIM-removed leg requires the participant to retain the SIM safely and have separate emergency contact; record SIM/eSIM, Wi-Fi and actual network state. Airplane mode alone is a narrower test, not a full SIM-removed route proof.
4. While still offline, close and reopen the app normally. Record that saved calls, activities, sent-order intents and any photos remain; do not uninstall, clear storage, sign out or alter the clock.
5. Restore the original network/SIM configuration and sync. The supervisor independently checks the office's received visits and operation acknowledgements against the phone, in plan order.
6. Sync again and compare the same visit/order/evidence references and counts. A stable phone label alone does not prove duplicate prevention.
7. Finish the remaining genuine stops in order, recording actual no-sale reasons or location exceptions when they occur. Do not invent an exception or productivity event to fill a test row; use a separately labelled rehearsal for cases not encountered.
8. For each included order, link the phone intent to the office record, approval and SAP test document if applicable. Record each boundary independently; never re-enter a potentially accepted order until the office has reconciled it.
9. Before the current access/day-close deadline, reconcile every planned stop, operation, order and photo; record unresolved items and their custodians. Complete the closeout and Sunpride sign-off.

This short offline leg does not prove a whole-day SIM-removed run, battery/data
budget, background delivery, all channels or all supported devices. Those remain
Not tested unless separately observed with their own dated evidence.

## Stop and preserve

Stop the affected workflow immediately for missing/duplicate work, wrong money,
unauthorized data, failed independent approval, an unusable route, lost evidence,
or a phone that claims synced while work remains. Sunpride's supervisor decides
how normal business continues; the pilot must not silently replace that process.

1. Keep the phone and unsent data intact. Do not reset, reinstall, sign out, replay on another device or change roles/registration to force a send.
2. Record the time, last successful step, counts, build, symptom and a redacted screenshot/support export. Treat review/held work as possibly the only copy; the office may also have accepted a send whose acknowledgement was lost.
3. Compare the phone and office receipts before any supervised recapture. Give each discrepancy an owner and link it on [the issue board](https://sunpride.cauldnclark.com/issues), keeping the SP-0014 session summary current.
4. Resume only after the delivery lead and Sunpride supervisor record the correction, narrow retest evidence and permission to continue. Preserve the initial failure; do not overwrite it with the retry.

## Closeout and acceptance

Complete the run record and one reconciliation row per planned stop, including
missed stops. Compare operation acknowledgements, not just visit totals: the two
sources can agree on a visit count while an activity or order is missing. Record
orders, quantities/UOMs, amounts or explicitly unknown prices, and evidence
attachments separately. Redact customer, personal and location details in shared
summaries; keep exact references in the restricted evidence pack, never credentials.

A completed pilot needs all of the following:

- The identified Sunpride participants actually worked the agreed Cebu route/day on the recorded candidate; evidence mode is real field, not a rehearsal.
- Every planned stop has an explained result; every saved operation/order/photo is either received exactly once or explicitly unresolved. Missing work, unexplained duplicates or unresolved Critical/High issues prevent a pass.
- The offline saves survived reopening, reconnected successfully and repeated sync created no additional business records. The record says exactly which offline conditions were observed.
- The supervisor's same-person/date reports reconcile with visit activities and orders. Completed alone is not proof of productivity; do not decide disputed KPI targets or per-diem policy here.
- Required UAT outcomes and the candidate's exact gaps are attached. Any omitted case or boundary is Not tested/Blocked with an owner, not silently counted as passed. A field-only success cannot certify SAP-inclusive end-to-end acceptance.
- Sunpride's named owner and the delivery lead sign the actual results and record the next action: repeat a failed portion, extend controlled coverage or propose rollout. No automatic wider rollout or production posting is authorized by this pack.

Until those records exist, SP-0014 remains incomplete. Ask Sunpride for the people,
route and date; record Awaiting client response rather than In QA for an unrun pilot.
