# F-007 / F-021 / F-024 / F-221 / F-312 / F-606 — Integrity

## F-007 — Identity and one-device policy

Company sign-in is OIDC authorization-code flow with S256 PKCE, nonce, a browser-bound single-use state, RS256 signature/issuer/audience/expiry checks, and an explicit issuer/subject → existing user link. Matching an email never links users. Email/password trial sign-in remains available. The local mock IdP is enabled only by `SP_MOCK_IDP=1`; its issuer is loopback `/api/mock-idp`, and it signs a real token for an explicitly linked, sample-marked identity. Real IdP setup is Needs Sunpride. Only the super administrator may change issuer trust or explicit identity links: an ordinary national administrator cannot use SSO mapping to impersonate a higher role. Issuer/client/subject literals are retained exactly, including meaningful trailing slash and subject case/spacing. The current provider adapter supports RS256, public-client PKCE and same-origin discovery endpoints; confidential-client authentication or split-origin providers need an adapter once specified.

The current implementation exposes company SSO in the web sign-in screen. Android retains its existing typed-password/native-session flow; native browser SSO handoff/exchange is not implemented in this lane. Handover currently needs a supervised copy of the replacement public key; a friendly native enrollment-code/QR pairing flow is still outstanding. Provider and identity-link setup are currently super-admin API commands, not yet web administration forms. Do not describe a web OIDC proof as an Android SSO proof.

`registered_devices_one_person_active_uq` enforces one active registration per persisted person across apps, rather than the previous per-app limit. Existing profiles are the identity authority. An additional app registration also requires handover: there is no attempt to infer that two app-private keys are the same physical phone.

Migration 0470 suspends and audits all conflicting pre-existing active registrations, without deleting their rows or queued work. The office must reconcile those phones. A handover records the replacement public key but does not activate it until reconciliation; lost-phone work requires an explicit audited unrecoverable-work decision. Ordinary reinstatement cannot bypass the pending integrity control. Only a first-ever trial phone self-registers: even after retirement, a new key and ordinary admin registration must go through reconciliation. A retired key is never revived. A completed wipe may supply the original held recovery for a later handover without copying/re-encrypting that archive.

Remote erasure is application/account/device scoped, not an OS factory reset:

1. The office creates a wipe/handover control and suspends normal device use.
2. On the next authenticated contact, the app holds the account's partitions. Pending controls remain reachable through session refresh; ordinary proof/enrollment/push remain blocked.
3. The app snapshots SQLCipher rows and unsent photos. Photo capture and erasure share an in-process recording fence; persisted holds gate ordinary business transactions.
4. A device-key-signed recovery request seals the bundle server-side with AES-GCM before deletion. A durable local marker makes interrupted erasure retryable; file keys are sorted so an uncertain recovery upload replays identical bytes even if directory enumeration changes.
5. The selected account/device rows are erased with SQLCipher secure-delete/checkpoint; selected recovered photo files are removed. Other accounts are not erased.
6. Only successful erasure is acknowledged. The device is retired and ordinary session credentials are cleared. Retained recovery is never automatically replayed.

Set a persistent, backed-up `DEVICE_RECOVERY_SECRET` of at least 32 characters before deployment. This is separate from `SYNC_CURSOR_SECRET` in deployment even though an isolated test instance may derive both from a test key. Without recovery configuration or if a bundle exceeds the supported roughly 900 KB raw-JSON bound, the app stays held and does not erase; supervised larger recovery is still required. This is not forensic flash destruction, full MDM, or a claim that a device's erasure acknowledgment is hardware-attested.

Native recovery sends signed `bundleJson` bytes so JVM scientific notation and 64-bit integers are not reserialized before signing/encryption. The supervised export's `bundleJson` is the lossless authority; its parsed `bundle` is only a convenience view. Setup → Admin → Fleet & integrity provides Download held evidence. Reconcile it with existing server visits, receipts, acknowledgments and operations before any supervised recovery. Never recapture or replay it blindly.

