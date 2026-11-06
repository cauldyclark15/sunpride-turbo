# Inventory + POS rebuild: shared seams (IP-FOUND)

Plumbing every later lane imports. Names and signatures are fixed; do not rename. Spec: `_plans/sunpride-inv-pos/SPEC.md` (3.3, 3.4, 3.5, 7.2).

**Rule that does not change: every stock change still goes through `postMovement` (`apps/api/src/domains/inventory/posting.js`).** Nothing here writes stock. These seams supply reasons, limits, numbers and tax maths to the documents that do.

## Migration ranges

| Range | Owner |
|---|---|
| 0700-0704 | ip0b / ip0fix |
| 0705-0709 | FOUND (0705 reason codes, 0706 tolerances, 0707 document sequences; 0708-0709 spare) |
| 0710-0719 | BIR |
| 0720-0729 | ZDAY |
| 0730-0739 | XFER |
| 0740-0749 | COUNTS |
| 0750-0759 | VALUE |
| 0760-0769 | VANDAY |
| 0770-0779 | NAV / DECIDE |
| 0780-0789 | HANDHELD (server parts) |

## API seams

Organization is the text id `ORGANIZATION = "sunpride"` (`inventory/common.js`). All amounts are integer centavos; screens show pesos.

### Reason codes: `domains/inventory/reasons.js`, table `inventory_reason_codes`
```js
listReasonCodes(db, org, { category?, direction?, activeOnly = true }) // -> ReasonCode[]; direction "in"/"out" also returns "both"
requireReason(db, org, code, { direction?, note?, photoCount? })        // -> ReasonCode, or throws code "reason_code_invalid" (422) with a plain message
ensureDefaultReasonCodes(db, org)                                       // seeds the ten SPEC 3.4 defaults once for an org with none
// ReasonCode = { code, label, category, direction, requiresNote, requiresPhoto, approvalThresholdCentavos|null, active }
```
Routes: `GET /api/v1/inventory/reason-codes?category=&direction=&all=1` (`inventory.read`), `POST /api/v1/inventory/reason-codes/save` (`admin.manage`; upsert by `code`, set `active:false` to retire).
Every reason field on adjustments, counts, dispositions, transfer variances, damage and voids stores a `code` from this table and calls `requireReason` before writing.

### Tolerances: `domains/inventory/tolerances.js`, table `approval_tolerances`
```js
toleranceFor(db, org, event, at = Date.now()) // -> { maxCentavos|null, maxQtyBase|null, maxCases|null, isDefault }
withinTolerance(tol, { centavos?, qtyBase?, cases? }) // -> boolean; compares sizes (abs); null limit or missing measure is not checked
TOLERANCE_EVENTS = load_out_difference | transfer_receive_variance | load_in_difference | count_variance | truck_damage | cash_variance
```
Effective-dated: the latest row with `effective_from <= at` applies; history is kept. Shipped rows have `isDefault: true` and show as "Default, not confirmed by Sunpride". Routes: `GET /api/v1/inventory/tolerances` (`inventory.read`), `POST /api/v1/inventory/tolerances` (`admin.manage`, body `{event, maxCentavos?, maxQtyBase?, maxCases?, effectiveFrom?}`).
Events with no number in SPEC 3.5 (adjustment, void, refund: "never auto") are not rows here.

### Document numbers: `core/docnum.js`, table `document_sequences`
```js
nextDocNumber(db, org, { type, locationCode, at }) // -> "TRF-CEB-261106-0012"
DOC_TYPES = TRF LOAD RLD LIN RCV CNT ADJ DSP REM SHF TILL Z
```
Manila business date, 4 digits (grows past 9999), one counter per org + type + location + day. One atomic upsert takes the row lock; call it inside the document's own transaction so a rolled-back document gives its number back. `locationCode` is upper-cased, 1-20 of `A-Z 0-9 -` (store tills use e.g. `REG01`). Fiscal documents (invoice, OR, credit memo) keep their own BIR series.

### Privilege discounts and per-line VAT: `domains/fiscal/privilege.js` (pure)
```js
PRIVILEGE_TYPES = ["senior","pwd","solo_parent","athlete","uniformed"]; PRIVILEGE_LABELS; PRIVILEGE_RATE_BPS
computeLine({ unitPriceCentavos, qty, vatRateBps, taxTreatment: "vatable"|"exempt"|"zero_rated", privilege?: {type}|null, promoDiscountCentavos? })
  // -> { grossCentavos, vatableCentavos, vatCentavos, vatExemptCentavos, zeroRatedCentavos,
  //      privilegeDiscountCentavos, promoDiscountCentavos, netCentavos, vatRemovedCentavos, privilegeType }
computeCart(lines, { privilege? }) // -> { gross, vatable, vat, vatExempt, zeroRated, vatRemoved, privilegeDiscount, promoDiscount, total, lines }
```
- Prices are VAT-inclusive. Senior, PWD: VAT removed, then 20% of the VAT-exclusive amount. Solo parent, uniformed: VAT removed, then 10%. Athlete: 20% of the VAT-exclusive amount, VAT stays.
- Privilege and promo never stack; the larger benefit to the customer wins, a tie goes to the promo. Rounding is half-up to the centavo per line.
- `netCentavos` is what the customer pays for the line. Buckets are shown before the privilege discount: `vatable + vat + vatExempt + zeroRated = net + privilegeDiscount`.
- `computeCart`: the cart-level `privilege` applies to every line unless the line carries its own `privilege` or `privilege: null` (not eligible). Quantity must be more than zero. BIR wires this into store and van sale validation.
- Itemcount check: P39.00 vatable 12% + Senior = P27.86.

## Web seams: `apps/web/src/components/ops/` (`index.ts` re-exports all)
- `Peso` / `formatPeso(centavos)`: "₱1,250.00", right-aligned, tabular digits, red when negative.
- `QtyCasesPieces {base, basePerCase?}` and `formatCasesPieces`, `splitCasesPieces`, `toBaseQty`: "2 cs 6 pc"; pieces only when the product has no case size.
- `CasesPiecesStepper {value:{cases,pieces}, onChange, basePerCase?, disabled?, hint?}`: two 48px steppers with a typed field; pieces carry into cases; never below zero.
- `DocNumber {value}`: monospace; a UUID or empty value reads "No number yet".
- `ReasonSelect {value, onChange(code, reason|null), direction?, category?, label?, disabled?}`: loads the reason-codes route, shows "Needs a photo / a short note".
- `StatusPill {state, children?}`: Saved on phone, Sent, Accepted, SAP posted, Needs review, plus the document states of SPEC 4.1 and 5.1 (`STATUS_STATES`).
`ReceivePanelLine` is not here (XFER owns it).
