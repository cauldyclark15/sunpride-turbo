# Shared foundation exit gate (SFD-019)

The shared foundation (org scope, people, product master, inventory ledger,
imports, van POS) is "done" only while this gate is green. A failure blocks the
next vertical-slice gate: do not merge a slice onto a red foundation.

```bash
bun run test:foundation        # from the repo root; convex-test only, no deployment touched
```

It runs every acceptance suite plus the domain suites the foundation relies on
(imports, inventory, scope, capability matrix, mobile push/bootstrap, the QSR-013
bootstrap size/duration budget, the mobile HTTP boundary and device proof, orders,
SAP outbound, visit commands). `bun run test` runs the same tests as part of the
full gate.

## Acceptance criteria → tests

| SFD-019 criterion                                | Test                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product CSV → inventory ledger → web/mobile read | `convex/acceptance/foundation_exit_gate.acceptance.test.ts` — "imports the shipped web product template, posts opening stock to the ledger, and reads it on web and van POS" and "reads the imported product on the field app: signed v1 bootstrap over HTTP, own region only" |
| Opening-stock replay rejection                   | same file — "rejects opening-stock replay: …"                                                                                                                                                                                                                                  |
| Idempotent adjustment retry                      | same file — "retries an adjustment idempotently: …"                                                                                                                                                                                                                            |
| Cycle-count variance approval                    | same file — "approves a blind cycle-count variance through a second person …"                                                                                                                                                                                                  |
| Cross-scope authorization denial                 | same file — "denies every cross-scope foundation read and write without side effects"; `acceptance/authorization_sweep.test.ts`; `lib/capabilities.matrix.test.ts`                                                                                                             |
| Audit completeness                               | same file — "audits every movement with its command, actor, outbound event and a reconciling ledger"; `acceptance/foundation.acceptance.test.ts` test 5                                                                                                                        |
| Contract compatibility                           | `convex/acceptance/foundation_contract.test.ts` against `packages/backend/contracts/foundation-v1.baseline.json`; the live field-app bootstrap response is parsed with the frozen v1 schema (`parseMobileV1Response`); mobile wire: `packages/domain-contracts` tests          |

### How the end-to-end story is built

- The product and opening-stock files are the **shipped web templates**
  (`apps/web/public/templates/*.csv`), parsed with the web client's own
  `parseCsv`, hashed with `hashText` and chunked with `chunkRows`/`chunkKeyFor`,
  so the server receives exactly what the import workspace sends. Operational
  adjustment CSVs use the web's `OPERATIONAL_HEADERS` mirror.
- Two regions (North, South); the warehouse `WH-MNL` and van `TRUCK-001` are
  mapped to North. People: North admin, manager, approver and van seller;
  South manager and seller. National imports run as the super admin.
- "Mobile read" is proven on both mobile products (ADR-010):
  - Android van POS: the North seller opens a route on the truck, sells
    imported stock, and a lost-ack replay is a no-op.
  - Native field apps: the North admin puts the CSV-imported product on an
    account's Annex C call sheet (public `callSheets.accounts.save`; the South
    manager is refused). The North seller's phone is registered and bound with
    a real P-256 key, then downloads its day through the real
    `POST /mobile/v1/bootstrap` HTTP route with a signed request. The response
    carries the imported product (code, name, barcode, pricing) on its call
    sheet and validates against the frozen v1 wire schema. A replayed nonce
    gets 401, the South phone sees only its own outlet and never the North
    product, and the North seller's login cannot drive the South phone.
  - The signed coverage day itself (territory, outlet, approved/activated plan
    visit) is seeded as a fixture; plan approval and activation are proven by
    the coverage suites.
  - v1 carries no nationwide selling catalog and no stock figures to the
    field apps (`productCatalog` is `[]`); the gate pins that until a scoped
    catalog ships.
- Every denied attempt compares a snapshot of all foundation tables before and
  after: a refusal must leave no rows, audit or outbound events behind.

### Contract baseline rules

`foundation-v1.baseline.json` freezes the argument and return validators of the
public functions the web import workspace, inventory screens and van POS call.
Clients already shipped keep sending those shapes, so:

- adding an **optional** argument, widening a union, or adding a return field
  is fine — no baseline change needed;
- adding a required argument, removing/narrowing an argument, or removing,
  optionalising or retyping a return field fails the gate. Ship it as a new
  function (or a v2 baseline beside v1), never by editing v1.

## Reused suites

| Tracker | Suite                                                                                                                                                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CVX-035 | `acceptance/field_pilot.acceptance.test.ts`, `inventory/pos.test.ts` (see `docs/architecture/BACKEND_TEST_SUITE.md`)                                                                                                                    |
| SFD-012 | `acceptance/foundation.acceptance.test.ts` (org tree, assignments, scope filters, audit of reason-bearing transitions)                                                                                                                  |
| QSR-004 | Duplicate prevention: `domains/orders.test.ts`, `integration/sap.test.ts`, `mobile/push.test.ts`, `inventory/pos.test.ts`                                                                                                               |
| QSR-006 | `acceptance/authorization_sweep.test.ts`, `lib/capabilities.matrix.test.ts`, `*.scope.test.ts`                                                                                                                                          |
| QSR-011 | Audit: `acceptance/foundation.acceptance.test.ts` test 5 and the exit-gate audit test; gaps in `docs/contracts/AUDIT_EXECUTION_EVENTS.md`                                                                                               |
| QSR-013 | `mobile/bootstrap_budget.test.ts` (size/duration per representative territory), `mobile/budget.test.ts`, `mobile/http_handlers.test.ts` (gzip, boundary) and `mobile/bootstrap.test.ts`; budget in `docs/qa/MOBILE_BOOTSTRAP_BUDGET.md` |

## Behaviour pinned by the gate (and open questions)

- Approving an adjustment or a count a second time (for example after a lost
  response) is refused with "not awaiting a decision" / "not ready for
  approval" and posts nothing. The effect is exactly-once, but the retrying
  screen sees an error instead of the original result.
- Opening stock emits no outbound integration event (cutover balances already
  exist in SAP); every other movement emits exactly one.
- An operational CSV row outside the caller's scope is reported per row
  (`scope_denied`) and nothing is staged; the attempt is still recorded as a
  failed import run under the caller's name.
