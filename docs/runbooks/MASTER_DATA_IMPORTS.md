# Master data and opening stock imports

Two controlled CSV operations put Sunpride's real data into Convex. Both validate on the
server, preview before writing, and are safe to re-upload: a repeated request returns the
original result and writes nothing (ADR-003).

Templates live at `apps/web/public/templates/` and are downloadable from Web → Imports.

| Operation      | Template             | Authority                                      |
| -------------- | -------------------- | ---------------------------------------------- |
| Product master | `product-master.csv` | `catalogSource: "import"` until SAP sync lands |
| Opening stock  | `opening-stock.csv`  | `opening_balance` movement, `cutover` source   |

## How a run works

1. **Download** the matching template. Do not rename, reorder, or add header columns.
2. **Upload** the file. The browser parses it; every value is re-validated on the server.
3. **Preview** runs validation without writing and reports row-level errors.
4. **Commit** writes in chunks of 100 rows. Each chunk carries one idempotency key
   (`<type>:<runKey>:<chunkIndex>`) and a file hash, so a crashed or repeated upload
   resumes safely and a replay is a no-op.
5. **Run history** keeps the counts, the actor, and any movement number for audit.

Row limits: 5,000 rows per file. A file over 100 rows posts as several sequential chunks —
for opening stock that means **one movement per chunk**, each with its own idempotency key.

## Product master

`product_code,name,category,base_uom,selling_uoms,barcode,tracking_mode,allocation_policy,shelf_life_days,expiry_required,manufacture_date_required,minimum_remaining_shelf_life_days,external_id`

| Column                              | Rule                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `product_code`                      | Required. `^[A-Z0-9][A-Z0-9-]{2,31}$` after trim and uppercase. **Immutable** once created.    |
| `name`                              | Required. ≤ 120 characters.                                                                    |
| `category`                          | Required. ≤ 60 characters.                                                                     |
| `base_uom`                          | Required. Must exist in units of measure (`CASE`, `EACH`, `KG`, `L` after provisioning).       |
| `selling_uoms`                      | Optional. `;`-separated codes; must exist; at most 8; must include `base_uom`.                 |
| `barcode`                           | Optional. Digits only, 8–14 characters. Unique among active barcodes. Mapped to the base unit. |
| `tracking_mode`                     | Required. `lot` or `none`.                                                                     |
| `allocation_policy`                 | Required when `tracking_mode=lot`. `fefo` or `fifo`.                                           |
| `shelf_life_days`                   | Optional integer, 0–3650.                                                                      |
| `expiry_required`                   | Optional `Y`/`N`. Defaults to `Y` for lot-tracked products.                                    |
| `manufacture_date_required`         | Optional `Y`/`N`. Defaults to `Y` for lot-tracked products.                                    |
| `minimum_remaining_shelf_life_days` | Optional integer ≥ 0. Defaults to `0`.                                                         |
| `external_id`                       | Optional. ≤ 64 characters. The SAP or supplier identifier.                                     |

A valid row imports even when other rows in the same chunk are rejected; errors are
reported per row. Renaming a product code is not an edit — it creates a second product.

## Opening stock

`product_code,location_code,lot_number,manufactured_at,expires_at,quantity,unit_cost_minor,source_reference`

| Column                           | Rule                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `product_code`                   | Required. Must exist and have an inventory policy.                                                                                       |
| `location_code`                  | Required. Must exist and be `active` (`WH-MNL`, `TRUCK-001`, `IN-TRANSIT`, `WIP-MAIN`, `PRODUCTION-MAIN`, `RETURNS` after provisioning). |
| `lot_number`                     | Required when the product is lot tracked. ≤ 40 characters, normalized to uppercase.                                                      |
| `manufactured_at` / `expires_at` | `YYYY-MM-DD`. Required when the product policy requires them.                                                                            |
| `quantity`                       | Required. Positive, at most 3 decimals. Converted to base units at scale 1,000.                                                          |
| `unit_cost_minor`                | Optional integer in minor currency units.                                                                                                |
| `source_reference`               | Required. ≤ 64 characters, recorded on every lot and the movement.                                                                       |

**Opening stock is all-or-nothing per chunk.** If any row is invalid the whole chunk is
rejected and no movement is posted — half a cutover is worse than none. Correct the file and
re-upload under the same run key, or fix the rows and use a new run key.

Do **not** use this operation to correct stock after go-live. Corrections go through a stock
count and an approved adjustment, and reversals must invert the original allocations
(`docs/runbooks/INVENTORY_OPERATIONS.md`).

## Error codes

