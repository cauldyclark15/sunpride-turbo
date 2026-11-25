# SP-0241 — Offline enrollment and permissive form acceptance

This is an implementation/retest checklist, not evidence of a published phone update.

## Implemented in this change

- Field Add customer downloads a national geography pack, including every barangay, alongside its existing reference lists and enrollment schema. The small pack remains compatible with older clients. Foreground and background sync warm the setup; unavailable transport retains cached lists.
- Missing picker options can be typed or left blank. The typed capture is retained for office follow-up; it is not invented as an official PSGC/reference code.
- Save customer accepts store identity and a person's name with missing nonessential answers, no photo, and no usable GPS. It queues through the existing encrypted customer outbox. Internet-only duplicate checking does not run on this save path. Submit for approval remains a separate completeness boundary.
- Storefront photo absence is accepted by both the native outbox and signed customer enrollment. Supplied images still have bounded JPEG checks. Additional required enrollment answers no longer make a field save disappear; the profile remains Draft with the original submitted copy and missing-field list.
- Explicitly saved phone drafts have an observable count on normal Home, mapping Home, and Customers, opening the draft list. Saving/discarding/completing updates that count without network. Count-only notifications are requested after a draft save and scheduled for the next 8 AM Philippine morning with WorkManager. Denial of notification permission does not affect saving. Android/battery restrictions can delay morning delivery.
- Office Customers shows Draft labels, a Drafts filter/button, and a scoped count, including pages beyond the last result.

## Acceptance still open — do not call this issue complete

1. New customers cannot yet be used for visits or transactions before their first successful upload. Add a durable local customer reference and resolve it to the enrollment acknowledgement before dependent visit/order operations are signed; do not send guessed server IDs.
2. Saved phone-only drafts are not mirrored to the office until Save customer/Submit is used. Completing a submitted customer is still the existing online Submitted customers editor. A unified offline editable draft lifecycle (including amendments, approval-state conflicts, and deduplication across local drafts/outbox/downloaded profiles) remains to build.
3. Phone draft alerts currently count the explicit encrypted phone draft book, not every submitted incomplete profile. Office counts reflect uploaded profiles. Reconcile both into one authoritative deduplicated phone list and verify it reaches zero only after the last incomplete record is completed.
4. Apply persistent editable drafts to the other Field forms. Preserve financial correctness: never post an empty/partial remittance as money, an empty order as a sale, or a placeholder photo as evidence. Store those as separate local drafts until sufficient information exists for the real domain command.
5. Edit customer and older form validation still have nonessential requirements. The current Submitted customers editor explicitly requires internet. Audit Add/Edit and every other Field form against the client's latest permissive-save rule; do not treat the Add customer change as this full audit's completion.
6. Add later duplicate/address/map checks without blocking a local save, and prove photo follow-up through the actual customer editing path.

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
