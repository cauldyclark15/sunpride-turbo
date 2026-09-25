import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import {
  DEFAULT_QUANTITY_SCALE,
  parseQuantity,
  SUNPRIDE_ORGANIZATION_ID,
} from "../inventory/constants";
import { requestAdjustment } from "../inventory/adjustments";
import { requireLocationCapability } from "../inventory/location_scope";
import { requireCapability } from "../lib/capabilities";
import type { StockStatus } from "../inventory/validators";
import {
  cell,
  ERROR_CODES,
  importRowValidator,
  MAX_IMPORT_ERRORS,
  MAX_IMPORT_ROWS,
  normalizeCode,
  requiredCell,
  rowError,
  rowErrorValidator,
  type ImportRow,
  type RowError,
} from "./shared";
import {
  duplicateResult,
  record,
  replay,
  validateHeader,
  type OperationalArgs,
} from "./operational";

export const HEADER =
  "source_reference,line_key,adjustment_type,reason_code,product_code,location_code,stock_status,lot_number,quantity_delta,unit_cost_minor,note";
const STATUSES = new Set([
  "available",
  "quality_hold",
  "quarantine",
  "damaged",
  "expired",
  "rejected",
  "wip",
  "in_transit",
]);
type Line = {
  rowNumber: number;
  productId: Id<"products">;
  locationId: Id<"inventoryLocations">;
  lotId?: Id<"inventoryLots">;
  stockStatus: StockStatus;
  varianceBase: bigint;
};

