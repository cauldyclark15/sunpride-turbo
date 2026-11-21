# Weekly truck stock (SP-0227)

## Status and boundary

The branch implements printable quantity reports and a weekly recording screen in **Van trips > Weekly truck stock**, a Saturday count in **Field app > More > Truck stock**, CSV exports, and editable reasons in **Setup > Field masters > Stock reasons**. Office staff enter requested and served quantities. The report calculates served minus net POS sold minus counted remainder. For newly prepared requests, POS quantities come only from explicitly linked trips, excluding voids and subtracting stock-bearing customer returns and item refunds. Existing unprepared records retain the earlier seller/week lookup and cannot print an approved request.

These are recording and comparison features, not the complete stock workflow. Saving served quantities does **not** post a depot-to-van movement; saving or reviewing the Saturday count does **not** return stock to cold storage. New requests retain applicable approved-plan references, the vehicle and issuing depot, explicit trip membership, frozen product units/scales and governed price conditions. The screen now prints request, actual service, count and cashier stock-value reports; CSV includes scaled quantities, prices and amounts. Every printed page explicitly warns that weekly quantities do not post inventory. Existing daily van stock movements remain separate and unchanged. Do not represent this branch as complete acceptance of SP-0227.

JC confirmed the served-quantity basis and initial reasons on 21 November 2026: cashier accountability is **actually served minus counted remainder**, never requested quantity. Start with **Unsold, Expired, Damaged, Missing, Returned by customer**; administrators can add, rename and deactivate reasons. The earlier board question is not a reason to wait for another client answer.

The HTML pack below is an older preparation worksheet, not an authenticated business document. It still prints both earlier cashier alternatives, marked NOT PAYABLE, and is not the finalized app report. Its sample reference price is not a governed price authority. The remaining software work is listed below; client acceptance and live-device verification have not been performed in this lane.

## Application reports (current implementation)

In **Van trips > Weekly truck stock**, add a salesman, choose the truck, pricing channel and relevant planned POS trips, and enter requested/served scaled base quantities. Every Monday–Saturday day must be covered by a persisted approved plan. The encoder can record a SAP sales order reference; no SAP order is created automatically. Open the week for the four print links, then use the browser's Print command.

The stock-value report uses **served minus counted**, times a frozen governed price resolved for the selected pricing channel at the week's Monday boundary. This rate-selection UI and half-up centavo rounding reuse existing pricing/money authorities; they are our software design, not evidence of an additional client decision. Sample conditions are visibly marked SAMPLE. Missing/ambiguous prices, missing counts and a negative accountability prevent a complete total; the report never substitutes the product-master price or certifies a partial sum. POS invoice and refund amounts are separate cross-checks, not assumed cash collected.

Once stock is served the request identity, requested quantities, chosen truck/trips and price snapshot are fixed. Served figures can still be corrected before the Saturday count. The existing Field count continues to work unchanged. Office review waits for linked POS trips to close, then persists the exact report and an audit event; later product/price master edits do not change reprints. Review does not move or settle inventory or money. New next-week records are separate and require their own request.

The automatic inventory lifecycle and a full Field app > Sell request/served workflow are still missing. No client answer is blocking these software tasks. Do not label this issue fully implemented or a live-stock acceptance pass.

## Client evidence

Source: client meeting, 20 November 2026 (Loren and Suecelle), `~/.hermes/attachments/SUNPRIDE_CORRECTIONS.md`, lines 37–45. Timestamps are elapsed recording time, not calendar times.

| Stage                  | Confirmed request                                                                                                                    | Source                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| Following MCP approval | Printable request for the encoder to create the SAP sales order; no automatic SAP order creation requested                           | 29:44–30:35              |
| Monday loading         | Salesman checks and records quantity actually served next to requested; only actual stock goes into the van                          | 30:36–31:02              |
| Saturday               | Count remaining stock at the issuing depot/plant; printable weekly requested, served, sold and counted comparison                    | 30:58–32:18, 36:52–38:08 |
| Cashier                | Quantity to account for and equivalent amount, with POS as cross-check; requested-versus-served basis unresolved for partial loading | 30:45–32:18, 37:08–37:44 |
| Storage and next week  | Stock out from van to cold storage; a new request next week; reasons not settled                                                     | 36:52–38:08              |

Do not repurpose the separate daily van settlement as evidence that this weekly workflow exists. The current daily paths are `apps/api/src/domains/van/commands.js` (`planTrip`, `planLoad`), `operations.js` (`finishLoad`, `movement`) and `settlement.js`. Every future stock write must still use `postMovement` in `apps/api/src/domains/inventory/posting.js` inside the business transaction. Never update balances directly.

## Print pack

Open `docs/templates/weekly-truck-stock.html` in a browser and print in landscape. It contains four blank, separately paginated worksheets:

1. Weekly stock request, with approved-plan and SAP sales order references.
2. Monday loading, requested versus actually served and their difference.
3. Saturday count and return, with net POS sold, counted remainder, discrepancy, batch/expiry and free-text reason. The destination remains the original issuing depot/plant.
4. Cashier comparison, showing both candidate quantity bases and their indicative amounts side by side. It is marked **NOT PAYABLE** and does not certify a cashier amount.

