# Weekly truck stock — preparation pending client decisions (SP-0227)

## Status and boundary

This is preparation, not the completed Field app workflow. No app menu, weekly stock records, inventory postings, POS integration or cashier settlement has been added. The HTML pack is a printable paper worksheet, not an authenticated business document. Existing daily van loads and settlements are unchanged.

Two questions were posted on SP-0227 and the issue is Awaiting client response:

1. If the warehouse serves less than requested, does the cashier use **requested minus counted remainder** or **actually served minus counted remainder**?
2. Which reasons should staff choose for unsold stock, expired stock and count differences?

The client must answer these; choosing a financial liability basis or inventing stock disposition rules is not a software-only decision. The preparation does not select a default. Price authority, discounts, taxes and rounding must also be verified against existing governed pricing before a final cashier amount is implemented; the sample reference price is not that authority.

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

## Implementation and acceptance checklist after confirmation

These are remaining work, not completed features:

- [ ] Record the client's exact answers on SP-0227; use their labels and do not rename their reasons.
- [ ] Define the weekly request lifecycle and its relationship to existing daily trips. Link a request to the salesman's approved MCP/daily routes, original issuing depot, vehicle, Monday–Saturday window and server-owned identity. Prevent overlapping open requests or accidental reuse next week.
- [ ] Add Field app > Sell > Stock for the week using the existing authenticated, selling-enabled device boundaries. No client-supplied salesman or branch should bypass scope. Show owned current and historical requests without exposing another seller's records.
- [ ] Capture requested product/unit quantities and create a printable request only after persisted plan approval. Keep the encoder's SAP sales order reference, not an invented automatic order.
- [ ] Capture actual served quantities alongside requested quantities. Post only actual units from the selected depot into that van via the canonical stock writer, atomically with the loading record. Preserve batch/expiry, insufficient-stock refusal, replay and partial-loading evidence.
- [ ] Resolve POS lines by authoritative request/trip links for the full week, not seller/date alone. Include returns, voids, reloads and damage without double counting. Disclose or refuse an incomplete read instead of showing a complete-looking report.
- [ ] Capture the Saturday physical count at the issuing depot. Preserve expected balance/version separately, investigate differences under the approved reasons and keep an audit trail. Refuse concurrent sale/return edits that invalidate the frozen report.
- [ ] Return counted stock from the van to that issuing depot's appropriate storage status, preserving lots and condition. Do not manufacture missing stock or silently write off a discrepancy. Post the return and close the request in one transaction with replay protection.
- [ ] Produce the cashier quantity and amount using the client-confirmed basis and governed price facts, frozen for reprints. Keep net POS sales as a distinct cross-check; stock value, cash collected, credit sales and actual remittances are not interchangeable.
- [ ] Print request, actual service, count/return and cashier reports from the same authorized persisted projection; all four must reconcile and retain their original values on reprint after master-data changes.
- [ ] Prove the smallest full flow: approved plan → request 100 → served 80 → net sold 50 → counted/returned 30 → new request next week. Check balances and canonical movement/ledger rows as well as printable facts. These are proposed sample values, not client stock.
- [ ] Counterexamples: unapproved plan; foreign seller/depot; duplicate command; changed-payload replay; insufficient source stock; missing price/count/POS; different units; partial service; overage/shortage; expired lots; late POS changes; repeated return/close; sign-out, scope withdrawal and suspended phone.
- [ ] Run touched-area API, web and Android gates and a lane-only integration proof. Physical phones and the main checkout remain outside this task's authorization. No live-device or deployed-workflow acceptance is implied by these preparation tests.
