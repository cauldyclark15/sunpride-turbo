# Security model

- Invitation-gated sign-in and active profiles are enforced by the Bun API; web sessions use an httpOnly cookie, native sessions use v2 bearer/device credentials.
- API capability checks and stored organizational scope are authoritative. Navigation and cached permissions are UI hints, never authorization.
- PostgreSQL constraints and transaction-owned command receipts protect state, audit and idempotency; all values use parameterized SQL.
- Native P-256 proof binds the exact request and a fresh nonce. Reauthorize persisted device/profile/scope before business replay, not only at the HTTP boundary.
- Encrypted local stores preserve offline evidence; expiration, sign-out, scope change and revocation hold/withdraw authority without silently discarding the only unsent copy.
- SAP mediation is one API domain with provenance-bearing replicas, durable outbox and redacted failure categories. Local mock success is not production SAP acceptance.
- JSON boundaries, bounded working sets and exact money/quantity representations are explicit. Secrets are never browser build values.

See [secrets and client config](SECRETS_AND_CLIENT_CONFIG.md), [backend contract](../architecture/BACKEND_V2.md), and [native auth](../contracts/MOBILE_AUTH_V1.md). These controls describe software design and source behavior; security review, real-device evidence and deployed operations remain separate acceptance.
