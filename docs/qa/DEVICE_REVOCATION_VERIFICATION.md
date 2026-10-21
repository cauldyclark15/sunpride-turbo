# Device revocation verification

V2 trust is implemented in `apps/api/src/core/devices.js`, `auth.js` and the domain transaction checks. Verify `apps/api/test/devices.test.js`, `sample-devices.test.js`, `sync.test.js` and `van.test.js` through the isolated API runner with the lane database.

Required counterexamples: suspend after success, permanent revoke, disabled profile, scope/app mismatch, old nonce reuse, and withdrawal after proof verification but before replay/write. Previously accepted receipts remain stable; refused work must not create business rows. Sample auto-registration must not restore a suspended/revoked phone.

Suspension and revocation are different. A disconnected phone cannot receive instant revocation or a guaranteed remote wipe. Pending evidence may exist only on that phone. Preserve it, retire cached authorization, reconcile office acknowledgements and use supervised recovery; do not tell a seller to clear storage or simply recapture the day. New enrollment is not a recovery mechanism for an old outbox.

Server/SQL tests, native storage tests and a physical-device scenario are different proofs. Log the exact build, device, role, state transitions and read-back. iOS delivery is paused; no rebuild or installation is part of this cleanup.
