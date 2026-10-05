# Offline and poor-network chaos tests — field apps

Tracker: SP-0025 (QSR-003), milestone `12 · Field sales pilot (Cebu)`.

Acceptance: test airplane mode, intermittent connectivity, long offline periods, app
restarts and reconnect during every critical field and van transaction. The business
guarantees under test are ADR-019 (offline business guarantees), ADR-020 (device
registration and revocation) and ADR-021 (mobile sync gateway).

This document has three parts:

1. The scenario catalogue below. Each scenario names the automated tests that inject the
   fault on every commit (server, Android and iPhone), and a `Device check:` line for the
   same fault on a real phone.
2. A device protocol for the pilot phones, run once per release candidate before UAT
   (`docs/qa/SFA_UAT_SCENARIOS.md`, UAT-FLD-04 and UAT-E2E-02).
3. Findings from the chaos runs, the coverage status per transaction, and the gaps that
   remain. SP-0025 is not complete until the device sign-off sheet is filled in and the
   transactions listed under "Not yet testable" exist and have their own scenarios.

`packages/backend/convex/acceptance/chaos_catalog.test.ts` fails the build if a scenario
loses its automated or device marker, or if a referenced test (TypeScript `it("…")`,
Kotlin `@Test fun …` or Swift `func test…`) is renamed or deleted.

## What the automated suites do

| Suite                                                                           | Runs in                      | How faults are injected                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/backend/convex/mobile/chaos.test.ts`                                  | `bun run test` (convex-test) | A seeded fault injector between a phone-like outbox and the real `mobile/push:applyOne` mutation: airplane mode, lost request, lost acknowledgement, duplicate delivery, restart replay of acknowledged work, clock advance. |
| `apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt` | Gradle JVM unit tests        | A seeded fault transport around the production `VisitSync`, `BootstrapClient` and store rules; restarts discard the sync engine and reopen the same store.                                                                   |
| `apps/field-ios/FieldIOSTests/ChaosSyncTests.swift`                             | `bun run native:ios`         | A seeded fault stub under the production sync clients, `AppModel` and the encrypted SQLCipher store; restarts reopen the same encrypted database.                                                                            |

Every seeded run checks the same outcome: each queued operation reaches the server
exactly once, in the order it was saved; a dependent (note, call sheet, check-out) is sent
only after its check-in is acknowledged; a resend carries byte-identical operation bytes;
nothing queued is deleted; and the phone never shows "All synced" while anything is
pending, sending, held or awaiting review.

Fault words used below:

- Airplane mode: the request never leaves the phone.
- Lost acknowledgement: the server saves the work, the answer never reaches the phone
  (weak signal, or the app is killed mid-send).
- Duplicate: the same request arrives twice at once (foreground and background sync, or
  a network retry).
- Long offline: hours to days without a successful sync, past the 24-hour offline cache
  and lease and up to the 7-day late window (ADR-019; both values provisional).
- Restart: the app process dies and starts again with only what it saved on the phone.

## Scenarios

### CHAOS-01 · A whole day saved offline drains exactly once

- Transactions: check-in, note, call sheet, check-out at two stores (phones); a planned MCP
  day on all three suites. Server: planned check-in against the signed plan, every
  structured activity form (ICO inventory check, merchandising, price check, promotion,
  order intent, call sheet, note), a completed check-out, then the next planned stop closed
  as nonproductive. Android: the same planned day with every form the phone captures (note,
  call sheet, merchandising, promotion, inventory check, price check) and a "no sale" close.
  iPhone: the planned day queued through the app's own Start/End commands (note, call sheet,
  completed close, then a "no sale" close at the next stop). The phone-side fake servers
  apply the server's call rules (one open call, plan order, one check-in per planned stop, a
  reason for "no sale"), so a phone that sent anything out of order fails the run.
- Fault: airplane mode, then a mix of lost requests, lost acknowledgements, duplicates,
  mid-batch failures and restarts, over 12–50 random seeds.
- Expected: both calls reach the server once, in order; each planned stop is linked to
  exactly one call; replaying the whole queue after reconnect changes nothing. Offline, the
  phone refuses the next planned stop until the earlier one is started and ended, refuses a
  second start of the same stop, and refuses a "no sale" close without a reason.
- Automated: `packages/backend/convex/mobile/chaos.test.ts` — "drains a two-store offline day exactly once under 40 seeded mixes of airplane mode, lost requests, lost acks, duplicates and restart replays"
- Automated: `packages/backend/convex/mobile/chaos.test.ts` — "drains a planned MCP day with every structured activity form and a nonproductive stop exactly once under 30 seeded fault mixes"
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt` — "seededOfflineDayTwoStoresDrainsExactlyOnceInEnqueueOrder"
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt` — "plannedDayEveryFormAndNoSaleStopDrainsExactlyOnceUnderSeededFaults"
- Automated: `apps/field-ios/FieldIOSTests/ChaosSyncTests.swift` — "testSeededOfflineDayDrainsTwoStoresExactlyOnceInEnqueueOrder"
- Automated: `apps/field-ios/FieldIOSTests/ChaosSyncTests.swift` — "testPlannedDayStopOrderAndNoSaleCloseDrainExactlyOnceUnderSeededFaults"
- Device check: protocol steps D1–D4.

### CHAOS-02 · The answer is lost after the server saved the work

- Transactions: check-in, note, call sheet, merchandising, check-out.
- Fault: lost acknowledgement, then reconnect.
- Expected: the phone resends the same bytes and receives the original acknowledgement;
  the server counts the work once. Changed bytes under the same request ID are a conflict.
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt` — "lostAckReconnectReturnsIdenticalAckWithoutDoubleCounting"
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt` — "callSheetAndStructuredActivityLostAcksReplayWithoutMutation"
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt` — "fakeServerRejectsChangedBytesForSameClientRequestId"
- Automated: `apps/field-ios/FieldIOSTests/ChaosSyncTests.swift` — "testLostAcknowledgementReconnectReturnsSameAckWithoutDoubleCount"
- Automated: `packages/backend/convex/mobile/push.test.ts` — "conflicts on changed payload or different device, and concurrent same-key calls commit once"
- Automated: `packages/backend/convex/mobile/chaos.test.ts` — "returns the stored ack for a planned check-in whose answer was lost, and refuses a second check-in for the same planned stop under a new request ID"
- Device check: protocol step D3.

