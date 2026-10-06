# VAN-010 (SP-0105): offline price lists and promotions on the van POS — readiness

Status: blocked. This page records what is needed before the work can start, the rules the build will follow, and
the tests that will prove it. Authority: ADR-008 (pricing before SAP), ADR-004/ADR-010 (separate van-sales Android
app), ADR-019 (offline business guarantees).

## Why it cannot be built yet

| Blocker                                                                                                | Owner                                 | Tracker               |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------- | --------------------- |
| Sunpride's real price lists, units/packs and promotion examples (filled intake files below)            | Sunpride sales team                   | SP-0033 (ARCH-006)    |
| Pricing scope decision: one price per channel, per customer group, or per customer with exceptions     | Sunpride (Sir Francis)                | ADR-008 open decision |
| Who may change a price on the handheld, by how much, and whether a supervisor must approve             | Sunpride (Sir Francis)                | this issue            |
| Governed price/promotion master on the server, delivered in the van bootstrap                          | our team, after the two answers above | SFD-006 / CVX-019     |
| The van-sales app itself on main (currently withheld on `feat/van-pos` for a bootstrap barcode defect) | our team                              | SP-0095, SP-0097      |

The van app branch already reserves an empty `price_list_line` table and shows **Priced by the office**; nothing
in the app or server defines a price today, and none may be invented (ADR-008: clients read prices, never define them).

## Rules the build will follow

### Price resolution (offline, on the handheld)

1. Only rows delivered by the signed van bootstrap/delta are used. A price typed, scanned or remembered on the
   device is never a price source.
2. Candidate rows match product, selling unit and currency, and the sale instant falls inside
   `[effective_from, effective_to)` (Manila time converted to UTC at import).
3. Precedence, most specific first: customer price → customer-group price → channel price → base list.
   Exactly the scope levels Sunpride confirms are enabled; unconfirmed levels are not shipped.
4. Two rows at the same level that overlap in time are a data error: the server import rejects them; if one still
   reaches a device, the line cannot be priced (fail closed), never "pick the cheaper".
5. No matching row → the line cannot be sold at a price. The app shows "No price for this customer" and the sale
   cannot be completed until a governed price arrives (or the line is removed).
6. A price list older than its sync lease is treated as expired: the app stops pricing until it syncs.
7. Every sale line stores its **price source**: price list ID and version, scope level (customer / group /
   channel / base), the row's effective window, and the bootstrap generation it came from. Receipts and the
   office review show the source.

### Promotions

- Promotions are governed rule sets from the server, not free-form discounts.
- Only rule types the app knows how to evaluate are applied (initial set to confirm from Sunpride's examples:
  percentage off, fixed amount off, buy X get Y free of the same or another product, minimum-quantity tier price).
- A promotion whose type, scope or condition the app cannot evaluate **fails closed**: the sale is blocked with
  "Promotion needs the office" rather than skipping it or approximating it.
- Stacking, priority and exclusivity are explicit fields on each rule; no implicit stacking.
- Free goods draw from truck stock through the normal ledger movement and are printed as separate zero-price lines.
- Each applied promotion is recorded on the line (promotion ID, version, rule type, discount amount).

### Manual price overrides

- Disabled by default. Only a capability granted by the server (e.g. `van.price.override`, name to be fixed when
  the master lands) enables it, optionally with a maximum percentage and a supervisor approval code.
- An override records original price, applied price, actor, reason code, time and approval reference, and is
  flagged for office review. Without the capability the price field is read-only and the attempt is refused.
- The server re-resolves every price on push; a client total that differs from the server's resolution is
  recorded as a discrepancy for office review, never silently accepted. SAP stays the financial authority.

## Intake files for Sunpride

Fill one row per price or promotion; keep the header row unchanged. Example rows are marked `EXAMPLE` and must be
deleted.

- `docs/requirements/pricing-intake/price-list.csv`
- `docs/requirements/pricing-intake/promotions.csv`

Columns are explained in `docs/requirements/pricing-intake/README.md`.

## Acceptance tests to write once unblocked

Pure resolver (JVM unit tests in the van app, mirrored by a backend parity test):

- customer price beats group beats channel beats base; disabled levels are ignored
- sale instant on `effective_to` uses the next row; before `effective_from` finds nothing
- overlapping same-level rows → unpriceable line
- no row → sale blocked; expired lease → sale blocked
- each promotion type computes the documented example; unknown type → sale blocked
- non-stacking promotions pick by explicit priority; ties → blocked
- override without capability refused; with capability over the limit refused; within limit stores all audit fields
- price source fields present on every sold line and on the printed receipt

Server: import rejects overlaps and unknown units; bootstrap delivers only rows in the device's scope; push
re-resolves and records discrepancies; override audit is append-only.

Device (Senraise H10P via `sunpride-pos-device-test.sh`): offline sale with customer price + one promotion prints
the price source; override is not offered to a seller without the capability.
