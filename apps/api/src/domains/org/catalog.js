import {
  requireCapability,
  requireNationalScope,
} from "../../core/capabilities.js";
import {
  dto,
  get,
  history,
  insert,
  instant,
  integer,
  ms,
  overlaps,
  replaceInterval,
  required,
  rule,
  update,
  uuid,
  code,
} from "./model.js";

/** @typedef {import('./model.js').Ctx} Ctx */
/** @typedef {import('./model.js').Row} Row */
/** @param {Ctx} c @param {string} action @param {Row} b */
export async function catalogCommand(c, action, b) {
  const actor = await requireCapability(c, "masterdata.manage");
  // These are national masters. A scoped operations actor must not modify other regions' catalog.
  await requireNationalScope(c, ["admin", "operations"]);
  required(b.reason, "Reason");
  if (
    c.env.SAP_MODE != null &&
    [
      "saveProduct",
      "saveUom",
      "saveCustomer",
      "saveBarcode",
      "saveConversion",
    ].includes(action)
  )
    rule("SAP owns these master fields; correct the record in SAP");
  if (action === "saveUom") {
    if (!["count", "mass", "volume", "length", "area"].includes(b.dimension))
      rule("Invalid dimension");
    integer(b.decimalPlaces, 0, 6);
    if (b.uomId) {
      const row = await get(c.db, "units_of_measure", uuid(b.uomId));
      if (
        row.dimension !== b.dimension ||
        row.decimal_places !== b.decimalPlaces
      ) {
        const used =
          await c.db`select id from products where base_uom_id=${row.id} union all select id from uom_conversions where from_uom_id=${row.id} or to_uom_id=${row.id} limit 1`;
        if (used.length)
          rule("A used unit cannot change dimension or precision");
      }
      await update(c.db, "units_of_measure", row.id, {
        name: required(b.name, "Unit name", 100),
        active: b.active !== false,
        dimension: b.dimension,
        decimal_places: b.decimalPlaces,
      });
      return row.id;
    }
    return (
      await insert(c.db, "units_of_measure", {
        organization_id: "sunpride",
        code: code(b.code),
        name: required(b.name, "Unit name", 100),
        dimension: b.dimension,
        decimal_places: b.decimalPlaces,
        active: true,
      })
    ).id;
  }
  if (action === "saveProduct") {
    const existing = b.productId
      ? await get(c.db, "products", uuid(b.productId))
      : null;
    if (existing?.sap_key)
      rule("SAP owns this material; correct the source record in SAP");
    const base = await get(c.db, "units_of_measure", uuid(b.baseUomId));
    if (!base.active) rule("Inactive base unit");
    const scale = integer(
      b.quantityScale ?? Math.pow(10, base.decimal_places),
      1,
    );
    const tracking = b.trackingMode ?? existing?.tracking_mode ?? "none",
      allocation = b.allocationPolicy ?? existing?.allocation_policy ?? "fifo";
    if (
      !["none", "lot", "serial"].includes(tracking) ||
      !["fefo", "fifo", "explicit_only"].includes(allocation)
    )
      rule("Invalid stock policy");
    const values = {
      name: required(b.name, "Name", 200),
      category: required(b.category, "Category", 100),
      base_uom_id: base.id,
      uom: base.code,
      quantity_scale: scale,
      active: b.active !== false,
      tracking_mode: tracking,
      allocation_policy: allocation,
      catalog_updated_at: new Date(c.now),
      catalog_source: "office",
    };
    let product;
    if (b.productId) {
      product = await get(c.db, "products", uuid(b.productId));
      if (
        product.base_uom_id !== base.id ||
        Number(product.quantity_scale) !== scale ||
        product.tracking_mode !== values.tracking_mode
      ) {
        const used =
          await c.db`select id from inventory_movement_lines where product_id=${product.id} limit 1`;
        if (used.length)
          rule("Posted product units and tracking are immutable");
      }
      await update(c.db, "products", product.id, values);
    } else
      product = await insert(c.db, "products", {
        ...values,
        code: code(b.code),
        organization_id: "sunpride",
        unit_price: 0,
        policy_version: 1,
      });
    if (b.sellingUomIds !== undefined) {
      if (
        !Array.isArray(b.sellingUomIds) ||
        b.sellingUomIds.length > 20 ||
        new Set(b.sellingUomIds).size !== b.sellingUomIds.length
      )
        rule("Choose up to 20 distinct selling units");
      await c.db`delete from product_selling_uoms where product_id=${product.id}`;
      for (const [ordinal, id] of b.sellingUomIds.entries()) {
        const selling = await get(c.db, "units_of_measure", uuid(id));
        if (!selling.active || selling.dimension !== base.dimension)
          rule("Incompatible selling unit");
        await c.db`insert into product_selling_uoms(product_id,ordinal,uom_id) values(${product.id},${ordinal},${id})`;
      }
    }
    return product.id;
  }
  if (action === "saveCustomer") {
    const values = {
      name: required(b.name, "Name", 200),
      channel: required(b.channel, "Channel", 100),
      territory: required(b.territory, "Territory", 100),
      credit_limit: integer(b.creditLimitCentavos, 0, 10 ** 14 - 1) / 100,
      active: b.active !== false,
    };
    if (b.customerId) {
      await update(c.db, "customers", uuid(b.customerId), values);
      return b.customerId;
    }
    return (await insert(c.db, "customers", { ...values, code: code(b.code) }))
      .id;
  }
  const product = await get(c.db, "products", uuid(b.productId));
  if (!product.active) rule("Inactive product");
  if (product.sap_key)
    rule(
      "SAP owns this material's units and barcodes; correct the source record in SAP",
    );
  if (action === "saveBarcode") {
    const barcode = required(b.barcode, "Barcode", 100);
    if (!/^[A-Za-z0-9-]+$/.test(barcode))
      rule("Barcode must be text without spaces");
    const uom = await get(c.db, "units_of_measure", uuid(b.uomId));
    if (!uom.active) rule("Inactive unit");
    if (uom.id !== product.base_uom_id) {
      const selling =
        await c.db`select id from product_selling_uoms where product_id=${product.id} and uom_id=${uom.id} and deleted_at is null`;
      if (!selling.length) rule("Barcode unit is not a selling unit");
    }
    const [existing] =
      await c.db`select * from product_barcodes where barcode=${barcode} and organization_id='sunpride' and active`;
    if (existing && existing.product_id !== product.id)
      rule("Barcode already belongs to another product");
    if (existing) {
      await update(c.db, "product_barcodes", existing.id, {
        active: b.active !== false,
        uom_id: uom.id,
      });
      return existing.id;
    }
    return (
      await insert(c.db, "product_barcodes", {
        organization_id: "sunpride",
        product_id: product.id,
        barcode,
        uom_id: uom.id,
        active: true,
        source: "office",
      })
    ).id;
  }
  if (action === "saveConversion") {
    const from = await get(c.db, "units_of_measure", uuid(b.fromUomId)),
      to = await get(c.db, "units_of_measure", uuid(b.toUomId));
    if (
      !from.active ||
      !to.active ||
      from.dimension !== to.dimension ||
      from.id === to.id
    )
      rule("Conversion units must be distinct, active and compatible");
    integer(b.numerator, 1);
    integer(b.denominator, 1);
    if (
      !["exact", "half_up", "floor", "ceiling"].includes(
        b.roundingMode ?? "exact",
      )
    )
      rule("Invalid rounding mode");
    const at = b.effectiveFrom;
    instant(at, c.now);
    if (b.effectiveTo !== undefined && b.effectiveTo <= at)
      rule("Invalid effective interval");
    /** @type {Row[]} */ const rows =
      await c.db`select * from uom_conversions where product_id=${product.id} and from_uom_id=${from.id} and to_uom_id=${to.id} and deleted_at is null and active`;
    if (rows.some((r) => overlaps(r, at)))
      rule("Overlapping conversion", "overlap");
    return (
      await insert(c.db, "uom_conversions", {
        organization_id: "sunpride",
        product_id: product.id,
        from_uom_id: from.id,
        to_uom_id: to.id,
        numerator: b.numerator,
        denominator: b.denominator,
        rounding_mode: b.roundingMode ?? "exact",
        effective_from: instant(at),
        effective_to: b.effectiveTo == null ? null : instant(b.effectiveTo),
        active: true,
      })
    ).id;
  }
  rule("Unknown catalog command");
}

/** Exact rational conversion. Quantities and factors never use floating point. @param {bigint} amount @param {{numerator:bigint|string|number,denominator:bigint|string|number,rounding_mode:string}} conversion */
export function convertQuantity(amount, conversion) {
  const numerator = BigInt(conversion.numerator),
    denominator = BigInt(conversion.denominator);
  if (numerator <= 0n || denominator <= 0n || amount < 0n)
    rule("Invalid conversion");
  const raw = amount * numerator,
    whole = raw / denominator,
    remainder = raw % denominator;
  if (!remainder) return whole;
  if (conversion.rounding_mode === "exact")
    rule("Quantity cannot be converted exactly");
  if (conversion.rounding_mode === "ceiling") return whole + 1n;
  if (conversion.rounding_mode === "half_up")
    return whole + (remainder * 2n >= denominator ? 1n : 0n);
  return whole;
}
