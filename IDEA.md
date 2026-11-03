# IDEA

> Salesforce Automation System with Inventory system on Manufacturing back office with SAP ERP integration

_The original seed, kept verbatim. Everything below is that idea after it met the code._

## The idea in one paragraph

Sunpride's back office runs on SAP, which is good at financial and ERP records and blind to floor-level reality: a salesperson selling off a truck with no signal, a warehouse team receiving lot-tracked stock, a QC team holding a pallet, a supervisor approving a variance. **Sunpride Turbo is the operational layer between the floor and the ERP.** It captures what physically happens — orders, receipts, transfers, counts, production, truck sales — as an auditable physical inventory ledger, and pushes the financial consequences into SAP. It is not an ERP replacement and not a reporting skin over SAP snapshots.

## Who it is for

Field sales representatives on trucks (intermittent connectivity, one-handed mobile use), warehouse and inventory teams, sales managers and approvers, finance, and IT administrators. Access is invitation-only; `jcing.jc@gmail.com` is the sole bootstrap super admin and first-arrival order grants no authority.

## Scope — what the idea actually covers

1. **Master data** — products, customers, warehouses, territories, pricing references, projected from SAP.
2. **Inventory** — lot-aware receiving, reservations, transfers, manufacturing, counts, rolling-truck custody, POS issues and reversals, operational balances, reconciliation.
3. **Sales force automation** — assignments, planned visits, completion and notes.
4. **Mobile / PWA** — offline storage, transactional outbox, retry and conflict handling.
5. **Orders** — idempotent creation, lines, approval lifecycle, SAP document number.
6. **SAP integration** — versioned contracts, HMAC authentication, heartbeat, retry, dead letter.
7. **Workflow / approval** — instances, decisions, authority checks, comments.
8. **Security / admin** — identity, application profiles, server-side roles, audit log.
9. **Dashboards / analytics** — maintained aggregates, not unbounded count scans.

Analytics also appears as its own navigation surface, but belongs to this same module.

## Where the truth lives

This is the decision the whole system bends around (ADR-003):

- **SAP is authoritative** for approved ERP master data, accounting and financial inventory outcomes, closed-period policy, and final SAP document identifiers.
- **Convex is authoritative** for operational physical inventory, exact lot allocation, identity and profiles, approval state, integration tracking, and audit events.
- **IndexedDB is a device-local working store**, never an independent system of record.
- **Connector SQLite is delivery state**, retained for deduplication and evidence.

Consequence: a SAP inventory snapshot is an _observation for reconciliation_ and must never overwrite an operational balance. Correcting real stock means a reviewed adjustment, not an import.

## Non-negotiable rules

- Inventory is a ledger, not an editable number. A stock change exists only when one command commits business document, immutable movement, exact allocations, ledger entries with before/after, balances, command result, audit record, and outbound SAP effect atomically. No network call inside that mutation.
- One command, one outcome. Every retry is idempotent and payload-hash protected; a duplicate returns the original result and posts nothing.
- Reversals invert the original allocations exactly. They never re-run FEFO, and they never invent an impossible reversal — that goes to review-required.
- Quantities are scaled integers in base UoM (1,000 per case), never floating point. Money is integer minor units.
- No negative stock. Available-to-promise is usable physical stock minus hard reservations; quality hold, quarantine, rejected, damaged, expired, and in-transit stock are not sellable.
- Nothing in the SAP network is ever reachable from the cloud. The connector only dials out.

## Shape of the build

A Bun/Turborepo monorepo with seven packages: `packages/backend` (Convex — schema, ledger engine, auth, HTTP integration endpoint), `apps/web` (Next.js management and approvals), `apps/pwa` (Vite/React offline field app on Dexie), `apps/sap-connector` (JavaScript-only Bun service with a SQLite retry queue; no build step so it can run on client infrastructure), `packages/ui` (Sunpride theme and workspace primitives on HeroUI), `packages/integration-contracts` (versioned JSON Schemas), plus shared lint/TypeScript config.

```text
Next.js web ───────┐
                   ├── Better Auth + Convex functions + Convex database
React/Vite PWA ────┘                         ▲
                                             │ signed outbound HTTPS
Local SAP ◄── Bun connector + SQLite queue ──┘
```

## Deliberately not in this idea

Serial-number tracking and warranty, demand forecasting or ML replenishment, warehouse wave/zone optimization, labor and machine overhead accounting, co-product cost apportionment, intercompany transfer pricing, supplier/customer portal promises, IoT scale or telematics ingestion, and automatic stock correction from SAP snapshot differences. The schema leaves room for each; none of them should precede correct quantities, lots, trucks, manufacturing, and reconciliation.

## Where it stands

Working and green as of the inventory implementation: schema, posting engine, receipts, transfers, reservations, counts and adjustments, manufacturing with genealogy, truck route sessions, POS sale/void/return, quality status and expiry, replenishment, reconciliation, and SAP movement ingestion. The SFA foundation is in: configurable organization levels and scope (ADR-005), product/UOM/barcode master (ADR-006), CSV imports, and the persona/access model (ADR-009) — app roles are a permission set, while Sunpride's job titles live in `positions` and carry the client's own call and work-with standards, seeded from the 2026-01-20 Sales Operations Standards memo. Quality gate passes — lint, typecheck, build, 106 tests (backend 65, web 26, pwa 10, connector 5), 5 SAP contracts validated.

Known soft spots: no CI workflow in the repository yet; a single hardcoded organization (`sunpride`) instead of the tenant model the plan recommends; PO receiving has no purchase-order record to check outstanding quantity against; the SAP adapter is still a thin OData stub running against a mock; and test depth is far below the invariant, concurrency, and soak coverage the implementation plan calls for.

## Read next

- `README.md` — how to run it
- `docs/architecture/SYSTEM.md` — deployment boundary and write paths
- `docs/architecture/INVENTORY_SYSTEM_IMPLEMENTATION_PLAN.md` — the full design and cutover plan
- `docs/decisions/` — ADR-001 monorepo boundaries, ADR-002 offline conflicts, ADR-003 inventory authority
- `docs/runbooks/` — inventory operations, SAP connector, deployment
- `docs/security/SECURITY.md` — security controls and pre-production checklist
