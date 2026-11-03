# ADR-023: Android managed distribution (SP-0012 / QSR-022)

Status: accepted as our engineering default, subject to Sunpride's operational rollout approval. This defines the approach; it does not assert that a managed store, production signing configuration or enrolled fleet exists. No account purchase, app publication, device enrolment or reset is authorized by this record.

## Decision

Use **private Managed Google Play apps through Sunpride's Android Enterprise EMM/MDM** for the production company fleet where the actual device supports it. Keep the existing **signed, hand-delivered beta APKs and authenticated in-app update channel** as the immediately usable pilot path, without requiring a paid service. A vendor-managed APK channel is the production alternative for handhelds without compatible Google services, but only after its management and update behaviour is proven on that model.

This covers the two existing Android products: Field and Van/Store POS. Store mode uses the Van APK; distributor/collector modes use the Field APK. It creates no third product or installer. iOS distribution is outside this decision.

The distinction is deliberate: controlled APK delivery is not Android Enterprise management. Installing an app or approving its registration in Sunpride does not enrol the physical device in MDM.

## Why this route

| Route                                                            | Decision and limits                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Signed APK, supervised first install and existing update channel | Use for the current beta. No store account is required by our software. Android asks the user to approve installation; there is no silent install, remote OS lock/wipe or fleet-wide forced-update guarantee.                                                |
| Private Managed Google Play through an existing EMM              | Production default for compatible company devices: organization-restricted availability, centrally assigned installation and update policies. Sunpride owns the enterprise/account; the EMM must support the required features.                              |
| OEM/EMM-managed APK delivery                                     | Conditional production path for non-GMS or otherwise incompatible handhelds. The supplier must demonstrate signed in-place updates, inventory, policy enforcement and incident controls. Do not assume the H10P supports Managed Play or a vendor MDM.       |
| Public Play listing                                              | Not selected: this is an internal company fleet, not public app discovery.                                                                                                                                                                                   |
| A new in-house device-policy controller/management service       | Not selected. Sunpride is not made an EMM by our fleet register. Google's Android Management API has restricted permissible usage, including a prohibition on exclusively first-party in-house solutions; it is not a free turnkey MDM for this project. [3] |

Google's EMM private-app iframe can accept an APK and waives the Play developer registration fee for that publishing route. This does **not** mean the EMM, devices, support or optional subscriptions are free. Direct Play Console publishing has separate account/fee requirements. No new paid service is selected here. [1][2]

## Packages, signing and environment boundaries

These are source-defined identities, not evidence of installation or store publication:

| Product       | Current signed beta package | Production flavour package | Source                                        |
| ------------- | --------------------------- | -------------------------- | --------------------------------------------- |
| Field         | `com.sunpride.field.beta`   | `com.sunpride.field.prod`  | `apps/field-android/app/build.gradle.kts`     |
| Van/Store POS | `com.sunpride.van.beta`     | `com.sunpride.van.prod`    | `apps/van-sales-android/app/build.gradle.kts` |

