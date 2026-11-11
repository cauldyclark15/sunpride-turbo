# Customer master (SP-0170)

Owner rule: **follow the client's data.** The customer master is Sunpride's SAP "Customer
Information template" (Loren Muñoz, MIS/IT, 2026-11-10): same fields, codes, lists and order.
Plan and decisions: `~/cnc/_plans/sunpride-customer-master/SPEC.md`. API contract for web/Android:
`docs/architecture/CUSTOMER_MASTER_CONTRACT.md`.

## Model

**Customer = store.** One record per physical store; chains (SM, Gaisano, Puregold…) are the
**Customer Group** field, each branch is its own customer.

| What                          | Where                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The customer record           | `outlets` row: `code` = Customer Code, `name` = Customer Name, `address` = Customer Address (one-liner), `status` prospect/active/inactive                                                                                                                                                                 |
| Every other sheet field       | `customer_profiles` (1:1, `outlet_id` PK) in sheet order, incl. PSGC codes + names, ADP block, `completeness` draft/complete, `source`; the names of the chosen Distribution Channel / Grp 1 / Grp 2 / Customer Group are kept on it by the writer and the list loader (one join for analytics and phones) |
| Ship-to entries (one or more) | `customer_ship_tos` (`ordinal`, soft-deleted on replace)                                                                                                                                                                                                                                                   |
| Geographical Coordinates      | `outlet_pins` (pending → verified by a second person, as before)                                                                                                                                                                                                                                           |
| Accounting customer           | `customers` row with the **same code**, kept by the writer in the same transaction; `outlet_customer_links` current link                                                                                                                                                                                   |
| Dropdown lists                | `customer_reference_values` (one table; parents in `sales_org_code`, `channel_code`, `group1_code`; `active`, `source`, `updated_by`, audit rows)                                                                                                                                                          |
| Geography                     | `ph_regions`, `ph_provinces`, `ph_municipalities`, `ph_barangays`, `ph_postal_codes`, `ph_geography_releases`                                                                                                                                                                                              |
| Rules                         | `packages/customer-master` (shared pure JS: labels, conditional required, TIN, PH mobile, email, coordinates, credit limit, dependent lists, postal code ↔ municipality)                                                                                                                                   |
| Writer / routes               | `apps/api/src/domains/masters/customers.js`, `customer-routes.js` (installed by the masters domain)                                                                                                                                                                                                        |

