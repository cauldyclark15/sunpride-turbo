# Customer enrollment drafts (SP-0241, SP-0244)

In the Field app, open More > Add customer (or Add customer on the Customer mapping Home).

1. Enter whatever customer details are available.
2. Tap Save as draft. Required fields, location and the storefront photo may be missing; partly typed values can be kept too.
3. The Drafts list shows every saved draft. Tap a customer to reopen it, or Add another customer to begin another. The Drafts button keeps any partly filled current customer before opening the list.
4. Edit the draft and save it as a draft again, or complete the required details and tap Submit for approval.
5. Submit for approval checks required fields and entered values. Missing details are marked on the form; an incomplete customer is not queued for approval.
6. A complete submission follows the existing sync and office approval process. Only that submitted draft is removed; other drafts remain editable.

Drafts are kept in the existing encrypted phone store for the signed-in account, device and area. They are not sent to the office or shared with another phone until submitted. Existing unfinished forms from earlier versions remain available. A draft save confirms success only after the phone write succeeds; a failed write leaves the current entries on screen for retry.

Discard and start again removes only the open draft. Saved drafts for other customers remain in Drafts.

## iOS Field app

Customers > Add a store has Save as draft and Drafts as well. These drafts preserve the existing iOS store form (including address, channel, location and photo when present); this change does not replace it with Android's newer customer-master form. Even an empty or partly typed store can be kept without setup or a connection. Tap a draft to finish it and Save store to submit it through the existing checks. Saving again updates the same draft rather than creating another.

Both apps keep several drafts in encrypted local storage. The final complete save queues the customer and removes only its own draft in one transaction, so interrupted saves cannot leave both a submitted customer and its unfinished copy. Drafts are not uploads or office records. Account/device/area isolation remains in place.

## Verification boundaries

JVM tests cover incomplete save, multiple drafts, reopen/edit, serialization and restart, photo/location/additional-field retention, old-format restoration, stale writes, write failure and the existing final-submission checks. Android build and lint pass; the draft screen and encrypted-storage instrumentation checks compile but were not run on a phone. iOS simulator tests exercise the real encrypted store and take two incomplete customers through draft save, app termination, simulated no-signal relaunch, reopen, required-field warnings and resave. The iOS network/account boundaries in that walkthrough are in-process substitutes, not live integrations. Physical phone restart, live sync and office approval remain separate checks.
