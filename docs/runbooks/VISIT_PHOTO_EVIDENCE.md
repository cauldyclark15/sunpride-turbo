# Visit photo evidence (AND-016)

How a field phone captures, keeps and uploads visit photos. Android ships first; iOS (IOS-016, SP-0042)
uses the same server API and bootstrap field.

## Photo types

- The backend list lives in `packages/backend/convex/visits/policy.ts` (`EVIDENCE_PHOTO_TYPES`) and
  reaches phones in every bootstrap page as `photoTypes: [{ code, label }]` (additive optional v1 field).
- Current list is **provisional** until Sunpride confirms it: Store front, Shelf and display, Price tags,
  Promotion material, Other. Sources: memo 2026-01-20 merchandising execution (display / price tagging),
  promotion compliance, and the 2 Oct 2026 call (a store photo verifies a new outlet).
- Changing the list is a backend deploy, not an app release: bump `EVIDENCE_PHOTO_TYPES_VERSION`; the
  version is in the day manifest, so phones re-download the snapshot once.
- `visits/evidence:attach` rejects any `photoType` outside the list (`invalid_request`).
- Photos are optional evidence today: no visit intent requires a photo, and End never checks for one.

## On the phone

1. A photo can be taken only while the call is open (after Start, before End is queued).
2. The person picks a type, then takes the photo (CameraX, back camera, about 2 MP JPEG, quality 85).
   The image is written to memory, never to the gallery or shared storage.
3. The JPEG is sealed with AES-256-GCM under a non-exportable Android Keystore key in no-backup app
   storage; its metadata (type, capture time, size, SHA-256, the call's Start request) goes into the
   encrypted Room store. At most 20 photos per call stay on the phone.
4. Upload is separate from the visit outbox (`field-evidence-upload` WorkManager job, network-constrained,
   exponential backoff). Waiting photos never block Start, activities or End; the status pill reads
   "Visits synced · photos uploading" until they are done.
5. A photo uploads once its call's Start has a server visit ID (from the Start ack):
   `generateUploadUrl` → POST bytes to the signed URL → `attach` with `source: "mobile"`. The phone copy
   is deleted after attach succeeds.

## Retry and review

- Offline, signed out or server busy: nothing changes; the job retries later.
- Lost attach response: the retry uploads the same bytes again; the server returns the original evidence
  row for the same visit, person and checksum (no duplicate row). The retry's own blob is left
  unreferenced in Convex storage (not deleted, because the caller-supplied storage ID is unproven).
- Storage refusal or an expired upload claim: retried up to 5 times, then marked for office review.
- `invalid_request`, `out_of_scope`, `conflict`, a rejected Start, or a damaged local file: marked for
  office review at once and kept on the phone. A held partition (sign-out, removed phone, scope change)
  uploads nothing.

## Not yet covered

- No web screen lists or verifies uploaded photos (`fieldEvidenceFiles.status` stays `pending`).
- No retention/deletion job for evidence files (`retentionDueAt` is unused).
- Orphaned upload blobs from lost-response retries are not swept.
