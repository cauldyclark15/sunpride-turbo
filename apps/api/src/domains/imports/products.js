import { ORGANIZATION, cell, error } from "./format.js";

/** @param {any} db @param {import('./format.js').Row[]} rows */
export async function validateProducts(db, rows) {
  /** @type {import('./format.js').RowError[]} */
  const errors = [];
  /** @type {any[]} */
  const resolved = [];
  const codes = new Set(),
    barcodes = new Set();
  for (const row of rows) {
    const start = errors.length;
    const code = cell(row, "product_code").toUpperCase();
    const name = cell(row, "name"),
      category = cell(row, "category");
    const tracking = cell(row, "tracking_mode").toLowerCase();
    const allocation = cell(row, "allocation_policy").toLowerCase() || "fefo";
    const barcode = cell(row, "barcode");
    const fail = (
      /** @type {string} */ column,
      /** @type {string} */ message,
      code = "invalid_format",
    ) => errors.push(error(row.rowNumber, code, message, column));
    if (!/^[A-Z0-9][A-Z0-9-]{2,31}$/.test(code))
      fail(
        "product_code",
        "Use a product code of 3–32 letters, numbers or hyphens.",
      );
    if (codes.has(code))
      fail(
        "product_code",
        "This product appears twice in the file.",
        "duplicate_in_file",
      );
    codes.add(code);
    if (!name || name.length > 120)
      fail("name", "Enter a product name of up to 120 characters.");
    if (!category || category.length > 60)
      fail("category", "Enter a category of up to 60 characters.");
    if (!["none", "lot"].includes(tracking))
      fail("tracking_mode", "Choose none or lot for stock tracking.");
    if (!["fefo", "fifo", "explicit_only"].includes(allocation))
      fail("allocation_policy", "Choose fefo, fifo or explicit_only.");
    const base = cell(row, "base_uom").toUpperCase();
    const selling = [
      ...new Set([
        base,
        ...cell(row, "selling_uoms")
          .split(";")
          .map((x) => x.trim().toUpperCase())
          .filter(Boolean),
      ]),
    ];
    if (selling.length > 8)
      fail("selling_uoms", "Use at most eight selling units.");
    /** @type {any[]} */
    const units = [];
    for (const unit of selling) {
      const [found] =
        await db`select * from units_of_measure where organization_id=${ORGANIZATION} and code=${unit} and active and deleted_at is null`;
      if (!found)
        fail(
          "base_uom",
          `Unknown active unit: ${unit || "(empty)"}.`,
          "unknown_reference",
        );
      else units.push(found);
    }
    const [existing] = await db`select * from products where code=${code}`;
    // Reinterpreting retained stock with a different base unit would corrupt its meaning.
    if (
      existing &&
      (existing.base_uom_id !== units[0]?.id ||
        existing.tracking_mode !== tracking)
    ) {
      const [used] =
        await db`select 1 from inventory_movement_lines where product_id=${existing.id} limit 1`;
      if (used)
        fail(
          "base_uom",
          "A product with stock movements cannot change its base unit or tracking mode.",
          "policy_locked",
        );
    }
    if (barcode) {
      if (!/^\d{8,14}$/.test(barcode))
        fail("barcode", "Use an 8–14 digit barcode stored as text.");
      const [owner] =
        await db`select product_id from product_barcodes where organization_id=${ORGANIZATION} and barcode=${barcode} and active`;
      if (barcodes.has(barcode) || (owner && owner.product_id !== existing?.id))
        fail(
          "barcode",
          "This barcode already belongs to another product.",
          "barcode_conflict",
        );
      barcodes.add(barcode);
    }
    /** @type {Record<string,number|null>} */
    const integers = {};
    for (const key of [
      "shelf_life_days",
      "minimum_remaining_shelf_life_days",
    ]) {
      const raw = cell(row, key);
      integers[key] = raw ? Number(raw) : key === "shelf_life_days" ? null : 0;
      if (raw && (!/^\d+$/.test(raw) || Number(raw) > 3650))
        fail(key, "Use a whole number of days from 0 to 3,650.");
    }
    /** @type {Record<string,boolean>} */
    const booleans = {};
    for (const key of ["expiry_required", "manufacture_date_required"]) {
      const raw = cell(row, key).toLowerCase();
      if (
        raw &&
        !["y", "yes", "true", "1", "n", "no", "false", "0"].includes(raw)
      )
        fail(key, "Enter Y or N.");
      booleans[key] = raw
        ? ["y", "yes", "true", "1"].includes(raw)
        : tracking === "lot";
    }
    const external = cell(row, "external_id");
    if (external.length > 64) fail("external_id", "Use at most 64 characters.");
    if (errors.length === start)
      resolved.push({
        rowNumber: row.rowNumber,
        code,
        name,
        category,
        tracking,
        allocation,
        barcode,
        units,
        existing,
        integers,
        booleans,
        external,
      });
  }
  return { errors, resolved };
}

