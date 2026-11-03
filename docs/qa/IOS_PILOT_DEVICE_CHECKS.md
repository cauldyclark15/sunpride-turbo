# iOS pilot device checks (SP-0001)

## Status and authority

Preparation only. No physical-device checks, native build, OS-delivered task or crash collection were performed for this document. The issue has no acceptance details beyond its title; the checks below are our proposed pilot acceptance, not a client-approved policy.

[iOS is paused](../runbooks/NATIVE_FIELD_DEV.md). The SP-0001 lane explicitly forbids phones and device installation. This checklist does not lift either restriction. jc must authorize an iOS verification window and designate the tester before execution. Use his designated iPhone and a dedicated test account; preserve existing work, keys and settings. Never reset a phone, alter enrolled biometrics or crash an app containing the only copy of real work.

## What the current source establishes (not device evidence)

| Area                | Source                                                                                                                                                                                                                                         | What remains unverified                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Encrypted database  | [FieldStore.swift](../../apps/field-ios/FieldIOS/Sources/Storage/FieldStore.swift): `EncryptedFieldStore.init`, `protect`, `protectFiles`                                                                                                      | SQLCipher is required; directory, DB and present WAL/SHM request backup exclusion and `completeUntilFirstUserAuthentication`. Actual device attributes, newly recreated sidecars and locked-device access still need checking.                           |
| Database/photo keys | [SecureStore.swift](../../apps/field-ios/FieldIOS/Sources/Auth/SecureStore.swift): `KeychainStore.save`, `attributes`                                                                                                                          | Generic items request `AfterFirstUnlockThisDeviceOnly`, non-synchronizable. Inspect attributes only; never export key or token values.                                                                                                                   |
| Photo evidence      | [PhotoFiles.swift](../../apps/field-ios/FieldIOS/Sources/Evidence/PhotoFiles.swift): `SealedPhotoFiles`                                                                                                                                        | AES-GCM files request the same first-unlock protection and backup exclusion as the database. Hardware availability and upload recovery are not proven.                                                                                                   |
| Background refresh  | [FieldIOSApp.swift](../../apps/field-ios/FieldIOS/Sources/App/FieldIOSApp.swift), [BackgroundRetry.swift](../../apps/field-ios/FieldIOS/Sources/Sync/Background/BackgroundRetry.swift), [Info.plist](../../apps/field-ios/FieldIOS/Info.plist) | Startup registration, permitted identifier, `fetch` mode, best-effort scheduling and expiration cancellation exist. Submission errors are currently swallowed by `try?`; a scheduled request and actual handler execution must be observed, not assumed. |
| Cold authentication | [AppModel.swift](../../apps/field-ios/FieldIOS/Sources/App/AppModel.swift): `launch(interactive:)`                                                                                                                                             | A cold background launch must not prompt for Face ID. A biometric-locked session returns without unlocking; this is not successful background delivery.                                                                                                  |
| Support diagnostics | [SupportInfo.swift](../../apps/field-ios/FieldIOS/Sources/Diagnostics/SupportInfo.swift)                                                                                                                                                       | Static allowlisted events, redaction, private OSLog and a bounded breadcrumb file exist. They are not a crash reporter.                                                                                                                                  |
| Crash integration   | [project.yml](../../apps/field-ios/project.yml), [Package.resolved](../../apps/field-ios/FieldIOS.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved)                                                                         | The only declared package is SQLCipher. No automatic crash SDK or MetricKit subscriber was found in iOS source. No crash has been collected or symbolicated for this issue.                                                                              |

Existing tests are reference points, not newly executed results: `StorageTests.testEncryptionKeychainReopenAndWrongKey` permits absent protection attributes on simulator; `VisitSyncTests.testCancelledInFlightPushRetainsDurableIntentAndRetry` exercises a stubbed transport; `SyncStatusDiagnosticsTests` exercises support redaction and breadcrumb persistence. None proves OS scheduling or physical protection.

## Before the authorized device session

1. Record the exact source commit, app version/build, bundle ID, physical model, iOS version, tester and UTC session times. Dev and Beta have separate containers (`com.sunpride.field.dev` / `com.sunpride.field.beta`); inspect the build actually being accepted.
2. Retain that build's archive, executable and matching dSYM UUIDs outside the repository. Do not rebuild, install or collect device data from this lane.
3. Confirm the installed app has no `FIELD_STUB_BACKEND` scenario and is using the authorized test backend. A successful local fixture is not a live proof.
4. Use minimal clearly marked test work: one queued Start with a dependent note/End, plus one photo if testing photo retry. Record operation references privately so office receipt can be reconciled. Do not reuse real customer evidence.
5. Record Background App Refresh, Low Power Mode, network and lock state without weakening device security. Do not enable work-day location just to make refresh appear successful: location delivery is a different mechanism.
6. Keep raw device exports and crash reports in access-restricted storage outside the repo. Board comments get sanitized outcomes and evidence references, never credentials, full database contents, raw coordinates or customer identities.

