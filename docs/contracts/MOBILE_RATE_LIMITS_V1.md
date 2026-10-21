# Native gateway rate limits

Current v2 policy is in `apps/api/src/core/rate.js`, enforced by auth/device and sync boundaries. The frozen v1 wire fixtures are not the current endpoint contract.

Current source defines sign-in, challenge and failure policies with bounded windows. Validate the exact values in that module rather than copying historical burst/transaction-limit figures into client behavior. Retry a legitimate transient transport failure with bounded backoff; never regenerate the operation ID or silently edit submitted bytes. Business rejection, authorization withdrawal and rebootstrap are distinct from transport failure.

Run `apps/api/test/devices.test.js`, `auth.test.js` and `sync.test.js` through the isolated API runner. Test concurrency as well as sequential retry, nonce reuse, wrong app/device, revocation, expired cursors and unchanged receipt replay. Unit/SQL tests do not establish public-edge flood protection or production fleet capacity. Those require separate deployment and load evidence.
