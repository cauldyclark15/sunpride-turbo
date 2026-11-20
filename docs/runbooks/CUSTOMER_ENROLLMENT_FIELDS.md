# Customer enrollment fields (SP-0229)

Setup > Enrollment form lets an administrator add text, number, date, choice-list, yes/no and photo fields. Drag a field to a new position or use Move up / Move down, then Save enrollment form.

The original customer-sheet fields and Street 1 rule are unchanged. Extra fields appear after those fields on Customers > Add customer and Field app > Add customer. The phone downloads the current form when opening Add customer online (and during its normal customer-setup warmup); its authorized encrypted setup cache is used offline. Answers survive the existing encrypted draft and outbox paths.

## Required or optional

Select distribution channels and/or customer types (the existing Type of Business list). A field is required if the customer matches any selected channel OR any selected type. Otherwise it may be left blank. No selections means optional for everyone. Zero and an explicit No are answers, not blanks. Required fields are checked on the phone, office saves, uploads and approval. An older queued capture that lacks a newly required answer is retained for review rather than silently inventing an answer.

Names and order can change. Stable internal field keys do not. Existing field types, fields and choices cannot be removed, to keep prior answers readable. New choices may be added. Concurrent editor saves use a revision check; reload when another administrator has changed the form. Changes record who, when, and the previous/new definition in the audit log.

## Exports and uploads

- Customers > select customers > Export selected includes the added fields, including photo data. It exports only the selected rows, like the existing export.
- Customers > Upload customers > download the current Excel or CSV template. Extra columns follow the original columns in form order. Keep the bracketed key in each extra heading: it identifies the field even after a rename.
- Text stays text; number cells use decimal notation; dates use YYYY-MM-DD; yes/no cells use true or false; choice cells contain an exact choice.
- Photo cells use a JPEG data URL, not an arbitrary remote URL. For photo values larger than Excel's cell limit, use CSV. The office form accepts JPEG files; the phone offers its camera and image picker and compresses its selected photo.
- Blank optional upload cells keep existing answers on an existing customer. Clear an answer in the customer form when removal is intended. Missing required answers on new customers are marked as row problems before import. The canonical customer writer checks again while saving.
- The import result CSV retains additional values too. Original SAP columns and reference sheets remain unchanged.

## Bounds and implementation

The form supports 30 extra fields, up to four of them photos, 100 choices per choice list, 500 text characters, and JPEGs up to 100 KB each. Photos are stored with the scoped customer answers, not public links. Native uploads split photo-sized operations below the existing request byte limit while preserving their order and acknowledgements.

Migration: 0839_enrollment_form.sql. Definitions live in enrollment_forms; answers live in customer_profiles.custom_fields. GET/PUT /api/v1/customers/enrollment-form, customer reference and field census setup expose definitions. Only admin.manage may edit them. Customer read/write and approval retain their existing authorization and independent-approver rules.

Verification uses a disposable lane-prefixed PostgreSQL harness and simulated signed device credentials, web rendering tests and Android JVM/build/lint. These are not a deployed-site or physical-phone proof. No phone installation is part of this change.