Current control contact requires an active authenticated profile/session. An account disabled before it contacts the server may require supervised/MDM recovery rather than this application control path. Full vendor MDM wipe is not implemented.

## F-021 — Fleet register

Setup → Admin → Fleet & integrity extends the existing shell. Effective-dated asset versions hold assignment, device link, model, printer/scanner/charger tags, MDM status/source/time, data plan, spare/repair state, due date and notes. Imports accept up to 200 complete JSON asset rows and are atomic and scoped. The current list explicitly discloses a 500-row asset/device cap.

The demo adds 12 invented assigned assets, two spares and one repair asset. They are explicitly sample-owned and do not pretend that hardware enrolled or passed MDM. `ensureIntegrityFleet` upgrades an already-seeded dataset additively and is called by repeat demo seeding and daily advancement. It never resets the database, updates existing assets or overwrites trial passwords/people. If an assigned person moves outside the current administrator’s scope, their current name is masked and the asset says Assignment needs review. Real procurement, SIM/data contracts, fleet enrollment, peripheral serials and charging/shift procedures remain operational work.

MDM fleet status is an imported register fact, not verified root attestation. The separate scoped device-assessment action supplies an office-reviewed integrity finding. No vendor MDM webhook/signature integration is claimed.

## F-024 — Device, location and capture checks

Android supplies local root/tamper heuristics at sign-in/refresh and before challenge-based requests. They are explicitly unverified self-reports. The server blocks missing/expired integrity observations and rooted/tampered observations at enrollment/refresh/proof/push unless another administrator grants an audited, expiring exception. Latest observations are evaluated independently by source: a clean Android self-report cannot erase an adverse MDM/office source. Office assessment requires another administrator and cannot impersonate the reserved native self-report source. Fleet display uses the same adverse-source precedence.

The field app refuses an OS mock fix before queuing a check-in. The server independently refuses signed mock check-ins with `mock_location_refused`; it never creates a refused visit. Travel plausibility derives distance/time from ordered observations, subtracting both accuracy radii and a policy tolerance. Late offline observations check both temporal neighbors. A travel flag requests investigation rather than making an automatic accusation.

The JPEG inspector reads bounded EXIF/TIFF and the capture manifest from uploaded original bytes. It compares derivative EXIF time/GPS/orientation with the capture and also checks reported pre-redraw source EXIF. Protected uploaded bytes and their checksum are not rewritten. New attachments persist those inspected capture facts; missing/mismatched legacy metadata creates a review signal rather than silently certifying an old image. Client-declared source EXIF is signed capture provenance, not independent proof of a camera's origin.

## F-221 / F-606 — Ongoing detection and review

An effective-dated policy controls travel, time/GPS, perceptual distance, burst, repeat-order, discount, return and settlement tolerances. Setup can schedule a new version. The fixed client exit criterion remains strictly below 0.5%; a rate equal to 0.5% fails. All initial numerical tolerances are clearly marked provisional SAMPLE values, not client policy.

Every minute, the domain reads canonical order/van sources and runs a bounded detector, then publishes an integrity refresh. Commercial reads never post inventory, payment or fiscal effects. Order source keys are formed in PostgreSQL to retain microseconds; repeat orders count distinct business order identities, not repeated revisions of one order. Per-policy keyset cursors drain up to 500 new observations per run without starving later rows. Photo comparison uses a bounded candidate window and emits an incomplete-scan finding when that window is exceeded.

Signals cover mock check-ins, impossible travel, exact duplicate image checksums, device-supplied perceptual hashes, EXIF mismatches, batch check-ins, repeated orders, high discounts/returns and cash variances. Perceptual hashes remain unverified device claims, not a server vision/forensic verdict. Findings and dispositions are append-only. Confirmed concern, False alarm and Request evidence are investigator outcomes, never an automatic finding of guilt.

Decide includes the role-scoped integrity review panel, a seven-day observed mock rate and its previous seven-day comparison, the below-0.5% target, next-page handling and investigator actions. Queue reads and review commands recheck the current person, current outlet owner, source-order and source-trip access. A transferred store is excluded from both the old area's findings and rate contributions.

