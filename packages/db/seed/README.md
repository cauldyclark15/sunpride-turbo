# Sunpride demo company

This is invented, clearly marked sample data, not Sunpride's customer list, prices,
financial accounts, actual employees or operating results. It answers: “Are we on
track, who is behind, where is stock short, and what needs a decision today?”

## Run

From the repository root, against an already migrated database:

```sh
DATABASE_URL=… bun packages/db/seed/run.js
DATABASE_URL=… bun packages/db/seed/run.js --anchor-date 2026-10-19 --days 90
DATABASE_URL=… bun packages/db/seed/run.js --reset
```

The CLI never supplies a database URL, migrates a database, starts a server or reads
an environment file for you. Supply the intended database explicitly. Do not seed
a real customer database. The seven login passwords are read from
`~/.sunpride-keys/v2-test-password`, never logged, and individually hashed with
`Bun.password.hash(..., { algorithm: "argon2id" })`, matching CORE.

The library entry point is `seedDemo(db, { anchorDate, days })` from `index.js`;
`anchorDate` defaults to today's Manila date and `days` to 90. The snapshot is noon
Manila on that date, independent of the clock time the command runs. `days` includes
that date. Sundays have no field calls. `resetDemo(db)` is also exported.

A repeat with identical options is a no-op. Different options require an explicit
reset followed by another seed. `--reset` means delete only; it does not reseed.
The CLI prints a safe JSON summary of row counts, dates and headline sums.

## What is inside

- A national root, Visayas region and four Metro Cebu territories:
  Mandaue-Consolacion, Cebu City North, Cebu City South, Talisay-Minglanilla.
  Each territory has three routes and three field people.
- One sales manager, two supervisors, twelve field people and three supporting
  accounts. Position, application role and scope are separate. Field positions
  mix DS, CDS, Sr CDS, KAS and PMOT/Extruck.
- Seven usable logins: `admin@sunpride.test`, `manager@sunpride.test`,
  `supervisor@sunpride.test`, `agent@sunpride.test`, `van@sunpride.test`,
  `approver@sunpride.test`, `viewer@sunpride.test`. Supervisors use the existing
  `manager` application role; van sellers use `sales`. There are no invented
  application-role enum values. The viewer is read-only.
- A pending `super_admin` invitation for `jcing.jc@gmail.com`, not a pre-created
  owner login or password.
- Forty products copied into `catalog.json` from the legacy sample catalog's
  invented names, prices and case sizes. The reporting categories are Canned
  (23, including fruit/juice), Mixes (8), Frozen (9). Products sell in PC and CASE,
  with per-product exact integer conversion factors. Case sizes include 12, 24,
  48, 72, 96 and 100; they are not all 24 pieces.
- Eighty synthetic restricted-circulation barcodes, four centavo price lists
  (`gt`, `pmot`, `supermarket`, `kas`) and three 5% case promotions using the
  existing discriminated promotion-rule shape. Promotions are available sample
  offers, not an assertion that every historical order received a discount.
- Three hundred active stores/customer accounts, plus one provisional store
  awaiting office review. The active mix is exactly 60% GT/sari-sari, 15% PMOT,
  15% supermarket, 10% KAS. Every active store has an accounting link, route
  assignment and verified synthetic Cebu pin. Seventy-five accounts have credit
  limits and 30-day sample terms. Coordinates are invented, not surveyed addresses.
- Approved, signed, active MCPs covering every month touched by the history;
  KAS has five daily stops, other sample workloads 25–30. A 90-day window often
  spans four calendar months: the earliest partial month is retained rather than
  dropping history to force a three-month count. Sales-value targets cover the
  current and previous two months. There is also one populated submitted future
  MCP, not an empty approval placeholder.
- Mon–Sat check-in/out evidence, immutable approved outlet snapshots, activities,
  location-review exceptions, orders with 2–6 lines, payday and seasonal quantity
  variation, separate rejected/approved/posted stages and signed centavo pricing.
  Productive credit is supported by an order intent or merchandising with a
  no-sales-due-to-inventory fact, never by a Completed button or note alone.
- Posted invoice orders, linked sales-return credits and FIFO collections for
  credit customers. Monthly AR snapshots reconcile to those exact sources, with
  overdue 31–60-day amounts, not an unrelated fabricated opening balance.
- Two trucks with load movements, cash-sale order links, counted return stock,
  unloading movements and settlement evidence. One historical cash shortage,
  one yesterday trip awaiting remittance, two today trips on route. Small excess
  depot stock is explicitly loaded onto today's first truck as a second confirmed
  load; balances are never edited to manufacture the stock-out flags.
- Depot plus two truck locations, opening stock, weekly receipts, sale issues,
  transfers/loads and returns. Each posting has a movement, lines, lot allocations,
  ledger, command and audit record. Balances, lot balances, costs and row versions
  are derived from that ledger, with no negative intermediate stock.
