# SFA end-to-end UAT scenarios — Cebu field sales pilot

Tracker: SP-0026 (QSR-001), milestone `12 · Field sales pilot (Cebu)`.

This is the user acceptance test (UAT) script for the field sales pilot. It walks one
pilot day end to end: the Master Coverage Plan (MCP) is written and approved, the day's
visits are generated, the salesperson checks in (also offline), records the call and the
order, the phone syncs, the order posts to SAP, and the supervisor monitors the day and
decides exceptions.

Client rules used here come from the 20 January 2026 memo
(`docs/requirements/SALES_OPS_STANDARDS_MEMO_2026-01-20.md`) and the 2 October 2026 call
answers. Where they differ, the call answers win.

## How to use this document

- Each scenario has an ID (`UAT-<area>-<nn>`), the role that runs it, preconditions,
  steps, and the expected result. Testers record Pass / Fail / Blocked and the defect
  number on the sign-off sheet at the end.
- `Automated:` lines name the convex-test that proves the same server behaviour on every
  commit. A green automated test does not replace the UAT run: UAT proves the screens,
  the phone and the people's workflow. `Manual only:` marks steps no automated test covers.
- `packages/backend/convex/acceptance/uat_catalog.test.ts` fails the build if a scenario
  loses its automated or manual marker, or if a referenced test is renamed or deleted.
- The full pilot day is automated as one story in
  `packages/backend/convex/acceptance/sfa_pilot.acceptance.test.ts` (scenarios
  `UAT-E2E-01` to `UAT-E2E-03`).

## Environment and roles

| Item         | Pilot setting                                                                   |
| ------------ | ------------------------------------------------------------------------------- |
| Web app      | DEV deployment of the management web app (Chrome or Safari; iPad also works)    |
| Field app    | Native Android field app first (salesperson's own phone), iPhone second         |
| Time zone    | Asia/Manila; the selling day closes at 10:00 PM                                 |
| Working week | Monday to Saturday (Saturday is a selling day; collection day for key accounts) |
| SAP          | SAP connector against the agreed SAP test company, never production             |

| UAT role                  | App role (system)        | Used for                                           |
| ------------------------- | ------------------------ | -------------------------------------------------- |
| Salesperson (KAS / RDS)   | `sales`                  | Writes own MCP, runs the day on the phone          |
| Supervisor                | `manager`                | Approves MCP, monitors the day, decides exceptions |
| Manager (backup approver) | `manager` (one level up) | Approves MCP while the supervisor is away          |
| Sales admin               | `operations`             | Encodes outside-call POs, maintains stores         |
| Order approver            | `approver` or `manager`  | Approves sales orders before SAP                   |
| Administrator             | `admin` / `super_admin`  | Users, org units, devices, store codes             |

Use a different person (and login) for every role: the system refuses self-approval of
plans, orders, new stores and exceptions, and UAT must prove that.

## Entry and exit criteria

Entry:

1. The latest `main` build is deployed to DEV and the automated gate is green.
2. Pilot data is loaded (see "Data Sunpride must provide").
3. Every pilot phone is enrolled (`UAT-SET-02`) and has the current field app build.

Exit (pilot go/no-go):

1. Every scenario below is Pass, or Fail with a defect that Sunpride and our team agree
   to accept for the pilot.
2. No open Critical or High defect in MCP approval, check-in, offline sync, order or SAP.
3. Sir Francis (or his named delegate) signs the sign-off sheet.

Defect severity: Critical = data lost or wrong money/stock; High = a pilot step cannot be
completed; Medium = workaround exists; Low = cosmetic.

## Data Sunpride must provide

| Data                                                                       | From                 |
| -------------------------------------------------------------------------- | -------------------- |
| Pilot people: name, email, position, supervisor, manager (Cebu pilot team) | Sunpride sales team  |
| Pilot stores with existing customer codes, address and a verified pin      | Sunpride sales team  |
| Products, units and prices for the pilot stores                            | Sunpride / SAP admin |
| One filled-in sample MCP for a pilot salesperson                           | Pilot supervisor     |
| SAP test company access for the connector                                  | Sunpride SAP admin   |
| Android phones of the pilot team (their own phones) on test day            | Pilot team           |

## Scenarios

### A. Setup

### UAT-SET-01 · Pilot users get the right role and unit

- Role: Administrator
- Preconditions: pilot people list received.
- Steps: 1) Invite each pilot person with their app role. 2) Assign each to their Cebu
  unit and position. 3) Sign in as the salesperson and open Field › Coverage.
