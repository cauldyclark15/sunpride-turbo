# SP-0241 — Offline enrollment and permissive form acceptance

This is an implementation/retest checklist, not evidence of a published phone update.

## Implemented in this change

- Field Add customer downloads a national geography pack, including every barangay, alongside its existing reference lists and enrollment schema. The small pack remains compatible with older clients. Foreground and background sync warm the setup; unavailable transport retains cached lists.
- Missing picker options can be typed or left blank. The typed capture is retained for office follow-up; it is not invented as an official PSGC/reference code.
- Save customer accepts store identity and a person's name with missing nonessential answers, no photo, and no usable GPS. It queues through the existing encrypted customer outbox. Internet-only duplicate checking does not run on this save path. Submit for approval remains a separate completeness boundary.
- Storefront photo absence is accepted by both the native outbox and signed customer enrollment. Supplied images still have bounded JPEG checks. Additional required enrollment answers no longer make a field save disappear; the profile remains Draft with the original submitted copy and missing-field list.
- Explicitly saved phone drafts have an observable count on normal Home, mapping Home, and Customers, opening the draft list. Saving/discarding/completing updates that count without network. Count-only notifications are requested after a draft save and scheduled for the next 8 AM Philippine morning with WorkManager. Denial of notification permission does not affect saving. Android/battery restrictions can delay morning delivery.
- Office Customers shows Draft labels, a Drafts filter/button, and a scoped count, including pages beyond the last result.
- Follow-up: the existing Edit customer change-request form now accepts missing/partly typed phone details, blank address parts, typed places absent from the downloaded lists, and absent camera/GPS. Saving a text/photo change does not fetch GPS or reverse-search an address. Typed places survive signed sync, office acceptance and later editing as Draft answers; official geography lists are never changed. Recognized official selections still cannot claim conflicting parent places.
- Accepting a customer edit recomputes Draft/completeness and missing fields without approving a new enrollment or replacing the original submitted copy. Clearing phone details updates the contact, customer and first ship-to consistently. The signed-request check also attaches a later storefront photo to the same store with no optional phone/address/GPS prerequisites.

## Continuation: editable captures and unfinished forms

- A named customer saved with Save as draft or Save customer now keeps its entry in the same editable phone draft book and queues an immutable capture. It is available in Customers for a visit/order/collection before upload. An unnamed form can still be kept locally, but is not fabricated into a usable customer.
- Reopening and saving an incomplete queued customer adds a serial revision of the same customer, rather than creating another enrollment. The original capture acknowledgement remains the identity for already-saved visits and carts. Changed operation bytes are never reused under an old request key.
- The signed writer checks the current person/phone, current customer edit permission, revision order and a fingerprint of the canonical customer. Office changes/approval cannot be overwritten by an old phone form. Refused/conflicting work remains available for review.
- Completing the form removes its unfinished count immediately without network. The phone retains a separate confirmation copy until the next sync; if the current office rules still find a missing answer, it returns to the draft list. Office completions clear only a matching acknowledged revision, never a newer unsent edit or the currently open form.
- Submitted customer details opened online have an encrypted, authorization-ticketed editor copy for offline reopening from the customer page. Their unfinished edits can be kept independently; Save details queues a signed, version-checked amendment, not an approval. A current online read is still needed to discover a customer not already downloaded/opened.
- Added Save as draft to the standard visit/note/collection form, partial/empty order editor, structured activities, photo selection/retry, remittance, collector, call sheet, workforce forms, joint calls, distributor forms, truck counts and retail audits. These encrypted unfinished forms are separate from real domain operations. Missing amount/date/photo/selection never fabricates money, a sale, attendance or evidence. The existing final domain validation still applies when recording the actual fact.
- Generic form drafts reopen by returning to the same form and record. They are not a new universal drafts inbox or customer-alert count. A changed/missing authorization still holds recording; draft storage is not an authorization grant. Sell-area carts retain their existing Hold/Recall workflow; that area was not changed here.

## Remaining verification and delivery

1. The standard Android forms above now have a persistent unfinished-save path. Exercise their actual Compose navigation, camera/gallery and restart flows on the designated phone; JVM persistence tests and compilation are not that proof.
2. Check prior-version already-uploaded incomplete profiles separately: they remain accessible through Submitted customers, but are not automatically imported into the new capture-revision book/count. The new unified count covers explicitly saved drafts and incomplete captures saved through this updated lifecycle.
3. Test online-only address/duplicate checks after reconnection. No local incomplete save waits for those checks. Office duplicate review still uses the existing customer tools.
4. Run the airplane-mode acceptance and notification checks below, then publish and verify the accepted signed Field build on Drive and the Play testing track. No phone, emulator, signing publication or live service was touched in this lane.
5. iPhone/iPad is on hold; no iOS target was changed, built or exercised.

## Form audit

The new unfinished-save controls preserve typed text and selections independently of the final command. This is source/model coverage, not a live device sign-off. Financial amounts, actual measurements, real photos and explicit Start/End actions are still checked before posting their domain facts. Persisted workforce/visit location is never refreshed into an invented current fix; stale evidence follows the existing final checks.

## Smallest real-phone proof (release owner; no device use in this lane)

1. Sign in online, sync once, then enable airplane mode. Restart the app without clearing its storage.
2. Add a customer using a province outside the agent's current area. Use every picker, including municipality, barangay, postal code, dependent groups/channels, and additional fields. Confirm all downloaded options remain available. Exercise a missing-option typed value too.
3. Save just the store/person names without photo/GPS; restart and reopen/edit it. Verify the draft count and draft notification, then finish the last draft and verify zero and notification removal.
4. Start a visit and an order against that newly saved named customer before any connection returns. JVM tests exercise the local production rules and acknowledgement resolution; the signed HTTP tests separately exercise the actual writers. Neither substitutes for this phone step.
5. Reconnect and sync twice. Read back one customer, preserved typed answers, Draft status in office Customers, and the linked visit/order without duplicates. Complete required details, submit, and verify count/lifecycle transitions.
6. Save incomplete visits, order forms, activities, photos and remittances; restart offline and complete each. Verify that keeping an unfinished form posts no money, sale or evidence. Include the other field modes for accounts allowed to use them.
7. With notification permission granted, verify a morning notification from the OS while the app is closed; repeat with denied permission and confirm saving still works.
8. After source integration, build the accepted signed Field version, publish to both Drive and the Play testing track, verify both published version identifiers, and only then ask testers to update. No publishing was attempted in this lane.

## Verification environment

Use the assigned SP-0241 database key and reserved ports only. On this Linux host the app role cannot install pgvector. The scratch-only bootstrap at `/home/jc/.hermes/cache/scratch/sp241-extension-bootstrap.js` initializes that extension only in disposable `sunpride_lane_sp241_t…` test databases through the existing local administration role, while tests/migrations retain the ordinary app role. It changes no domain or transport behavior and no shared template or role grants.

The web gate requires the real licensed `@heroui-pro/react` artifacts (`empty-state`, `kpi`, `sidebar`). They are present for this continuation: web TypeScript, the touched Customers suite and lint passed without substitute components or declarations. Preserve that dependency requirement.
