# Mobile reference data: products and stock availability (SP-0051 / SFD-018)

The field phones (iOS, Android) receive the products they are allowed to sell and the stock
available to their own unit through the existing v1 bootstrap and pull endpoints. Office CSV
imports (product master, opening stock, adjustments, counts) reach the phones on the next pull,
with no SAP involvement and without a fresh day snapshot.

## Who sees what

- **Products**: only active products that appear on the Annex C call sheets of the accounts in
  the phone's own planned visits (today plus the next two days). This is the only per-account
  authorized assortment the system holds; there is no nationwide catalog on a phone.
- **Stock**: only balances of those products at the inventory locations of the phone's own
  organization unit that are active and allow sale (`inventoryLocations.orgUnitId` equals the
  device's unit, `active`, `allowsSale`). Legacy SAP warehouse-code balances without a product
  and location ID are never sent.
- Limits: at most 300 products and 10 sale locations per phone, and 1,000 balance rows per
  location. Over a limit the server answers `temporarily_unavailable` (500) instead of sending a
  partial list; raise the limit or split the unit.

## Opting in (old app builds keep today's behaviour)

`bootstrap.request` gains an optional `referenceData: true`. Send it on the first page only.
Continuation pages follow the mode recorded in the signed page cursor (sending a different value
on a continuation page is `invalid_request`). Without the flag the bootstrap still returns an
empty `productCatalog`, and pulls never contain the new entity kinds.

## Bootstrap (`referenceData: true`)

Product and stock rows are paged together with visits and tasks: `limit` counts them all, in the
order visits, tasks, products (by code), stock (by location code, then product code).

`productCatalog[]` (one per product on this page):

```json
{
  "id": "<products id>",
  "code": "SUNP-001",
  "name": "Sunpride Corned Beef 150g",
  "uom": "CAN",
  "revision": 1759550000000,
  "quantityScale": 1000,
  "baseUom": { "code": "CAN", "name": "Can", "decimalPlaces": 0 },
  "sellingUoms": [
    {
      "code": "CS",
      "name": "Case",
      "decimalPlaces": 0,
      "toBase": {
        "numerator": 48000,
        "denominator": 1,
        "roundingMode": "exact"
      }
    }
  ],
  "barcodes": [{ "barcode": "4800000000017", "uom": "CAN" }]
}
```

- `baseUom` may be `null` (legacy product without a unit record); `toBase` is `null` when no
  conversion is in force. `toBase` converts a quantity in the selling unit into base quantity
  (`quantityBase = quantity × numerator ÷ denominator`, in base units × `quantityScale`).
- `barcodes` lists active barcodes (at most 20, 64 characters each) in server order. The call
  sheet line's `barcode` is always `barcodes[0].barcode` or `null`.

`inventoryAvailability[]` (one per balance row on this page):

```json
{
  "id": "<inventoryBalances id>",
  "productId": "<products id>",
  "locationId": "<inventoryLocations id>",
  "locationCode": "BR-MNL-01",
  "locationName": "Manila branch",
  "availableBase": 24000,
  "physicalBase": 30000,
  "reservedBase": 6000,
  "revision": 1759550000123,
  "asOf": 1759550000123
}
```

Quantities are integers in base units × the product's `quantityScale` (24000 with scale 1000 is
24 cans).

## Pull (cursor issued by a `referenceData` bootstrap)

Pull pages carry two additional entity kinds after the person's own visit/activity changes:

| entity      | id             | value                           |
| ----------- | -------------- | ------------------------------- |
| `product`   | product ID     | a `productCatalog` item         |
| `inventory` | balance row ID | an `inventoryAvailability` item |

- Always `op: "upsert"`. A product leaving the assortment (call sheet edit, deactivation) or a
  location change forces `rebootstrap_required` as before, so there are no reference tombstones.
- `revision` is a server millisecond timestamp. Apply a change only when its `revision` is
  greater than or equal to the stored one; the same row may be sent again for about a minute
  after it changes (the server re-reads a 60-second overlap so late commits are never lost).
- `seq` on these rows is the person's current change high-water, not a unique sequence.
- On a `product` upsert, also refresh `code`, `name`, `uom` and `barcode` (= `barcodes[0]`) on
  every stored call sheet line with that `productId`. In reference mode, product name/code/UOM
  and barcode edits no longer force a fresh snapshot; they arrive as these upserts.
- Store the changes and the new cursor in one transaction, exactly as for visit changes,
  including pages with no changes.

## Verifying on DEV

1. Import a product master CSV changing a name for a product on a salesperson's call sheet.
2. Pull on that salesperson's phone: one `product` upsert with the new name; the call sheet line
   shows it.
3. Post an opening stock or adjustment CSV for that product at a sale location of the person's
   unit: the next pull contains an `inventory` upsert with the new `availableBase`.

## Open questions for Sunpride

- Is the call sheet assortment the right list of products a salesperson may sell, or does each
  channel/route have its own authorized list?
- Which locations should a route seller see: the branch's sale locations (current rule), or only
  the truck they drive? Pre-booking staff carry no stock and see the branch.
