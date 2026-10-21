# Sunpride platform blueprint

## Current design authority

This is our software design, not an observation of Sunpride's existing business or proof of deployment. The client's Phase 1 feature workbook is the primary scope reference. The [backend v2 contract](BACKEND_V2.md), [analytics contract](ANALYTICS_V2.md), current [spec notes](../spec/) and accepted [decisions](../decisions/README.md) supersede earlier implementation sketches.

The runtime is native PostgreSQL 17 with pgvector, a plain-JavaScript Bun API, Next.js management web/installable office app, and local-first encrypted Android clients. iOS is paused. The old browser field pilot is retired without clearing stored evidence. See [SYSTEM](SYSTEM.md) for the source map.

## One operational model

- One effective-dated organizational tree, with app role, job position and organizational scope kept separate.
- Accounting customer and physical outlet are different identities; route/beat membership belongs to outlets, not customer-name text.
- Coverage plans are versioned; approved snapshots are immutable and generate planned visits idempotently. Later master edits do not rewrite signed facts.
- Field selling, van selling, pre-sell, merchandising and distributor work configure one call-flow engine in `apps/api/src/domains/callflow`; they do not invent competing flow state machines.
- Start/end, governed activities, photos and location evidence remain separately attributable facts. A completed call or note is not automatically productive, certified, or eligible for per diem.
- Per diem is plan/report validation, not payroll. Client standards and policy defaults remain explicit, effective-dated and editable.

## SAP boundary

SAP is the system of record for prices, credit, inventory value and financial posting. The API keeps provenance-bearing replicas and a durable posting outbox. Local `apps/sap-mock` and versioned contracts support development without real SAP access; switching configuration is not a production compatibility proof. Device business intent remains immutable; technical document acknowledgements and financial outcomes are separate facts.

## Inventory and van custody

One SQL movement transaction writes document, movement, exact lots/allocations, ledger, derived balances, command receipt and audit. Counts, adjustments, damage, returns and voids are explicit workflows, never balance patches. Separate physical custody, local acceptance, SAP posting and fiscal status. Van receipts reprint frozen sale-time facts and mark copies. Cash/stock reconciliation and final office close must not be inferred from transport completion.

## Offline and trust

Android uses encrypted SQLite/Room and atomic data-plus-outbox writes. `/api/sync` provides snapshot/delta and ordered per-operation push with durable receipts. Stable client IDs and payload hashes make uncertain transport retry safe. Every server write reauthorizes current profile, role, device and scope before replay. Device P-256 proof binds exact method/path/body/nonce/time; private keys never leave the phone.

Pending, review and held evidence survive process death and controlled recovery. Sign-out and scope withdrawal retire in-flight cache authority independently of fallible storage cleanup. A lost offline phone cannot be instantly revoked or magically recovered. Never clear the only retained evidence to make a demo look synced.

## Management experience

Exceptions come first. Today, Sales, Coverage, Stores, Stock, Vans, Money and Decide answer an owner question with target/prior comparison, trend, drill-down and next action. Totals must reconcile across pages. Show unknown/incomplete separately from zero. Use pesos and configured cases/pieces; do not display raw IDs as business labels.

## Acceptance

API and DB checks execute real SQL in throwaway lane databases; web checks cover types, rendering, lint and build. Android JVM/build/lint checks do not prove a physical route. Offline selling, printing, collection, return and settlement need real authorized-device evidence with network removed. Native installation, public deployment and real SAP/fiscal acceptance are independent release steps. See [release and cutover](../spec/release-and-cutover.md).