Each page says **WORKSHEET ONLY**, pending confirmation. Signatures are paper discussion fields; they do not post inventory, verify plan approval, grant authority or settle cash. There is no reason dropdown because the client has not supplied its list. Expired/damaged stock must not silently become saleable stock on return.

Regenerate blank worksheets from the repository root:

```sh
bun scripts/weekly-truck-stock.ts --output docs/templates/weekly-truck-stock.html
```

For an arithmetic-only example, use the explicitly invented sample file and write the result outside the repository:

```sh
bun scripts/weekly-truck-stock.ts \
  --input docs/examples/weekly-truck-stock.sample.json \
  --output "$TMPDIR/sp227-sample-worksheets.html"
```

The sample uses 100 requested, 80 served, 50 net POS sold, 30 counted and PHP 25.00 reference price per unit. The two possible accountabilities are 70 / PHP 1,750.00 and 50 / PHP 1,250.00. The 20-unit loading difference remains visible. This is invented arithmetic proof only, not client data, approved policy or a live stock movement.

The output is self-contained static HTML: no JavaScript, web requests, login or persistent storage. Keep any populated real forms in an appropriately protected location; there is no application access control on a local HTML file. A print pack is bounded at 40 lines and may span more physical pages when populated. Repeat the table header; never truncate products to force a one-page report.

### Supplied data format

Use the example as the exact input shape. Every stock line identifies product, unit, optional batch and expiry. Quantities are nonnegative safe integers in scaled units: `decimalPlaces: 3` and `servedBase: 1250` means 1.250 of the named unit, not 1,250 whole units. All values in one line use that same unit and scale. Do not compare pieces to cases, sum mixed products, or duplicate the same product/unit/batch/expiry line.

`servedBase`, `posSoldBase`, `countedBase`, `referenceUnitPriceMinor` and `posNetSalesMinor` must be explicitly a number or `null`. Null means **not recorded**, never zero. Prices and POS sales are in whole centavos. A reference price comes from the supplied file only; the tool neither looks up nor authorizes a price. The supplied POS amounts and net sold quantities must cover the same request, seller and week after returns and voids; the worksheet does not verify this against POS.

Differences remain signed, including a physical overage. Indicative amounts are unavailable for missing values, negative candidate accountability, or fractional centavos requiring an unconfirmed rounding rule. Multiplication uses integer arithmetic, not floating point. A zero count or price is preserved when explicitly supplied; it is not inferred. No mixed-unit quantity total or guessed payable total is printed.

## Remaining implementation and acceptance work

The recording screen above does not complete the following acceptance items:

- [x] Record the owner's answers: actually served minus counted remainder; start with the five editable reasons listed above.
- [ ] Define the weekly request lifecycle and its relationship to existing daily trips. Link a request to the salesman's approved MCP/daily routes, original issuing depot, vehicle, Monday–Saturday window and server-owned identity. Prevent overlapping open requests or accidental reuse next week.
- [ ] Add Field app > Sell > Stock for the week using the existing authenticated, selling-enabled device boundaries. No client-supplied salesman or branch should bypass scope. Show owned current and historical requests without exposing another seller's records.
- [x] Office capture of requested quantities with frozen product/unit facts, printable request after persisted plan approval, and the encoder's SAP sales order reference. Field request capture remains separate unfinished work.
- [ ] Capture actual served quantities alongside requested quantities. Post only actual units from the selected depot into that van via the canonical stock writer, atomically with the loading record. Preserve batch/expiry, insufficient-stock refusal, replay and partial-loading evidence.
- [ ] Resolve POS lines by authoritative request/trip links for the full week, not seller/date alone. Include returns, voids, reloads and damage without double counting. Disclose or refuse an incomplete read instead of showing a complete-looking report.
- [ ] Capture the Saturday physical count at the issuing depot. Preserve expected balance/version separately, investigate differences under the approved reasons and keep an audit trail. Refuse concurrent sale/return edits that invalidate the frozen report.
- [ ] Return counted stock from the van to that issuing depot's appropriate storage status, preserving lots and condition. Do not manufacture missing stock or silently write off a discrepancy. Post the return and close the request in one transaction with replay protection.
- [x] Produce cashier quantity and stock value using served less counted, frozen governed prices, explicit missing values and frozen reviewed reprints. POS invoices and refunds are separate. This quantity-only report is not proof of inventory movements or cash settlement.
- [x] Print request, actual service, count and cashier quantity reports from one authorized projection; reviewed reprints retain their original product, price, quantities and money. A count print is not yet a posted return document.
- [ ] Prove the smallest full flow: approved plan → request 100 → served 80 → net sold 50 → counted/returned 30 → new request next week. Check balances and canonical movement/ledger rows as well as printable facts. These are proposed sample values, not client stock.
- [ ] Counterexamples: unapproved plan; foreign seller/depot; duplicate command; changed-payload replay; insufficient source stock; missing price/count/POS; different units; partial service; overage/shortage; expired lots; late POS changes; repeated return/close; sign-out, scope withdrawal and suspended phone.
- [ ] Run touched-area API, web and Android gates and a lane-only integration proof. Physical phones and the main checkout remain outside this task's authorization. No live-device or deployed-workflow acceptance is implied by these preparation tests.
