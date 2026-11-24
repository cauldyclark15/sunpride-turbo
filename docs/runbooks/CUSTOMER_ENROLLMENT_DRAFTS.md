# Customer enrollment drafts (SP-0241)

In the Field app, open More > Add customer (or Add customer on the Customer mapping Home).

1. Enter whatever customer details are available.
2. Tap Save as draft. Required fields, location and the storefront photo may be missing; partly typed values can be kept too.
3. The Draft customers list shows saved drafts. You can begin another customer or open an existing draft with Edit draft.
4. Edit the draft and save it as a draft again, or complete the required details and tap Submit for approval.
5. Submit for approval checks required fields and entered values. Missing details are marked on the form; an incomplete customer is not queued for approval.
6. A complete submission follows the existing sync and office approval process. Only that submitted draft is removed; other drafts remain editable.

Drafts are kept in the existing encrypted phone store for the signed-in account, device and area. They are not sent to the office or shared with another phone until submitted. Existing unfinished forms from earlier versions remain available. A draft save confirms success only after the phone write succeeds; a failed write leaves the current entries on screen for retry.

Discard and start again removes only the open draft. Saved drafts for other customers remain in Draft customers.

## Verification boundaries

JVM tests cover incomplete save, multiple drafts, reopen/edit, serialization and restart, photo/location/additional-field retention, old-format restoration, stale writes, write failure and the existing final-submission checks. Build and lint verify the Android sources. Device interaction and a real office approval are separate checks; no device installation is required for the lane proof.
