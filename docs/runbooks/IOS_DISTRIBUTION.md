# iOS private distribution approach — SP-0013 / QSR-021

## Decision and scope

Approach defined on 2026-11-03. This is our recommended release design, not a statement of Sunpride's current device fleet, Apple accounts, approval or deployment. The issue asks to define the approach; enrollment, paid purchases, build publication and device acceptance are separate release work.

1. Keep local development and simulator tests independent of paid distribution services.
2. When iOS testing resumes, use invitation-only **TestFlight external testing** for the client pilot. Do not give field testers App Store Connect staff access.
3. For production, publish a **private Custom App** to Sunpride's organization in **Apple Business**, with managed app assignment. Prefer its built-in device management; reuse an existing suitable management service if Sunpride already has one. Do not purchase another service by default.
4. Prefer Sunpride ownership of the production Apple Developer organization account, app record and Apple Business organization, with TLS invited to maintain releases. This is a handover recommendation, not an Apple requirement: an authorized third-party developer can also supply a Custom App (A1, A2).
5. Do **not** apply for the Apple Developer Enterprise Program by default. Private company distribution does not require enterprise signing (A3).

Apple Business replaced Apple Business Manager in April 2026; older references to ABM mean the organization-distribution role now provided by Apple Business. Apple's current regional guide lists **Get Apps** and **built-in device management** for the Philippines (A4, A5). Availability is not evidence that Sunpride has enrolled or that its devices are managed.

This decision does not resume the paused iOS workstream, alter Android delivery, change signing teams or authorize an upload. The current pause remains recorded in [native field development](NATIVE_FIELD_DEV.md) and [release and cutover](../spec/release-and-cutover.md).

## Routes considered

| Route                              | Use here                                                 | Constraints and reason                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simulator / local Xcode            | Development and automated tests                          | No paid membership needed for simulator work. Apple's free Personal Team has short-lived provisioning and is not a client rollout channel (A6).                                                                                                                                                                                           |
| Existing development-signed beta   | Developer-only device testing                            | Registered devices and development provisioning; not an unrestricted IPA, TestFlight build or in-house enterprise distribution. Preserve this path unchanged.                                                                                                                                                                             |
| Ad Hoc distribution                | Exceptional, explicitly authorized small test group only | Requires registered UDIDs and a correctly exported Ad Hoc build. Apple caps registered devices at 100 per product family per membership year; disabling a device does not immediately free a slot (A7). Not the default pilot or production route.                                                                                        |
| TestFlight                         | Client iOS pilot, once authorized                        | Up to 10,000 external testers; up to 100 internal testers who are App Store Connect users. External builds go through beta review as required. Each build is testable for at most 90 days (A8). Use named email invitations, not public links.                                                                                            |
| Private Custom App                 | Recommended production route                             | App Store Connect **Private** distribution restricted to Sunpride's verified Organization ID; Apple reviews the app and every update. Distribution is through Apple Business, not a public IPA link (A1, A2).                                                                                                                             |
| Public or unlisted App Store app   | Not selected                                             | An unlisted link can be forwarded; it is not an organization allowlist. Changing between approved public and private distribution requires a new app record and resubmission (A1).                                                                                                                                                        |
| Apple Developer Enterprise Program | Not selected                                             | Apple requires a legal entity with at least 100 employees, employee-only secure distribution, verification and a use case not adequately served by Custom Apps, Ad Hoc or TestFlight. Sunpride's eligibility and need are unverified; a contractor's enterprise certificate cannot be used as a general client distribution service (A3). |

TestFlight is a testing channel, not permanent field deployment. Apple Business/device management controls installation and assignment; Sunpride's own sign-in, role, registered-device binding and offline authority still control access to business data. Neither an invitation nor an app license grants API permission.

## Current repository boundary

These are source observations, not a fresh signing-account or installed-build check:

