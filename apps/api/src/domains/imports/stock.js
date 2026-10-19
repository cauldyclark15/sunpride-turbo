import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import {
  ORGANIZATION,
  cell,
  error,
  quantity,
  dateOnly,
  countChunks,
} from "./format.js";

/** @param {any} ctx @param {any} location @param {string} capability */
export async function locationAccess(ctx, location, capability) {
  if (!location?.active || location.deleted_at)
    throw new ApiError(
      "unknown_reference",
      422,
      "Choose an active inventory location.",
    );
  if (!location.org_unit_id && ctx.actor?.role !== "super_admin")
    throw new ApiError(
      "scope_denied",
      403,
      "This location has no organizational owner.",
    );
  await requireCapability(ctx, capability, location.org_unit_id);
}
/** @param {any} ctx @param {string} kind @param {any} input */
export async function validateStock(ctx, kind, input) {
  const db = ctx.db;
  /** @type {import('./format.js').RowError[]} */
  const errors = [];
  /** @type {any[]} */
  const resolved = [];
  const seen = new Set();
  const capability =
    kind === "cycle_count"
      ? "inventory.count.submit"
      : kind === "stock_adjustment"
        ? "inventory.adjustment.request"
        : "inventory.write";
  const first = input.rows[0];
  const reference = cell(
    first,
    kind === "cycle_count" ? "count_reference" : "source_reference",
  );
  if (kind === "cycle_count") countChunks(input.rows);
  for (const row of input.rows) {
    const start = errors.length;
    const fail = (
      /** @type {string} */ column,
      /** @type {string} */ message,
      code = "invalid_format",
    ) => errors.push(error(row.rowNumber, code, message, column));
    const code = cell(row, "product_code").toUpperCase(),
      locationCode = cell(row, "location_code").toUpperCase();
    const [product] =
      await db`select * from products where code=${code} and organization_id=${ORGANIZATION} and active and deleted_at is null`;
    const [location] =
      await db`select * from inventory_locations where code=${locationCode} and organization_id=${ORGANIZATION}`;
    // Authorize before looking at stock, even on a replay.
    if (location) await locationAccess(ctx, location, capability);
    else
      fail(
        "location_code",
        "Unknown active inventory location.",
        "unknown_reference",
      );
    if (!product)
      fail("product_code", "Unknown active product.", "unknown_reference");
    const [policy] = product
      ? await db`select * from product_inventory_policies where organization_id=${ORGANIZATION} and product_id=${product.id} and active and deleted_at is null`
      : [];
    if (product && !policy)
      fail(
        "product_code",
        "Set up this product's inventory policy first.",
        "policy_missing",
      );
    const lotNumber = cell(row, "lot_number").toUpperCase();
    const [lot] =
      product && lotNumber
        ? await db`select * from inventory_lots where organization_id=${ORGANIZATION} and product_id=${product.id} and normalized_lot_number=${lotNumber}`
        : [];
    if (policy?.tracking_mode === "lot" && !lotNumber)
      fail("lot_number", "Enter the product's lot number.", "lot_required");
    if (policy?.tracking_mode === "none" && lotNumber)
      fail("lot_number", "This product does not use lots.");
    if (policy?.tracking_mode === "serial")
      fail("product_code", "Serial-tracked products cannot use this template.");
    if (lotNumber && !lot)
      fail(
        "lot_number",
        "Create the lot through Inventory before importing stock.",
        "unknown_reference",
      );
    const column =
      kind === "cycle_count"
        ? "counted_quantity"
        : kind === "stock_adjustment"
          ? "quantity_delta"
          : "quantity";
    const amount = policy
      ? quantity(cell(row, column), policy.quantity_scale)
      : null;
    if (
      amount === null ||
      (kind === "opening_stock" && amount <= 0) ||
      (kind === "cycle_count" && amount < 0) ||
      (kind === "stock_adjustment" && amount === 0)
    )
      fail(
        column,
        kind === "stock_adjustment"
          ? "Enter a nonzero stock change in the product's base unit."
          : "Enter a valid quantity in the product's base unit.",
      );
    const status =
      kind === "opening_stock"
        ? "available"
        : cell(row, "stock_status").toLowerCase();
    if (
      ![
        "available",
        "quality_hold",
        "quarantine",
        "damaged",
        "expired",
        "rejected",
        "wip",
        "in_transit",
      ].includes(status)
    )
      fail(
        "stock_status",
        "Choose a stock status from the template instructions.",
      );
    const rowReference = cell(
      row,
      kind === "cycle_count" ? "count_reference" : "source_reference",
    );
    if (
      !rowReference ||
      (kind !== "cycle_count" && rowReference !== reference) ||
      (kind === "opening_stock" && input.sourceReference !== rowReference)
    )
      fail(
        "source_reference",
        "Use the same source reference on every row and on the import form.",
      );
    const key =
      kind === "stock_adjustment"
        ? `${rowReference}:${cell(row, "line_key")}`
        : `${rowReference}:${product?.id}:${location?.id}:${lotNumber}:${kind === "opening_stock" ? "" : status}`;
    if (seen.has(key))
      fail(
        "product_code",
        "This stock line appears twice in the file.",
        "duplicate_in_file",
      );
    seen.add(key);
    if (kind === "stock_adjustment") {
      for (const key of ["line_key", "adjustment_type", "reason_code"])
        if (!cell(row, key))
          fail(key, "This field is required.", "required_missing");
      for (const key of ["adjustment_type", "reason_code"])
        if (cell(row, key).toUpperCase() !== cell(first, key).toUpperCase())
          fail(key, "Use one adjustment type and reason per file.");
      if (cell(row, "unit_cost_minor"))
        fail(
          "unit_cost_minor",
          "Cost overrides are not allowed in adjustment imports.",
          "cost_override_not_allowed",
        );
    }
    if (kind === "opening_stock" && product && location) {
      const balances = lot
        ? await db`select physical_base from inventory_lot_balances where organization_id=${ORGANIZATION} and lot_id=${lot.id} and location_id=${location.id}`
        : await db`select physical_base from inventory_balances where organization_id=${ORGANIZATION} and product_id=${product.id} and location_id=${location.id}`;
      if (
        balances.some(
          (/** @type {any} */ b) => BigInt(b.physical_base ?? 0) !== 0n,
        )
      )
        fail(
          "product_code",
          "Opening stock already exists here. Correct it with a stock count.",
          "duplicate_stock",
        );
      // The frozen postMovement seam cannot carry cost or create lot metadata. Refuse, never silently drop them.
      if (cell(row, "unit_cost_minor"))
        fail(
          "unit_cost_minor",
          "Costed opening stock needs the inventory posting contract extension.",
          "posting_contract_required",
        );
      for (const key of ["manufactured_at", "expires_at"]) {
        const raw = cell(row, key);
        if (raw && !dateOnly(raw))
          fail(key, "Enter a real date as YYYY-MM-DD.");
        if (
          raw &&
          (!lot?.[key] || new Date(lot[key]).toISOString().slice(0, 10) !== raw)
        )
          fail(key, "This date must match the existing inventory lot.");
      }
      if (policy?.expiry_date_required && !lot?.expires_at)
        fail("expires_at", "The inventory lot needs an expiry date.");
      if (policy?.manufacture_date_required && !lot?.manufactured_at)
        fail("manufactured_at", "The inventory lot needs a manufacture date.");
    }
    if (errors.length === start)
      resolved.push({
        rowNumber: row.rowNumber,
        product,
        location,
        policy,
        lot,
        quantityBase: amount,
        stockStatus: status,
        reference: rowReference,
      });
  }
  if (kind === "cycle_count") {
    for (const group of countChunks(input.rows)) {
      const ref = cell(group[0], "count_reference");
      const [session] =
        await db`select * from stock_count_sessions where organization_id=${ORGANIZATION} and count_number=${ref}`;
      if (!session) {
        errors.push(
          error(
            group[0].rowNumber,
            "unknown_reference",
            "Unknown count session.",
            "count_reference",
          ),
        );
        continue;
      }
      const [location] =
        await db`select * from inventory_locations where id=${session.location_id}`;
      await locationAccess(ctx, location, capability);
      if (session.count_type !== "cycle" || session.status !== "counting")
        errors.push(
          error(
            group[0].rowNumber,
            "count_not_open",
            "This cycle count is not open for counting.",
          ),
        );
      const expected =
        await db`select * from stock_count_lines where session_id=${session.id}`;
      const lines = resolved.filter((r) => r.reference === ref);
      if (
        expected.length > 100 ||
        expected.length !== group.length ||
        expected.some(
          (/** @type {any} */ e) =>
            !lines.some(
              (r) =>
                r.product.id === e.product_id &&
                r.location.id === session.location_id &&
                (r.lot?.id ?? null) === (e.lot_id ?? null) &&
                r.stockStatus === e.stock_status,
            ),
        )
      )
        errors.push(
          error(
            group[0].rowNumber,
            "count_incomplete",
            "Include every expected line of one count session; never split it.",
          ),
        );
      for (const e of expected) {
        const [balance] = e.lot_id
          ? await db`select version,last_movement_id,physical_base as current_base from inventory_lot_balances where organization_id=${ORGANIZATION} and lot_id=${e.lot_id} and location_id=${session.location_id} and stock_status=${e.stock_status}`
          : await db`select version,last_movement_id,available_stock_base as current_base from inventory_balances where organization_id=${ORGANIZATION} and product_id=${e.product_id} and location_id=${session.location_id}`;
        if (
          BigInt(e.system_base) !== BigInt(balance?.current_base ?? 0) ||
          e.snapshot_balance_version == null ||
          e.snapshot_balance_version !== (balance?.version ?? 0) ||
          (e.snapshot_movement_id ?? null) !==
            (balance?.last_movement_id ?? null)
        )
          errors.push(
            error(
              group[0].rowNumber,
              "stale_snapshot",
              "Stock changed after the count snapshot. Recount before submitting.",
            ),
          );
      }
    }
  }
  return { errors, resolved };
}