- Expected: each person sees only their own unit's people and stores; a salesperson
  cannot open administration; an unassigned invited person is refused scoped screens.
- Automated: `packages/backend/convex/coverage/plans.test.ts` — "enforces current plan and outlet scope, and analyst remains read-only"
- Manual only: invitation emails and first sign-in on each tester's own device.

### UAT-SET-02 · Enrol and revoke a salesperson's phone

- Role: Salesperson, Administrator
- Steps: 1) Salesperson installs the field app, signs in and requests enrolment. 2) Administrator of the salesperson's unit approves the phone. 3) Salesperson finishes
  binding on the phone. 4) Administrator revokes the phone, then the salesperson tries to sync.
- Expected: only an administrator of the person's unit can approve; after revocation the
  phone cannot sync, and queued work on the phone is kept, not deleted.
- Automated: `packages/backend/convex/mobile/devices.test.ts` — "requires an administrator in the employee's stored unit, not a sales or foreign administrator"
- Automated: `packages/backend/convex/mobile/devices.test.ts` — "revokes without deleting queued sync state; replacement requires explicit revocation"
- Manual only: install and enrolment on the tester's own Android phone.

### UAT-SET-03 · Salesperson adds a new store; supervisor approves it

- Role: Salesperson, Supervisor
- Steps: 1) Salesperson pre-enrols a new store with a photo or customer information sheet
  (CIS). 2) Supervisor opens the new-store approvals and approves it. 3) Repeat with a
  second store and reject it.
- Expected: the store is provisional until approved; the system issues the customer code
  (the salesperson never types it); the proposer cannot approve their own store; a
  rejected store is deactivated.
- Automated: `packages/backend/convex/outlets/enrolment.test.ts` — "requires a CIS or photo, valid files, the field's own territory and a contact"
- Automated: `packages/backend/convex/outlets/enrolment.test.ts` — "lets an in-scope manager approve, issuing the next free system code and verifying the pin"
- Automated: `packages/backend/convex/outlets/enrolment.test.ts` — "never lets the proposer decide, and rejection deactivates the provisional store"
- Open item: the customer code format is still to be agreed with Sunpride.

### B. Master Coverage Plan (MCP)

### UAT-MCP-01 · Salesperson writes and submits next month's MCP

- Role: Salesperson
- Preconditions: last week of the month; the salesperson's stores and route exist.
- Steps: 1) Field › Coverage › create the plan for next month. 2) Add the stores, apply
  the weekly routine, place each store on its days in route order. 3) Submit.
- Expected: invalid rows (inactive store, duplicate sequence, wrong route) are refused
  with a clear message and nothing is saved; after submit the plan is frozen for the
  salesperson.
- Automated: `packages/backend/convex/coverage/plans.test.ts` — "allows draft edits, freezes submission, requires return reason and resubmission"
- Automated: `packages/backend/convex/coverage/plans.test.ts` — "rejects invalid route, inactive outlet, and duplicate sequence atomically"

### UAT-MCP-02 · Supervisor approves; nobody approves their own plan

- Role: Supervisor, Salesperson
- Steps: 1) Salesperson tries to approve their own submitted plan. 2) Supervisor opens
  the review, checks stores, days and exceptions, and approves.
- Expected: step 1 is refused; after approval the plan shows approved by the supervisor
  with its version and signature, and the approved stores and route are frozen as signed.
- Automated: `packages/backend/convex/coverage/plans.test.ts` — "rejects self-approval by preparer and by submitter"
- Automated: `packages/backend/convex/coverage/plans.test.ts` — "lets the direct supervisor approve and records the capacity"
- Automated: `packages/backend/convex/coverage/plans.test.ts` — "freezes customer/link/route/outlet snapshots and refuses approved edits"

