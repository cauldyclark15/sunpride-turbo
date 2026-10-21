# Authorization matrix verification on v2

The API is authoritative. Hiding a button or navigation item never grants access. Use `apps/api/src/core/capabilities.js`, the org scope helpers and each stored source owner; role, position and scope are separate axes.

Run `SP_LANE=<lane> bun run test` from `apps/api`. Current sources include `test/capabilities.test.js` (all grants × roles plus frozen baseline), `org.test.js`, `devices.test.js`, `sync.test.js`, `role-tab-parity.test.js`, and domain tests. The harness uses real disposable PostgreSQL databases and separate processes for global mocks.

For every read, command and replay check active profile, current persisted owner/scope, role capability, source customer/location, retired/future assignment and independent-approver restrictions. A shared accounting customer or a formerly authorized cached partition is not permission. Native device proof and in-transaction reauthorization must both survive withdrawal between HTTP verification and a domain write.

Retain exact candidate/log/count/exit evidence. These sources are not a real-phone, public-site or production penetration-test report; iOS is paused.