### CHAOS-03 · The signal drops in the middle of a batch

- Transactions: a batch of queued operations (up to 20 per send).
- Fault: the server commits the first part of the batch, then the connection fails.
- Expected: the saved part is not repeated on the server; the rest is sent later in order.
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt` — "partialBatchCommitReplaysOriginalBytesAndDrainsOnce"
- Automated: `apps/field-ios/FieldIOSTests/ChaosSyncTests.swift` — "testMidBatchCommitReplaysPrefixOnceAndKeepsDependentOrder"
- Device check: protocol step D3.

### CHAOS-04 · The app is killed and reopened between every step

- Transactions: every queued operation, including one being sent.
- Fault: restart after each save and after each server acknowledgement.
- Expected: work saved before the restart is still queued; an interrupted send is resent
  with the same bytes; nothing is counted twice.
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt` — "restartAfterEveryAckRecoversSendingRowsAndFrozenBytes"
- Automated: `apps/field-ios/FieldIOSTests/ChaosSyncTests.swift` — "testRestartBetweenEveryStepReplaysFrozenBytesAndFinishesOnce"
- Automated: `apps/field-android/app/src/androidTest/java/com/sunpride/field/sync/RoomVisitSyncTest.kt` — "interruptedAckRecordingReplaysSameServerAckAndFinishesOnce"
- Device check: protocol step D2.

### CHAOS-05 · Work arrives out of order after a restart

- Transactions: check-out sent before its note was acknowledged; the next planned stop's
  check-in sent before the earlier stop was started or closed.
- Fault: reordered delivery.
- Expected: the server rejects it (`dependency_missing`, `mcp_order` or `call_open`)
  without using up its request ID; sent again in order, the same bytes are accepted.
- Automated: `packages/backend/convex/mobile/chaos.test.ts` — "rejects a dependent sent ahead of its dependency after a restart without consuming its key, then accepts it in order"
- Automated: `packages/backend/convex/mobile/chaos.test.ts` — "refuses the next planned stop while the earlier stop is open or unclosed after a restart, without consuming its key, then accepts the same bytes in order"
- Automated: `packages/backend/convex/mobile/push.test.ts` — "rejects missing dependency and unsupported middle item without consuming keys; later independent operation works"
- Device check: not reproducible by hand (the apps never send out of order); covered by the automated tests only.

