# ADR-008: Pricing authority before SAP integration

Status: accepted as a bridge decision. Revisit when SAP pricing is integrated or when Sunpride confirms a different source.

## Decision

- **Until SAP pricing is integrated, Turbo owns a governed price baseline.** Prices are effective-dated rows scoped by product, unit of measure, and channel or customer, held server-side. The field and POS applications read prices; they never define them.
- **Prices are resolved server-side.** A client may send a requested quantity, but an authoritative price comes from the price list that applies at the transaction time. Client-supplied prices are advisory input, never authority.
- **Manual overrides fail closed.** A price override requires an explicit permission, records the original price, the applied price, the actor, and a reason, and is disabled by default.
- **Promotions are governed rule sets**, not free-form discounts. A rule the client cannot evaluate offline fails closed rather than being skipped or approximated.
- **SAP remains the financial authority** (`ARCH-020`). Where SAP and Turbo both price a transaction, SAP wins; Turbo's list is a baseline that exists so field and van sales can operate before the ERP feeds prices.

## Known gap this ADR records

`packages/backend/convex/domains/orders.ts` computes `subtotal`, `total`, and each `orderLines.lineTotal` from a `unitPrice` supplied by the caller, and stores it. Until the price-list implementation (`SFD-006`) lands:

- order totals are advisory and must not be treated as financial truth;
- no approval authority, credit decision, or margin report may depend on them;
- SAP recomputes the financial outcome, which is consistent with ADR-003.

Closing this gap is the first task after the master-data and opening-stock slice, and it is what makes offline van-sales pricing defensible (`VAN-010`).

## Consequences

- The product master deliberately carries no price column; the import templates exclude pricing.
- Price list versioning and effective dates become part of the mobile bootstrap payload so devices can price offline (`CVX-019`).
- A pricing decision from Sunpride is still required on scope: price by channel only, by customer group, or per customer with exceptions.
