import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  DEFAULT_QUANTITY_SCALE,
  parseQuantity,
  SUNPRIDE_ORGANIZATION_ID,
} from "../inventory/constants";
import { postMovement, type PostingLine } from "../inventory/posting";
import {
  buildOpeningBalanceLine,
  OpeningBalanceLineError,
} from "../inventory/setup";
import { requireScopedRole } from "../lib/scope";
import {
  cell,
  ERROR_CODES,
  IMPORT_CHUNK_ROWS,
  importRowValidator,
  MAX_IMPORT_ERRORS,
  normalizeLotNumber,
  parseCsvDate,
  parseCsvInteger,
  requiredCell,
  rowError,
  rowErrorValidator,
  type ImportRow,
  type RowError,
} from "./shared";

const MAX_SOURCE_REFERENCE_LENGTH = 64;
const MAX_LOT_LENGTH = 40;

type ResolvedOpeningRow = {
  rowNumber: number;
  productId: Id<"products">;
  locationId: Id<"inventoryLocations">;
  quantityBase: bigint;
  lotNumber: string | null;
  manufacturedAt: number | null;
  expiresAt: number | null;
  unitCostMinor: bigint | null;
};

export type OpeningStockValidation = {
  valid: ResolvedOpeningRow[];
  errors: RowError[];
  rowCount: number;
  totalBase: bigint;
};

function optionalDateCell(
  row: ImportRow,
  column: string,
  errors: RowError[],
): number | null {
  const raw = cell(row, column);
  if (raw === "") return null;
  const parsed = parseCsvDate(raw);
  if (parsed === null) {
    errors.push(
      rowError(
        row.rowNumber,
        ERROR_CODES.invalidFormat,
        `${column} must be a YYYY-MM-DD date`,
        column,
      ),
    );
    return null;
  }
  return parsed;
}

/**
 * Server-authoritative validation for the opening-stock import. Read-only, so the preview
 * query and the commit mutation share it (ADR-007: opening stock is explicit and exact).
 */
