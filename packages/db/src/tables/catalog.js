// @ts-check
/**
 * Units of measure, products, customers, warehouses. Row shapes for migration 0102_catalog.sql.
 * Tables: units_of_measure, products, product_selling_uoms, customers, warehouses, uom_conversions, product_barcodes, sales_assignments.
 * Field names are camelCase versions of the snake_case columns. Instants are
 * Date (date columns too: UTC midnight of the Manila day), uuid/text are string, and
 * bigint/numeric come back as string from Bun.sql.
 */

export const UNITS_OF_MEASURE_DIMENSION = /** @type {const} */ ([
  "count",
  "mass",
  "volume",
  "length",
  "area",
]);
export const PRODUCT_TRACKING_MODE = /** @type {const} */ ([
  "none",
  "lot",
  "serial",
]);
export const PRODUCT_ALLOCATION_POLICY = /** @type {const} */ ([
  "fefo",
  "fifo",
  "explicit_only",
]);
export const UOM_CONVERSION_ROUNDING_MODE = /** @type {const} */ ([
  "exact",
  "half_up",
  "floor",
  "ceiling",
]);

/**
 * `units_of_measure`
 * @typedef {Object} UnitsOfMeasureRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} code
 * @property {string} name
 * @property {"count" | "mass" | "volume" | "length" | "area"} dimension
 * @property {number} decimalPlaces
 * @property {boolean} active
 * @property {string | null} externalCode
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `products`
 * @typedef {Object} ProductRow
 * @property {string} id
 * @property {string} code
 * @property {string} name
 * @property {string} category
 * @property {string} uom
 * @property {string} unitPrice
 * @property {boolean} active
 * @property {string | null} externalId
 * @property {string | null} organizationId
 * @property {string | null} baseUomId
 * @property {string | null} quantityScale
 * @property {"none" | "lot" | "serial" | null} trackingMode
 * @property {"fefo" | "fifo" | "explicit_only" | null} allocationPolicy
 * @property {number | null} policyVersion
 * @property {string | null} catalogSource
 * @property {Date | null} catalogUpdatedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `product_selling_uoms` (child of `products`)
 * @typedef {Object} ProductSellingUomRow
 * @property {string} id
 * @property {string} productId
 * @property {number} ordinal
 * @property {string} uomId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `customers`
 * @typedef {Object} CustomerRow
 * @property {string} id
 * @property {string} code
 * @property {string} name
 * @property {string} channel
 * @property {string} territory
 * @property {string} creditLimit
 * @property {boolean} active
 * @property {string | null} externalId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `warehouses`
 * @typedef {Object} WarehouseRow
 * @property {string} id
 * @property {string} code
 * @property {string} name
 * @property {string} location
 * @property {boolean} active
 * @property {string | null} externalId
 * @property {string | null} organizationId
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * `uom_conversions`
 * @typedef {Object} UomConversionRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string | null} productId
 * @property {string} fromUomId
 * @property {string} toUomId
 * @property {string} numerator
 * @property {string} denominator
 * @property {"exact" | "half_up" | "floor" | "ceiling"} roundingMode
 * @property {Date} effectiveFrom
 * @property {Date | null} effectiveTo
 * @property {boolean} active
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `product_barcodes`
 * @typedef {Object} ProductBarcodeRow
 * @property {string} id
 * @property {string} organizationId
 * @property {string} productId
 * @property {string} barcode
 * @property {string} uomId
 * @property {boolean} active
 * @property {string} source
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} deletedAt
 * @property {string} changeSeq
 */

/**
 * `sales_assignments`
 * @typedef {Object} SalesAssignmentRow
 * @property {string} id
 * @property {string} salespersonSubject
 * @property {string} customerCode
 * @property {string} territory
 * @property {boolean} active
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

export {};
