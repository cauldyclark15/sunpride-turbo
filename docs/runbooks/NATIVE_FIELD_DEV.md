# Native field development on v2

## Scope

Android field and van clients use the Bun API on one configured Sunpride origin. iOS is paused: retain source and configuration only; do not rebuild or install it during backend cleanup. The frozen v1 schemas/vectors remain regression artifacts, not a substitute for the current v2 API contract.

## Configuration and protocol

Set the existing `SUNPRIDE_<FLAVOR>_API_ORIGIN` Android configuration as needed; the field BuildConfig exposes `SUNPRIDE_API_ORIGIN`, and van exposes `API_ORIGIN`. Credentials and signing keys stay outside the repository. Local development may use an authorized lane API; never repoint a tester's installed app casually.

- Online authentication: `/api/auth/*` and `/api/me`; current shapes live in `apps/api/src/core/auth.js`.
- Device registration/challenge/bind and proof: `apps/api/src/core/devices.js`. Registration is scoped; marked sample profiles may follow the explicit sample-device path.
- Sync: `POST /api/sync/pull` and `/api/sync/push`, protocol v2. Retain the exact request bytes and stable client operation ID through uncertain transport.
- Proof: ECDSA P-256/SHA-256, DER SPKI public key, P1363 signature over exact method/path/body digest/fresh nonce/time. Use the server's current header/body contract; never forge a web origin or send an admin token from the phone.
- Media: `/api/media/*`; preserve encrypted local evidence until the authorized attach/ack path completes.

## State and recovery

Snapshot, cursor and lease promotion is transactional. Queued facts are immutable after first send; accepted acknowledgement is durable before marking done. A dependent visit operation needs the real acknowledged visit ID. A successful HTTP exchange is not proof that all queued work was accepted.

Sign-out and device/scope withdrawal lock cached authority independently of fallible teardown. Do not delete unsent evidence. Suspension, permanent revocation and scope transfer require different recovery paths. Reconcile what the office already received before any supervised recapture.

## Verification boundaries

Run unit/lint/assemble in each Android project using Android Studio's JBR. Real-device tests require the project's authorized phone wrapper and machine-wide lock; never run an all-device connected task. Build success is not physical-route, battery, camera, receipt or release proof. Do not use a personal phone or emulator as a substitute for the assigned field/van hardware.

Server checks are the isolated `apps/api` suites, with real throwaway PostgreSQL databases selected by `SP_LANE`. See [backend tests](../architecture/BACKEND_TEST_SUITE.md), [ADR-021](../decisions/ADR-021-MOBILE-SYNC-GATEWAY.md), and [release and cutover](../spec/release-and-cutover.md).