async function validate(ctx: QueryCtx | MutationCtx, rows: ImportRow[]) {
  const errors: RowError[] = [],
    lines: Line[] = [],
    locations = new Set<Id<"inventoryLocations">>();
  const seen = new Set<string>();
  let source = "",
    type = "",
    reason = "";
  if (rows.length > MAX_IMPORT_ROWS)
    errors.push(
      rowError(
        rows[0]?.rowNumber ?? 1,
        ERROR_CODES.tooManyRows,
        "File exceeds 5000 rows",
      ),
    );
  for (const row of rows.slice(0, MAX_IMPORT_ROWS)) {
    const e: RowError[] = [];
    for (const name of [
      "source_reference",
      "line_key",
      "adjustment_type",
      "reason_code",
      "product_code",
      "location_code",
      "stock_status",
      "quantity_delta",
    ])
      requiredCell(row, name, e);
    const ref = cell(row, "source_reference"),
      key = cell(row, "line_key");
    if (ref && !source) source = ref;
    if (ref && source !== ref)
      e.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.invalidFormat,
          "Mixed source references",
          "source_reference",
        ),
      );
    const stableKey = `${ref}:${key}`;
    if (ref && key) {
      if (seen.has(stableKey))
        e.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.duplicateInFile,
            "Duplicate source line",
            "line_key",
          ),
        );
      seen.add(stableKey);
    }
    const a = normalizeCode(cell(row, "adjustment_type")),
      r = normalizeCode(cell(row, "reason_code"));
    for (const [value, column] of [
      [a, "adjustment_type"],
      [r, "reason_code"],
    ] as const)
      if (value.length > 40)
        e.push(
          rowError(
            row.rowNumber,
            "invalid_reason",
            `${column} exceeds 40 characters`,
            column,
          ),
        );
    if (a && !type) type = a;
    if (r && !reason) reason = r;
    if (a && a !== type)
      e.push(
        rowError(
          row.rowNumber,
          "invalid_reason",
          "Mixed adjustment types",
          "adjustment_type",
        ),
      );
    if (r && r !== reason)
      e.push(
        rowError(
          row.rowNumber,
          "invalid_reason",
          "Mixed reason codes",
          "reason_code",
        ),
      );
    if (cell(row, "unit_cost_minor"))
      e.push(
        rowError(
          row.rowNumber,
          "cost_override_not_allowed",
          "CSV cost override is not allowed",
          "unit_cost_minor",
        ),
      );
    const code = normalizeCode(cell(row, "product_code"));
    const product = code
      ? await ctx.db
          .query("products")
          .withIndex("by_code", (q) => q.eq("code", code))
          .unique()
      : null;
    if (code && (!product || !product.active))
      e.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.unknownReference,
          "Unknown active product",
          "product_code",
        ),
      );
    const policy = product
      ? await ctx.db
          .query("productInventoryPolicies")
          .withIndex("by_organizationId_and_productId", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("productId", product._id),
          )
          .unique()
      : null;
    if (product && (!policy || !policy.active))
      e.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.policyMissing,
          "Product inventory policy missing",
          "product_code",
        ),
      );
    const locationCode = normalizeCode(cell(row, "location_code"));
    const location = locationCode
      ? await ctx.db
          .query("inventoryLocations")
          .withIndex("by_organizationId_and_code", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("code", locationCode),
          )
          .unique()
      : null;
    if (locationCode && (!location || !location.active))
      e.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.unknownReference,
          "Unknown active location",
          "location_code",
        ),
      );
    if (location?.active) {
      locations.add(location._id);
      try {
        await requireLocationCapability(
          ctx,
          "inventory.adjustment.request",
          location._id,
        );
      } catch {
        e.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.scopeDenied,
            "Location outside request scope",
            "location_code",
          ),
        );
      }
    }
    const status = cell(row, "stock_status").toLowerCase();
    if (status && !STATUSES.has(status))
      e.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.invalidFormat,
          "Invalid stock status",
          "stock_status",
        ),
      );
    let delta = 0n;
    if (cell(row, "quantity_delta")) {
      try {
        delta = parseQuantity(
          cell(row, "quantity_delta").replace(/^\+/, ""),
          DEFAULT_QUANTITY_SCALE,
        );
      } catch {
        e.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.invalidFormat,
            "Invalid signed base quantity",
            "quantity_delta",
          ),
        );
      }
      if (delta === 0n && !e.some((x) => x.column === "quantity_delta"))
        e.push(
          rowError(
            row.rowNumber,
            "zero_delta",
            "Delta must be nonzero",
            "quantity_delta",
          ),
        );
    }
    const lotNumber = normalizeCode(cell(row, "lot_number"));
    if (policy?.trackingMode === "lot" && !lotNumber)
      e.push(
        rowError(row.rowNumber, "lot_required", "Lot required", "lot_number"),
      );
    if (policy && policy.trackingMode !== "lot" && lotNumber)
      e.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.invalidFormat,
          "Lot not allowed for untracked product",
          "lot_number",
        ),
      );
    const lot =
      product && lotNumber
        ? await ctx.db
            .query("inventoryLots")
            .withIndex(
              "by_organizationId_and_productId_and_normalizedLotNumber",
              (q) =>
                q
                  .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
                  .eq("productId", product._id)
                  .eq("normalizedLotNumber", lotNumber),
            )
            .unique()
        : null;
    if (lotNumber && !lot)
      e.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.unknownReference,
          "Unknown product lot",
          "lot_number",
        ),
      );
    if (e.length) {
      errors.push(...e);
      continue;
    }
    if (product && location && policy && status)
      lines.push({
        rowNumber: row.rowNumber,
        productId: product._id,
        locationId: location._id,
        ...(lot ? { lotId: lot._id } : {}),
        stockStatus: status as StockStatus,
        varianceBase: delta,
      });
  }
  const groups = new Map<
    string,
    {
      lastRow: number;
      line: Line;
      delta: bigint;
      positive: bigint;
      negative: bigint;
    }
  >();
  for (const line of lines) {
    const key = `${line.productId}:${line.locationId}:${line.stockStatus}:${line.lotId ?? ""}`;
    const group = groups.get(key);
    if (group) {
      group.delta += line.varianceBase;
      group.positive += line.varianceBase > 0n ? line.varianceBase : 0n;
      group.negative += line.varianceBase < 0n ? -line.varianceBase : 0n;
      group.lastRow = line.rowNumber;
    } else
      groups.set(key, {
        lastRow: line.rowNumber,
        line,
        delta: line.varianceBase,
        positive: line.varianceBase > 0n ? line.varianceBase : 0n,
        negative: line.varianceBase < 0n ? -line.varianceBase : 0n,
      });
  }
  const partitions = [];
  for (const { lastRow, line, delta, positive, negative } of groups.values()) {
    let available: bigint;
    if (line.lotId) {
      const balance = await ctx.db
        .query("inventoryLotBalances")
        .withIndex(
          "by_organizationId_and_lotId_and_locationId_and_stockStatus",
          (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("lotId", line.lotId!)
              .eq("locationId", line.locationId)
              .eq("stockStatus", line.stockStatus),
        )
        .unique();
      available = balance?.availableBase ?? 0n;
    } else {
      const balance = await ctx.db
        .query("inventoryBalances")
        .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("productId", line.productId)
            .eq("locationId", line.locationId),
        )
        .unique();
      const field = (
        {
          available: "availableBase",
          quality_hold: "qualityHoldBase",
          quarantine: "quarantineBase",
          damaged: "damagedBase",
          expired: "expiredBase",
          rejected: "rejectedBase",
          wip: "wipBase",
          in_transit: "inTransitBase",
        } as const
      )[line.stockStatus];
      available = balance?.[field] ?? 0n;
    }
    const [product, location, lot] = await Promise.all([
      ctx.db.get(line.productId),
      ctx.db.get(line.locationId),
      line.lotId ? ctx.db.get(line.lotId) : null,
    ]);
    const uom = product?.baseUomId ? await ctx.db.get(product.baseUomId) : null;
    partitions.push({
      productCode: product?.code ?? "",
      baseUomCode: uom?.code ?? "",
      locationCode: location?.code ?? "",
      stockStatus: line.stockStatus,
      lotNumber: lot?.lotNumber,
      positiveBase: positive,
      negativeBase: negative,
      netDeltaBase: delta,
      currentBase: available,
      projectedBase: available + delta,
    });
    if (available + delta < 0n)
      errors.push(
        rowError(
          lastRow,
          "insufficient_stock",
          "Projected eligible balance would be negative",
          "quantity_delta",
        ),
      );
  }
  return {
    errors,
    lines,
    partitions,
    locations: [...locations],
    source,
    type,
    reason,
  };
}

