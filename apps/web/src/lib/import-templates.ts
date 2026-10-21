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
      "Create or update products, their inventory policy, selling units, and barcodes. Fix every rejected row before loading a 100-row chunk.",
    templatePath: "/templates/product-master.csv",
    templateFileName: "product-master.csv",
    headers: PRODUCT_MASTER_HEADERS,
    allOrNothing: true,
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
 * has to be stable and unique — the run and chunk identity is checked by the API import domain
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
  if (!Number.isSafeInteger(size) || size < 1)
    throw new Error("Chunk size must be positive.");
  for (let index = 0; index < rows.length; index += size)
    chunks.push(rows.slice(index, index + size));
  return chunks;
}

export const PRICE_HEADERS = ["product_code", "uom", "unit_price_centavos"];
export const TARGET_HEADERS = ["level", "key", "amount_centavos"];
export type BusinessImport = "prices" | "targets";
type Row = { rowNumber: number; values: Record<string, string> };

/** One complete session per chunk, including nonadjacent lines in the file. */
export function countSessionChunks(rows: Row[]): Row[][] {
  const sessions = new Map<string, Row[]>();
  for (const row of rows) {
    const reference = row.values.count_reference?.trim();
    if (!reference)
      throw new Error(`Row ${row.rowNumber}: enter a count reference.`);
    const session = sessions.get(reference) ?? [];
    session.push(row);
    if (session.length > 100)
      throw new Error(
        `Count ${reference} exceeds 100 lines. A count cannot be split.`,
      );
    sessions.set(reference, session);
  }
  return [...sessions.values()];
}

export function businessPayload(
  kind: BusinessImport,
  rows: Row[],
  fields: {
    month: string;
    priceListCode: string;
    channelKey: string;
    effectiveFrom: string;
  },
) {
  const errors: { rowNumber: number; code: string; message: string }[] = [];
  const fail = (rowNumber: number, message: string) =>
    errors.push({ rowNumber, code: "invalid_format", message });
  if (!rows.length || rows.length > 5000)
    fail(1, "Choose a file with 1–5,000 rows.");
  if (kind === "targets" && !/^\d{4}-(0[1-9]|1[0-2])$/.test(fields.month))
    fail(1, "Choose a target month.");
  const instant = new Date(`${fields.effectiveFrom}T00:00:00+08:00`).getTime();
  if (kind === "prices") {
    if (!fields.priceListCode.trim() || !fields.channelKey.trim())
      fail(1, "Enter a price-list code and channel.");
    const utc = new Date(`${fields.effectiveFrom}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(fields.effectiveFrom) ||
      !Number.isFinite(instant) ||
      !Number.isFinite(utc.getTime()) ||
      utc.toISOString().slice(0, 10) !== fields.effectiveFrom
    )
      fail(1, "Choose a valid price effective date.");
  }
  const seen = new Set<string>();
  const values = rows.map((row) => {
    const value = row.values;
    const amount =
      value[kind === "prices" ? "unit_price_centavos" : "amount_centavos"] ??
      "";
    if (!/^\d+$/.test(amount) || !Number.isSafeInteger(Number(amount)))
      fail(
        row.rowNumber,
        "Enter a nonnegative whole number of centavos (₱1 = 100 centavos).",
      );
    const key =
      kind === "prices"
        ? `${value.product_code}:${value.uom}`
        : `${value.level}:${value.key}`;
    if (seen.has(key))
      fail(row.rowNumber, "This product/unit or target appears twice.");
    seen.add(key);
    if (kind === "prices") {
      if (!value.product_code?.trim() || !value.uom?.trim())
        fail(row.rowNumber, "Enter the product code and unit of measure.");
      return {
        productCode: value.product_code?.trim(),
        uom: value.uom?.trim(),
        unitPriceCentavos: Number(amount),
      };
    }
    if (
      !["company", "channel", "territory", "agent"].includes(
        value.level ?? "",
      ) ||
      !value.key?.trim()
    )
      fail(
        row.rowNumber,
        "Choose company, channel, territory or agent, and enter its key.",
      );
    return {
      level: value.level,
      key: value.key?.trim(),
      amountCentavos: Number(amount),
    };
  });
  return {
    errors,
    body:
      kind === "prices"
        ? {
            priceListCode: fields.priceListCode.trim(),
            channelKey: fields.channelKey.trim(),
            effectiveFrom: instant,
            rows: values,
          }
        : { month: fields.month, rows: values },
  };
}