| Code                | Meaning                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `required_missing`  | A required cell is empty.                                                                                             |
| `invalid_format`    | Wrong shape — code, date, barcode, quantity, or boolean.                                                              |
| `unknown_reference` | A code does not resolve: UOM, location, or product.                                                                   |
| `duplicate_in_file` | The same product appears twice in one file.                                                                           |
| `duplicate_stock`   | That product/lot/location already carries opening stock; correct it through a stock count and an approved adjustment. |
| `barcode_conflict`  | The barcode belongs to another active product.                                                                        |
| `policy_missing`    | The product has no inventory policy, so lot rules cannot be applied.                                                  |
| `not_positive`      | Quantity is zero or negative.                                                                                         |
| `too_many_rows`     | The file exceeds the row limit.                                                                                       |
| `scope_denied`      | The caller's organizational scope excludes the target.                                                                |

## Re-uploading a file

The run identity is the file's content hash, so uploading the identical file again resolves to the
same run: the server reports a **duplicate** and adds no stock. Editing the file creates a new run,
and for opening stock a row whose lot already carries stock at that location is rejected with
`duplicate_stock` instead of being posted twice.

## Cutover sequence

1. Provision the inventory foundation (Web → Inventory → **Provision inventory foundation**).
2. Provision the organization foundation: `bunx convex run migrations:seedOrganizationFoundation`.
3. Import the product master and resolve every reported error.
4. Export the approved opening quantities, lots, expiry dates, and unit costs to
   `opening-stock.csv` and import it under one stable run key.
5. Verify Web → Inventory → Movement ledger contains the opening movement, and that every
   product-location balance has a non-zero version.
6. Re-upload the same file. The Run history tab shows a duplicate and no additional stock is
   posted. Opening stock whose lot already carries stock at that location is refused with
   `duplicate_stock`.

## Operational CSV adapters (server only)

The adjustment and count CSV adapters are available as `imports.adjustments.preview/commit`
and `imports.counts.preview/commit`; the Web import interface and downloadable templates are
**not yet implemented**. Pass parsed rows with original `rowNumber` and exact column keys,
plus the optional `header` string array from the uploaded CSV. When supplied, the header must
match the template **exactly in order**: missing, extra, or reordered columns produce a
file-level `invalid_format` error (row 1, `header`), and commit stages nothing. Existing
row-only clients remain supported. No Web callers of these operational adapters exist yet.
Pass `runKey`, `chunkIndex`, `<type>:<runKey>:<chunkIndex>` idempotency key, `fileHash`, and
`rowCount` (whole-file count). A chunk has at most 100 rows; a file at most 5,000.
An identical type/file hash under a different run key returns the original run ID.
A changed payload under a used key is rejected. The server hashes each chunk and its
source reference. Operational chunks fail as a unit and retain row errors in run history.

### Stock adjustment

`source_reference,line_key,adjustment_type,reason_code,product_code,location_code,stock_status,lot_number,quantity_delta,unit_cost_minor,note`

A nonzero signed delta is scaled by 1,000. Product, active location, policy, and existing
lot (when tracked) are resolved on the server; each location requires the request capability
and current organizational scope. One source reference/type/reason per chunk, unique line keys.
A successful commit creates **one submitted adjustment request**, not stock movement. A
separate authorized person uses `inventory.adjustments.decide` to approve/post, or reject;
requesters cannot approve themselves. `unit_cost_minor` must be empty:
`cost_override_not_allowed` rejects a populated cell. `adjustment_type` and `reason_code`
are provisionally required free text, uppercase-normalized and limited to 40 characters;
there is no approved catalog or threshold exemption. This policy needs client confirmation.
Preview returns each product/location/status/lot partition with separate positive/negative
base quantities, net delta, current eligible balance, projected balance, and request chunk
count. These figures are provisional until approval.

### Cycle count

`count_reference,location_code,product_code,stock_status,lot_number,counted_quantity,finding,note`

The reference must resolve an existing **cycle** session in `counting` state. Every expected
line must appear exactly once; missing/unknown/duplicate lines block submission. Counts are
nonnegative absolute base quantities, including zero. A session over 100 lines is rejected
atomically (`session_too_large`) rather than split. Preview never writes or reveals the
expected/variance in a blind count. Submission calls the inventory count workflow, posting
nothing; approval by a different authorized user invokes `approveAndPost`, which posts only
nonzero variance. A changed live balance since the frozen snapshot returns `stale_snapshot`
and requires a recount (no rebase or automatic correction). Only available-status cycle
snapshots are supported. Preview exposes counted quantities and row status to a blind
counter, never expected/variance before submission even for a non-creator with approval
capability. After submission a separate authorized approver reviews expected quantities
and variance in `inventory.counts.detail`. Count lines freeze the balance version and
latest movement ID at snapshot creation, so a
+5 then -5 posting still returns `stale_snapshot` even when the quantity is restored.
These policies and blind disclosure need client confirmation.