- Keep dev/staging, beta and production installations separate. Never publish a debug/performance/test APK as a company release. Both projects currently define `minSdk = 29` and `targetSdk = 36`; the recommended company-fleet floor remains Android 12 in [device rollout](../spec/device-rollout.md), not a claim that the manifest enforces that floor.
- The beta builders are `bun run apk:field-beta` and `bun run apk:van-beta`. They build `betaRelease`, verify its signature and reject the Android debug signer. The beta build number is `SUNPRIDE_BETA_BUILD` (currently bounded to 1–9999); choose a value strictly above every version already distributed for that package. Keep APK hashes, source commit and the Field R8 mapping with the release evidence. Do not run these builders merely to review this document.
- Beta signing properties are consumed from outside the repository by the existing builders. Never print, commit or attach signing keys, passwords, recovery codes or property-file contents. The release custodian must arrange restricted, encrypted key backup and a recovery rehearsal before production; no such backup is claimed here.
- Production flavours exist, but their current source has base version code `1` and no dedicated production signing configuration. Before the first production binary, the release owner must configure protected production signing and monotonically increasing versioning in a separate implementation change, verify the built endpoint/package/signer, and run the native release gates. `assembleProdRelease` alone is not an established signed production-release procedure.
- A `.beta` → `.prod` switch is a **new installation and sandbox**, not an in-place upgrade or automatic SQLCipher/Keystore transfer. Reconcile uploaded and phone-only work, preserve/recover unsent evidence, and complete the existing registered-device handover before activating the replacement. Never uninstall, clear storage, revoke a key or factory-reset just to resolve an update failure. See [native state/recovery](../runbooks/NATIVE_FIELD_DEV.md) and [integrity controls](../spec/integrity.md).
- Within one package, preserve the installed app-signing certificate and increase `versionCode` for every release, regardless of delivery channel. The current in-app updater requires exact single-signer equality; signing-certificate rotation is a separately tested migration, not an automatic fallback. An upload key is not necessarily the key signing the APK installed by Play. [5]
- For the first EMM-iframe publication, prefer the accepted **APK signed by the intended app key**. Google documents that creating a private app with an AAB in the iframe generates a Google-managed app-signing key. Do not accidentally break APK-channel continuity by using that default. A later AAB/Play App Signing transition needs explicit key-custody approval and a cross-channel installed-certificate/update rehearsal. Do not upload a private key as part of this task. [1][5]
- Create private listings in the Sunpride-controlled enterprise, with named recovery/admin owners, not a developer's personal tenant. Iframe-created private apps cannot be transferred to a different developer account or converted to public apps; agree ownership before first publication. [1]

## Pilot delivery with the existing software

This is the current controlled-APK procedure, not a new managed installer. The release lead executes it only under separate release/device authorization.

1. Choose one accepted source commit and a newer beta build number. Run the touched app's assemble/unit/lint gates and build its signed release once, using the existing protected signing configuration and explicitly verified API/web origins. Never ship a lane endpoint to testers.
2. Record package, version code/name, app-signer SHA-256, APK SHA-256, size, source commit, intended environment, release notes, operator and approval in a release record. Verify the **actual APK**, not only Gradle declarations.
3. For first install, hand the verified artifact to the named tester through a controlled transfer. Verify its checksum/signing certificate against the release record and supervise Android's installation prompt. A public attachment or chat forward is not the ongoing company distribution channel. First install is separate because the authenticated update endpoint is unavailable before app sign-in/device binding.
4. For an existing beta installation, stage the already signed artifact on the target API host: `cd apps/api && bun scripts/stage-app-release.js /absolute/path/to/signed.apk`. `SP_APP_RELEASE_DIR` selects its private artifact directory. Never run this against the showcase from a lane.
5. A super administrator opens Setup → Devices → Android app updates, chooses the inspected artifact, adds release notes/effective time and publishes. The server inspects the APK with `aapt`/`apksigner`, not an administrator-supplied signer or arbitrary download URL.
6. The signed-in user opens Account → Check app updates, downloads and approves Android's installer. The client checks configured origin, exact hash/size, package, newer version and installed signing certificate, then rechecks the active channel before opening the installer. If Android's per-source install permission is needed, an authorized pilot operator handles that setting; do not disable Play Protect or globally allow unknown applications.
7. Reopen the app and record its installed version plus retained local work and sync outcome. Server publication or an installer prompt alone is not installation evidence. An offline phone cannot discover/download an update until it reconnects.