- Work-With evidence (one supervisor behind cadence), twelve Talk Sheets with
  six overdue actions, DAR submissions with intentional gaps and three per-diem
  evidence packs awaiting review. No payroll amount or allowance rate is invented.

The DS/CDS/Sr CDS Work-With minima are respectively 4/16, 3/12 and 1/4 per
week/month, copied from `sfa/constants.ts` consumed by `sfa/setup.ts`. KAS's
provisional 90% productivity target retains the documented 85% email versus 90%
memo dispute. PMOT/Extruck standards remain 30 calls and 85%; the sample's actual
70% productive rate demonstrates a performance problem, not a replacement policy.

## Owner headlines

The fixed reference date `2026-10-19` represents a running company at noon Manila.
The SQL-backed tests assert these definitions and tolerances; exact peso amounts
for the current implementation are printed in the test log and CLI summary.

| Headline                                       | Expected                                        |
| ---------------------------------------------- | ----------------------------------------------- |
| Today sales                                    | ₱281,947.94                                     |
| MTD sales                                      | ₱7,405,801.06                                   |
| Today collections                              | ₱91,606.27                                      |
| Company MTD sales / elapsed selling-day target | 92%, within 2 percentage points                 |
| Talisay-Minglanilla MTD attainment             | 75%, within 2 percentage points                 |
| Historical planned-stop compliance             | About 85% (reference approximately 83.85%)      |
| Productive / completed historical calls        | 70%                                             |
| Weak territory compliance                      | 70%                                             |
| Ana Mercado                                    | Star, approximately 98% historical compliance   |
| Ben Flores and Grace Yu                        | Under-performing, approximately 76% compliance  |
| Field board today                              | 2 not started, 5 in call, 4 done, 1 idle        |
| Depot stock                                    | 3 SKUs out, 5 additional SKUs low               |
| Near-expiry stock                              | 2 lots within 30 days                           |
| Historical van cash variance                   | ₱1,250 short, three days before anchor          |
| Vans                                           | 1 yesterday trip unclosed; 2 today trips active |
| Approvals                                      | 2 orders, 1 MCP, 1 new store                    |
| Talk Sheets                                    | 6 overdue actions                               |
| Per-diem evidence packs                        | 3 awaiting validation                           |

Sales means net order-line value excluding draft, rejected and voided orders,
including linked negative return lines, by the Manila order date. Do not count
`field_order_pricings` again as additional sales. Van sales are the same linked POS
orders, not a second revenue stream. Approved/pending orders have not issued stock.
Money in integer minor-unit columns and JSON is centavos; frozen `orders.total`,
`order_lines.*`, `customers.credit_limit` and `sales_targets.value` are legacy
numeric pesos. Convert them once, never twice. Inventory base units are pieces;
use each product's conversion to display cases plus pieces.

## Frozen-schema integration gaps — explicit, not silently renamed

This lane has no migration range. Three requested concepts cannot be represented
canonically in the frozen `0100–0118` schema:

1. `sales_targets.subject_kind` only allows employee/team/territory, not company
   or channel. Company/channel values therefore use clearly named
   `SMP-TARGET-COMPANY`, `SMP-TARGET-GT`, `SMP-TARGET-PMOT`,
   `SMP-TARGET-SUPERMARKET`, `SMP-TARGET-KAS` teams. All levels reconcile exactly.
   Every target also has a `sample.sales_target` audit record with
   `{targetId, month, level, key, amountCentavos, teamId, source:"sample"}`.
   ANALYTICS must map these proxy teams or promote them to its new canonical
   target table after integration. Do not sum all four levels together.
2. There is no van cash/payment/remittance/settlement table in the base schema.
   Stock, trips, route sessions and POS orders are canonical; cash facts are
   tracked `audit_logs` rows with `action='sample.van_settlement'`. Their JSON
   contains trip/session/vehicle/seller IDs, service date, centavo expected,
   remitted and variance values, status, count and unload references, stock-flow
   quantities and `source:"sample"`. VAN/ANALYTICS must consume or promote these
   facts; the seed does not pretend an unrelated table is a cash ledger.
3. `per_diem_validations.decision` permits only validated/returned. Awaiting
   evidence packs therefore have no fake final decision; they are tracked
   `sample.per_diem_pending` audit rows containing profile/owner, period, due
   time, pending status and review reason. FIELDREPORTS/ANALYTICS must expose
   these pending requests or materialize them after its additive migration.

A Sunday shortage is recorded three calendar days before the anchor against the
preceding Saturday's real selling trip; it never creates a negative remittance on
a Sunday with no sales. The fixed reference date has a Friday selling-trip shortage.

