# ADR-006: Product, unit-of-measure, and barcode baseline

Status: accepted. The barcode table and the bounded selling-UOM list are recommended defaults; unit conversion factors are outstanding client input.

## Decision

- **`products.code` is the stable product key.** Uppercase, matching `[A-Z0-9][A-Z0-9-]{2,31}`, immutable once created. The SAP or supplier identifier lives in `externalId`. Nothing keys off the product name.
- **Every product has exactly one base unit of measure** (`baseUomId`) and a `quantityScale`, initially 1,000 per case. All quantities persist as scaled `int64` base units; no quantity is ever a floating-point number (see ADR-003).
- **A product may declare a bounded set of allowed selling units** (`sellingUomIds`, at most eight, always including the base unit). This is separate from `uomConversions`, which holds the exact rational conversion (`numerator`, `denominator`, `roundingMode`, effective dates) between units.
- **Conversions fail closed.** No implicit 1:1, no default case size, no guessing. Selling, receiving, transferring, or counting in a non-base unit requires an explicit `uomConversions` row. Until Sunpride supplies real case sizes, only base-unit transactions are permitted.
- **Barcodes are per product and per unit of measure** (`productBarcodes`: product, barcode, UOM, active, source). The same SKU carries different barcodes for a case and for an each, and the Android POS scans both (`VAN-009`). Barcodes are normalized to digits, 8–14 characters, and must be unique across active rows.
- **Inventory behaviour lives in the policy document**, not on the product: `productInventoryPolicies` holds tracking mode, allocation policy, shelf-life and expiry/manufacture requirements, quality release, negative-stock permission, and costing method. Policies are versioned; `products.policyVersion` states which version is in force.
- **SAP stays authoritative for the approved catalogue** once integration lands (`SAP-002`, `SAP-003`). Products created by import are marked `catalogSource: "import"` so the later SAP reconciliation can distinguish Turbo-originated rows from ERP-originated ones and resolve them deliberately rather than by overwrite.
- **Lot tracking is the default** for manufactured and saleable goods; a product without lot tracking is an explicit policy choice, not an omission.

## Consequences

- Imported products carry `unitPrice: 0`. Price is not a product attribute (see ADR-008).
- Renaming a product code is a new product plus a migration decision, not an edit.
- The opening-stock import requires a lot number, manufacture date, and expiry date for every lot-tracked product whose policy demands them.
