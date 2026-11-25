# Customer enrollment drafts (SP-0241, SP-0244)

In the Field app, open More > Add customer (or Add customer on the Customer mapping Home).

1. Enter whatever customer details are available.
2. Tap Save as draft. Required fields, location and the storefront photo may be missing; partly typed values can be kept too. With both the store name and the person's name, this also queues the available profile for the office and makes it available in Customers for a visit or transaction before upload.
3. The Drafts list shows saved unfinished customers, including those already queued by this version. Tap a customer to reopen it, or Add another customer to begin another. The Drafts button keeps any partly filled current customer before opening the list.
4. Edit the draft and save it again. Save customer also queues the available details without requiring a photo, phone number, address lists or GPS. Repeated saves of the same draft update that customer after sync; they do not enroll another copy.
5. Submit for approval is the separate complete-submission action. It checks required fields and entered values, marking missing details on the form. Save customer remains available to keep incomplete work instead.
6. A new customer's durable phone reference links its visit, order and collection to the original enrollment acknowledgement during sync. The website still makes its own completeness and approval checks. Missing pricing is shown as unknown, never borrowed from another customer.

Drafts are encrypted and scoped to the signed-in account, device and area. Forms without enough identity to make a usable customer stay only on the phone; named captures reach office Customers on sync. Completing a form removes its unfinished count locally, while a confirmation copy protects it until sync. If current office rules still find missing answers, it returns to Drafts. An office change or approval is never overwritten by a stale phone revision.

Home and Customers show the unfinished count and open Drafts. With notification permission, the phone requests a reminder after a draft save and each morning while drafts remain; Android may delay delivery under battery restrictions. Office Customers has a scoped Drafts count and filter. Existing incomplete profiles uploaded by older versions are not automatically added to the new phone book/count; use Submitted customers to open those.

Edit customer accepts blank nonessential phone/address details and typed places when a list has no matching option. It keeps those answers for office review; accepting the change leaves the customer Draft until its required information is complete. Typed place answers do not create entries in official geography lists. Recognized official selections with conflicting parents still need correction. Previously opened Submitted customer details can reopen from their authorized encrypted copy without signal; Save details queues a version-checked change, not approval.

Other standard Field forms have Save as draft for unfinished text, selections and supported photos. Reopen the same record/form to continue. These are local unfinished forms, not posted money, orders, attendance or evidence; final recording keeps the domain's real-data checks. They are separate from the customer draft-alert count. Sell-area carts keep their existing Hold/Recall workflow.

The remaining verification and physical-phone checklist are in `docs/delivery/SP-0241-OFFLINE-ACCEPTANCE.md`. This source change is not a published phone update.

Discard and start again removes only the open draft. Saved drafts for other customers remain in Drafts.

## iOS Field app

Customers > Add a store has Save as draft and Drafts as well. These drafts preserve the existing iOS store form (including address, channel, location and photo when present); this change does not replace it with Android's newer customer-master form. Even an empty or partly typed store can be kept without setup or a connection. Tap a draft to finish it and Save store to submit it through the existing checks. Saving again updates the same draft rather than creating another.

Both apps keep several drafts in encrypted local storage. The final complete save queues the customer and removes only its own draft in one transaction, so interrupted saves cannot leave both a submitted customer and its unfinished copy. Drafts are not uploads or office records. Account/device/area isolation remains in place. On iOS, refreshing the downloaded lists keeps drafts; clearing downloaded data holds drafts for review rather than deleting them. They can only be reopened after the same account, phone and area have been verified again. Final Save keeps the current location policy: location is best effort, not a required field.

## Verification boundaries

JVM tests cover incomplete save, multiple drafts, reopen/edit, serialization and restart, photo/location/additional-field retention, old-format restoration, stale writes, write failure and the existing final-submission checks. Android build and lint pass; the draft screen and encrypted-storage instrumentation checks compile but were not run on a phone. iOS simulator tests exercise the real encrypted store and take two incomplete customers through draft save, app termination, simulated no-signal relaunch, reopen, required-field warnings and resave, then complete one customer and confirm only that draft is removed. Storage tests also check refresh preservation, cache clearing, holds and transaction rollback. The iOS network/account boundaries in that walkthrough are in-process substitutes, not live integrations. Physical phone restart, live sync and office approval remain separate checks.
