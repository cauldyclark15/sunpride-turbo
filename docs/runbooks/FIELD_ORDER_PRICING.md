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
   are never trusted.

## Credit check

- Limit: `customers.creditLimit` (pesos; 0 or less = no limit set).
- Server: open orders of the customer (submitted / pending approval / approved / sent to SAP /
  review required; there is no receivables feed yet) + earlier priced orders on the same call +
  this order, against the limit. Recorded as `within`, `over`, `no_limit` or `unknown` (more than
  200 recent orders to read). **Over the limit never blocks the order**: the office approves it.
- Phone (advisory, offline): the cached account summary's limit and open orders plus this phone's
  other sent orders for the store that day. Over the limit shows a warning; Send stays enabled.
  When the summary is withheld (shared account) the phone says the office checks credit.

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
