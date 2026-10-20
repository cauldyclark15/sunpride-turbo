# Native authentication reference

## Current v2 runtime

The current native API is one Sunpride HTTPS origin. Sign-in is `POST /api/auth/sign-in`; native credentials, refresh/sign-out and device challenge/bind are defined in `apps/api/src/core/auth.js` and `devices.js`. The web uses an httpOnly `sp_session` cookie. Phones keep refresh/session material only in platform secure storage, and never embed administrator credentials in a binary.

Every signed request binds the exact method, API path, raw-body SHA-256, fresh server nonce and timestamp using ECDSA P-256/SHA-256. The signature is 64-byte P1363 `r||s`; the public key is DER SPKI. Private keys stay on the phone. The API computes the digest itself and validates current subject, profile, role, app, device status and stored scope. A bearer or device ID alone is not device authorization.

Device challenges are online and single-use. Suspension is reversible through authorized review; revocation is not restoration of queued evidence. Preserve pending/held work for supervised reconciliation, and never assume a disconnected lost phone can be wiped or recovered remotely. Plain attestation metadata is not proof of verified hardware integrity.

## Frozen v1 artifacts

The v1 JSON schemas and P-256 vectors in `packages/domain-contracts` remain frozen interoperability fixtures. They are not an auth endpoint catalogue for the v2 runtime, and v1 field names/envelopes must not be substituted into `/api/sync` requests. See [ADR-021](../decisions/ADR-021-MOBILE-SYNC-GATEWAY.md), [native development](../runbooks/NATIVE_FIELD_DEV.md), and the binding backend contract. Source/fixture tests are not a live bearer, physical-device or public-release proof.