### UAT-MCP-03 · Supervisor returns a plan; salesperson fixes and resubmits

- Role: Supervisor, Salesperson
- Steps: 1) Supervisor returns the plan without a reason (refused), then with a reason. 2) Salesperson edits and resubmits. 3) Supervisor approves.
- Expected: a return needs a reason; the returned plan is editable again; the history
  shows submit, return and resubmit with who and when.
- Automated: `packages/backend/convex/coverage/plans.test.ts` — "allows draft edits, freezes submission, requires return reason and resubmission"

### UAT-MCP-04 · Manager approves while the supervisor is away

- Role: Supervisor, Manager
- Steps: 1) Record the supervisor as away for a period. 2) Salesperson submits. 3) Manager approves inside the away period. 4) After the period ends, try again with
  the manager on a new plan.
- Expected: the manager can approve only while the away period is in effect; outside it,
  the request goes back to the supervisor.
- Automated: `packages/backend/convex/coverage/plans.test.ts` — "routes to the supervisor's manager only while an away period is in effect"

### UAT-MCP-05 · Late plans show on the deadline list

- Role: Supervisor
- Steps: open Field › Coverage deadlines in the last week and in the first week of the month.
- Expected: people without a submitted MCP show as due, then overdue; approvals later
  than the first week of the month show as late.
- Automated: `packages/backend/convex/coverage/plans.test.ts` — "lists people without a submitted MCP as due or overdue and tracks approval lateness"

### C. Visit generation

### UAT-VIS-01 · The approved MCP becomes the day's planned visits

- Role: Salesperson, Supervisor
- Steps: 1) On the first day of the approved plan, open the day on the phone after it
  downloads. 2) Supervisor opens the same person's day.
- Expected: exactly the signed stores for today appear, in MCP order, using the approved
  store details (not later edits); yesterday is never back-filled.
- Automated: `packages/backend/convex/coverage/activation.test.ts` — "refuses future approved plans, then activates once due and generates only signed outlet visits"
- Automated: `packages/backend/convex/coverage/activation.test.ts` — "includes today's signed visit when activation runs after Manila midnight"
- Automated: `packages/backend/convex/mobile/bootstrap.test.ts` — "returns own signed plan, scoped outlet and link; no legacy price or order capture"

### D. Field execution on the phone

### UAT-FLD-01 · Check in at the first planned store; location is recorded

- Role: Salesperson
- Steps: 1) Tap Start at the first store of the day. 2) Repeat at a store far from its pin.
- Expected: check-in is accepted at any distance (no fixed radius, per the 2 October
  call); the location fix and the distance are recorded and far fixes are flagged for
  the supervisor, never refused.
- Automated: `packages/backend/convex/visits/commands.test.ts` — "has no distance limit: far fixes and bad pin data are recorded and flagged, never refused"
- Manual only: real GPS on the tester's phone.

### UAT-FLD-02 · Follow the MCP order: one open call at a time

- Role: Salesperson
- Steps: 1) Try to check in at the second store before the first. 2) Check in at the
  first store, then try the second store before tapping End. 3) End the first call,
  then check in at the second.
- Expected: steps 1 and 2 are refused with a clear message; step 3 works; Start, End and
  time spent per store are recorded.
- Automated: `packages/backend/convex/visits/commands.test.ts` — "follows the MCP order: an earlier planned stop must be closed first"
- Automated: `packages/backend/convex/visits/commands.test.ts` — "allows one open call at a time and records Start, End and time per account"

### UAT-FLD-03 · Record the call and its productivity

- Role: Salesperson
- Steps: 1) At a store record merchandising, then End. 2) At another store record
  nothing, then End. 3) As a truck seller, mark "no sales due to inventory" plus merchandising.
- Expected: any one listed activity makes the call productive; a visit with no activity
  still counts as a call but not productive; the truck seller's merchandising counts only
  with the no-sales-due-to-inventory marker.
