# ADR-021: Versioned mobile sync over the Bun HTTP API

Status: accepted; current protocol is v2.

Android field and van clients, plus retained paused iOS source, use native HTTP and local encrypted databases. UI reads its local partition; a live web socket is not its offline authority.

- `POST /api/sync/pull` supplies registered projections with snapshot, delta, cursor and scope/lease checks.
- `POST /api/sync/push` accepts bounded ordered operations and returns independent applied/duplicate/rejected outcomes.
- Durable `op_receipts` bind subject, device, stable client operation ID and payload hash. Changed bytes under a reused key conflict. The whole HTTP batch is not one transaction.
- Native access uses v2 bearer credentials and P-256 device proof over exact method, path, raw-body digest, nonce and timestamp. Current persisted role/device/scope are checked before replay and in domain writes.
- Snapshot replacement and cursor advancement are local transactions; pending intent cannot be overwritten by a pull. Authorization withdrawal, expired lease and unsupported changes hold work or require fresh bootstrap rather than silently trusting stale data.

The shared implementation is `apps/api/src/core/sync.js` and `devices.js`; domains register projections/ops instead of forking a sync engine. Frozen v1 schemas remain compatibility fixtures, not the current transport contract. See [native development](../runbooks/NATIVE_FIELD_DEV.md), [backend contract](../architecture/BACKEND_V2.md), and ADR-019/020/022 for business guarantees and recovery policy.