### CHAOS-06 · Foreground and background sync race on reconnect

- Transactions: the whole queue.
- Fault: duplicate delivery from two sync flights at the same time.
- Expected: each operation is committed once and both flights see the same
  acknowledgements; on the phone only one flight runs at a time.
- Automated: `packages/backend/convex/mobile/chaos.test.ts` — "commits each operation once when foreground and background flights resend the same queue concurrently"
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/sync/VisitSyncTest.kt` — "overlappingSyncCallsShareOneFlight"
- Device check: protocol step D4.

### CHAOS-07 · Long offline: hours and days without signal

- Transactions: queued visits; new work after the offline lease expires.
- Fault: 7, 16, 72 and 216 hours without a successful sync.
- Expected: queued work is kept and sent when signal returns; after the lease expires the
  phone refuses new work until it refreshes; a day synced up to 7 days late is accepted and
  flagged for supervisor review; older work is refused and kept on the phone for review.
- Automated: `packages/backend/convex/mobile/chaos.test.ts` — "accepts a day synced six days late and flags it for supervisor review, but refuses work older than the late window without writing"
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt` — "expiredLeaseAndStaleCachePreserveQueuedWorkUntilReconnect"
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt` — "rebootstrapAfterLongOfflineRetriesRecentWorkAndReviewsWorkBeyondSevenDays"
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt` — "offlineLeaseRenewalStaysHeldWithoutCrashingAndVerifiedBootstrapRenews"
- Automated: `apps/field-ios/FieldIOSTests/ChaosSyncTests.swift` — "testLongOfflineExpiredLeasePreservesWorkAndRequiresBootstrapBeforeRetry"
- Device check: protocol step D5.

### CHAOS-08 · Reconnect after the phone was revoked or the scope changed

- Transactions: queued visits.
- Fault: on reconnect the server answers 401, revoked device, 409 (cursor invalid or
  rebootstrap required), or the phone was revoked while offline.
- Expected: queued work is held, never deleted and never sent past the revocation; an
  unexplained 401 refreshes once and does not invent a revocation; only a verified
  bootstrap of the same person, phone and scope resumes the held queue.
- Automated: `packages/backend/convex/mobile/chaos.test.ts` — "refuses the rest of the queue when the phone was revoked while offline, keeps accepted work, and never replays past the revocation"
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt` — "revokedUnauthorizedAndCursorConflictHoldQueuedWorkOnReconnect"
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt` — "verifiedSameScopeBootstrapAfter409ResumesFrozenQueue"
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt` — "failedRebootstrapStaysHeldUntilVerifiedForegroundBootstrap"
- Automated: `apps/field-ios/FieldIOSTests/ChaosSyncTests.swift` — "testReconnectRevocationAnd409HoldWithoutDeletingQueuedWork"
- Automated: `apps/field-ios/FieldIOSTests/ChaosSyncTests.swift` — "testUnresolved401RetainsPendingWorkWithoutInventingRevocation"
- Device check: protocol step D6.

### CHAOS-09 · Office changes download over a bad connection

- Transactions: delta pull (office changes) and the day download (bootstrap).
- Fault: lost request or lost answer on any page, duplicate pages, restart mid-download.
- Expected: a pull retries the same cursor and only moves past pages it applied; a day
  download never replaces the previous day with half a download; queued work survives.
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt` — "interruptedPullRetriesSameCursorAndKeepsDurableIntents"
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt` — "interruptedBootstrapNeverPromotesPartialSnapshotOrDropsQueue"
- Automated: `apps/field-ios/FieldIOSTests/ChaosSyncTests.swift` — "testPullDeltaFaultsAndRestartPreserveCursorAndQueuedWork"
- Automated: `apps/field-ios/FieldIOSTests/ChaosSyncTests.swift` — "testBootstrapPageFaultAndRestartNeverPromotePartialSnapshot"
- Device check: protocol step D7.

### CHAOS-10 · The phone never claims "All synced" too early

- Transactions: the Today sync status.
- Fault: any of the above, at every step.
- Expected: "All synced" only when nothing is pending, sending, held or awaiting review,
  including held work from a previous scope.
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/sync/ChaosSyncTest.kt` — "syncStatusNeverClaimsAllSyncedWithUnresolvedRows"
- Automated: `apps/field-ios/FieldIOSTests/ChaosSyncTests.swift` — "testTodayStatusNeverClaimsAllSyncedForPendingDeferredReviewOrHeldWork"
- Device check: protocol steps D1–D7 (read the status line after every step).

