# ORG API and shared readers

This domain installs the v2 HTTP master-data/setup surface and identity/scope hooks. It does not deploy or seed sample operational data.

## Shared seams

- `scopeFilterForActor(db, actor) -> Promise<{unitIds: string[] | null}>`: null means an authorized cross-scope role; an empty array means no organizational scope. Effective parent edges, not scheduled materialized parent IDs, define current scope. A malformed or over-500-unit tree is refused explicitly.
- `outletOwnerUnit(db, outletId, asOf = Date.now()) -> Promise<string | null>`: effective outlet assignment -> territory ownership; the custodian is used only without an assignment. Authorization of historical reads separately checks the current owner.
- `writeAudit(tx, {subject?, actor?: {userId?, profileId?}, action, entityType, entityId, details?, at?}) -> Promise<void>`: callers own authorization and transaction boundaries. Prefer the authenticated full `subject`. Never include secrets, location evidence or credentials in generic audit details.

## Reference readers for FIELDSYNC

`readers.js` exports `fieldOutlets(ctx, pageInput = {})`, `fieldRoutes(ctx, pageInput = {})` and `fieldProducts(ctx)`.

- The first two return the same authorized keyset pages as HTTP lists: `{page, next, continueCursor, isDone}`. `pageInput` accepts `{q?, cursor?, limit?}` or `{q?, paginationOpts: {numItems, cursor}}`; page sizes are 1–100.
- A sales actor's assigned territory/routes are checked as well as its current unit subtree. An outlet's historical territory alone is not authorization.
- `fieldProducts` deliberately returns `[]`: global inventory master data is not a governed selling catalog. FIELDSYNC should assemble the authorized selling projection with ORDERS/pricing rather than interpret the legacy `products.unit_price` as an approved price. The HTTP product DTO omits that legacy money field.
- These functions are not registered native operations/projections. FIELDSYNC owns `field.bundle` and can read the tables directly as its lane brief allows.

## HTTP wire

All paths below are relative to `/api/v1/`. GET parameters accept epoch-millisecond `asOf`. JSON objects such as `paginationOpts` are JSON encoded in the query string. Dates in returned DTOs are epoch milliseconds; bigint values are serialized as decimal strings. IDs have `id` and `_id` aliases for the local web editor DTOs, not server-generated types. Money is integer centavos (`creditLimitCentavos`), and unknown amounts stay absent/null.

List families: `people/list`, `people/invitations/list`, `people/devices/list`, `org/teams/list`, `territories/list`, `territories/routes/list`, `outlets/list`, `catalog/products/list`, `catalog/customers/list`. All apply `q` before LIMIT and use UUID keyset cursors. Search uses generated tsvectors where available, with escaped substring matching for names/codes. Details and bounded histories are installed beside these families; exact route names are in `index.js`.

Queues: `outlets/unassigned`, `outlets/pins/queue`, and `outlets/enrolment/pending`. Enrolment evidence is served only after an outlet-owner check and exact persisted file linkage. Disk paths never appear on the wire.

POST commands require cookie authentication and a current capability/scope check inside a transaction. `Idempotency-Key` is optional at the HTTP boundary and always supplied by the new web adapter. Receipts bind profile + route + key to a canonical whole-payload SHA-256. Changed payloads under an old key return 409; retry authorization is checked before the receipt is returned. Generic SQL unique/overlap failures become 409, missing foreign references become 422.

`catalog/foundation` is an explicit, national-only idempotent command for memo position/standards defaults. It does not overwrite office-authored standards. KAS/Booking 85% email versus 90% memo remains explicitly provisional, not a resolved client rule.

Topics: `org`, `people`, `outlets`, `catalog`. Commands publish all four and append an unsupported `org.reference` sync change so a stale authorized field bundle is rebuilt rather than falsely treated as a complete delta.

`org.materialize` durable jobs update effective org parent/status and employee role/unit/persona projections. HTTP authorization reads effective histories even if a materialization job has not run yet.

## Setup and web integration

`org/setup-health` returns `{asOf, comparisonNote, items: [{key, label, count, target: 0, prior: null, trend: [], fix, href}]}`. Counts cover unassigned people, unrouted active outlets, routes without salespeople, products without an effective governed price-list line, and stores without a current verified pin. Out-of-scope facts are unknown, not zero. Historical snapshots/trends are not yet implemented and the UI states that explicitly.

The existing admin exports retain their names and use the shared HTTP data layer through `components/master-data/api.ts`. Setup defaults to its health summary, and `section` query parameters drill into owned tabs.

The lead should import `MasterDataWorkspace` from `components/master-data/master-data-workspace` and mount `<MasterDataWorkspace />` in its master-data module. ORG intentionally did not edit `module-workspace.tsx`, routing, shell, session, shared API hooks or navigation.

This is a partial L01 port. Consult the lane report outside the repo for the remaining parity and integration work before treating it as a release.
