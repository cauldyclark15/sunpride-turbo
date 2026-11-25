# Customer enrollment drafts (SP-0241, SP-0244)

In the Field app, open More > Add customer (or Add customer on the Customer mapping Home).

1. Enter whatever customer details are available.
2. Tap Save as draft. Required fields, location and the storefront photo may be missing; partly typed values can be kept too.
3. The Drafts list shows every saved draft. Tap a customer to reopen it, or Add another customer to begin another. The Drafts button keeps any partly filled current customer before opening the list.
4. Edit the draft and save it as a draft again. With a store name and the person's name, Save customer also queues the available details for the office without requiring a photo, phone number, address lists or GPS. Missing details keep the uploaded customer marked Draft.
5. Submit for approval is the separate complete-submission action. It checks required fields and entered values, marking missing details on the form. Save customer remains available to keep incomplete work instead.
6. Queued customers follow the existing sync and office approval process. Only that queued customer's phone-only draft is removed; other phone drafts remain editable. A queued capture is not yet a customer that can be used for a visit or transaction before its first successful upload.

Save as draft keeps work only in the encrypted phone store for the signed-in account, device and area; Save customer and Submit for approval queue it for the office. Existing unfinished forms from earlier versions remain available. A draft save confirms success only after the phone write succeeds; a failed write leaves the current entries on screen for retry.

Home and Customers show the number of explicitly saved phone drafts. Tapping that count opens Drafts. With notification permission, the phone requests a reminder after saving a draft and each morning while these drafts remain; Android may delay morning delivery under battery restrictions. This count does not yet include submitted incomplete customer profiles. Office Customers has its own Drafts count and filter for uploaded profiles. These are not yet a unified list.

Edit customer accepts blank nonessential phone/address details and typed places when a list has no matching option. It keeps those answers for office review; accepting the change leaves the customer Draft until its required information is complete. Typed place answers do not create entries in the official geography lists. Recognized official selections with conflicting parents still need correction.

The unfinished acceptance work and physical-phone checklist are in `docs/delivery/SP-0241-OFFLINE-ACCEPTANCE.md`. This source change is not a published phone update.

Discard and start again removes only the open draft. Saved drafts for other customers remain in Drafts.

## iOS Field app

Customers > Add a store has Save as draft and Drafts as well. These drafts preserve the existing iOS store form (including address, channel, location and photo when present); this change does not replace it with Android's newer customer-master form. Even an empty or partly typed store can be kept without setup or a connection. Tap a draft to finish it and Save store to submit it through the existing checks. Saving again updates the same draft rather than creating another.

Both apps keep several drafts in encrypted local storage. The final complete save queues the customer and removes only its own draft in one transaction, so interrupted saves cannot leave both a submitted customer and its unfinished copy. Drafts are not uploads or office records. Account/device/area isolation remains in place. On iOS, refreshing the downloaded lists keeps drafts; clearing downloaded data holds drafts for review rather than deleting them. They can only be reopened after the same account, phone and area have been verified again. Final Save keeps the current location policy: location is best effort, not a required field.

## Verification boundaries

JVM tests cover incomplete save, multiple drafts, reopen/edit, serialization and restart, photo/location/additional-field retention, old-format restoration, stale writes, write failure and the existing final-submission checks. Android build and lint pass; the draft screen and encrypted-storage instrumentation checks compile but were not run on a phone. iOS simulator tests exercise the real encrypted store and take two incomplete customers through draft save, app termination, simulated no-signal relaunch, reopen, required-field warnings and resave, then complete one customer and confirm only that draft is removed. Storage tests also check refresh preservation, cache clearing, holds and transaction rollback. The iOS network/account boundaries in that walkthrough are in-process substitutes, not live integrations. Physical phone restart, live sync and office approval remain separate checks.