### CHAOS-11 · Photo evidence upload over a bad connection

- Transactions: visit photo (upload URL, file upload, attach) after the check-in is
  acknowledged. Android only: the iPhone app has no photo capture yet.
- Fault: airplane mode before the upload; lost acknowledgement of the attach, then a
  retry with a fresh upload of the same photo.
- Expected: the photo stays on the phone as pending until it uploads; a retried attach
  resolves to the original evidence row (no second file); a different photo type or size
  under the same checksum is a conflict; the visit outbox is never blocked by a photo.
- Automated: `packages/backend/convex/mobile/chaos.test.ts` — "resolves a retried photo attach whose answer was lost to the original evidence row, and refuses changed metadata under the same checksum"
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/evidence/EvidenceUploaderTest.kt` — "offlineKeepsThePhotoPendingAndALostAttachResponseResolvesToTheSameRow"
- Automated: `apps/field-android/app/src/test/java/com/sunpride/field/evidence/EvidenceUploaderTest.kt` — "damagedFilesRejectedStartsAndHeldPartitionsNeverUpload"
- Device check: protocol step D8 (Android only).

## Device protocol (pilot phones)

Run on one Android pilot phone and one iPhone with the release-candidate build, enrolled
to a DEV pilot salesperson with an approved MCP for today (UAT-SET-02, UAT-VIS-01). One
tester holds the phone; a second tester watches the supervisor's web view. Record each step
on the sheet below. A phone emulator or simulator may be used for a dry run: Android
emulator `adb -s emulator-5554 shell cmd connectivity airplane-mode enable|disable` and the
emulator console `network delay`/`network speed`; iPhone simulator with the Network Link
Conditioner "100% Loss" and "Very Bad Network" profiles. The dry run does not replace the
real phones.

- D1 Airplane mode: turn airplane mode on. On today's plan, check in at planned store 1, add
  a note and a call sheet (Android: also each visit form), check out as completed; at
  planned store 2 check in and end the call as not productive with a reason. Before ending
  store 1, try to start store 2: the phone must refuse. The status must read
  "Saved on device • N pending".
- D2 Restart: with airplane mode still on, force-close the app (swipe away) and reopen it
  after each of D1's saves. Nothing saved may disappear.
- D3 Intermittent: turn airplane mode off for 2–3 seconds and on again, ten times, while
  the phone is syncing (or walk into a weak-signal spot). Then leave the network on.
- D4 Reconnect: with the network on, press Sync now, then lock the phone so background
  sync also runs. The web view must show each call once, in order; Sync again creates
  nothing new; the status reads "Synced at <time>".
- D5 Long offline: keep the phone in airplane mode with queued work for more than 24 hours
  (overnight plus a day). New check-ins must be refused until the phone refreshes; on
  reconnect the queued day arrives and shows in the supervisor's late queue.
- D6 Revoked on reconnect: queue work offline, ask the administrator to revoke the phone,
  then reconnect. The work stays on the phone as held, nothing is sent, and the phone says
  it was removed. Re-enrol only after recording the result.
- D7 Bad connection download: on a weak or throttled network, pull to refresh and reopen
  the app during the download. Today's list must stay complete (old or new, never half).
- D8 Photo on a bad connection (Android only): in airplane mode, take two visit photos
  after check-in; reconnect for a few seconds and drop again mid-upload, then reconnect.
  Each photo appears once on the supervisor's visit view; the phone deletes its copy only
  after the upload is confirmed.

| Step | Android: Pass / Fail | iPhone: Pass / Fail | Tester | Date | Defect | Notes |
| ---- | -------------------- | ------------------- | ------ | ---- | ------ | ----- |
| D1   |                      |                     |        |      |        |       |
| D2   |                      |                     |        |      |        |       |
| D3   |                      |                     |        |      |        |       |
| D4   |                      |                     |        |      |        |       |
| D5   |                      |                     |        |      |        |       |
| D6   |                      |                     |        |      |        |       |
| D7   |                      |                     |        |      |        |       |
| D8   |                      | n/a (not built)     |        |      |        |       |

## Findings from the first run (4 October 2026)

- Fixed — Android: when the offline lease expired and the refresh lost signal halfway,
  the sync crashed (it tried to mark a held queue as "retry pending"). It now stays held
  without crashing and resumes after a verified refresh
  (`ChaosSyncTest` — "offlineLeaseRenewalStaysHeldWithoutCrashingAndVerifiedBootstrapRenews").
- By design — Android: after a 409 whose refresh lost signal, background sync leaves the
  held queue alone; the next time the salesperson opens the app it refreshes and sends the
  queue. No work is lost (`ChaosSyncTest` — "failedRebootstrapStaysHeldUntilVerifiedForegroundBootstrap").
- iPhone: no defects found.
- Server: no defects found.

- Server, second run (5 October 2026): the planned MCP day (planned check-in, every
  structured activity form, nonproductive close), MCP stop order under reordering and
  lost-answer photo retries all held under fault injection. No defects found.

- Phones, third run (5 October 2026): the planned day with a "no sale" stop on Android
  (30 seeds, every form the phone captures) and iPhone (12 seeds, through the app's own
  Start/End commands), against fake servers that apply the server's call rules. Every run
  sent each call once, in plan order, with the reason kept on the "no sale" close; the
  phones refused out-of-order, repeated and reasonless starts and ends while offline. No
  defects found. The iPhone run is capped at 12 seeds because its retry back-off waits on
  the real clock.

## Coverage status by transaction

| Transaction                                          | Server    | Android         | iPhone          | Real phones |
| ---------------------------------------------------- | --------- | --------------- | --------------- | ----------- |
| Unplanned check-in, note, check-out                  | Yes       | Yes             | Yes             | Not run     |
| Planned (MCP) check-in and stop order                | Yes       | Yes             | Yes             | Not run     |
| Structured activity forms                            | Yes       | Yes (see below) | Yes (see below) | Not run     |
| Nonproductive ("no sale") check-out                  | Yes       | Yes             | Yes             | Not run     |
| Photo evidence upload                                | Yes       | Yes             | Not built       | Not run     |
| Delta pull and day download                          | n/a       | Yes             | Yes             | Not run     |
| Collections, task completion                         | Not built | —               | —               | —           |
| Van POS (sell, collect, receipt, truck stock, count) | Not built | —               | —               | —           |

Forms per phone: Android faults every form it can capture (note, call sheet,
merchandising, promotion, inventory check, price check); the iPhone app captures only the
note and call sheet, and both are faulted. Order intent is faulted on the server only:
neither phone captures orders yet (order capture is switched off in the downloaded
settings). "Not built": the server refuses collections and task completion
(`unsupported_operation`), the van POS app does not exist, and the iPhone app has no photo
capture. "Not run": D1–D8 need the pilot phones and testers; the sign-off sheet above is
still empty.

## Acceptance status

Everything the field apps and server can do today is fault-tested on every commit. The
issue is not complete until both of these are done; neither can be done in code:

1. Real-phone run: D1–D8 on one Android pilot phone and one iPhone, with the sheet above
   signed. D5 needs a phone left offline for more than a day. Owner and date to be agreed.
2. Dependency acceptance: collections, task completion, iPhone photos and the van POS app
   get their chaos scenarios when they are built (tracked as follow-up work, not as part of
   this run).

## Not yet testable

- Van POS (sell, collect, receipt print/reprint, truck stock, end-of-day count): the
  separate Android van POS app (ADR-010) is not built yet. Add its chaos scenarios when it
  is, following ADR-019 and `docs/architecture/VAN_POS_HARDWARE.md`.
- Collections and task completion: the server answers `unsupported_operation` for
  `collection.record` and `task.complete` today, so there is nothing to sync yet.
- Photo evidence on iPhone: the iPhone app has no photo capture yet; add it to CHAOS-11
  when it does.
- The first photo attach's storage checks (size, type, checksum against the stored file)
  cannot run under convex-test, which has no file metadata; they are covered as isolated
  checks in `visits/evidence.test.ts` and on the real phone in step D8.
- Device steps D1–D7 on the pilot phones need the pilot team and their phones.