Coverage signatures use the explicitly labelled `sample-sql-v1` payload, binding
plan identity/window, assignments, roster and all sorted slot snapshots. There is
no shared coverage-signing seam on this isolated base. COVERAGE must reconcile
this payload with its production signer before claiming export/signature
interoperability; mere nonempty signature strings are not that proof.

Saleable field pull-outs and their linked credits are generated. A separate
expired/damaged BO disposition and damaged-stock partition are not yet generated;
that portion of the requested sample remains incomplete rather than putting bad
stock back into saleable balances.

A `source` column with a restricted enum such as visits' planned/unplanned,
execution events' mobile/web/system or merchandising's mobile/web cannot contain
`sample`. Those rows retain a valid enum and are still individually tracked.
The seed-only inventory builder is not the production `postMovement` seam; that
seam remains an untouched placeholder in this isolated branch. No sync receipts,
device enrolments, jobs, SAP sends or realtime notifications are fabricated.
Run the seed before starting the API; there is no live-deployment/browser proof.

## Determinism, ownership and reset safety

Mulberry32 starts with fixed seed `20260120`. Business IDs are SHA-256-derived
UUIDs, business timestamps are anchored Manila instants, and all inserts plus all
`sample_data_rows` ownership markers commit in one transaction. Repeated fresh
runs with the same options have identical row counts and money/quantity sums.
Salted Argon2id hashes, Postgres change-sequence values and migration metadata are
intentionally not byte-identical business data.

Reset validates marker identities, obtains the same batch advisory lock, builds a
temporary indexed ownership map, checks every actual foreign key and known legacy product/customer-code and
salesperson-subject references for non-sample dependents, locks affected tables, and deletes child before parent. It never
TRUNCATEs, disables constraints, deletes by an `SMP` name prefix or adopts existing
rows into its ownership list. Non-sample rows and other sample batches survive.
If someone has created a session or another external record referring to sample
data, reset refuses and rolls back rather than cascading into their data. Reconcile
those dependent records explicitly; do not bypass the guard. The temporary index
is dropped on transaction completion, not an additive schema migration.

## Client trial accounts

After migrating and seeding the sample company, run from the repository root:

```sh
DATABASE_URL=… bun packages/db/seed/trial-accounts.js --per-role 3
DATABASE_URL=… bun packages/db/seed/trial-accounts.js --per-role 3 --rotate
```

The first command creates 27 private logins: three each for Administrator, Sales
manager, Supervisor, Field agent, Van seller, Approver, Operations, Analyst and
Viewer. No trial login has the super-admin role. Managers and supervisors share
the manager application role; agents and van sellers share sales. Supervisors
are limited to a sample team's territory; sales managers retain regional scope.
Existing sample people without logins are used before extra people are created.
Existing route/plan/profile IDs and historical signed snapshots are preserved.
Extra van sellers receive separate empty sample trucks and planned trips, not
fabricated loads or a second active trip on another seller's truck.

The API is not started or deployed by this command. Passwords are independently
generated and Argon2id-hashed. The CLI prints only counts and the output path.
Credentials are retained in `~/.sunpride-keys/trial-accounts.json`, partitioned by
database identity, and the client instructions default to
`~/Downloads/sunpride-trial-accounts.txt`. Both files are atomically replaced with
mode 0600. `--out` chooses another instruction-file path. Keep both files private.
Normal repeats preserve passwords; `--rotate` replaces them and revokes their
sessions. A tester-changed password is not overwritten or reprinted as the old
password by a normal repeat.

Every newly created database row uses the demo batch's ownership markers, so it
participates in the same dependency-checked reset. Trigger-created sample order
queues are also marked; composite-key outside dependencies still block reset.
The current integrated VISITS migration additionally makes raw observation and
execution-event rows unconditionally append-only. That pre-existing guard also
blocks deletion of the sample company. Trial code does not disable triggers or
weaken real evidence protection; a platform-approved sample-reset exception is
needed before a full reset can succeed on that schema.

Library: `createTrialAccounts(db, { perRole, rotate, recordPath, outPath })`.
Tests use isolated private paths and a throwaway acct database, never the shared
credential record. Run `bun test seed/trial-accounts.test.js` in `packages/db`.

## Demo seed verification

```sh
cd packages/db
bun test ./seed
bunx tsc -p jsconfig.json
```

The suite reads only `~/.sunpride-keys/pg-lane-seed-url`, creates a uniquely named
`sunpride_lane_seed_t*` throwaway database, applies the actual migrations and drops
that database in cleanup. It tests full fresh seeds, database-read determinism,
CLI seed and reset, non-sample preservation, cascade refusal, every real foreign
key, ledger/cost/version chains, pricing/UOM/product references, call timing and
planning, AR reconciliation, target totals and headline tolerances. It never
seeds, migrates or resets the shared development database.