Source anchors: [beta builders](../../apps/field-android/scripts/build-beta-apk.sh), [van builder](../../apps/van-sales-android/scripts/build-beta-apk.sh), [artifact inspector](../../apps/api/src/domains/integrity/apk-artifacts.js), [release API](../../apps/api/src/domains/integrity/app-releases.js), [native updater](../../packages/android-integrity/src/main/java/com/sunpride/integrity/AppUpdateClient.kt), [native validation](../../packages/android-integrity/src/main/java/com/sunpride/integrity/AppUpdateRules.kt), and [F-006 notes](../spec/finish-a.md#f-006-controlled-android-update-channel).

## Managed production rollout

These are required operational steps, not completed checks or a vendor purchase request.

1. Sunpride IT names the enterprise administrator and deputy, confirms company ownership and the EMM supplier/entitlement, and inventories exact models, OS/patch levels and Google-services/Android Enterprise support. Prove compatibility separately for the field phone and printer handheld. An imported fleet-register status is not evidence of enrolment or hardware attestation.
2. Use company-owned **fully managed** devices by default. A Van/Store device may use a dedicated-device policy that still permits camera/scanner, printer, connectivity and support workflows. Personal-device work profiles are outside the default company-fleet rollout and need a separate privacy/support decision. Existing-device conversion can require a reset: first preserve/reconcile work and obtain explicit reset authorization; this document grants none.
3. Bind the Sunpride enterprise to its EMM and private Managed Play store. Restrict each private app to the intended organization and assign it to the correct field or Van/Store groups. Verify package ownership/availability before publication; package names cannot simply be reclaimed by deleting a listing. [1][2]
4. Apply screen lock, supported OS/patch policy, approved app sources, developer-options/USB-debugging restrictions and lost-device controls through the EMM. Allow required business runtime permissions and Wi-Fi/data settings. Do not weaken app identity, device-binding, integrity or offline-lease checks because a device is managed.
5. Configure the EMM as the production installation/update authority. Keep unknown-source self-installation disabled on that fleet; the app's manual update feature is a pilot/fallback tool, not a reason to relax the production policy. Do not publish competing same-package candidates through the app channel and EMM. Emergency alternate delivery needs an explicit administrator-controlled exception and the same signer/version checks.
6. Rehearse on one spare/test unit per distinct hardware/OS combination, then the Cebu pilot group, then each remaining depot. Choose controlled groups rather than assuming a Play percentage rollout exists for the selected private-app/EMM workflow. Hold the next group until the evidence below passes.
7. Schedule updates at the depot over Wi-Fi between calls/shifts, after sync/reconciliation where possible. An EMM may close an app during update; do not force one during invoice capture, printing or an active call. Reopen, confirm retained queue/receipts/device identity and reconcile before the next shift. Offline or powered-off devices remain pending, not compliant.
8. Maintain desired versus actually installed package/version, last device contact, enrolment/policy state, assigned person and exceptions in the EMM release record. The current Sunpride fleet register imports status; it is not a live vendor integration or installed-version compliance monitor. Keep pending/failed devices with a named follow-up action, not a guessed success count.

## Withdrawal, recovery and lost devices

- Stop assignment/rollout of a defective candidate immediately. In the APK channel, withdraw it in Android app updates; discovery and downloads stop, but the installed app is not removed. Already opened installers or already distributed copies cannot be remotely recalled by this channel.
- Prefer a forward fix with a **higher** version code and the same signer. Never promise Android will install an older APK over a newer one. Repackaging old code under a higher version is safe only if its Room schema/protocol remain compatible; if not, hold further business use under existing controls and repair without deleting the queue or receipts.
- For interrupted downloads, wrong signer/package, full storage, unavailable managed store or refusal by policy, keep the existing installation and saved work. Record the actual failure; reconnect/retry or escalate to IT. Do not bypass the OS warning, invent a compliance state or delete app data.
- For loss/theft, IT suspends the Sunpride registration and records the incident; the EMM administrator separately requests OS lock/wipe. These are distinct systems. An offline device may never receive a wipe; the app's finite offline lease and encrypted storage do not prove remote erasure. Any deliberate unrecoverable-work/wipe decision belongs to authorized operations, not an automatic update job.
- For a physically controlled replacement, reconcile server receipts/acks against encrypted phone-only work using the existing supervised recovery/handover process before destruction. Changing hardware does not transfer non-exportable device keys. Keep held evidence access restricted; do not blindly replay a recovered sale or visit.

## Ownership and activation inputs

| Owner                            | Before production activation                                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sunpride IT / security           | Named enterprise admins and recovery contacts, actual fleet/Google-services compatibility, approved EMM entitlement and policies, depot enrolment and incident operator. No account or budget is assumed. |
| Release lead / signing custodian | Protected production signing/version setup, backup/recovery record, approved endpoint, immutable release record and channel-continuity evidence.                                                          |
| Depot supervisor / pilot users   | Authorized test units and update window; reconcile held/unsynced work, validate actual field and printer workflows, record accepted installations and follow up offline devices.                          |
| Sunpride business owner          | Go/no-go for widening the pilot and any operational exceptions; this is not implied by a software test.                                                                                                   |

Source classification: F-006 is the controlled update feature; F-021 explicitly names MDM enrolment and fleet operations in the client plan. Particular vendor, account custody, signing administration and the exact rollout/update window are **our proposed implementation/operational inputs**, not answers already supplied by Sunpride. Their absence does not prevent defining the approach or using the existing authorized beta path; it does prevent claiming managed production deployment.

## Acceptance and evidence checklist

For this issue, QA checks that the decision is actionable and consistent with the source and cited platform rules. Actual fleet activation has a different evidence bar:

- [ ] Record the release identifier, source commit, package, version code/name, signer and APK hash/size, API environment, channel/group, operator and approval. Do not include credentials or private keys.
- [ ] On authorized actual hardware, prove a first install and a same-package/same-signer higher-version update. For Managed Play, read back both EMM enrolment/policy and the **installed** package/version; store publication alone fails this check.
- [ ] Update with one locally queued fact and existing acknowledged history. Reopen and prove the queue, encrypted data, device identity and frozen receipts remain, then replay the pending UUID and read back one canonical result. A schema/unit fixture is not physical upgrade evidence.
- [ ] Check Field sign-in/bootstrap and a call; check Van/Store mode, scan, receipt/reprint and printer reconnect on its actual supported hardware. Do not count invented/sample sales as live client transactions.
- [ ] Prove offline update deferral, interrupted-download retry and candidate withdrawal. The APK channel must refuse wrong signer/package or non-increasing version; keep installed work unchanged. Exercise failure cases on spare/test devices, never by damaging an operational install.
- [ ] Demonstrate the selected EMM's group assignment, update window, failed/offline-device reporting and incident lock path. A remote-wipe rehearsal needs separate authorization and an expendable/reconciled device; never reset a working phone for this document.
- [ ] Rehearse the forward-fix/hold procedure and record outstanding incompatible devices. Attach the results to the board release/pilot record; unperformed checks stay unchecked.

This lane supplied a source-checked distribution definition only. No checklist item above is represented as executed, and no managed fleet, physical upgrade, printer pass, account approval or live client acceptance is claimed.

## Platform references

Official documentation reviewed on 2026-11-03; recheck provider requirements before activation:

1. [Google: publish private apps from an EMM console](https://support.google.com/work/android/answer/9146439?hl=en) — supported artifact types, fee waiver, signing defaults and non-transferable private listings.
2. [Google: private apps through Play Console](https://support.google.com/googleplay/android-developer/answer/9874937) — organization restriction and account ownership/publishing requirements.
3. [Google: Android Management API permissible usage](https://developers.google.com/android/management/permissible-usage) — restrictions on building an in-house management service.
4. [Android Enterprise feature list](https://developers.google.com/android/work/requirements) — provisioning, managed installation and device-policy capabilities; confirm the chosen EMM actually provides them.
5. [Android: app signing](https://developer.android.com/studio/publish/app-signing) — app-signing versus upload keys and cross-channel certificate continuity.
6. [Android developer verification FAQ](https://developer.android.com/developer-verification/guides/faq?hl=en) — managed organization-store exemption and evolving off-Play requirements. Do not extend the managed-store exemption to an ordinary sideloaded beta on an unenrolled phone. Before broader off-Play release, the account owner must check applicable country/channel rules and package/identity registration. Neither the power-user advanced flow nor developer installation is our company distribution strategy.