- Automated: `packages/backend/convex/sfa/productive_call.test.ts` — "makes a call productive with any ONE listed activity, not a full checklist"
- Automated: `packages/backend/convex/sfa/productive_call.test.ts` — "counts a visited store with no activity as a nonproductive call"
- Automated: `packages/backend/convex/sfa/productive_call.test.ts` — "lets a truck seller's merchandising count only with the no-sales-due-to-inventory marker"

### UAT-FLD-04 · Work a whole morning offline, then sync

- Role: Salesperson
- Steps: 1) Put the phone in airplane mode. 2) Check in, record activities and End at
  two stores. 3) Close and reopen the app. 4) Turn the network back on and sync. 5) Sync again.
- Expected: work is kept on the phone through the restart; on reconnect both calls reach
  the server once, in order; a second sync creates nothing new; the phone shows all synced.
- Automated: `packages/backend/convex/acceptance/sfa_pilot.acceptance.test.ts` — "UAT-E2E-02 offline replay is idempotent, payload conflicts and missing dependencies reject, and MCP call order is enforced"
- Automated: `packages/backend/convex/mobile/push.test.ts` — "replays a batch across calls and clock advance without new domain/event/change rows"
- Automated: `packages/backend/convex/mobile/chaos.test.ts` — "drains a two-store offline day exactly once under 40 seeded mixes of airplane mode, lost requests, lost acks, duplicates and restart replays"
- Manual only: airplane mode, app restart and reconnect on the real phone (device protocol in `docs/qa/OFFLINE_CHAOS_TESTS.md`).

### E. Orders

### UAT-ORD-01 · Order for a planned store is approved by another person

- Role: Salesperson, Order approver
- Steps: 1) During the call, record the order intent on the phone. 2) Enter the sales
  order for the store in Commercial › Orders. 3) The salesperson tries to approve it. 4) The order approver approves it.
- Expected: the order is pending approval; self-approval is refused; once approved it is
  queued for SAP.
- Automated: `packages/backend/convex/acceptance/sfa_pilot.acceptance.test.ts` — "UAT-E2E-01 happy pilot day signs MCP, syncs a call, posts an approved order to SAP and monitors completion"
- Known gap: the phone does not yet create the sales order itself (order capture is off in
  the field app; it records an order intent). The order is entered in the web app for the
  pilot. Phone order entry is a later phase (2 October call, question 18).

### UAT-ORD-02 · Outside-call PO encoded by the sales admin

- Role: Sales admin, Salesperson
- Steps: 1) A store not in today's MCP sends a PO. 2) Sales admin encodes it in
  Commercial › Outside-call POs. 3) Salesperson records the activity for it. 4) Try to encode a PO for a store that is in today's MCP.
- Expected: steps 2 and 3 work; step 4 is refused (that store is a planned call).
- Automated: `packages/backend/convex/orders/outside_calls.test.ts` — "sales admin encodes a PO for a store outside the day's MCP; the salesperson records the activity"
- Automated: `packages/backend/convex/orders/outside_calls.test.ts` — "refuses stores in the day's plan, wrong salespeople, duplicates and bad lines"

### F. SAP posting

### UAT-SAP-01 · Approved order posts to SAP and gets its document number

- Role: Order approver, SAP admin
- Steps: 1) Approve an order (UAT-ORD-01). 2) Wait for the connector cycle. 3) Open the
  order and Integration › SAP; check the document in the SAP test company.
- Expected: the order shows sent to SAP with the SAP document number; the same order is
  never posted twice.
- Automated: `packages/backend/convex/acceptance/sfa_pilot.acceptance.test.ts` — "UAT-E2E-01 happy pilot day signs MCP, syncs a call, posts an approved order to SAP and monitors completion"
- Automated: `packages/backend/convex/integration/sap.test.ts` — "returns only pending outbound connector tasks"
- Manual only: the document in the SAP test company.

### UAT-SAP-02 · SAP is down: the order waits and retries

- Role: SAP admin
- Steps: 1) Stop the connector or make SAP refuse the document. 2) Approve an order. 3) Restore SAP.
- Expected: the order stays approved and waiting, retries with growing delays, and posts
  once SAP is back; after ten failures it moves to the dead-letter list for the admin.
