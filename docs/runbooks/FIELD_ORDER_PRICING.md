# Field order pricing, selling units and credit check (SP-0088, PRICING-001)

Status: built on made-up **beta sample data**. Sunpride's real price lists, unit/pack samples and
pricing scope (SP-0033) replace the sample rows later without code changes.

## How a field order is priced

1. **Which price list.** The outlet's channel (`outlets.channel`, else the linked customer's
   `customers.channel`), compared trimmed and lower-case, picks the single active, effective
   `priceLists` row with that `channelKey`. With no list for the channel, the single effective
   default list (`channelKey: null`) applies. Two effective lists for one key are ambiguous and
   price nothing (never a guess).
2. **Which price.** One effective `priceListLines` row for the product and the ordered unit code.
   Prices are whole centavos per one unit (`unitPriceMinor`). No single line = "Priced by the
   office" for that line; it is left out of the total.
3. **Selling units.** A product can be ordered in its own unit (`products.uom`) or any active unit
   in `products.sellingUomIds` (at most 6). One line per product per order.
4. **Phone preview.** Bootstrap ships `orderTerms` per account with its call sheet: the list and
   every orderable unit with its price (or null). A price edit changes the signed manifest, so
   phones take a fresh snapshot. iOS and Android show unit prices, line amounts and the order total.
5. **Server pricing.** On every submitted `order_intent` with lines, `visits/commands.ts` prices
   the order itself at the capture time (`min(deviceTime, serverTime)`) and stores the result in
   `fieldOrderPricings` (lines, total, unpriced count, list and its source). The phone's figures
   are never trusted. An order stamped before its call's check-in (`visit.startedAt`, same phone
   clock) is refused `invalid_request`, so a backdated order can never pick a retired price. Other
   activities keep device time as evidence only (ADR-022).

## Credit check

- Limit: `customers.creditLimit` (pesos; 0 or less = no limit set).
- Server: open orders of the customer (submitted / pending approval / approved / sent to SAP /
  review required; there is no receivables feed yet) + every field order sent for the same
  customer in the last 30 days (`FIELD_ORDER_PENDING_DAYS`, a sample default: field orders do not
  become `orders` rows yet), on any call by anyone + this order, against the limit. Recorded as
  `within`, `over`, `no_limit` or `unknown`. A line without a price has no known amount: known
  amounts over the limit are still `over`, otherwise an order or pending exposure with an
  office-priced line is `unknown`, never `within`. More than 200 recent orders or 200 pending
  field orders to read is also `unknown`. **Over the limit never blocks the order**: the office
  approves it.
- Phone (advisory, offline): the cached account summary's limit and open orders plus this phone's
  other sent orders for the store that day. Over the limit shows a warning ("by at least" when
  some lines are office-priced); Send stays enabled. With office-priced lines and no proven
  overrun the phone says the office checks credit. When the summary is withheld (shared account)
  the phone says the office checks credit.

## iOS and Android parity (SP-0134)

Both field apps read the same `orderTerms` and `accountSummaries` bootstrap sections (no iOS-only
contract). Each order line shows the unit price for the chosen selling unit (a picker on iOS, chips
on Android; only units in the account's terms), the line amount, and the review shows the PHP total,
office-priced lines, the price list name with "Sample prices" for beta sample lists, and the advisory
credit check (over-limit warns, Send stays enabled). Neither app shows a "1 CS = N PC" caption yet:
the conversions reach the phone in the reference products (`sellingUoms[].toBase`), but whether
`toBase` counts scaled base quantity (`quantityScale`, as stock posting uses it) or plain pieces (as
the sample price seed uses it) must be settled first, or the caption could be off by 1,000. Each
unit's own price already reflects its conversion. Neither app applies promotions to field orders
(out of scope, see below). iOS screenshots, light and dark: UI test `testOrderPricingScreenshots`.

## Beta sample data (made up, clearly marked)

`convex/pricing/sample.ts` (internal functions only):

- `seed({ cursor })` — four lists marked `source: "sample"` with `SAMPLE-` codes: Key Accounts
  (4% below standard), Route Sales / PMOT (standard), Public Market (4% above), and the default
  Standard list. Every active product gets a stable piece price between ₱15.00 and ₱160.00 (from
  its code), and each selling unit is priced by its in-force conversion (packs of 12 or more 3%
  cheaper per piece). Units without a conversion stay unpriced. Idempotent; batched.
- `seedCreditLimits({ cursor })` — active customers with no limit get a sample limit between
  ₱50,000 and ₱300,000, recorded in `sampleDataChanges`. Office-set limits are never touched.
- `reset({})` — removes only the sample lists/lines and restores recorded credit limits (unless
  the office changed them since). Call until `isDone`.

The lead runs them on the beta backend after deploying (never from a lane):

```bash
cd packages/backend
bunx convex run pricing/sample:seed '{"cursor":null}'              # repeat with continueCursor until isDone
bunx convex run pricing/sample:seedCreditLimits '{"cursor":null}'   # same
bunx convex run pricing/sample:reset '{}'                           # when real data arrives
```

## Replacing the sample with real data

Insert Sunpride's lists with `source: "office"` and their `channelKey`s, then run `reset`. While
both an office list and a sample list are effective for the same channel the outlet is ambiguous
and unpriced, so reset the samples in the same window. There is no office editing screen yet
(follow-up); ADR-008's manual override and promotions remain out of scope.

## Open questions for Sunpride (do not block)

- Price scope: by channel only (built), or per customer group / per customer exceptions?
- Real channel names for the three lists and which outlets carry them.
- Credit: should over-limit orders be blocked, held for approval (built: recorded for approval),
  or allowed? Is there a receivables (AR) balance to include?
- Units and packs per product (piece/pack/case factors) and barcodes per pack.