## A. Physical file protection

Use a device-attached development inspection session for attributes; keep its result separate from the untethered background observation. Inspect only the designated app container. Do not copy a live database/key into the repository or treat an unlocked container download as proof of locked-device behavior.

| Item (under Application Support)                                            | Expected protection                    | Backup exclusion |
| --------------------------------------------------------------------------- | -------------------------------------- | ---------------- |
| `FieldStore/`                                                               | `completeUntilFirstUserAuthentication` | true             |
| `FieldStore/field.sqlite`                                                   | `completeUntilFirstUserAuthentication` | true             |
| `FieldStore/field.sqlite-wal`, `FieldStore/field.sqlite-shm`, while present | `completeUntilFirstUserAuthentication` | true             |
| `FieldStore/evidence/` and a created `*.jpg.sealed` file                    | `completeUntilFirstUserAuthentication` | true             |
| `field-breadcrumbs.json`, after a diagnostic event                          | `complete`                             | true             |

1. Read `FileManager.attributesOfItem(...)[.protectionKey]` and `URL.resourceValues(forKeys: [.isExcludedFromBackupKey])` on the physical phone for every row above. Capture only relative path, protection value, exclusion flag and observation time. A missing attribute is **not** a pass on a physical phone.
2. Write the small queued operation while the store is open; inspect present WAL/SHM before closing. Repeat inspection after reopen and another write so newly created sidecars are covered. Missing sidecars are N/A only for that observation; do not claim a sidecar pass without observing one.
3. After the owner has unlocked once since boot, lock the phone and observe authorized background access to the existing store/photo. First-unlock protection intentionally permits this; failure to read the `complete` breadcrumb file while locked must not lose or corrupt queued work. Wait for protected data to become unavailable before judging that breadcrumb read.
4. Arrange an owner-attended reboot only in the authorized window. Before first unlock, protected files and first-unlock Keychain items must be unavailable; do not unlock early for debugging or infer a successful denial from a handler that never ran. If access cannot be observed safely, record NOT RUN. Do not delete/recreate a DB or key to bypass denial.
5. After unlock, reopen normally and reconcile the original queue/acks and photo metadata. No new empty store, lost intents, plaintext fallback or forced biometric prompt is acceptable.

