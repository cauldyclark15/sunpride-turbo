# SP-0241 — Offline enrollment and permissive form acceptance

This is an implementation/retest checklist, not evidence of a published phone update.

## Implemented in this change

- Field Add customer downloads a national geography pack, including every barangay, alongside its existing reference lists and enrollment schema. The small pack remains compatible with older clients. Foreground and background sync warm the setup; unavailable transport retains cached lists.
- Missing picker options can be typed or left blank. The typed capture is retained for office follow-up; it is not invented as an official PSGC/reference code.
- Save customer accepts store identity and a person's name with missing nonessential answers, no photo, and no usable GPS. It queues through the existing encrypted customer outbox. Internet-only duplicate checking does not run on this save path. Submit for approval remains a separate completeness boundary.
- Storefront photo absence is accepted by both the native outbox and signed customer enrollment. Supplied images still have bounded JPEG checks. Additional required enrollment answers no longer make a field save disappear; the profile remains Draft with the original submitted copy and missing-field list.
- Explicitly saved phone drafts have an observable count on normal Home, mapping Home, and Customers, opening the draft list. Saving/discarding/completing updates that count without network. Count-only notifications are requested after a draft save and scheduled for the next 8 AM Philippine morning with WorkManager. Denial of notification permission does not affect saving. Android/battery restrictions can delay morning delivery.
- Office Customers shows Draft labels, a Drafts filter/button, and a scoped count, including pages beyond the last result.
- Follow-up: the existing Edit customer change-request form now accepts missing/partly typed phone details, blank address parts and absent camera/GPS. Saving a text/photo change does not fetch GPS or reverse-search an address. Supplied official geography still has to be valid; unmatched typed places in Edit customer remain an open item.
- Accepting a customer edit recomputes Draft/completeness and missing fields without approving a new enrollment or replacing the original submitted copy. Clearing phone details updates the contact, customer and first ship-to consistently. The signed-request check also attaches a later storefront photo to the same store with no optional phone/address/GPS prerequisites.

## Acceptance still open — do not call this issue complete

1. New customers cannot yet be used for visits or transactions before their first successful upload. Add a durable local customer reference and resolve it to the enrollment acknowledgement before dependent visit/order operations are signed; do not send guessed server IDs.
2. Saved phone-only drafts are not mirrored to the office until Save customer/Submit is used. Completing a submitted customer is still the existing online Submitted customers editor. A unified offline editable draft lifecycle (including amendments, approval-state conflicts, and deduplication across local drafts/outbox/downloaded profiles) remains to build.
3. Phone draft alerts currently count the explicit encrypted phone draft book, not every submitted incomplete profile. Office counts reflect uploaded profiles. Reconcile both into one authoritative deduplicated phone list and verify it reaches zero only after the last incomplete record is completed.
4. Apply persistent editable drafts to the other Field forms. Preserve financial correctness: never post an empty/partial remittance as money, an empty order as a sale, or a placeholder photo as evidence. Store those as separate local drafts until sufficient information exists for the real domain command.
5. The legacy Edit customer change-request path now permits missing nonessential phone/address/GPS/photo details, but its unmatched typed place values still need deferred handling. The Submitted customers editor still requires internet. Finish the required-field and restart-persistence audit for every Field form; do not treat the Add/Edit changes as that full audit's completion.
6. Add later duplicate/address/map checks without blocking a local save. Later photo attachment has signed-request and native model coverage; the actual gallery/camera and editing workflow still needs physical proof.

## Form audit and continuation seams

These are code findings and implementation follow-ups, not passed end-to-end checks.

| Form                                                                    | Current boundary                                                                                                                    | Still needed                                                                                                                                                 |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add customer (`census/CensusScreen.kt`, `CustomerCapture.kt`)           | Explicit phone drafts accept unfinished text; Save customer queues identity-only captures; Submit for approval checks completeness. | Unify explicit drafts, queued captures and uploaded incomplete profiles; mirror editable drafts to office.                                                   |
| Edit customer change (`census/CensusRules.kt`, API `masters/census.js`) | Store/person identity is required; phone/address/photo/GPS can be missing. Existing access and office decisions remain separate.    | Preserve unmatched typed places for later resolution; persistent unsent edit drafts across restart.                                                          |
| Submitted customers (`ui/customers/SubmittedCustomers.kt`)              | Loads and saves through online customer editor/amend requests with a current version check.                                         | Durable offline edits plus acknowledgement/conflict handling; do not cache permission after approval or withdrawal.                                          |
| Visits and activities (`ui/diagnosticvisit/DiagnosticVisitScreen.kt`)   | Start/end and Add note queue real domain operations, not editable partial forms.                                                    | Separate encrypted unfinished intent forms; resolve new-customer capture references before upload. Preserve genuine visit facts and do not invent check-ins. |
| Orders (`ui/orders/OrderDraftScreen.kt`)                                | Has persistent order drafts, but Save draft is disabled without valid nonempty quantities and needs an existing call.               | Persist partial/empty cart and requested date separately; offline new-customer/call linking. Never post a partial cart as a sale.                            |
| Photos (`storage/EvidencePhotos.kt`, controller `savePhoto`)            | Actual JPEG evidence is sealed against a call; customer storefront photo is optional.                                               | Persistent unfinished photo form/selection and later linking, without fabricated evidence.                                                                   |
| Collections (`ui/CollectorScreen.kt`, `CollectorDraft`)                 | Promise/cheque functions validate actual amounts/dates and evidence before queuing. Visible typing is session-only Compose state.   | Encrypted unfinished form saves independent of financial posting and live assignment fetch.                                                                  |
| Remittances and other field modes                                       | Not comprehensively audited in this continuation.                                                                                   | Enumerate remaining forms and both persistence/writer checks before claiming the requested every-form rule.                                                  |

## Smallest real-phone proof (release owner; no device use in this lane)

1. Sign in online, sync once, then enable airplane mode. Restart the app without clearing its storage.
2. Add a customer using a province outside the agent's current area. Use every picker, including municipality, barangay, postal code, dependent groups/channels, and additional fields. Confirm all downloaded options remain available. Exercise a missing-option typed value too.
3. Save just the store/person names without photo/GPS; restart and reopen/edit it. Verify the draft count and draft notification, then finish the last draft and verify zero and notification removal.
4. Start a visit and an order against that newly saved customer before any connection returns. This step is currently blocked by acceptance item 1 and must not be reported as passed.
5. Reconnect and sync twice. Read back one customer, preserved typed answers, Draft status in office Customers, and the linked visit/order without duplicates. Complete required details, submit, and verify count/lifecycle transitions.
6. Save incomplete visits, order forms, activities, photos and remittances; restart offline and complete each. This remains to implement, not a tested flow.
7. With notification permission granted, verify a morning notification from the OS while the app is closed; repeat with denied permission and confirm saving still works.
8. After source integration, build the accepted signed Field version, publish to both Drive and the Play testing track, verify both published version identifiers, and only then ask testers to update. No publishing was attempted in this lane.

## Verification environment

Use the assigned SP-0241 database key and reserved ports only. On this Linux host the app role cannot install pgvector. The scratch-only bootstrap at `/home/jc/.hermes/cache/scratch/sp241-extension-bootstrap.js` initializes that extension only in disposable `sunpride_lane_sp241_t…` test databases through the existing local administration role, while tests/migrations retain the ordinary app role. It changes no domain or transport behavior and no shared template or role grants.

The web gate needs the real licensed `@heroui-pro/react` artifacts (`empty-state`, `kpi`, `sidebar`). The installed/public cached package is a postinstall shell. Do not replace those components or add fake declarations to manufacture a passing gate.
