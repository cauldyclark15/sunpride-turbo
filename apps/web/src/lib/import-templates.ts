export const IMPORT_CHUNK_ROWS = 100;

export type ImportKind = "products" | "opening_stock";

export const PRODUCT_MASTER_HEADERS = [
  "product_code",
  "name",
  "category",
  "base_uom",
  "selling_uoms",
  "barcode",
  "tracking_mode",
  "allocation_policy",
  "shelf_life_days",
  "expiry_required",
  "manufacture_date_required",
  "minimum_remaining_shelf_life_days",
  "external_id",
];

export const OPENING_STOCK_HEADERS = [
  "product_code",
  "location_code",
  "lot_number",
  "manufactured_at",
  "expires_at",
  "quantity",
  "unit_cost_minor",
  "source_reference",
];

export const IMPORT_TEMPLATES: Record<
  ImportKind,
  {
    label: string;
    description: string;
    templatePath: string;
    templateFileName: string;
    headers: string[];
    /** Opening stock rejects the whole chunk when any row is invalid. */
    allOrNothing: boolean;
  }
> = {
  products: {
    label: "Product master",
    description:
      "Create or update products, their inventory policy, allowed selling units, and barcodes. Valid rows import even when other rows are rejected.",
    templatePath: "/templates/product-master.csv",
    templateFileName: "product-master.csv",
    headers: PRODUCT_MASTER_HEADERS,
    allOrNothing: false,
  },
  opening_stock: {
    label: "Opening stock",
    description:
      "Post approved opening quantities with their lots, dates, and unit costs as one movement per 100-row chunk. Any invalid row rejects the whole chunk.",
    templatePath: "/templates/opening-stock.csv",
    templateFileName: "opening-stock.csv",
    headers: OPENING_STOCK_HEADERS,
    allOrNothing: true,
  },
};

/**
 * Idempotency key per chunk. The server treats it as an opaque unique string, so this only
 * has to be stable and unique — the shape matches `chunkKey` in convex/imports/shared.ts
 * to keep the two readable side by side.
 */
export function chunkKeyFor(
  kind: ImportKind,
  runKey: string,
  chunkIndex: number,
): string {
  return `${kind}:${runKey}:${chunkIndex}`;
}

export function chunkRows<T>(rows: T[], size = IMPORT_CHUNK_ROWS): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size)
    chunks.push(rows.slice(index, index + size));
  return chunks;
}