`outlets.channel` is no longer a business category: it is the **price-list / call-flow key**
the pricing engine and both phone apps already use. Migrated sample stores keep their old key
(`gt`, `pmot`, `supermarket`, `kas`) so demo prices keep working; new customers carry their SAP
Distribution Channel code (SAP prices by sales org + distribution channel). Everything that
_shows or groups_ a channel reads the Distribution Channel name instead (analytics view, targets,
people's channel scope, mobile `channel`, list filters). The old governed `channel`/`subchannel`
masters (`master_definitions`) and `master_channel_aliases` stay only for the old office/census
forms and legacy imports until the web and Android lanes move to `/api/v1/customers`.

## Data sources

- Reference lists: `packages/db/reference/sunpride-customer-master-2026-11-10.json` (the client
  workbook extracted; identical to `_plans/sunpride-customer-master/client-reference-lists.json`).
  Migration `0820` is **generated** from it — never hand-edit:
  `bun packages/db/scripts/build-customer-reference-sql.js` (`--check` verifies).
  Counts: 2 sales orgs, 11 distribution channels (SFI 8, ARI 3), 20 sales offices, 26 plants,
  35 Customer Grp 1 + 32 Grp 2 rows (61 chain rows), 91 customer groups, 7 types of business,
  5 payment terms, 5 tax classes, 2 pricing procedures, 0 sales partners, 1 country.
- Geography: PSA PSGC **3Q-2026** (publication 30 Sep 2026, released 2026-10-12;
  datafile sha256 `8aad47f8…dc9a59`) + PHLPost ZIP locator, community ZIP list for the rest.
  `packages/db/reference/ph-geography-psgc-2026q3.json` is built by
  `packages/db/scripts/build-ph-geography.py` (raw inputs were in scratch `sp170/`; the PHLPost
  extract is committed as `phlpost-zip-locator-raw.json`). 18 regions, 87 provinces (NCR
  districts as pseudo-provinces), 1,655 municipalities/cities, 42,010 barangays, 1,703 postal
  codes over 1,495 municipalities; 338 PHLPost rows did not match a PSGC municipality.

## Operations

```sh
# after migrate (lists come with migration 0820)
DATABASE_URL=… bun packages/db/scripts/seed-ph-geography.js        # idempotent; ~42k barangays
# when Sunpride sends an updated workbook: regenerate the JSON, rebuild 0820 for fresh DBs,
# and upsert existing DBs (rows removed from the file are deactivated, never deleted)
DATABASE_URL=… bun packages/db/scripts/seed-customer-reference.js
```

`bun packages/db/seed/run.js` (fresh lanes) loads the geography and builds the customer shape for
every sample store. `seedDemo` and the daily advance call `customer_master_backfill()` too.
Without the geography load, saves that send PSGC codes fail `invalid_option` (the API never
guesses geography).

## Field app "Add customer" and offline data (SP-0170)

The Android field app's new-store flow (More / Customers / Today → **Add customer**) is the
census screen, now in the client's shape: General Information, Location, Assignment and the
ship-to Contact Person (SPEC rule 10); the office completes the rest. It is sent through the
existing offline outbox as the same `census.capture` op with a `customer` object (contract §6).
The server routes such a capture through the enrolment writer (provisional code, pending pin from
the phone's GPS, pending enrolment, `draft` profile with a "same as customer" ship-to) instead of
the census review queue, so it appears in the office as a prospect customer to complete and
approve. Old app versions (no `customer`) keep the census review path unchanged.

Offline data, smallest correct set:

- **Reference lists** (~250 rows) ride in `GET /api/v1/masters/census-config` as
  `customerMaster: { salesOrgCode, provinceCodes, lists }` — already cached per grant on the
  phone (CensusConfigCache). `salesOrgCode` = the Sales Organization most of the agent's
  customers use (SFI 1000 when none); `provinceCodes` = provinces of the agent's customers.
- **Geography**: `GET /api/v1/geography/pack` (every region, province, municipality and postal
  code, ~1.7k rows, one request) and `GET /api/v1/geography/pack/barangays?provinceCode=`
  (barangays one province at a time). The phone keeps them in its encrypted store
  (`local.geography`, refreshed after 30 days when online): the pack, the barangays of
  `provinceCodes`, and of any province picked while online. When a province's barangays are not
  on the phone, Barangay is left for the office (not required at capture).
- Field-required at capture (beyond the shared `draft` rules): Customer Name, Mobile No., Region,
  Province, Municipality, Barangay (when on the phone), Postal Code (when the municipality has
  one), Geographical Coordinates (GPS ±<50 m), Sales Organization, Distribution Channel, Customer
  Grp 1/Grp 2 (when the chain has them), Customer Group, Type of Business, Contact Person, and the
  storefront photo the enrolment needs.
- The Kotlin port of the rules (`apps/field-android/.../census/CustomerMaster.kt`) is held to
  the JS package by `packages/customer-master/fixtures/android-parity.json` (regenerate with
  `bun packages/customer-master/scripts/android-parity.js`; both sides test it).

## Lifecycle

1. **Field capture** (prospect): the phone's enrolment carries an optional `customer` object →
   profile saved at `draft`, pending pin, pending enrolment; no accounting customer yet.
2. **Office create** (`POST /api/v1/customers`): store `prospect`, profile, ship-to, pending pin,
   accounting customer with the same code.
3. **Office completion** (`PUT`): Payment, Delivery, Tax, Pricing Procedure, Sales Office,
   Delivering Plant…; `completeness` re-evaluated on every save.
4. **Approval** (`POST …/approve`, `outlet.enrol.approve`): refused until `complete`; a pending
   field enrolment is decided by the existing writer (final code allocated); store `active`;
   accounting customer created/renamed to the same code.
5. **Deactivate**: store `inactive` and accounting customer `active=false` together.

Customer Code changes (office, before SAP sync) move the accounting customer's code in the same
transaction; refused once the accounting customer has a SAP `external_id`.

## Sample migration (0823, deterministic)

Every existing store (all sample/demo data) got a profile with sales org **1000 SFI**:

| Old key                     | Distribution Channel / Grp 1 / Grp 2               | Customer Group |
| --------------------------- | -------------------------------------------------- | -------------- |
| `gt`, named "Sari-sari"     | 41 Route Sales / RSF / RSS Sari-Sari Store         | 74 NO GROUP    |
| `gt` (other), general trade | 30 General Trade / KAS3 / GGS GT-Grocery Stores    | 74             |
| `pmot` (public market)      | 41 Route Sales / RSF / RWM Wet Market              | 82 MARKET      |
| `supermarket`               | 30 General Trade / KAS3 / GSS GT-Supermarket Store | 74             |
| `kas`, `mt`, modern trade   | 10 Key Accounts / KAS2 / KAL Key Accts. Local      | 74             |
| `horeca`, `food_service`    | 20 Food Service / FRT Restaurant                   | 74             |
| `institutional`             | 70 Office Sales / OSD / OSC Office Served Cust.    | 74             |
| `distributor`               | 30 General Trade / KAS3 / GSD GT-Sub-Distributors  | 65 DISTRIBUTOR |
| anything else               | 30 General Trade / KAS3 / GGS                      | 74             |

Other required values are clearly marked samples: Registered Name "Sample …", Street 1 "Sample
street", ship-to Contact Person "Sample contact person", Mobile No. from the store contact or
`09000000000`; Cebu PSGC location by sample territory (Mandaue → Banilad 6014, Cebu North → Apas
6000, Cebu South → Basak Pardo 6000, Talisay → Bulacao 6045); Sales Office 100 SFI Cebu; Plant
1000 Cebu Production; Tax Class 1; Terms 0005 (accounts with a credit limit) else ZC03; Pricing
Procedure 1 (channels 10/30) else 2. Customer Code: the store takes its only accounting
customer's code (orders/AR already carry it), e.g. `SMP-O0001` → `SMP-C0001` (fresh seeds create
the store with that code directly). The store's existing address line is kept as Customer Address
(`addressCustom`); a one-liner is built only where none existed. Channel targets
and people's channel scope are re-keyed to the channel most of their stores moved to
(`gt`+`pmot` → Route Sales, summed; `supermarket` → General Trade; `kas` → Key Accounts).
Stores without any pin (two kickoff samples) stay `draft`.

## Decisions (SP-0170, beyond the SPEC)

- One generic `customer_reference_values` table instead of 12 tables: one loader, one endpoint,
  parents as columns; dependent lists cannot be plain FKs anyway.
- Lists live in a generated migration (always present, so the sample migration and validation
  work on every DB); geography is a seed script (42k rows would slow every test database).
- PSGC names are stored beside codes on the profile so the address line never depends on the
  geography load.
- Type of Business has no codes in the sheet: the description is its code.
- `outlets.channel` kept as the price/call-flow key (see Model) rather than relabelled: price
  lists, call-flow bindings and both phones key on it; re-keying them is a pricing decision.
- Field drafts get their accounting customer at approval (a provisional code must not reach AR).
- Mobile changes are additive (`channel`, `customerMaster`); the frozen mobile-v1 JSON schema is
  untouched (the server already sends optional keys beyond it; both apps ignore unknown keys).
- Sales Partner falls back to active `sales` profiles (code = employee code) while the "List of
  Agents" tab is empty.

## Open questions for Sunpride

- Can one customer have several delivery addresses (ship-to)? Built as a list; UI shows one.
- "List of Agents" (Sales Partner) and the Master Data Hierarchy (distribution mode, distributor
  salesmen, trucks, clusters) are still to come; those fields are free text + code now.
- Are SAP prices keyed by Distribution Channel (as assumed for new customers' price key)?
- Customer Code format for new customers before SAP sync (we use `SP000123`), and who assigns
  the SAP number.
- Is Credit Limit maintained in SFA or only read from SAP?