- Automated: `packages/backend/convex/acceptance/sfa_pilot.acceptance.test.ts` — "UAT-E2E-03b SAP failures keep the approved order pending with exponential backoff and dead-letter the tenth failure"
- Manual only: stopping and restoring the real connector.

### G. Sync

### UAT-SYN-01 · Office changes reach the phone

- Role: Salesperson, Sales admin
- Steps: 1) Sales admin moves a store to another territory. 2) Salesperson syncs.
- Expected: the moved store disappears from the phone (it is not shown with the new
  owner's details); visits recorded on the phone stay.
- Automated: `packages/backend/convex/mobile/pull.test.ts` — "emits a tombstone rather than a foreign projection after outlet transfer"
- Automated: `packages/backend/convex/mobile/pull.test.ts` — "projects own upsert/tombstone and skips foreign-only pages with continuation"

### UAT-SYN-02 · Work synced after the 10 PM close goes to the supervisor

- Role: Salesperson, Supervisor
- Steps: 1) Record a call offline and keep the phone offline past 10:00 PM. 2) Sync. 3) Supervisor opens the late-sync queue and decides it.
- Expected: the call is accepted but flagged late and held for review; only the
  supervisor (not a viewer, not the salesperson) decides it, once.
- Automated: `packages/backend/convex/acceptance/sfa_pilot.acceptance.test.ts` — "UAT-E2E-03a a pilot call arriving after the 22:00 Manila close enters the supervisor late queue and can be decided"
- Automated: `packages/backend/convex/visits/commands.test.ts` — "accepts work after the 10 PM close, flags it late and holds it for supervisor review"

### H. Supervisor monitoring and exceptions

### UAT-SUP-01 · Supervisor sees the team's day

- Role: Supervisor
- Steps: open Field › Supervision for today; filter by channel; open one salesperson.
- Expected: each field person in scope shows calls done against plan; no one outside the
  supervisor's scope appears.
- Automated: `packages/backend/convex/supervision/supervision.test.ts` — "summarizes each field person in the supervisor's scope"
- Automated: `packages/backend/convex/supervision/supervision.test.ts` — "filters by channel and direct reports, and never widens scope"

### UAT-SUP-02 · Supervisor traces the route on the map

- Role: Supervisor
- Steps: open the activity map for a salesperson's day.
- Expected: check-ins are plotted at the verified store pins in check-in order, with
  planned stops not visited shown.
- Automated: `packages/backend/convex/supervision/supervision.test.ts` — "plots check-ins at verified outlet pins in check-in order"
- Automated: `packages/backend/convex/supervision/supervision.test.ts` — "adds planned stops not visited and hides raw fixes from viewers"

### UAT-SUP-03 · Supervisor decides field exceptions

- Role: Supervisor, Salesperson
- Steps: 1) Open the exceptions queue after UAT-FLD-01 (far check-in) and a skipped store. 2) Decide the far check-in. 3) A viewer tries to decide.
- Expected: open location exceptions are listed first, with missed stops and calls out of
  MCP order; the decision and its author are shown; a viewer can read but not decide; the
  salesperson cannot approve their own exception.
- Automated: `packages/backend/convex/supervision/supervision.test.ts` — "lists open geofence evidence first with the informational exceptions"
- Automated: `packages/backend/convex/supervision/supervision.test.ts` — "flags a call checked in after a later MCP stop"
- Automated: `packages/backend/convex/supervision/supervision.test.ts` — "lets a viewer read the queue but not decide"
- Automated: `packages/backend/convex/visits/commands.test.ts` — "approves an exception independently, never self-approves, retaining original proof"

### UAT-SUP-04 · Daily reports build themselves from the day

- Role: Salesperson, Supervisor
- Steps: after the day, open Field › Daily sales report and DAR / ROAR.
- Expected: the route seller's ROAR is built from the day's visits; reports are due by
  10:00 PM and late after; the DSR counts orders that became sales.
- Automated: `packages/backend/convex/field_reports/reports.test.ts` — "generates a route seller's ROAR from the day's visits"
- Automated: `packages/backend/convex/field_reports/reports.test.ts` — "is due by 10 PM Manila, late after, missing once a selling day closes"
- Automated: `packages/backend/convex/dsr/dsr.test.ts` — "builds the Annex B sheet from orders and visits"

