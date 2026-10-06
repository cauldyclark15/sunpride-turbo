# Beta sample data (SP-0129, BETA-SAMPLE-DATA)

Made-up, realistic master data so beta testers can use the web dashboard, the field apps and the
van POS before Sunpride sends its real data (SP-0033 products/prices/promotions, SP-0034 stores).
**None of it is Sunpride's real data.** Every code starts with `SMP`, price lists and promotions
carry `source: "beta_sample"`, and every row the seed writes is listed in the `sampleDataRows`
table (batch `beta-sample-v1`) so it can be removed in one step when real data arrives.

Code: `packages/backend/convex/beta/sample.ts` (seed/reset), data in `beta/sample_data.ts`,
pricing in `convex/pricing/` (ADR-008 price baseline). Tests: `beta/sample.test.ts`,
`pricing/model.test.ts`, `mobile/bootstrap.test.ts` (pricing case).

## What it creates

| Area         | Sample content                                                                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization | existing national root > `SMP-VIS` Visayas > `SMP-CEBU` Cebu > `SMP-CEBU-N` Cebu North, `SMP-CEBU-S` Cebu South                                                                                                                                                 |
| Units        | `PC` piece (base), `PACK`, `CASE` (reused if they already exist)                                                                                                                                                                                                |
| Products     | 40 Sunpride-style items: canned fruit, juices, canned meat, sauces/mixes, frozen. Base unit piece; case conversion for all (12–100 pcs), pack for some; piece EAN-13 and case GTIN-14 barcodes (made-up `48099999` prefix, valid check digits); not lot-tracked |
| Price lists  | `SMP-PL-KA` Key Accounts (−4%), `SMP-PL-RS` Route Sales / PMOT (base), `SMP-PL-PM` Public Market (+3%): PHP, VAT-inclusive, piece/pack/case prices (case 5% and pack 2% under the piece multiple)                                                               |
| Promotions   | `SMP-PROMO-PJ240-B10G1` buy 10 Pineapple Juice 240ml get 1 free (all lists); `SMP-PROMO-CB150-CASE5` 5% off each case of Corned Beef 150g (all lists); `SMP-PROMO-MERIENDA` Pancake Mix 400g + Pineapple Juice 1L for ₱159 (Route Sales only)                   |
| Coverage     | territories `SMP-T-CBN` (Mandaue–Consolacion), `SMP-T-CBS` (Talisay–Minglanilla), `SMP-T-CKA` (Metro Cebu key accounts); routes `SMP-R-CBN-1` Mon/Wed/Fri, `SMP-R-CBS-1` truck route Tue/Thu/Sat, `SMP-R-CKA-1` Mon–Fri                                         |
| Stores       | 30 Cebu outlets (8 key accounts, 14 sari-sari/minimarts, 8 public-market stalls) with real street/barangay addresses, verified pins, contact, legacy customer link with a made-up credit limit, route sequence, and a call sheet (order catalog) per channel    |
| Stock        | depot `SMP-DEPOT-CEBU` with 40 cases of every product, posted as one `opening_balance` movement through `postMovement`                                                                                                                                          |
| Trucks       | `SMP-TRK-01` (Cebu South, truck location `SMP-TRUCK-01`) and `SMP-TRK-02` (Cebu North, `SMP-TRUCK-02`), both homed at the depot                                                                                                                                 |
| Positions    | the memo / 2 Oct 2026 call positions and standards (`sfa/setup:foundation`; real configuration, never removed by reset)                                                                                                                                         |
| People       | invitations only, one per role, `@sunpride.test` (table below)                                                                                                                                                                                                  |

| Email                    | Role               | Position     | Unit       | Territory / route       |
| ------------------------ | ------------------ | ------------ | ---------- | ----------------------- |
| supervisor@sunpride.test | manager            | CDS          | Cebu       | —                       |
| sales@sunpride.test      | sales              | RS           | Cebu North | SMP-T-CBN / SMP-R-CBN-1 |
| van@sunpride.test        | sales (van seller) | PMOT Extruck | Cebu South | SMP-T-CBS / SMP-R-CBS-1 |
| operations@sunpride.test | operations         | —            | Cebu       | —                       |
| approver@sunpride.test   | approver           | —            | Visayas    | —                       |
| admin@sunpride.test      | admin              | —            | National   | —                       |
| analyst@sunpride.test    | analyst            | —            | National   | —                       |

## How prices reach the apps

- A store's **channel** picks its list (Key Accounts / Route Sales incl. PMOT, RDS, extruck /
  Public Market). Exactly one active list and one effective line per product+unit, otherwise the
  apps show "Priced by the office" (fail closed, ADR-008).
- **Field apps**: the mobile bootstrap carries an optional `pricing` object (lists for the working
  set's stores, store→list map, promotions) on every page. Phone display/order totals are SP-0088.
- **Field orders**: when an order reaches the server it is priced there from the store's list
  at receipt (promotions applied, never stacked) and kept in `fieldOrderPrices` (`priced` or
  `needs_office_price`).
- **Van POS**: the van bootstrap carries `priceLines` (Route Sales list, the truck's selling
  unit) and `promotions`; the handheld stores the lines and Find product / checkout show them.
  Offline promotion evaluation on the handheld is SP-0105.

## Running it on the beta backend (lead)

The functions are internal; run them with the deployment's admin key after the normal deploy.

1. Deploy as usual, then run the organization and super-admin bootstrap if this is a new
   deployment (`migrations:bootstrapSuperAdmin`, the super admin signs in once).
2. Seed: `cd packages/backend && bunx convex run beta/sample:seed` (add `--prod` for the
   production deployment). It prints what it created and `testersPending` (invited emails that
   have not signed in yet). Re-running is safe: it creates only what is missing.
3. Give testers their email and the web/app links. Each tester **signs up with that email and a
   password of their own** (no password is created or shared by us).
4. After testers have signed in, run the seed again. It gives each newly signed-in tester their
   unit, position, supervisor, territory and route (`testersAttached`). A tester an admin has
   already reassigned is not changed.
5. Daily van test: there is no web screen for van trip planning yet, so each test day run
   `bunx convex run beta/sample:planVanDay` (optional `'{"serviceDate":"2026-10-08"}'`). It plans
   the van seller's trip on `SMP-TRK-01` / `SMP-R-CBS-1` with a 10-line load sheet (idempotent per
   day). The handheld then downloads the trip, load, customers and prices; stock moves from the
   depot to the truck only when the seller confirms the load on the handheld.

Field testers still need a Master Coverage Plan (prepared by the salesperson, approved by the
supervisor) before planned visits reach the phone; unplanned calls work immediately.

## Replacing it with real data

When Sunpride's real products, prices and stores are imported:

```bash
cd packages/backend
bunx convex run beta/sample:reset '{"confirm":"remove-beta-sample"}'   # repeat until "isDone": true
```

Reset deletes only rows listed in `sampleDataRows` (newest first, 400 per call). It never touches
rows testers created by using the app (visits, orders, trips, their profiles and assignment
history); those remain as history and may point at removed sample stores/products, so prefer a
fresh production deployment for go-live and use reset on the beta deployment only. Testers keep
their accounts but lose their sample unit; an admin reassigns them.

## Assumptions to confirm with Sunpride

- Pricing by channel only (not per customer group or per customer); price lists VAT-inclusive.
- Promotions do not combine: a line takes part in at most one promotion (first by code).
- Van trucks sell at the Route Sales / PMOT list.
- Credit limits, prices, products, stores, people and trucks are all invented.