| Source                                                                               | What exists now                                                                                                                                                         | What it does not establish                                                                                                                               |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/field-ios/project.yml`](../../apps/field-ios/project.yml)                     | Dev bundle `com.sunpride.field.dev`; Beta bundle `com.sunpride.field.beta`; Beta uses `Apple Development` and team `FV2R5JV6YD`. Minimum deployment target is iOS 26.0. | No verified production team/account, reserved production bundle ID, compatible client fleet or App Store Connect app record.                             |
| [`apps/field-ios/scripts/build-beta.sh`](../../apps/field-ios/scripts/build-beta.sh) | `bun run ipa:field-ios-beta` archives Beta and exports with method `debugging`, destination `export`; optionally installs on a named device.                            | Not Ad Hoc, App Store Connect, TestFlight or Enterprise export. **Do not run this command to enact this plan.** It can provision and optionally install. |
| [`apps/field-ios/Config/Beta.xcconfig`](../../apps/field-ios/Config/Beta.xcconfig)   | Beta uses the public Sunpride HTTPS origin and numeric version/build settings.                                                                                          | Not an isolated review environment or proof that a reviewer can sign in, enroll and reach every reviewed feature.                                        |
| [`apps/field-ios/docs/BETA_FEATURES.md`](../../apps/field-ios/docs/BETA_FEATURES.md) | Existing feature flags and developer-beta instructions.                                                                                                                 | No upload authorization or evidence that the development-signed beta is suitable for client distribution.                                                |

No native configuration, entitlement, certificate, provisioning profile, app record or export script is changed by this issue. Before implementing TestFlight, add a separately reviewed App Store Connect archive/export route rather than relabeling the development IPA. Inspect the installed Xcode's supported export options at that time; no upload command is supplied as though it already exists.

## Ownership and release prerequisites

These are prerequisites for **execution**, not unanswered policy choices blocking this definition. Unknown values stay unknown. Record non-secret identifiers and approval references in the release issue; keep credentials and signing assets in the authorized secret store, never in source, screenshots, comments or this checklist.

| Owner                                            | Required before the relevant release                                                                                                                                                                                                                             | Status in this issue                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Sunpride authorized legal/account representative | Confirm the legal entity, binding authority, D-U-N-S, organization contact/domain and production Apple Developer account ownership; accept agreements and any membership purchase. Apple lists USD 99/year for the standard program, with regional pricing (A9). | Not requested or verified; no purchase authorized.   |
| Sunpride IT / Apple Business administrator       | Create or identify the verified organization; provide its exact Organization ID, regional storefront and managed-device/enrollment model. Configure a payment method if required even for free app licenses (A10).                                               | Account, ID, payment setup and enrollment unknown.   |
| jc / TLS release owner                           | Authorize iOS work to resume and authorize each publishing action; confirm the publisher team and any cost before enrollment, purchase or upload. The existing personal team remains a development setup, not assumed production ownership.                      | No publication authorization supplied by this issue. |
| TLS iOS maintainer                               | Reserve a production bundle ID in the chosen team; configure distribution signing, correct HTTPS environment, numeric version/build, privacy disclosures and review materials; provide an App Store Connect distribution build.                                  | Not implemented or reserved.                         |
| Sunpride pilot coordinator                       | Supply the named tester list, phone/iOS compatibility and work/personal ownership split through a restricted channel.                                                                                                                                            | No client fleet or tester list inspected.            |
| TLS QA and Sunpride IT                           | Complete the live acceptance checklist below on authorized devices and accounts, then retain evidence with the release issue.                                                                                                                                    | Not run; this lane does not use phones.              |

Recommended production ownership avoids depending indefinitely on jc's personal signing team. It does not require an extra subscription if Sunpride already has the correct account. If a vendor-owned publisher is later preferred, record the ownership and handover agreement before creating the app record; do not silently substitute the developer's or another client's account.

Apple Business's base service, including built-in device management, is currently free (A4). Do not enroll paid add-ons, buy licenses or choose a paid management vendor under this issue. Enterprise membership is USD 299/year if ever separately justified and approved (A3); it buys no exemption from Apple's eligibility rules. No paid/cloud prerequisite is added to local development.

## Pilot and production procedure

### Pilot: invitation-only TestFlight

1. The release owner records authorization, publisher team, app identity, environment and pilot group in the board release issue. If the publisher team differs from today's developer beta, resolve the data transition below first.
2. The iOS maintainer prepares an App Store Connect distribution archive from a recorded commit, not the existing development IPA. Keep DEV/Beta and production identities deliberate; a proposed production ID is not considered reserved until checked in the correct developer account.
3. Provide review notes, contact information, accurate privacy/export-compliance answers and a restricted sample review account. Apple must be able to exercise the app, including its registered-device flow, without real client data or disabling production security (A2).
4. Submit for TestFlight review as needed and invite the named client testers as **external** testers. Keep public invitation links off and administrative access limited to release staff (A8).
5. Testers install TestFlight, accept their invitation, install the identified build, sign in with their own Sunpride account and complete normal phone registration. Run and record the live acceptance checklist.
6. Record the build's actual expiry. Our operating policy is to deliver and verify a replacement at least 30 days before expiry, with reminders at 30, 14 and 7 days remaining; these reminders are a proposed release responsibility, not a scheduler installed by this issue. If no replacement is ready, stop expanding the pilot; do not let a business-critical fleet depend on an expiring build.

### Production: private Custom App and managed assignment

1. Sunpride IT confirms its Apple Business Organization ID and enrollment model. Start with company-owned managed phones; for personal phones obtain consent and select a supported work/personal separation model before enrollment. Do not erase or supervise existing personal phones as a shortcut.
2. The release owner confirms account ownership, final bundle ID and **Private** distribution before the first production submission. In App Store Connect → Pricing and Availability → App Distribution Methods, choose Private and enter only Sunpride's confirmed Organization ID. Do not leave the default Public setting selected (A1).
3. Submit the app and each update to Apple review with sanitized review access (A2). Check current Apple SDK, privacy and submission requirements at release time; review duration and approval are not guaranteed by this plan.
4. After approval, Sunpride IT obtains the app through Apple Business Apps and Books → Custom Apps and assigns it through built-in or already-approved device management (A10). Pilot one managed device before broad assignment. If using an external management service, record its license/content-token and management-certificate renewal responsibilities as applicable.
5. Install and upgrade using that managed channel and record the checklist evidence. Do not distribute the development IPA as a substitute. Redemption-code delivery is not our default because it does not provide the same managed reassignment/offboarding controls.
6. Maintain an inventory of release owner, bundle/team/app identifiers, deployed version/build, assigned group, membership renewal and applicable management-token/certificate expiries. Our proposed reminders are 60, 30 and 7 days before renewal/expiry; verify the actual dates in the accounts, not from assumed one-year lifetimes.

## Updates, recovery and offboarding

- **Preserve offline work first.** Before changing bundle ID, signing team, channel or managed/unmanaged installation, reconcile pending/held operations and photos with the server. A different app identity can install alongside the old app and cannot be assumed to read its SQLCipher store or Keychain. Do not uninstall, wipe, copy keys or claim automatic migration. Cross-team/bundle transition needs a separate rehearsed migration or supervised recovery plan.
- **Prove in-place upgrades.** With the same accepted app identity, test an update containing a local database migration while unacknowledged work exists. Record unchanged operation IDs, retained encrypted storage and the eventual server acknowledgement. A successful download alone is not upgrade acceptance.
- **Release failure.** Pause further assignment, preserve the existing app/data and investigate the exact build. Prefer a higher-build forward fix. TestFlight can offer a still-valid prior test build, but selecting it is not evidence a schema downgrade is safe; production rollback availability must not be assumed. Never uninstall/reinstall to disguise an update failure.
- **Offboarding or lost phone.** Sunpride administrators deny business access through the current server device/account controls; IT separately removes managed assignment/app access as supported. Removing an invitation/license alone is not a server revocation, and removing an app can destroy phone-only work. Reconcile accessible unsent work before any authorized removal; a lost offline phone cannot be remotely reconciled or guaranteed immediately erased.
- **No privileged review path.** Review and test accounts use restricted sample scope and normal device authorization. Do not ship bypass credentials, disable proof validation or embed an admin session to make Apple review easier.

## Live acceptance checklist — not performed by this issue

Use one authorized iPhone and the smallest sample scope that exercises these cases when publication is authorized. Keep source/build identifiers and redacted evidence in the release issue, with pass/fail and actual date. A simulator test, local archive or policy-document check cannot tick these boxes.

- [ ] Published build appears only in the intended TestFlight group or Sunpride Custom Apps organization; read back the configured audience. A non-invited tester/non-target organization cannot obtain it through that restricted channel.
- [ ] Intended device can install, reports the expected bundle/version/build and HTTPS backend, and has no configuration warning. Record iOS version against the current iOS 26.0 minimum.
- [ ] A real restricted user signs in, registers/binds the phone, bootstraps and can run one offline call; no administrative token or security bypass is used.
- [ ] Queue one operation and evidence item offline, close/reopen, update through the chosen channel, then sync. Reconcile exact operation acknowledgements and evidence; nothing is duplicated or lost.
- [ ] A second account or removed scope cannot see the prior account's cached data. Server device/account withdrawal denies fresh online access; document the real remaining offline-authority window rather than promising immediate offline erasure.
- [ ] A replacement build is available and accepted before TestFlight expiry; for production, test managed update, license reassignment and an offboarding rehearsal without deleting unreconciled work.
- [ ] Record publisher ownership, renewal/expiry owners, support contact and release go/no-go separately from software test results.

Definition acceptance for SP-0013 is the documented channel choice, rejected alternatives, source-backed limits, ownership, execution prerequisites and safe release/maintenance checklist. None of the unchecked live steps, account purchases or approvals is claimed complete.

## Apple references

Retrieved 2026-11-03. Apple may change policies or console labels; recheck at publication. These sources describe platform policy, not Sunpride's accounts or client acceptance.

- A1 — [Set distribution methods](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/set-distribution-methods/): Private versus Public, Organization ID restriction, and new app-record requirement when switching approved distribution methods.
- A2 — [Distribute Custom Apps](https://support.apple.com/guide/deployment/distribute-custom-apps-dep0113f6e18/web): own or third-party developers, review of every update, sanitized review access and managed distribution.
- A3 — [Apple Developer Enterprise Program](https://developer.apple.com/programs/enterprise/): eligibility, employee-only purpose, alternatives and annual fee.
- A4 — [Introducing Apple Business](https://www.apple.com/newsroom/2026/03/introducing-apple-business-a-new-all-in-one-platform-for-businesses-of-all-sizes/): April 2026 replacement of Apple Business Manager and free base service with built-in management.
- A5 — [Apple Business feature availability](https://support.apple.com/guide/business/feature-availability-axmef1c47twq/web): Philippines availability of app acquisition and built-in management.
- A6 — [Developer account overview](https://developer.apple.com/help/account/basics/about-your-developer-account/): free development access and Personal Team provisioning limits.
- A7 — [Devices overview](https://developer.apple.com/help/account/devices/devices-overview/) and [Disable or enable a device](https://developer.apple.com/help/account/devices/disable-or-enable-a-device/): registered-device caps, membership-year reset rules and why disabling does not free a slot.
- A8 — [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/): tester categories, beta review and 90-day build lifetime.
- A9 — [Become a member](https://developer.apple.com/programs/enroll/): organization enrollment, binding authority, D-U-N-S and standard membership fee.
- A10 — [Get apps and books in Apple Business](https://support.apple.com/guide/business/get-apps-and-books-axmc21817890/web): Custom App acquisition, assignment and payment-method prerequisite even for free licenses.
