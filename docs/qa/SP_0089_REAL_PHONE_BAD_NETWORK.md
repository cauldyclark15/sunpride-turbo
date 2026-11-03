# SP-0089: real-phone bad-network run D1–D8

## Execution status

**NOT RUN on either phone.** This is a preparation packet, not a device test report.
The `sp/89` lane prohibits phones, device-control commands, installations and other
agents. No phone, network setting, enrollment or server business data was changed
while preparing it. Unit tests, simulated faults and source inspection cannot
satisfy this issue's real-phone acceptance.

**Needed from jc:** assign a device-authorized tester and an office observer, approve
a dedicated test enrollment for the permanent-revocation case, and schedule the
Android and iPhone run, including the more-than-24-hour offline interval. Explicitly
authorize resuming iPhone testing (currently paused). This lane does not lift its own
no-phone restriction. No Sunpride client data or policy answer is needed to prepare
or execute these cases against clearly marked test accounts.

Use [the result sheet](SP_0089_BAD_NETWORK_RESULTS.csv) for a **new copy per candidate**.
Every row starts `NOT_RUN`; do not fill a pass from an older run or automated suite.
The original D1–D8 definitions are in
[Offline chaos scenarios](OFFLINE_CHAOS_TESTS.md#device-protocol-pilot-phones).
The corrections below keep their business intent without relying on outdated
capability, lease or recovery assumptions.

## Candidate and safety prerequisites

The authorized tester completes these before disconnecting either phone:

1. Record the test date/time with timezone, tester and office observer, candidate
   source commit, each installed version/build and artifact checksum, API candidate
   revision and test environment. A source commit alone does not identify an installed
   build. If an artifact's provenance is unknown, stop acceptance until resolved.
2. Use the designated Xiaomi field phone and jc's designated iPhone only after device
   authorization. Never use the personal Galaxy, an emulator or simulator as a substitute.
   Record model and OS version, not serial, phone number or key material.
3. Preserve all existing unsent work, accounts and keys. Do not clear app data, uninstall,
   factory-reset, change the phone clock, replace a real enrollment, or revoke an active
   field phone to make a case pass. Permanent revocation is not a routine cleanup step.
4. Use one distinct, clearly marked test salesperson per phone and a scoped supervisor
   observer on the same approved test environment. Establish the baseline with each
   person's own account; never use an administrator session as the salesperson.
5. Arrange an approved current-day plan with two ordered test stores for D1–D4. Record
   the offered visit forms and any required activity rules. Use fresh eligible test
   stops for later phases; never reuse a completed stop as if it were a new visit.
6. While online, verify bound/active enrollment, download the complete day and record
   the exact route order, office baseline, pending/sending/review/held and photo counts,
   last successful sync, cache expiry and offline-access expiry. Existing unresolved
   real work is a stop condition, not permission to delete it.
7. Confirm airplane mode actually removes all usable paths: Wi-Fi can remain enabled.
   Record the actual disconnection/reconnection times. Apply any throttling only to
   the authorized test connection, never to the Mac's shared network or other services.
8. Keep evidence outside the repository under a restricted run folder. Use harmless test
   notes and photos. Redact names, contacts, coordinates and account identifiers. Never
   record passwords, tokens, request signatures, public/private keys or raw DB exports.

This lane's reservation is API `5010`, web `5011`, database `sunpride_lane_sp89`.
All lane-local services must stay within the reserved `5010..5019` range.
No service or fixture was started here. A future tester must verify the phones can
reach the approved test origin without repointing the live site or exposing a new
public endpoint. A phone's loopback address is not the Mac. The existing showcase
must not be used for revocation or other fixture mutations without separate approval.

## Execution order and per-case checks

Run D1 and D2 together, then D3, D4, D7, D8, D5, and **D6 last** on each phone.
D6 permanently revokes the test enrollment; doing it earlier would invalidate later
cases. Run D5 in real elapsed time; crossing a mocked clock is not phone evidence.
Capture the visible sync state and queue/photo counts at every transition, including
a prior-scope hold if one exists. "All synced" is unacceptable while anything is
pending, sending, held or awaiting review; exact wording may differ by platform.

### D1 — Save a planned day without a connection

- Disconnect after a complete verified download. At store 1: Start, save a harmless
  note and call sheet, and each supported configured visit form. Before ending store 1,
  try starting store 2; it must refuse without creating another call.
- End store 1 with all governing requirements met. At store 2, Start and end with a
  nonproductive/no-sale reason. Confirm the reason is required and preserved.
- Expected: saved work remains visible in the local queue in stop order; the office
  baseline is unchanged while offline. A completed End alone is not proof of a
  productive call. Record actual form coverage separately for each platform.

### D2 — Reopen after every saved action

- During D1, close and reopen the app offline after Start, note, call sheet, other
  forms and each End. Record the exact close method (app switcher or separately
  authorized process termination); swiping away alone is not proof of forced process
  death or a device reboot.
- Expected: every saved action and queue count persists; the open-call and stop-order
  guards survive reopening. A missing item fails the case even if later sync succeeds.

### D3 — Repeated connection loss while sending

- During sync, reconnect for 2–3 seconds and disconnect again, ten times, recording
  timestamps and the queue state. Then leave the connection available.
- Expected: original work survives partial sends; dependencies reach the office in
  order, and no visit/activity is counted twice. The observer reconciles each test
  visit's note, call sheet, forms, reason and End against the offline action log.
- Toggling signal does not prove a response was lost after a commit. Record the fault
  actually observed. Claim lost-ack or mid-batch-commit coverage only with redacted
  server/transport correlation showing that specific event; otherwise leave that
  subcase unproved rather than inferring it from a successful reconnect.

### D4 — Foreground and background reconnect

- With queued test work and signal restored, tap Sync now, background/lock the phone,
  then reopen. Record any actual OS background attempt and its result. Repeat Sync now
  after the first reconciliation and compare office counts and event identities.
- Expected: calls, activities and End facts exist once, in order; a replay creates
  nothing new. Only acknowledged work leaves the queue. Background execution is best
  effort; a manual sync is not evidence that an OS background task ran. If background
  delivery is not observed, record that subcase as unproved, not passed.

### D5 — More than one day offline, including lease expiry

- On fresh eligible test stops, queue work while the server-issued offline lease is
  valid. Record disconnect time, service date and actual lease/cache expiries; stay
  disconnected for more than 24 hours, including the actual lease expiry.
- After expiry, attempt new Start and other new recording actions without changing
  clocks. Expected: new recording is refused, but previously saved work remains.
  An "Offline" label by itself proves neither valid nor expired access.
- Reconnect as the same person/device/scope, allow supported access refresh, and sync.
  Expected for this within-window test: original work arrives once and the office
  flags the late work for review. Compare old-day facts and queue dispositions before
  and after; a fresh day's download must not erase the old queue.
- The current field bundle normally ends visit access at that service day's 22:00
  Asia/Manila close (some grants can end earlier), **not a fixed 24-hour lease**.
  The greater-than-24-hour wait is a test duration, not a claim about access policy.
  Record any changed authorization or rejection separately; do not relabel it synced.

### D6 — Permanently revoked test enrollment reconnects

- **Only after jc approves the dedicated disposable test enrollment and reconciliation
  plan:** queue identifiable test work offline and record the unchanged office baseline.
  The authorized administrator revokes that exact test enrollment and reads its status
  back before the tester reconnects.
- Expected: no new business writes from that queue after withdrawal; the app stops
  sending and preserves unacknowledged work/photos for supervised review. Inspect
  phone state as well as office counts; absence on the office screen alone does not
  prove the phone retained its evidence.
- Verify permanent revocation, not just suspension or an unexplained 401. Do not
  reinstate, re-register or replay the revoked key/operation IDs from another phone.
  Re-enrollment is not recovery of the revoked outbox. If permanent revocation was
  not authorized or cannot be isolated safely, mark D6 `BLOCKED`, not passed.

### D7 — Interrupted day download and changes

- With the old complete route and an unsent test action saved, begin downloading a
  deliberately changed approved test route over an interrupted/throttled connection.
  Reopen during the download and record the visible stores/order plus queue counts.
- Expected: only a complete old or complete new snapshot is visible, never a partial
  mixture; the queued action survives. On reconnect, complete the download and confirm
  the expected office change is visible. Exercise an office-change refresh separately
  from a full day download; record both outcomes.
- Record evidence that a page/transfer actually was interrupted. If the fixture fits
  one response and interruption is not observed, do not claim multi-page atomicity.

### D8 — Interrupted photo upload on both platforms

- Both candidate source apps now contain photo capture/upload; do not copy the old
  sheet's iPhone "not built" exemption. Confirm the installed build exposes it. If not,
  mark that row blocked and record the exact build/capability gap.
- Start a fresh eligible test call offline and take two harmless, distinct photos before
  End. Reopen to confirm they remain pending. Briefly reconnect and interrupt during
  upload, then leave signal available. Upload must wait for the Start acknowledgement.
- Expected: visit operations can progress independently of a pending photo; both photos
  eventually appear once in the office. An interrupted upload/attach keeps the local
  copy pending until confirmed attachment; no copy disappears on an uncertain result.
  Verify retained/deleted local file state only through authorized privacy-safe
  diagnostics. If unavailable, record that part as unproved rather than inferring it
  from a photo thumbnail or queue count.

## Evidence and sign-off

For each of the sixteen device/case rows record actual start/end timestamps, tester,
fault applied, before/after phone and office evidence references, expected/observed
counts, disposition of each queued action/photo, result, defect link and restoration.
Record candidate metadata above in a restricted companion run note. Blank fields are
not evidence. `PASS` requires all of that case's checks on that physical phone;
use `FAIL` for observed incorrect behavior, `BLOCKED` for an unavailable prerequisite,
and `NOT_RUN` when not attempted. Explain every non-pass. Do not turn incomplete
subcases into a pass or use `N/A` to waive iPhone photos.

The office observer must read actual persisted visit/activity/evidence facts through
an authorized view, not just an optimistic phone counter or a successful HTTP status.
A restricted correlation map can retain request/event identities for duplicate checks;
public board comments contain only redacted counts and outcomes. Save the same
readback after the repeated sync to demonstrate unchanged totals, not just a screenshot
of one visit. No raw SQL export or secret-bearing network trace is needed.

At the end, restore the authorized test connection, confirm phone access/lock state,
stop only run-owned test resources, and reconcile all pending/review/held work with the
observer. Preserve failed/revoked queues and keys under custody until their owner signs
off; never uninstall or clear data to obtain a clean screen. Record the final office
counts, unresolved items, restored settings and both reviewers' names/timestamps.

This issue remains incomplete until actual results from one Android and one iPhone
cover D1–D8, with any failed/blocked/unproved check explicitly resolved. No part of this
packet asserts that an installed build, hosted environment or current integrations
passed these cases.

## Source checkpoints used for preparation

These identify inspected implementation boundaries, not executed device evidence:

- `apps/api/src/core/scope.js`: `nextDayClose` uses 22:00 Manila.
- `apps/api/src/domains/fieldsync/projections.js`: field bundle lease and complete-day
  projection, including optional shorter partner grants.
- `apps/api/src/domains/visits/commands.js`: check-in service date and late window.
- `apps/api/src/domains/visits/shared.js`: `touchVisit` marks late work pending review.
- `apps/api/src/domains/org/devices.js`: permanent revoked-state transition guard.
- `apps/field-android/app/src/main/java/com/sunpride/field/evidence/EvidenceUploader.kt`:
  separate upload/attach flow and retained pending bytes until success.
- `apps/field-ios/FieldIOS/Sources/UI/DiagnosticVisit/PhotoCaptureScreen.swift` and
  `apps/field-ios/FieldIOS/Sources/Evidence/EvidenceUploader.swift`: iPhone photo capture
  and upload/attachment path exist in source; actual installation is unverified.
