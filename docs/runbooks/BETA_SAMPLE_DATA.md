# Beta sample data (SP-0129, BETA-SAMPLE-DATA)

Made-up, realistic master data so beta testers can use the web dashboard, the field apps and the
van POS before Sunpride sends its real data (SP-0033 products/prices/promotions, SP-0034 stores).
**None of it is Sunpride's real data.** Every product/store code starts with `SMP`, price lists
and promotions carry `source: "sample"`, and every row the seed writes is listed in the
`sampleDataRows` table (batch `beta-sample-v1`) so it can be removed in one step when real data
arrives.

Pricing is SP-0088's model (`priceLists` / `priceListLines`, `convex/pricing/model.ts`): this
branch builds on `feat/sp-0088` and must be integrated after it. The beta seed shares SP-0088's
sample lists (`SAMPLE-KA`, `SAMPLE-RS`, `SAMPLE-PM`, same codes and channel keys as
`pricing/sample:seed`), so running both seeds in either order leaves exactly one list per
channel; it never adds a sample list for a channel an office list already prices (reported in
`skipped`).

Code: `packages/backend/convex/beta/sample.ts` (seed/reset), data in `beta/sample_data.ts`,
promotions and van pricing in `convex/pricing/promotions.ts` / `wire.ts`. Tests:
`beta/sample.test.ts`, `pricing/wire.test.ts` (plus SP-0088's pricing tests).

## What it creates

| Area         | Sample content                                                                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization | existing national root > `SMP-VIS` Visayas > `SMP-CEBU` Cebu > `SMP-CEBU-N` Cebu North, `SMP-CEBU-S` Cebu South                                                                                                                                                 |
| Units        | `PC` piece (base), `PACK`, `CASE` (reused if they already exist)                                                                                                                                                                                                |
| Products     | 40 Sunpride-style items: canned fruit, juices, canned meat, sauces/mixes, frozen. Base unit piece; case conversion for all (12–100 pcs), pack for some; piece EAN-13 and case GTIN-14 barcodes (made-up `48099999` prefix, valid check digits); not lot-tracked |
| Price lists  | `SAMPLE-KA` Key Accounts (−4%), `SAMPLE-RS` Route Sales / PMOT (base), `SAMPLE-PM` Public Market (+3%): PHP, VAT-inclusive, piece/pack/case prices for the `SMP` products (case 5% and pack 2% under the piece multiple)                                        |
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

## How it writes (no parallel writers)

The seed uses the same domain writers as the office screens, so every integrity rule applies
and every change is audited:

| Data                              | Writer                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| Org units + parent edges          | `createOrgUnit` (`org/mutations`)                                                      |
| Territories + ownership           | `createTerritory` (`territories/mutations`)                                            |
| Routes + territory link           | `createRoute` (`territories/routes`)                                                   |
| Stores, customer links            | `createOutlet`, `changeOutletCustomerLink` (`outlets/mutations`)                       |
| Store pins                        | `proposeOutletPin` then `decideOutletPin` by a second subject (`outlets/verification`) |
| Store → territory/route/sequence  | `assignOutlet` (`outlets/assignments`)                                                 |
| Tester territory / route          | `assignTerritorySalesperson`, `assignRouteSalesperson`                                 |
| Tester unit, position, supervisor | `recordAssignment` (people assignment history)                                         |
| Unit conversions                  | `insertUomConversion` (`inventory/policies`)                                           |
| Opening stock                     | `postMovement` (opening balance)                                                       |
| Van day trip + load sheet         | `planTrip` (`van/trips`), `planLoad` (`van/loads`)                                     |

It writes as a trusted **system actor** (`system:beta-sample`, pins verified by
`system:beta-sample:verifier`; `lib/write_actor.ts`). Compared with a signed-in office user,
the only differences are: no per-person capability check, and records may already be in force
(start = the sample epoch, never before the organization root, never in the future). The
office mutations themselves still accept only future-effective changes. Price lists, price
lines and promotions have no office writer yet; they are written only by this seed and
SP-0088's `pricing/sample`, marked `source: "sample"`. Audit entries the writers leave stay
after a reset (audit history is never deleted).

## How prices reach the apps

- A store's **channel** picks its list (SP-0088 `priceListFor`: Key Accounts / Route Sales /
  Public Market, else the default list). Exactly one effective list and one effective line per
  product+unit, otherwise the apps show "Priced by the office" (fail closed, ADR-008). Too many
  lists for one channel to read in one bound also prices nothing, never a guess.
- **Field apps and orders** (SP-0088): the mobile bootstrap's `orderTerms` (part of the signed
  day manifest, so a price change forces a fresh snapshot) drive the phone order screens; the
  server prices every received order itself and keeps it in `fieldOrderPricings` with a credit
  check against the sample credit limits.
- **Van POS**: the van bootstrap (one snapshot, no continuation) carries `priceLines` (Route
  Sales list, the truck's selling unit) and the list's `promotions` whose products are all on
  the truck; the handheld stores the lines and Find product / checkout show them. A promotion
  read past its bound ships no promotions. Offline promotion evaluation is SP-0105.

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
6. Live map (SP-0135, optional): `bunx convex run beta/sample_live_map:seed` writes made-up,
   flagged trails for today for the signed-up sales tester and the van tester's truck, so the
   web Live map shows movement before real phones send positions (`apps/web/docs/LIVE_MAP.md`).

Field testers still need a Master Coverage Plan (prepared by the salesperson, approved by the
supervisor) before planned visits reach the phone; unplanned calls work immediately.

## Replacing it with real data

When Sunpride's real products, prices and stores are imported:

```bash
cd packages/backend
bunx convex run beta/sample_live_map:clear     # first: the live-map sample pings (repeat until "isDone": true)
bunx convex run beta/sample:reset '{"confirm":"remove-beta-sample"}'   # repeat until "isDone": true
```

Reset deletes only rows listed in `sampleDataRows` (up to 400 per call, children before parents:
a sample row is deleted only once no surviving sample row holds its ID, so the data stays whole
after every call even if you stop part-way), and **only
while the sample is unused**. It refuses and removes nothing when any of these exist: a tester
has signed up with a sample invitation; anyone is or was assigned to a sample unit; stock moved
at the sample depot or a truck after the opening balance; a sample truck has a trip; a sample
store has visits or orders; or **any row the seed did not create holds the ID of a sample row**
(for example stock of a sample product received at a real warehouse, a real order line, a real
device or plan). That last check walks every ID field in the schema (`beta/sample_dependencies.ts`,
so new tables are covered automatically); a table without a usable index is scanned, and a table
over 4,000 rows is reported as unverifiable rather than assumed clean. Deleting those rows would
leave profiles, assignment history and the stock ledger pointing at removed rows. The check runs
before every batch, so no batch deletes anything another row still uses. A beta deployment testers have used is
retired, not reset: go live on a fresh production deployment. A sample price list SP-0088's seed
has also filled is kept (its own reset removes it).

## Assumptions to confirm with Sunpride

- Pricing by channel only (not per customer group or per customer); price lists VAT-inclusive.
- Promotions do not combine: a line takes part in at most one promotion.
- Van trucks sell at the Route Sales / PMOT list.
- Credit limits, prices, products, stores, people and trucks are all invented.