/** Catalog writes are the expressly permitted IMPORTS→ORG transaction exception.
 * Product inventory policy mirrors the historical product-import writer; never balances.
 * @param {any} db @param {any[]} rows */
export async function writeProducts(db, rows) {
  /** @type {string[]} */
  const ids = [];
  for (const r of rows) {
    const base = r.units[0];
    const scale = r.existing?.quantity_scale ?? 10 ** base.decimal_places;
    const [product] =
      await db`insert into products (code,name,category,uom,unit_price,active,external_id,organization_id,base_uom_id,quantity_scale,tracking_mode,allocation_policy,catalog_source,catalog_updated_at)
      values (${r.code},${r.name},${r.category},${base.code},0,true,${r.external || null},${ORGANIZATION},${base.id},${scale},${r.tracking},${r.allocation},'import',now())
      on conflict (code) do update set name=excluded.name, category=excluded.category, uom=excluded.uom, base_uom_id=excluded.base_uom_id, tracking_mode=excluded.tracking_mode, allocation_policy=excluded.allocation_policy, external_id=coalesce(excluded.external_id,products.external_id), catalog_source='import', catalog_updated_at=now() returning id`;
    ids.push(product.id);
    await db`update product_selling_uoms set deleted_at=now() where product_id=${product.id} and deleted_at is null`;
    for (let i = 0; i < r.units.length; i++)
      await db`insert into product_selling_uoms(product_id,ordinal,uom_id) values(${product.id},${i},${r.units[i].id}) on conflict(product_id,ordinal) do update set uom_id=excluded.uom_id,deleted_at=null`;
    if (r.barcode)
      await db`insert into product_barcodes(organization_id,product_id,barcode,uom_id,active,source) values(${ORGANIZATION},${product.id},${r.barcode},${base.id},true,'import') on conflict(organization_id,barcode) where active do update set uom_id=excluded.uom_id`;
    await db`insert into product_inventory_policies(organization_id,product_id,base_uom_id,quantity_scale,quantity_precision,tracking_mode,allocation_policy,allow_mixed_lots_per_line,allow_negative_stock,quality_release_required,shelf_life_days,expiry_date_required,manufacture_date_required,minimum_remaining_shelf_life_days,costing_method,version,active)
      values(${ORGANIZATION},${product.id},${base.id},${scale},${base.decimal_places},${r.tracking},${r.allocation},true,false,false,${r.integers.shelf_life_days},${r.booleans.expiry_required},${r.booleans.manufacture_date_required},${r.integers.minimum_remaining_shelf_life_days},'weighted_average',1,true)
      on conflict(organization_id,product_id) do update set base_uom_id=excluded.base_uom_id,tracking_mode=excluded.tracking_mode,allocation_policy=excluded.allocation_policy,shelf_life_days=coalesce(excluded.shelf_life_days,product_inventory_policies.shelf_life_days),expiry_date_required=excluded.expiry_date_required,manufacture_date_required=excluded.manufacture_date_required,minimum_remaining_shelf_life_days=excluded.minimum_remaining_shelf_life_days,version=product_inventory_policies.version+1`;
  }
  return ids;
}