### I. Full pilot day (end to end)

### UAT-E2E-01 · One pilot day, start to finish

- Role: all
- Steps: run UAT-MCP-01, UAT-MCP-02, UAT-VIS-01, UAT-FLD-01 to UAT-FLD-03, UAT-ORD-01,
  UAT-SAP-01 and UAT-SUP-01 in order for one salesperson and six stores.
- Expected: every step succeeds with the same data flowing through; the supervisor sees
  the completed call and the order reaches SAP.
- Automated: `packages/backend/convex/acceptance/sfa_pilot.acceptance.test.ts` — "UAT-E2E-01 happy pilot day signs MCP, syncs a call, posts an approved order to SAP and monitors completion"

### UAT-E2E-02 · Offline day with replays

- Role: Salesperson
- Steps: run UAT-FLD-04, then UAT-FLD-02, with the phone offline.
- Expected: as in those scenarios.
- Automated: `packages/backend/convex/acceptance/sfa_pilot.acceptance.test.ts` — "UAT-E2E-02 offline replay is idempotent, payload conflicts and missing dependencies reject, and MCP call order is enforced"

### UAT-E2E-03 · Exceptions day

- Role: Salesperson, Supervisor, SAP admin
- Steps: run UAT-SYN-02, UAT-SUP-03 and UAT-SAP-02.
- Expected: as in those scenarios.
- Automated: `packages/backend/convex/acceptance/sfa_pilot.acceptance.test.ts` — "UAT-E2E-03a a pilot call arriving after the 22:00 Manila close enters the supervisor late queue and can be decided"
- Automated: `packages/backend/convex/acceptance/sfa_pilot.acceptance.test.ts` — "UAT-E2E-03b SAP failures keep the approved order pending with exponential backoff and dead-letter the tenth failure"

## Open items for Sunpride (affect expected results)

- KAS and Booking productive target: 85% (email) or 90% (memo).
- Whether a visit outside the approved plan can ever be paid for per diem, and its proof.
- Customer code format for new stores (UAT-SET-03).
- Handheld printer model and receipt layout (receipt printing is outside this pilot script).

## Sign-off sheet

| Scenario   | Tester | Date | Pass / Fail / Blocked | Defect | Notes |
| ---------- | ------ | ---- | --------------------- | ------ | ----- |
| UAT-SET-01 |        |      |                       |        |       |
| UAT-SET-02 |        |      |                       |        |       |
| UAT-SET-03 |        |      |                       |        |       |
| UAT-MCP-01 |        |      |                       |        |       |
| UAT-MCP-02 |        |      |                       |        |       |
| UAT-MCP-03 |        |      |                       |        |       |
| UAT-MCP-04 |        |      |                       |        |       |
| UAT-MCP-05 |        |      |                       |        |       |
| UAT-VIS-01 |        |      |                       |        |       |
| UAT-FLD-01 |        |      |                       |        |       |
| UAT-FLD-02 |        |      |                       |        |       |
| UAT-FLD-03 |        |      |                       |        |       |
| UAT-FLD-04 |        |      |                       |        |       |
| UAT-ORD-01 |        |      |                       |        |       |
| UAT-ORD-02 |        |      |                       |        |       |
| UAT-SAP-01 |        |      |                       |        |       |
| UAT-SAP-02 |        |      |                       |        |       |
| UAT-SYN-01 |        |      |                       |        |       |
| UAT-SYN-02 |        |      |                       |        |       |
| UAT-SUP-01 |        |      |                       |        |       |
| UAT-SUP-02 |        |      |                       |        |       |
| UAT-SUP-03 |        |      |                       |        |       |
| UAT-SUP-04 |        |      |                       |        |       |
| UAT-E2E-01 |        |      |                       |        |       |
| UAT-E2E-02 |        |      |                       |        |       |
| UAT-E2E-03 |        |      |                       |        |       |

Signed for Sunpride: ______________________ Date: __________

Signed for the delivery team: ______________________ Date: __________
