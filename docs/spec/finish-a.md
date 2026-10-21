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

A collection against an unvoided same-trip credit invoice writes one payment, one controlled Official Receipt reservation, its frozen document, and the existing immutable outbox intent in one Room transaction. It creates no second sale or stock movement. Replays retain the number and facts. Card references must not contain a card number. Cash captures enter the expected cash count; noncash stays awaiting office confirmation. A refused upload does not erase physically received cash or release that amount for local recapture. Office reconciliation is required. Print/reprint uses the frozen OR and original invoice reference, and print journaling resolves the collection payment. Broader historical returns and the remaining correction/cheque adapters are separate backlog items, not implied by this slice.

## F-108/F-109: governed invoice tax and payment-only ORs

SAP condition metadata distinguishes VATable, exempt and zero-rated selling lines. A zero rate without an explicit class is unknown, not an exemption. The native checkout freezes each line's class/source/version and VAT partition after governed schemes/manual reductions, without changing the selling amount. Exclusive-tax sources retain the source net/gross quote ratio and rounding rather than a second unit-price calculation. The canonical writer re-derives and compares the printed tax snapshot before issuing the number; changed facts require office review, never a silent reprint with new amounts. Paper shows the four partitions and exempt/zero-rated line labels. Missing tax setup blocks invoice completion but not a cart's price preview.

New collection ORs retain the original invoice reference/tax facts for reconciliation but recognize no invoice tax again. Their paper and office view say that they acknowledge payment only. Existing frozen documents are not rewritten. Old clients remain compatible only for their original same-rate, inclusive, VAT-only calculation; other treatments require the updated handheld. Release the API and handheld together. The actual new SAMPLE API invoice/OR snapshots feed the native unit fixture; source change after capture does not change frozen paper. Targeted API, native and web cases plus package checks passed; this is not BIR filing or physical printer/device proof.

## F-019/F-020: fiscal history

Lost/retired allocation tails can be reconciled by another authorized administrator only after device suspension/retirement; they never return to the available number pool. Issuance refuses a closed allocation even after device reinstatement. Audit search/export uses scoped filters and completes bounded paging before exporting; it does not promise a retention/deletion policy that has not yet been implemented.

## F-221: refused mock attempts

A locally refused mock check-in queues independent integrity telemetry in the existing encrypted outbox. It never opens a visit or advances call flow, and no mock coordinates are retained in that telemetry. Signed upload counts the refusal once in the office mock-attempt denominator and creates a mock finding, not travel/batch facts. Not-yet-uploaded attempts remain outside the server denominator; OS signals are not hardware attestation.

## F-110/F-124: van manual discounts

The van cart accepts separate line reductions and a basket reduction after approved schemes. Basket centavos are allocated proportionally with deterministic remainder order; reductions cannot make a line negative. Saving rechecks the quote, current cached role/channel/value band and any exact-cart approval inside the existing encrypted sale transaction. Preview is not permission to save. The immutable operation includes the reason, request and matching certificate, and the canonical server writer reconstructs its financial facts and consumes the existing fiscal override once. Within-own-limit reductions record a reason through that same authority; there is no parallel approval table.

An independent approver can explicitly authorize offline use when the effective policy permits it. Phones verify a P-256 certificate using only the server public key, bound to the request, person, branch, rule, channel, amount, reason, named product/quantity/price/reduction facts and expiry. The signing key is domain-separated from the server cursor secret; it is never shipped to Android and does not touch the phone's Keystore private key. Online-only approvals get a one-minute live certificate; long offline use is not silently enabled. Every upload still rechecks current requester/approver scope and authority. Edited carts retire earlier approvals; stale responses are fenced by request/session epochs. Known refusal clears the current certificate, and a withdrawn matrix uses the existing held-scope path until fresh authorization. No company login or SAP acknowledgement is contained in an approval code.

This slice supplies van line/basket capture and portable authorization. Remaining cross-channel adapters and credit/price/stock/void authority connections stay explicit in the backlog; these notes do not declare the entire F-124/F-511 group complete. Targeted API authority/withdrawal/consumption, the exact API-to-JVM certificate/facts bridge, two new native unit cases and the new web reviewer case passed. Device installation remains for the final new-screen pass.

### F-110: simple programme integration

The van now downloads active, canonically eligible percentage, bundle and free-goods rules from the existing TPM authority rather than an empty promotion list. The negotiated native version follows the same precedence/exclusion, residual-net stacking, half-up and proportional-bundle semantics as that server engine; historical unversioned snapshots keep their prior calculation. Manual reductions follow those schemes. The canonical sale writer independently verifies paid/free stock quantities, programme metadata and minimum scheme reductions before applying the existing exact-facts financial authority. Offer codes and total discounts are labelled separately on paper so an additional manual reduction is not falsely attributed entirely to a programme.

The existing frozen v1 wire is unchanged; the codec explicitly removes negotiated extension fields only from its validation copy, then validates and retains their typed metadata. Programme eligibility is bound to the downloaded buyer, not a caller-selected channel or a different outlet sharing a price book. Unsupported on-invoice mechanics, missing governed item units and unsupported engine versions create visible completion holds rather than silently dropping a benefit. This slice handles the three simple on-invoice mechanics requested by F-110; deferred claimable benefits remain the separate TPM/SAP workflow. One small API-to-native fixture covers stacked percentages, a bundle plus a manual basket reduction and a governed gift; a native-Postgres case reads the actual active programme/outlet and refuses its withdrawal. No old full suite or route walk was repeated.

## F-119: operational posting bridges

Independent settlement approval links the retained operational request to one canonical SAP outbox effect for that immutable version, with frozen source facts and dependencies. It waits for earlier invoice/payment/credit/movement effects. Only the identity/hash/lease-checked provider acknowledgement marks the request acknowledged and writes the trip reference. Replaying a version preserves its original dependency set. Queue conflicts stay retained for operator resolution, not renamed as success. The fiscal register reads existing SI/OR/CM source events rather than creating duplicate financial documents; it distinguishes queued/refused/acknowledged and labels mock success SAMPLE. No live SAP posting is claimed.

## Needs Sunpride

Real IdP/provider configuration, SAP access/mappings, fiscal registration/permit evidence and production signing/distribution ownership remain external inputs. Existing clearly marked sample/mock data keeps the software usable without inventing these outcomes. No sample registration is presented as a BIR filing. These notes describe our implementation choices, not confirmed client operating policy.

## iOS parity later

No iOS files were changed. Company sign-in/pairing, master copy/freshness, the update-channel equivalent, collection/OR screens and refused-attempt telemetry need a separately authorized iOS pass when that app resumes.