The rate counts accepted/duplicate or mock-refused signed attempts received by the server, once per device/request identity. Malformed clean requests cannot dilute it. Refused attempts are persisted outside the rolled-back business transaction. On-phone refusals which are never uploaded are not yet a complete telemetry denominator. The screen labels this limitation and does not certify the production route exit gate from those numbers. Native durable refusal telemetry and a full production-route measurement remain outstanding.

## F-024 / F-312 — Shared Android watermark

Both Android products use `packages/android-integrity` to burn visible capture coordinates/accuracy, Manila timestamp/timezone, user and outlet into pixels before hashing/storage/upload. Field evidence remains encrypted in its existing store. Van truck-damage photos explicitly say the outlet is not applicable; they never substitute a store's master pin as a capture location. Production capture requires a fresh permitted OS fix and refuses a reported mock. The van camera requests precise one-shot photo location separately from continuous trip-sharing consent; approximate-only/denied permission keeps Capture disabled and presents a next action. Only the explicitly labeled DEBUG practice backend uses synthetic photo coordinates.

The shared transform normalizes orientation, bounds image size and stores a real EXIF derivative plus a versioned APP15 capture manifest in the same hashed bytes. A pre-watermark dHash compares the photograph rather than the text overlay. Existing camera-only capture paths remain in place. A checksum is of the final watermarked JPEG, not of its unmarked source.

The opt-in H10P erasure proof uses a separate `.integrity` application sandbox when `SUNPRIDE_INTEGRITY_PROOF_DIR` is set. It refuses a tester's package, uses only a throwaway `integrity-wipe-…@sample.sunpride.test` account on port 4500, and creates one explicitly SAMPLE review-only outbox row. It runs through the existing machine-locked wrapper; it is not a live POS sale or a money-posting proof. A generated SAMPLE bitmap watermark is not a real-camera proof. The Redmi real-camera/mock-provider/second-phone walk must be reported separately and must not be replaced by fixtures.

## F-007 / F-024 / F-606 — Seams and integration

- `SEAM(CALLFLOW)`: consume `evaluateCheckInIntegrity(ctx, payload)` with `allowed`, `flags`, `policyId` and the unverified-attestation label. The existing visit handler uses it; do not create another call-flow engine.
- The commercial adapter reads the current canonical orders and van ledgers. If SAP/FISCAL/VANOPS replace those source projections, adapt this collector or subscribe to their authoritative events. Never add parallel stock/payment/fiscal writers.
- Merge migrations 0470–0475 in the reserved integrity range and keep domain registration/capability additions when resolving concurrent lane edits.
- The demo policy uses its own sample ownership batch so it does not make a fresh core demo appear partially seeded.
- Retain all existing bonus surfaces. The intentional contrast is mock-location refusal and cross-app one-active registration, replacing the old permissive behavior.
- Update Android binaries together with the new integrity gate; an old client without a fresh assessment will fail closed. iOS is paused, not silently compatible with a new enrollment policy.

## F-007 / F-021 / F-024 / F-221 / F-312 / F-606 — Needs Sunpride

Real IdP issuer/client registration and explicit identity mappings; native company-SSO requirements; real MDM vendor/assessment trust; approved fleet/data plans, peripherals, spares and break-fix/charging rules; travel/EXIF/fraud tolerances and exception authority; evidence/raw-location/recovery retention and supervised reconciliation procedure; persistent recovery-key backup/rotation; real-route exit measurement. These are refinements/configuration needs, not permission to invent claims of deployment or client operations.

## F-007 / F-024 / F-221 / F-312 — iOS parity later

No iOS source is changed. Later work needs company/native SSO, the cross-app one-device/handover UX, root/integrity provider policy, signed remote recovery/erasure, mock-refusal telemetry, preserved source EXIF, shared-equivalent pixel watermarking and physical iPhone proof. Do not re-enable old iOS clients against a fail-closed integrity gate without this review.