export async function validateOpeningStockRows(
  ctx: QueryCtx | MutationCtx,
  rows: ImportRow[],
): Promise<OpeningStockValidation> {
  const errors: RowError[] = [];
  const valid: ResolvedOpeningRow[] = [];
  const seenKeys = new Set<string>();
  let totalBase = 0n;
  const sourceReferences = new Set<string>();

  for (const row of rows) {
    const rowErrors: RowError[] = [];

    const sourceReference = requiredCell(row, "source_reference", rowErrors);
    if (sourceReference) {
      if (sourceReference.length > MAX_SOURCE_REFERENCE_LENGTH)
        rowErrors.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.invalidFormat,
            `source_reference must be at most ${MAX_SOURCE_REFERENCE_LENGTH} characters`,
            "source_reference",
          ),
        );
      sourceReferences.add(sourceReference);
    }

    const rawCode = requiredCell(row, "product_code", rowErrors);
    const productCode = rawCode ? rawCode.trim().toUpperCase() : "";
    const product = productCode
      ? await ctx.db
          .query("products")
          .withIndex("by_code", (q) => q.eq("code", productCode))
          .unique()
      : null;
    if (productCode && !product)
      rowErrors.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.unknownReference,
          `Unknown product ${productCode}`,
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
    if (product && !policy)
      rowErrors.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.policyMissing,
          `${productCode} has no inventory policy`,
          "product_code",
        ),
      );

    const locationCode = requiredCell(row, "location_code", rowErrors);
    const location = locationCode
      ? await ctx.db
          .query("inventoryLocations")
          .withIndex("by_organizationId_and_code", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("code", locationCode.trim().toUpperCase()),
          )
          .unique()
      : null;
    if (locationCode && !location)
      rowErrors.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.unknownReference,
          `Unknown location ${locationCode}`,
          "location_code",
        ),
      );
    else if (location && !location.active)
      rowErrors.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.unknownReference,
          `Location ${locationCode} is inactive`,
          "location_code",
        ),
      );

    const rawQuantity = requiredCell(row, "quantity", rowErrors);
    let quantityBase = 0n;
    if (rawQuantity) {
      try {
        quantityBase = parseQuantity(rawQuantity, DEFAULT_QUANTITY_SCALE);
      } catch {
        rowErrors.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.invalidFormat,
            "quantity must be a decimal number with at most 3 decimals",
            "quantity",
          ),
        );
      }
      if (quantityBase <= 0n)
        rowErrors.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.notPositive,
            "quantity must be greater than zero",
            "quantity",
          ),
        );
    }

    const rawLot = cell(row, "lot_number");
    const lotNumber = rawLot === "" ? null : normalizeLotNumber(rawLot);
    if (lotNumber && lotNumber.length > MAX_LOT_LENGTH)
      rowErrors.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.invalidFormat,
          `lot_number must be at most ${MAX_LOT_LENGTH} characters`,
          "lot_number",
        ),
      );
    const manufacturedAt = optionalDateCell(row, "manufactured_at", rowErrors);
    const expiresAt = optionalDateCell(row, "expires_at", rowErrors);

    if (policy?.trackingMode === "lot") {
      if (!lotNumber)
        rowErrors.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.requiredMissing,
            "lot_number is required for a lot-tracked product",
            "lot_number",
          ),
        );
      if (policy.expiryDateRequired && expiresAt === null)
        rowErrors.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.requiredMissing,
            "expires_at is required for this product",
            "expires_at",
          ),
        );
      if (policy.manufactureDateRequired && manufacturedAt === null)
        rowErrors.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.requiredMissing,
            "manufactured_at is required for this product",
            "manufactured_at",
          ),
        );
    }

    const rawCost = cell(row, "unit_cost_minor");
    let unitCostMinor: bigint | null = null;
    if (rawCost !== "") {
      const parsed = parseCsvInteger(rawCost);
      if (parsed === null || parsed < 0)
        rowErrors.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.invalidFormat,
            "unit_cost_minor must be a whole number of minor units",
            "unit_cost_minor",
          ),
        );
      else unitCostMinor = BigInt(parsed);
    }

    if (product && location && lotNumber) {
      const key = `${product._id}:${location._id}:${lotNumber}`;
      if (seenKeys.has(key))
        rowErrors.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.duplicateInFile,
            `${productCode} at ${locationCode} lot ${lotNumber} appears more than once`,
            "lot_number",
          ),
        );
      else seenKeys.add(key);

      // Opening stock is posted once. A lot that already carries stock at this location must
      // be corrected through a stock count and an approved adjustment (ADR-007), never by
      // importing the file again under a new run key.
      const lot = await ctx.db
        .query("inventoryLots")
        .withIndex(
          "by_organizationId_and_productId_and_normalizedLotNumber",
          (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("productId", product._id)
              .eq("normalizedLotNumber", lotNumber),
        )
        .unique();
      if (lot) {
        const lotBalance = await ctx.db
          .query("inventoryLotBalances")
          .withIndex(
            "by_organizationId_and_lotId_and_locationId_and_stockStatus",
            (q) =>
              q
                .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
                .eq("lotId", lot._id)
                .eq("locationId", location._id)
                .eq("stockStatus", "available"),
          )
          .unique();
        if (lotBalance && lotBalance.physicalBase > 0n)
          rowErrors.push(
            rowError(
              row.rowNumber,
              ERROR_CODES.duplicateStock,
              `${productCode} lot ${lotNumber} already has ${lotBalance.physicalBase} base units at ${locationCode}. Correct stock through a stock count and an approved adjustment.`,
              "lot_number",
            ),
          );
      }
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }
    if (!product || !location) continue;

    totalBase += quantityBase;
    valid.push({
      rowNumber: row.rowNumber,
      productId: product._id,
      locationId: location._id,
      quantityBase,
      lotNumber,
      manufacturedAt,
      expiresAt,
      unitCostMinor,
    });
  }

  // One cutover, one source reference: mixing references in a single file means the file is
  // two cutovers and must be split.
  if (sourceReferences.size > 1)
    errors.push(
      rowError(
        rows[0]?.rowNumber ?? 1,
        ERROR_CODES.invalidFormat,
        "source_reference must be identical on every row",
        "source_reference",
      ),
    );

  return { valid, errors, rowCount: rows.length, totalBase };
}

