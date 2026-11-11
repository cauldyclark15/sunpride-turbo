# Master data and opening stock imports

Two controlled CSV operations put Sunpride's real data into Bun API. Both validate on the
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

## Customers upload — SP-0170 (machinery from SP-0169)

Where: **Customers (Stores page) → Upload customers**, or **Imports → Customers**. Same
component in both places. Needs `masterdata.manage` and `outlet.manage` (super admin, admin,
operations). A user scoped to an area can only update customers in the areas they manage; new
customers land in the uploader's own area.

**Template = Sunpride's own "Customer Information template"** (Loren Muñoz, 2026-11-10): one row
per customer, **Customer Code** + the client's 51 fields in their order with their exact labels
(General Information, Location, Assignment, Payment, Delivery with the first ship-to inline, ADP
Specific last). Single source: `packages/import-templates/src/customers.js` (columns, header
mapping, readers, rules) and `customers-xlsx.js` (the workbook). Tests prove parity with the
client's workbook (`docs/requirements/client-customer-information-template-2026-11-10.xlsx`:
field order, labels, required flags, remarks, tab names and list contents).

- **Download template (Excel)** — built in the browser from `GET /api/v1/imports/customer-upload/template`
  (the DB's `customer_reference_values`): an *Instructions* sheet, the *Customers* sheet (required
  headings yellow + bold; each heading's comment = the rule + Sunpride's remark; every cell text
  formatted; in-cell dropdowns on list columns) and one sheet per client list with the client's
  tab names (Cust. Grp. 1&2, Sales Organization, Customer Groups, Distribution Channel, Type of
  Business, Sales Office, List of Agents, Delivering Plant, Payment Terms, Tax Class, Pricing
  Procedure). Dependent lists are plain lists in Excel; the upload enforces the chain. Sales
  Partner has no dropdown while "List of Agents" is empty. **CSV version**: the header line.
- Client-ready file: `DATABASE_URL=… bun apps/api/scripts/build-customer-template.js <out.xlsx>`.

| Cells | Rule |
| --- | --- |
| Customer Code* | Up to 40 letters, numbers, `-`, `_`; stored upper-case; unique in the file. An existing code **updates** that customer (preview shows *New* / *Update*). |
| Dropdown columns | `Description (Code)`, the code alone or the description alone; case/accents ignored; numbers that lost leading zeros in Excel still match (`3` → `0003`). Dependent lists checked against the Sales Organization / channel / Grp 1. |
| Region, Province, Municipality, Barangay | PSGC name (case/accent-insensitive; `City of Cebu` = `Cebu City`; `Region VII (Central Visayas)` = `Central Visayas`) or the 10-digit PSGC code. Postal Code must be one of the municipality's ZIP codes. |
| Geographical Coordinates | `latitude, longitude`; saved as a **pending** pin (two-person verification). |
| Mobile No. (both) | `09…` / `+639…` (an Excel number `9171234567` is read as `09171234567`). |
| Everything else | The `@sunpride/customer-master` rules at the `complete` level: Grp 1/Grp 2 only when the chain has them, ADP block only for channel 40, TIN, email, credit limit. |

Blank optional cells on an **update** keep the customer's current values; the row's ship-to
replaces the first ship-to (blank cells keep its values), further ship-tos stay. New customers
are created through the customer writer as `prospect` and, when the uploader may approve
(`outlet.enrol.approve`), approved to `active` in the same row.

### Steps

1. **Upload file** — download the template, choose an .xlsx (sheet "Customers", else the first
   sheet with "Customer Code") or .csv. Headers must match by name (order may differ); missing and
   unknown columns are listed.
2. **Validate** — instant browser checks with the shared rules and the reference lists, then
   server checks in batches of 1,000 rows with a progress bar (PSGC geography, existing customers,
   scope, inactive customers).
3. **Preview** — bad cells outlined with the message on hover and under the row; *Show only rows
   with problems* (also narrows to the columns with problems); **Download errors**
   (`Row,Column,Value,Problem,Code` with the client's labels). Fix the file and choose it again,
   or import the valid rows (rows with problems are recorded as failed).
4. **Import** — returns a run id at once; the server processes the file in the background. The
   page polls live counts. The browser can be closed.
5. **Result** — totals, **Download report** (template columns + Result, Action, Problem column,
   Problem), **Resume** and **Retry failed rows**.

**Upload history** lists every run (when, who, file, rows, new, updated, failed, status); *Open*
drills into the per-row report.

### How the server runs it

- Tables `customer_upload_runs`, `customer_upload_chunks`, `customer_upload_rows` (migration 0825;
  renumbered from SP-0169's 0816 to run after the customer master migrations 0820–0824).
- Chunks of 100 rows, at most 4 concurrent workers. Each chunk is **one transaction** (its clock
  is the transaction's, so effective-dated links agree with readers); each row a savepoint.
- Every chunk re-validates its rows against the database as it is at that moment, then writes
  through the customer-master writer (`saveCustomer`: store + profile + ship-to + pending pin +
  1:1 accounting customer, audit) and `approveCustomer`, with an audit row
  (`SP-0170.customer.upload_new|update`) and a change-feed entry per customer.
- **Idempotency**: server-computed file hash + per-chunk hash; the identical file again returns
  the existing run (`duplicate: true`) and writes nothing.
- **Interruption**: 30 s lease renewed every 5 s; expired runs are swept to `interrupted`.
  **Resume** processes only pending rows; **Retry failed rows** re-queues failed rows (e.g. after
  a reference list is fixed).
- API: `POST /api/v1/imports/customer-upload/preview`, `POST …/runs`, `GET …/runs`,
  `GET …/runs/:id[?rows=0]`, `POST …/runs/:id/resume {retryFailed}`, `GET …/template`,
  `GET …/reference`. Preview and runs accept up to 8 MB of JSON (5,000 rows); other routes 1 MB.

### Error codes (customer upload)

File: `header_mismatch`, `empty_file`, `too_many_rows`, `unreadable_file`. Row: the
customer-master codes (`required`, `invalid_option`, `not_for_sales_org`, `not_for_channel`,
`not_for_group1`, `not_applicable`, `choose_parent_first`, `invalid_tin`, `invalid_mobile`,
`invalid_email`, `invalid_coordinates`, `invalid_credit_limit`, `geography_mismatch`,
`postal_code_mismatch`, `too_long`) plus `invalid_code`, `duplicate_in_file`, `ambiguous_option`,
`customer_out_of_scope`, `customer_inactive`, `conflict`, `write_failed`, `forbidden`, and
`not_processed` in the report for rows an interrupted run never reached.

## Cutover sequence

1. Provision the inventory foundation (Web → Inventory → **Provision inventory foundation**).
Use the current API/admin workflow; the retired cloud command is not available.
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
