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

## On iOS (IOS-016, SP-0042)

Same rules, same server API, same bootstrap `photoTypes` (strict decode; an older server's empty list
falls back to the same provisional defaults).

1. The visit screen shows a Photos card while the call is open; the photo screen lists the configured
   types and the call's photos with their state.
2. The system camera (`UIImagePickerController`, back camera, stills) returns the image in memory; it is
   redrawn to about 2 MP and encoded as JPEG quality 0.85, which drops all camera metadata (no EXIF/GPS).
   Nothing is saved to the photo library. Camera permission text is `NSCameraUsageDescription`.
3. The JPEG is sealed with AES-256-GCM (CryptoKit) under a random key in the Keychain (after first
   unlock, this device only), written atomically to a backup-excluded, file-protected folder beside the
   encrypted store; the local ID is bound as associated data. Metadata goes into the SQLCipher store
   (`evidence_photos`, schema v5). At most 20 photos per call.
4. Upload (`Evidence/EvidenceUploader.swift`) runs after every successful sync and right after a photo
   is saved when online; the background refresh task also wakes for waiting photos. The sync pill reads
   "Synced · photos uploading" while photos wait; the Sync sheet counts waiting and office-review photos.
5. Visit association is the call's Start request ID, resolved to the server visit ID from the Start ack.
   The capture time is the moment the camera returned the photo. No separate per-photo location is
   recorded: `attach` has no location field, and the call's Start/End fixes already locate the visit.

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