Apple distinguishes first-unlock Class C from Complete Class A: [Data Protection classes](https://support.apple.com/guide/security/data-protection-classes-secb010e978a/web). File attributes, ciphertext and locked-state availability are separate checks; none substitutes for the others.

## B. Background handler diagnostics (forced, not natural delivery)

Task identifier in both Dev and Beta is currently `com.sunpride.field.dev.sync-refresh`; do not substitute the Beta bundle ID.

1. Queue the marked work offline, restore network and confirm a pending request for the exact identifier after `BGTaskScheduler.submit` succeeds. Observe errors in the debugger; the current app does not surface them.
2. Following [Apple's device-only development procedure](https://developer.apple.com/documentation/backgroundtasks/starting-and-terminating-tasks-during-development), pause after successful submission and execute in Xcode's debugger only:

   ```text
   e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"com.sunpride.field.dev.sync-refresh"]
   ```

3. Resume; observe handler entry, completion, durable acknowledgements and actual test-backend receipt. Verify each operation was applied once. A task completion callback or HTTP success alone is insufficient.
4. In a separate run with remaining marked work, pause inside the task and force expiration in the debugger only:

   ```text
   e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateExpirationForTaskWithIdentifier:@"com.sunpride.field.dev.sync-refresh"]
   ```

5. Confirm cancellation stops further acknowledgement processing; already committed acks remain durable. Pending work retains its operation IDs/bytes, a new pending request exists when eligible work remains, and a later retry reconciles without duplicate business effects. Rejected/held work stays for review.
6. Check a cold launch with the ordinary session and separately with an already-enabled biometric gate. Never trigger unattended Face ID or change enrolled biometrics. A locked gate must preserve work without prompting; label that outcome BLOCKED BY AUTH, not delivered.

These selectors are debugger diagnostics only. Never ship them in app code or use them to claim iOS chose to launch the app.

## C. Natural OS background delivery

1. Use the identified release-style build with marked queued work, an eligible verified session and successful submission. Record the pending task, counts and time before leaving the app.
2. Detach the debugger; background the app normally, without swiping it away. Restore connectivity, lock the phone and leave the app unopened. Record an agreed observation window and the actual device conditions.
3. Correlate an OS task-launch observation with the exact task identifier, receipt time on the authorized backend and a durable ack after reopening. Server receipt alone could be foreground, connectivity recovery or location-triggered work, so it does not prove a `BGAppRefreshTask` launch.
4. If current diagnostic tooling cannot distinguish the trigger without affecting scheduling, record INCONCLUSIVE and arrange an approved instrumentation build later; do not invent timestamps or rely on the generic `syncStarted` breadcrumb.
5. Record delivered / not observed / blocked by settings or authentication separately. The source's 15-minute `earliestBeginDate` is a hint, not a delivery promise; a finite wait with no delivery is not proof of data loss or a guaranteed scheduler defect. Keep natural delivery unverified until actually observed.
6. Reopen and confirm foreground fallback safely sends remaining eligible work once. This proves recovery, not natural background delivery. Restore only test settings changed for the session, and reconcile all marked records before cleanup.

See [Apple's background strategies](https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app). Debugger-triggered launch, a simulator pass and location updates do not meet this section.

## D. Crash capture and support handoff

Recommended first path: Apple's native device crash reports plus the matching archive/dSYM, with manual collection by the designated tester. This adds no hosted service, cost or automatic telemetry. It is a proposed pilot support path, **not** an implemented automatic crash reporter or a waiver of that requirement. If automatic remote capture is required, integration and privacy/retention configuration remain separate unfinished work.

1. Agree a test-only crash exercise with jc in the authorized window, using a build with no unique real unsent work. No deliberate crash switch is added by SP-0001 and no production test account is crashed by this lane.
2. With the debugger detached, collect an actual app crash through Xcode's Devices and Simulators logs or iPhone Settings → Privacy & Security → Analytics & Improvements → Analytics Data. Choose the app binary's report matching the recorded build/time; a force-stop is not a crash report.
3. Preserve the original `.ips`/`.crash` privately; retain a reviewed/redacted copy for support. Record the app version/build, exception/termination type, incident time and matching executable/dSYM UUIDs. Never post raw device identifiers or user data to the issue.
4. Symbolicate with the matching archive; require readable app frames. A file with only raw addresses, an unrelated old crash or a `JetsamEvent` memory report is not evidence of the intended crash exercise.
5. Reopen safely and reconcile the same saved queue/acks without loss or duplicate effects. Copy Support info and verify it contains only the documented safe fields; breadcrumbs remain a separate diagnostic artifact.
6. Record the named recipient and successful private handoff. Manual log retrieval proves native collection only; it does not prove automatic upload, alerts, grouping or a crash-service dashboard.

Source: [Apple: acquiring crash reports and diagnostic logs](https://developer.apple.com/documentation/xcode/acquiring-crash-reports-and-diagnostic-logs). A debugger intercepts crashes; detach to allow the OS to finish generating a report. Do not add paid dependencies or upload private reports without authorization.

## Evidence record (copy outside the repository for execution)

Keep regression/execution reports outside the repository. Suggested location: `/Users/jc/cnc/_regression_reports/<YYYY-MM-DD>-sp-1-ios-regression-report.md`, including a `## Scope` section. A blank field means NOT RUN, never PASS.

```text
Issue: SP-0001
Overall: PARTIAL / BLOCKED / PASS (only with all required evidence)
Tester and owner-authorized window:
Source commit; archive path; executable/dSYM UUID match:
App version/build; bundle ID; physical model; iOS version:
Test-backend label (no credentials); test-data marker:
UTC start/end; network; power; Background App Refresh; lock/first-unlock state:

Case | Mode | Result | Actual observation | Private evidence reference
A attributes + recreated DB sidecars | physical inspection | NOT RUN | |
A locked-after-first-unlock access | physical inspection | NOT RUN | |
A before-first-unlock denial + safe recovery | physical inspection | NOT RUN | |
B forced launch + exact-once receipt | device/debugger-forced | NOT RUN | |
B forced expiration + durable replay | device/debugger-forced | NOT RUN | |
B cold launch + biometric no-prompt | physical inspection | NOT RUN | |
C natural OS task launch + server receipt | physical/OS-selected | NOT RUN | |
C foreground fallback | physical/foreground | NOT RUN | |
D real crash + matching symbols + handoff | physical/native crash log | NOT RUN | |
D reopen + queue reconciliation | physical recovery | NOT RUN | |
Automatic remote crash reporter | not implemented | NOT RUN | |

Before/after queued, deferred, sending, review, held, photo and ack counts:
Operation replay identity comparison; office record reconciliation:
Settings restored; test records reconciled; original work/keys preserved:
Open failures, inconclusive observations and required next owner:
```

## Exit rule

Do not close SP-0001 from this checklist, source review or a simulator/stub pass. Require physical protection evidence, a separately identified natural OS launch and a real symbolicated crash/handoff. Record any explicitly accepted manual-only crash scope with jc; otherwise automatic crash reporting remains open. A paused or forbidden device session leaves the issue in Needs fix with a `NEEDS JC:` comment, not In QA or Awaiting client response.