export const preview = query({
  args: {
    rows: v.array(importRowValidator),
    header: v.optional(v.array(v.string())),
  },
  returns: v.object({
    rowCount: v.number(),
    accepted: v.number(),
    errorCount: v.number(),
    errors: v.array(rowErrorValidator),
    partitions: v.array(
      v.object({
        productCode: v.string(),
        baseUomCode: v.string(),
        locationCode: v.string(),
        stockStatus: v.string(),
        lotNumber: v.optional(v.string()),
        positiveBase: v.int64(),
        negativeBase: v.int64(),
        netDeltaBase: v.int64(),
        currentBase: v.int64(),
        projectedBase: v.int64(),
      }),
    ),
    requestChunks: v.number(),
  }),
  handler: async (ctx, { rows, header }) => {
    await requireCapability(ctx, "inventory.adjustment.request");
    const headerErrors = validateHeader(header, HEADER);
    const result = headerErrors.length ? null : await validate(ctx, rows);
    const errors = headerErrors.length ? headerErrors : result!.errors;
    return {
      rowCount: rows.length,
      accepted: errors.length ? 0 : result!.lines.length,
      errorCount: errors.length,
      errors: errors.slice(0, MAX_IMPORT_ERRORS),
      partitions: result?.partitions ?? [],
      requestChunks: errors.length ? 0 : Math.ceil(result!.lines.length / 100),
    };
  },
});

export const commit = mutation({
  args: {
    runKey: v.string(),
    chunkIndex: v.number(),
    idempotencyKey: v.string(),
    fileHash: v.string(),
    rowCount: v.number(),
    rows: v.array(importRowValidator),
    header: v.optional(v.array(v.string())),
  },
  returns: v.object({
    runId: v.id("importRuns"),
    adjustmentId: v.optional(v.id("inventoryAdjustments")),
    sessionId: v.optional(v.id("stockCountSessions")),
    accepted: v.number(),
    failed: v.number(),
    duplicate: v.boolean(),
    errors: v.array(rowErrorValidator),
  }),
  handler: async (ctx, args: OperationalArgs) => {
    const { identity } = await requireCapability(
      ctx,
      "inventory.adjustment.request",
    );
    if (validateHeader(args.header, HEADER).length)
      throw new ConvexError(
        "invalid_format: header must match adjustment template",
      );
    const source = cell(args.rows[0]!, "source_reference");
    const { existing, chunkHash } = await replay(
      ctx,
      "stock_adjustment",
      args,
      source,
    );
    if (existing) {
      for (const locationId of existing.locationIds ?? [])
        await requireLocationCapability(
          ctx,
          "inventory.adjustment.request",
          locationId,
        );
      return duplicateResult(existing);
    }
    const result = await validate(ctx, args.rows);
    const prior = await ctx.db
      .query("importRuns")
      .withIndex("by_organizationId_and_runKey", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("runKey", args.runKey),
      )
      .take(200);
    const keys = args.rows.map(
      (row) => `${cell(row, "source_reference")}:${cell(row, "line_key")}`,
    );
    const priorKeys = new Set(
      prior
        .filter((run) => run.importType === "stock_adjustment")
        .flatMap((run) => run.rowKeys ?? []),
    );
    for (const row of args.rows)
      if (
        priorKeys.has(
          `${cell(row, "source_reference")}:${cell(row, "line_key")}`,
        )
      )
        result.errors.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.duplicateInFile,
            "Duplicate source line across chunks",
            "line_key",
          ),
        );
    if (
      prior.some(
        (run) =>
          run.importType === "stock_adjustment" &&
          (run.adjustmentType !== result.type ||
            run.reasonCode !== result.reason),
      )
    )
      result.errors.push(
        rowError(
          args.rows[0]?.rowNumber ?? 1,
          "invalid_reason",
          "Adjustment type/reason differs from earlier chunk",
        ),
      );
    const adjustmentId = result.errors.length
      ? undefined
      : await requestAdjustment(ctx, {
          adjustmentType: result.type,
          reasonCode: result.reason,
          note: `CSV ${result.source} chunk ${args.chunkIndex}`,
          lines: result.lines.map((line) => ({
            productId: line.productId,
            locationId: line.locationId,
            ...(line.lotId ? { lotId: line.lotId } : {}),
            stockStatus: line.stockStatus,
            varianceBase: line.varianceBase,
          })),
        });
    const runId = await record(
      ctx,
      "stock_adjustment",
      args,
      chunkHash,
      identity.tokenIdentifier,
      result.errors,
      {
        sourceReference: result.source,
        rowKeys: keys,
        adjustmentType: result.type,
        reasonCode: result.reason,
        locationIds: result.locations,
        adjustmentId,
      },
    );
    return {
      runId,
      adjustmentId,
      sessionId: undefined,
      accepted: result.errors.length ? 0 : result.lines.length,
      failed: new Set(result.errors.map((e) => e.rowNumber)).size,
      duplicate: false,
      errors: result.errors.slice(0, MAX_IMPORT_ERRORS),
    };
  },
});
