# FINISH-A implementation notes

## F-006: controlled Android update channel

This is our side-loaded-app distribution design, not a claim about Sunpride's MDM deployment. It extends the two existing Android packages; it does not create another app or an automatic installer.

1. Build/sign the accepted APK through the existing Android release process, incrementing its version code. Do not export its signing keys.
2. On the API host, stage that existing artifact with `cd apps/api && bun scripts/stage-app-release.js /absolute/path/to/signed.apk`.
3. A super administrator opens Setup → Devices → Android app updates, chooses the inspected artifact, writes release notes, sets its effective time, and publishes it.
4. A signed-in phone checks Account → Check app updates. It downloads only from its configured API, verifies the full hash, package, newer version and equality with its installed signing certificate, then asks Android to confirm installation.

`SP_APP_RELEASE_DIR` selects the host's artifact directory (default `~/.sunpride-app-releases`). `SP_ANDROID_BUILD_TOOLS` selects the installed Android build-tools directory (default the host's SDK 36.0.0); `SP_ANDROID_JAVA_HOME` selects the existing Android Studio JBR. These are paths, not credentials. Publication re-inspects the real APK with `aapt` and `apksigner`; the web cannot invent its signer or redirect a phone to an arbitrary URL. Downloads recheck immutable content. Withdrawal stops discovery/download, and the phone rechecks the active channel before opening the installer. Signing-certificate rotation needs a separately planned rollout; it is deliberately not silently accepted. An already installed version is not removed by withdrawal.

## F-007/F-024: identity and device control

Company OIDC remains explicitly linked by issuer and subject; matching email alone never creates trust. Native browser completion leaves credentials on the server until the requesting Keystore key redeems them. Replacement codes are short-lived, same-person/app candidates for the existing handover: old queued work still needs recovery or explicit lost-work reconciliation before the new device activates. A code is not a bearer login or automatic registration. OS root/tamper signals remain self-reports, not verified hardware attestation. Office assessments and independently approved expiring exceptions remain visible/audited.

## F-004/F-015/F-016: native source copy and selling authority

Each phone maintains a separate authorized `sap.masters` cursor and complete staged copy in its existing SQLCipher database, including source/version/effective dates and revisioned changes/tombstones. Account exposes freshness and currently effective reference records. A durable read grant is removed before an online request; a refusal cannot expose old retained bytes on a later offline read. Requests and visible answers are fenced by session/scope lifetimes and finite offline authorization. Van reference grants use its own current trip and truck/depot rather than assuming field MCP membership. No extra stock balance or pricing authority is created. The existing governed selling book still supplies checkout/credit quotes; the mock SAP supplies full net/tax/gross facts for exclusive-tax conditions.

## F-019/F-108/F-109/F-111/F-123: later collections

A collection against an unvoided same-trip credit invoice writes one payment, one controlled Official Receipt reservation, its frozen document, and the existing immutable outbox intent in one Room transaction. It creates no second sale or stock movement. Replays retain the number and facts. Card references must not contain a card number. Cash captures enter the expected cash count; noncash stays awaiting office confirmation. A refused upload does not erase physically received cash or release that amount for local recapture. Office reconciliation is required. Print/reprint uses the frozen OR and original invoice reference, and print journaling resolves the collection payment. Mixed-tax invoicing, broader historical returns and the remaining correction/cheque/financial posting adapters are separate backlog items, not implied by this slice.

## F-019/F-020: fiscal history

Lost/retired allocation tails can be reconciled by another authorized administrator only after device suspension/retirement; they never return to the available number pool. Issuance refuses a closed allocation even after device reinstatement. Audit search/export uses scoped filters and completes bounded paging before exporting; it does not promise a retention/deletion policy that has not yet been implemented.

## F-221: refused mock attempts

A locally refused mock check-in queues independent integrity telemetry in the existing encrypted outbox. It never opens a visit or advances call flow, and no mock coordinates are retained in that telemetry. Signed upload counts the refusal once in the office mock-attempt denominator and creates a mock finding, not travel/batch facts. Not-yet-uploaded attempts remain outside the server denominator; OS signals are not hardware attestation.

## F-119: operational posting bridges

Independent settlement approval links the retained operational request to one canonical SAP outbox effect for that immutable version, with frozen source facts and dependencies. It waits for earlier invoice/payment/credit/movement effects. Only the identity/hash/lease-checked provider acknowledgement marks the request acknowledged and writes the trip reference. Replaying a version preserves its original dependency set. Queue conflicts stay retained for operator resolution, not renamed as success. The fiscal register reads existing SI/OR/CM source events rather than creating duplicate financial documents; it distinguishes queued/refused/acknowledged and labels mock success SAMPLE. No live SAP posting is claimed.

## Needs Sunpride

Real IdP/provider configuration, SAP access/mappings, fiscal registration/permit evidence and production signing/distribution ownership remain external inputs. Existing clearly marked sample/mock data keeps the software usable without inventing these outcomes. No sample registration is presented as a BIR filing. These notes describe our implementation choices, not confirmed client operating policy.

## iOS parity later

No iOS files were changed. Company sign-in/pairing, master copy/freshness, the update-channel equivalent, collection/OR screens and refused-attempt telemetry need a separately authorized iOS pass when that app resumes.