/** Read-only preview: same validation as the commit, no writes. */
export const validateOpeningStock = query({
  args: { rows: v.array(importRowValidator) },
  returns: v.object({
    rowCount: v.number(),
    accepted: v.number(),
    totalQuantityBase: v.string(),
    errorCount: v.number(),
    errors: v.array(rowErrorValidator),
  }),
  handler: async (ctx, args) => {
    await requireScopedRole(ctx, ["admin"]);
    const validation = await validateOpeningStockRows(ctx, args.rows);
    const blocking = validation.errors.length > 0;
    return {
      rowCount: validation.rowCount,
      accepted: blocking ? 0 : validation.valid.length,
      totalQuantityBase: validation.totalBase.toString(),
      errorCount: validation.errors.length,
      errors: validation.errors.slice(0, MAX_IMPORT_ERRORS),
    };
  },
});

/**
 * Commits one chunk of opening stock as exactly one movement through the posting engine.
 * All-or-nothing: any invalid row rejects the whole chunk and posts nothing, because a
 * partially applied cutover is worse than none (ADR-007).
 */
export const commitOpeningStock = mutation({
  args: {
    runKey: v.string(),
    chunkIndex: v.number(),
    idempotencyKey: v.string(),
    fileHash: v.string(),
    sourceReference: v.string(),
    scopeUnitId: v.optional(v.id("orgUnits")),
    rows: v.array(importRowValidator),
  },
  returns: v.object({
    runId: v.id("importRuns"),
    movementId: v.optional(v.id("inventoryMovements")),
    movementNumber: v.optional(v.string()),
    accepted: v.number(),
    failed: v.number(),
    duplicate: v.boolean(),
    errors: v.array(rowErrorValidator),
  }),
  handler: async (ctx, args) => {
    const { identity } = await requireScopedRole(
      ctx,
      ["admin"],
      args.scopeUnitId,
    );
    if (args.rows.length === 0)
      throw new ConvexError("Import needs at least one row");
    if (args.rows.length > IMPORT_CHUNK_ROWS)
      throw new ConvexError(
        `Import chunks are limited to ${IMPORT_CHUNK_ROWS} rows`,
      );
    if (args.chunkIndex < 0)
      throw new ConvexError("chunkIndex must not be negative");
    if (!args.sourceReference.trim())
      throw new ConvexError("A cutover source reference is required");

    const existing = await ctx.db
      .query("importRuns")
      .withIndex("by_organizationId_and_idempotencyKey", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing) {
      if (existing.fileHash !== args.fileHash)
        throw new ConvexError(
          "Idempotency key reused with a different payload",
        );
      const movement = existing.movementId
        ? await ctx.db.get(existing.movementId)
        : null;
      return {
        runId: existing._id,
        movementId: movement?._id,
        movementNumber: movement?.movementNumber,
        accepted: existing.createdCount,
        failed: existing.failedCount,
        duplicate: true,
        errors: [],
      };
    }

    const validation = await validateOpeningStockRows(ctx, args.rows);
    const now = Date.now();
    const reportedErrors = validation.errors.slice(0, MAX_IMPORT_ERRORS);

    if (validation.errors.length > 0) {
      const failedRows = new Set(
        validation.errors.map((error) => error.rowNumber),
      );
      const runId = await ctx.db.insert("importRuns", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        importType: "opening_stock",
        runKey: args.runKey,
        chunkIndex: args.chunkIndex,
        fileHash: args.fileHash,
        idempotencyKey: args.idempotencyKey,
        actorSubject: identity.tokenIdentifier,
        status: "failed",
        rowCount: validation.rowCount,
        createdCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        failedCount: failedRows.size,
        createdAt: now,
        completedAt: now,
      });
      for (const error of reportedErrors) {
        const sourceRow = args.rows.find(
          (row) => row.rowNumber === error.rowNumber,
        );
        await ctx.db.insert("importRunErrors", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          runId,
          rowNumber: error.rowNumber,
          ...(error.column ? { column: error.column } : {}),
          code: error.code,
          message: error.message,
          rawRow: JSON.stringify(sourceRow?.values ?? {}).slice(0, 500),
          createdAt: now,
        });
      }
      return {
        runId,
        movementId: undefined,
        movementNumber: undefined,
        accepted: 0,
        failed: failedRows.size,
        duplicate: false,
        errors: reportedErrors,
      };
    }

    const lines: PostingLine[] = [];
    for (const row of validation.valid) {
      try {
        lines.push(
          await buildOpeningBalanceLine(ctx, {
            sourceReference: args.sourceReference,
            line: {
              productId: row.productId,
              locationId: row.locationId,
              quantityBase: row.quantityBase,
              ...(row.lotNumber ? { lotNumber: row.lotNumber } : {}),
              ...(row.manufacturedAt
                ? { manufacturedAt: row.manufacturedAt }
                : {}),
              ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
              ...(row.unitCostMinor
                ? { unitCostMinor: row.unitCostMinor }
                : {}),
            },
          }),
        );
      } catch (error) {
        if (error instanceof OpeningBalanceLineError)
          throw new ConvexError(
            `Row ${row.rowNumber} failed validation after preview: ${error.message}`,
          );
        throw error;
      }
    }

    const movement = await postMovement(ctx, {
      idempotencyKey: args.idempotencyKey,
      payloadHash: args.fileHash,
      commandType: "inventory.openingBalanceImport",
      movementType: "opening_balance",
      sourceType: "cutover",
      sourceDocumentId: args.sourceReference,
      actorSubject: identity.tokenIdentifier,
      note: `Opening stock import ${args.runKey} chunk ${args.chunkIndex}`,
      lines,
      emitIntegrationEvent: false,
    });

    // Fail closed: opening stock is never reserved, so available must equal physical and
    // every touched balance must carry a version (runbook verification step 4).
    for (const row of validation.valid) {
      const balance = await ctx.db
        .query("inventoryBalances")
        .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("productId", row.productId)
            .eq("locationId", row.locationId),
        )
        .unique();
      if (!balance || (balance.version ?? 0) === 0)
        throw new ConvexError(
          "Opening stock posted without a versioned balance",
        );
      if ((balance.availableBase ?? 0n) !== (balance.physicalBase ?? 0n))
        throw new ConvexError(
          "Opening stock posted with a reserved or missing quantity",
        );
    }

    const runId = await ctx.db.insert("importRuns", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      importType: "opening_stock",
      runKey: args.runKey,
      chunkIndex: args.chunkIndex,
      fileHash: args.fileHash,
      idempotencyKey: args.idempotencyKey,
      actorSubject: identity.tokenIdentifier,
      status: "completed",
      rowCount: validation.rowCount,
      createdCount: validation.valid.length,
      updatedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      movementId: movement.movementId,
      createdAt: now,
      completedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "import.opening_stock",
      entityType: "importRun",
      entityId: runId,
      details: `${args.sourceReference} accepted:${validation.valid.length} movement:${movement.movementNumber}`,
      createdAt: now,
    });

    return {
      runId,
      movementId: movement.movementId,
      movementNumber: movement.movementNumber,
      accepted: validation.valid.length,
      failed: 0,
      duplicate: false,
      errors: [],
    };
  },
});
