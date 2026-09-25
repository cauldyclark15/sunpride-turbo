import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  DEFAULT_QUANTITY_SCALE,
  SUNPRIDE_ORGANIZATION_ID,
} from "../inventory/constants";
import { requireNationalScope } from "../lib/scope";
import {
  cell,
  chunkHashOf,
  ERROR_CODES,
  IMPORT_CHUNK_ROWS,
  importRowValidator,
  MAX_IMPORT_ERRORS,
  normalizeBarcode,
  normalizeCode,
  parseCsvBoolean,
  parseCsvInteger,
  requiredCell,
  rowError,
  rowErrorValidator,
  type ImportRow,
  type RowError,
} from "./shared";

const PRODUCT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
const BARCODE_PATTERN = /^\d{8,14}$/;
const MAX_SELLING_UOMS = 8;
const MAX_NAME_LENGTH = 120;
const MAX_CATEGORY_LENGTH = 60;
const MAX_EXTERNAL_ID_LENGTH = 64;
const ALLOCATION_POLICIES = ["fefo", "fifo", "explicit_only"] as const;

type TrackingMode = "none" | "lot";
type AllocationPolicy = (typeof ALLOCATION_POLICIES)[number];

type ResolvedProductRow = {
  rowNumber: number;
  productCode: string;
  name: string;
  category: string;
  baseUomId: Id<"unitsOfMeasure">;
  baseUomCode: string;
  sellingUomIds: Id<"unitsOfMeasure">[];
  barcode: string | null;
  trackingMode: TrackingMode;
  allocationPolicy: AllocationPolicy;
  shelfLifeDays: number | null;
  expiryRequired: boolean;
  manufactureDateRequired: boolean;
  minimumRemainingShelfLifeDays: number;
  externalId: string | null;
  existingProductId: Id<"products"> | null;
  policyId: Id<"productInventoryPolicies"> | null;
};

export type ProductValidation = {
  valid: ResolvedProductRow[];
  errors: RowError[];
  rowCount: number;
  wouldCreate: number;
  wouldUpdate: number;
};

function optionalIntegerCell(
  row: ImportRow,
  column: string,
  minimum: number,
  maximum: number,
  errors: RowError[],
): number | null {
  const raw = cell(row, column);
  if (raw === "") return null;
  const parsed = parseCsvInteger(raw);
  if (parsed === null || parsed < minimum || parsed > maximum) {
    errors.push(
      rowError(
        row.rowNumber,
        ERROR_CODES.invalidFormat,
        `${column} must be a whole number between ${minimum} and ${maximum}`,
        column,
      ),
    );
    return null;
  }
  return parsed;
}

function optionalBooleanCell(
  row: ImportRow,
  column: string,
  fallback: boolean,
  errors: RowError[],
): boolean | null {
  const parsed = parseCsvBoolean(cell(row, column), fallback);
  if (parsed === null) {
    errors.push(
      rowError(
        row.rowNumber,
        ERROR_CODES.invalidFormat,
        `${column} must be Y or N`,
        column,
      ),
    );
    return null;
  }
  return parsed;
}

async function unitOfMeasureByCode(ctx: QueryCtx | MutationCtx, code: string) {
  return ctx.db
    .query("unitsOfMeasure")
    .withIndex("by_organizationId_and_code", (q) =>
      q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("code", code),
    )
    .unique();
}

/**
 * Server-authoritative validation for the product-master import. Used by both the preview
 * query and the commit mutation, so a previewed file is checked exactly as it will be
 * written (ADR-006, docs/runbooks/MASTER_DATA_IMPORTS.md).
 */
export async function validateProductRows(
  ctx: QueryCtx | MutationCtx,
  rows: ImportRow[],
): Promise<ProductValidation> {
  const errors: RowError[] = [];
  const valid: ResolvedProductRow[] = [];
  const seenCodes = new Set<string>();
  const seenBarcodes = new Map<string, string>();

  for (const row of rows) {
    const rowErrors: RowError[] = [];

    const rawCode = requiredCell(row, "product_code", rowErrors);
    const productCode = rawCode ? normalizeCode(rawCode) : "";
    if (productCode && !PRODUCT_CODE_PATTERN.test(productCode))
      rowErrors.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.invalidFormat,
          "product_code must be 3-32 characters of A-Z, 0-9 or -",
          "product_code",
        ),
      );
    if (productCode) {
      if (seenCodes.has(productCode))
        rowErrors.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.duplicateInFile,
            `${productCode} appears more than once in this file`,
            "product_code",
          ),
        );
      else seenCodes.add(productCode);
    }

    const name = requiredCell(row, "name", rowErrors) ?? "";
    if (name.length > MAX_NAME_LENGTH)
      rowErrors.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.invalidFormat,
          `name must be at most ${MAX_NAME_LENGTH} characters`,
          "name",
        ),
      );
    const category = requiredCell(row, "category", rowErrors) ?? "";
    if (category.length > MAX_CATEGORY_LENGTH)
      rowErrors.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.invalidFormat,
          `category must be at most ${MAX_CATEGORY_LENGTH} characters`,
          "category",
        ),
      );

    const baseUomCode = normalizeCode(
      requiredCell(row, "base_uom", rowErrors) ?? "",
    );
    const baseUom = baseUomCode
      ? await unitOfMeasureByCode(ctx, baseUomCode)
      : null;
    if (baseUomCode && !baseUom)
      rowErrors.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.unknownReference,
          `Unknown base_uom ${baseUomCode}`,
          "base_uom",
        ),
      );

    const sellingUomIds: Id<"unitsOfMeasure">[] = [];
    const sellingCodes = cell(row, "selling_uoms")
      .split(";")
      .map(normalizeCode)
      .filter((code) => code !== "");
    if (sellingCodes.length > MAX_SELLING_UOMS)
      rowErrors.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.invalidFormat,
          `selling_uoms supports at most ${MAX_SELLING_UOMS} units`,
          "selling_uoms",
        ),
      );
    for (const code of sellingCodes.slice(0, MAX_SELLING_UOMS)) {
      const uom = await unitOfMeasureByCode(ctx, code);
      if (!uom)
        rowErrors.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.unknownReference,
            `Unknown selling UOM ${code}`,
            "selling_uoms",
          ),
        );
      else if (!sellingUomIds.includes(uom._id)) sellingUomIds.push(uom._id);
    }
    // The base unit is always sellable (ADR-006).
    if (baseUom && !sellingUomIds.includes(baseUom._id))
      sellingUomIds.unshift(baseUom._id);

    const rawBarcode = cell(row, "barcode");
    const barcode = rawBarcode === "" ? null : normalizeBarcode(rawBarcode);
    if (barcode !== null && !BARCODE_PATTERN.test(barcode))
      rowErrors.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.invalidFormat,
          "barcode must be 8-14 digits",
          "barcode",
        ),
      );

    const trackingRaw = (requiredCell(row, "tracking_mode", rowErrors) ?? "")
      .trim()
      .toLowerCase();
    let trackingMode: TrackingMode = "lot";
    if (trackingRaw && trackingRaw !== "lot" && trackingRaw !== "none")
      rowErrors.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.invalidFormat,
          'tracking_mode must be "lot" or "none"',
          "tracking_mode",
        ),
      );
    else if (trackingRaw) trackingMode = trackingRaw as TrackingMode;

    const allocationRaw = cell(row, "allocation_policy").trim().toLowerCase();
    let allocationPolicy: AllocationPolicy = "fefo";
    if (
      allocationRaw &&
      !(ALLOCATION_POLICIES as readonly string[]).includes(allocationRaw)
    )
      rowErrors.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.invalidFormat,
          "allocation_policy must be fefo, fifo or explicit_only",
          "allocation_policy",
        ),
      );
    else if (allocationRaw)
      allocationPolicy = allocationRaw as AllocationPolicy;

    const shelfLifeDays = optionalIntegerCell(
      row,
      "shelf_life_days",
      0,
      3650,
      rowErrors,
    );
    const minimumRemainingShelfLifeDays =
      optionalIntegerCell(
        row,
        "minimum_remaining_shelf_life_days",
        0,
        3650,
        rowErrors,
      ) ?? 0;

    const lotDefaults = trackingMode === "lot";
    const expiryRequired =
      optionalBooleanCell(row, "expiry_required", lotDefaults, rowErrors) ??
      lotDefaults;
    const manufactureDateRequired =
      optionalBooleanCell(
        row,
        "manufacture_date_required",
        lotDefaults,
        rowErrors,
      ) ?? lotDefaults;

    const externalIdRaw = cell(row, "external_id");
    const externalId = externalIdRaw === "" ? null : externalIdRaw;
    if (externalId && externalId.length > MAX_EXTERNAL_ID_LENGTH)
      rowErrors.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.invalidFormat,
          `external_id must be at most ${MAX_EXTERNAL_ID_LENGTH} characters`,
          "external_id",
        ),
      );

    let existingProduct = null;
    let policy = null;
    if (productCode && PRODUCT_CODE_PATTERN.test(productCode)) {
      existingProduct = await ctx.db
        .query("products")
        .withIndex("by_code", (q) => q.eq("code", productCode))
        .unique();
      if (existingProduct)
        policy = await ctx.db
          .query("productInventoryPolicies")
          .withIndex("by_organizationId_and_productId", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("productId", existingProduct!._id),
          )
          .unique();
    }

    if (barcode && BARCODE_PATTERN.test(barcode)) {
      const firstCode = seenBarcodes.get(barcode);
      if (firstCode && firstCode !== productCode)
        rowErrors.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.barcodeConflict,
            `Barcode ${barcode} already belongs to another product in this chunk`,
            "barcode",
          ),
        );
      else seenBarcodes.set(barcode, productCode);
      const owner = await ctx.db
        .query("productBarcodes")
        .withIndex("by_organizationId_and_barcode", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("barcode", barcode),
        )
        .unique();
      if (
        owner &&
        owner.active &&
        (!existingProduct || owner.productId !== existingProduct._id)
      )
        rowErrors.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.barcodeConflict,
            `Barcode ${barcode} already belongs to another product`,
            "barcode",
          ),
        );
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }
    if (!baseUom) continue;

    valid.push({
      rowNumber: row.rowNumber,
      productCode,
      name,
      category,
      baseUomId: baseUom._id,
      baseUomCode,
      sellingUomIds,
      barcode,
      trackingMode,
      allocationPolicy,
      shelfLifeDays,
      expiryRequired,
      manufactureDateRequired,
      minimumRemainingShelfLifeDays,
      externalId,
      existingProductId: existingProduct?._id ?? null,
      policyId: policy?._id ?? null,
    });
  }

  return {
    valid,
    errors,
    rowCount: rows.length,
    wouldCreate: valid.filter((row) => row.existingProductId === null).length,
    wouldUpdate: valid.filter((row) => row.existingProductId !== null).length,
  };
}

async function upsertProduct(
  ctx: MutationCtx,
  row: ResolvedProductRow,
  now: number,
): Promise<"created" | "updated" | "unchanged"> {
  if (!row.existingProductId) {
    await ctx.db.insert("products", {
      code: row.productCode,
      name: row.name,
      category: row.category,
      uom: row.baseUomCode,
      unitPrice: 0,
      active: true,
      ...(row.externalId ? { externalId: row.externalId } : {}),
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      baseUomId: row.baseUomId,
      quantityScale: DEFAULT_QUANTITY_SCALE,
      trackingMode: row.trackingMode,
      allocationPolicy: row.allocationPolicy,
      sellingUomIds: row.sellingUomIds,
      catalogSource: "import",
      catalogUpdatedAt: now,
      updatedAt: now,
    });
    return "created";
  }

  const current = await ctx.db.get(row.existingProductId);
  if (!current)
    throw new ConvexError(`Product ${row.productCode} disappeared mid-import`);

  const changes: Partial<typeof current> = {};
  if (current.name !== row.name) changes.name = row.name;
  if (current.category !== row.category) changes.category = row.category;
  if (current.uom !== row.baseUomCode) changes.uom = row.baseUomCode;
  if (current.baseUomId !== row.baseUomId) changes.baseUomId = row.baseUomId;
  if (current.trackingMode !== row.trackingMode)
    changes.trackingMode = row.trackingMode;
  if (current.allocationPolicy !== row.allocationPolicy)
    changes.allocationPolicy = row.allocationPolicy;
  if (
    JSON.stringify(current.sellingUomIds ?? []) !==
    JSON.stringify(row.sellingUomIds)
  )
    changes.sellingUomIds = row.sellingUomIds;
  if (row.externalId && current.externalId !== row.externalId)
    changes.externalId = row.externalId;

  if (Object.keys(changes).length === 0) return "unchanged";

  await ctx.db.patch(row.existingProductId, {
    ...changes,
    catalogSource: "import",
    catalogUpdatedAt: now,
    updatedAt: now,
  });
  return "updated";
}

async function upsertPolicy(
  ctx: MutationCtx,
  row: ResolvedProductRow,
  productId: Id<"products">,
  now: number,
): Promise<number> {
  const base = {
    baseUomId: row.baseUomId,
    quantityScale: DEFAULT_QUANTITY_SCALE,
    quantityPrecision: 3,
    trackingMode: row.trackingMode,
    allocationPolicy: row.allocationPolicy,
    allowMixedLotsPerLine: true,
    allowNegativeStock: false,
    qualityReleaseRequired: false,
    expiryDateRequired: row.expiryRequired,
    manufactureDateRequired: row.manufactureDateRequired,
    minimumRemainingShelfLifeDays: row.minimumRemainingShelfLifeDays,
    costingMethod: "weighted_average" as const,
    active: true,
  };
  if (!row.policyId) {
    await ctx.db.insert("productInventoryPolicies", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      productId,
      ...base,
      ...(row.shelfLifeDays !== null
        ? { shelfLifeDays: row.shelfLifeDays }
        : {}),
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    return 1;
  }
  const current = await ctx.db.get(row.policyId);
  if (!current) return 1;
  const changed =
    current.baseUomId !== base.baseUomId ||
    current.trackingMode !== base.trackingMode ||
    current.allocationPolicy !== base.allocationPolicy ||
    current.expiryDateRequired !== base.expiryDateRequired ||
    current.manufactureDateRequired !== base.manufactureDateRequired ||
    current.minimumRemainingShelfLifeDays !==
      base.minimumRemainingShelfLifeDays ||
    (row.shelfLifeDays !== null && current.shelfLifeDays !== row.shelfLifeDays);
  if (!changed) return current.version;
  const version = current.version + 1;
  await ctx.db.patch(row.policyId, {
    ...base,
    ...(row.shelfLifeDays !== null ? { shelfLifeDays: row.shelfLifeDays } : {}),
    version,
    updatedAt: now,
  });
  return version;
}

async function upsertBarcode(
  ctx: MutationCtx,
  row: ResolvedProductRow,
  productId: Id<"products">,
  now: number,
) {
  if (!row.barcode) return;
  const existing = await ctx.db
    .query("productBarcodes")
    .withIndex("by_organizationId_and_barcode", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("barcode", row.barcode!),
    )
    .unique();
  if (!existing) {
    await ctx.db.insert("productBarcodes", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      productId,
      barcode: row.barcode,
      uomId: row.baseUomId,
      active: true,
      source: "import",
      createdAt: now,
      updatedAt: now,
    });
    return;
  }
  await ctx.db.patch(existing._id, {
    productId,
    uomId: row.baseUomId,
    active: true,
    source: "import",
    updatedAt: now,
  });
}

/** Read-only preview: same validation as the commit, no writes. */
export const validateProducts = query({
  args: { rows: v.array(importRowValidator) },
  returns: v.object({
    rowCount: v.number(),
    wouldCreate: v.number(),
    wouldUpdate: v.number(),
    errorCount: v.number(),
    errors: v.array(rowErrorValidator),
  }),
  handler: async (ctx, args) => {
    await requireNationalScope(ctx, ["admin"]);
    const validation = await validateProductRows(ctx, args.rows);
    return {
      rowCount: validation.rowCount,
      wouldCreate: validation.wouldCreate,
      wouldUpdate: validation.wouldUpdate,
      errorCount: validation.errors.length,
      errors: validation.errors.slice(0, MAX_IMPORT_ERRORS),
    };
  },
});

/**
 * Commits one chunk. Valid rows are written; invalid rows are reported and skipped.
 * Replaying a chunk with the same key and file hash returns the stored counts and writes
 * nothing (ADR-003); reusing a key with different content is rejected.
 */
export const commitProducts = mutation({
  args: {
    runKey: v.string(),
    chunkIndex: v.number(),
    idempotencyKey: v.string(),
    fileHash: v.string(),
    rows: v.array(importRowValidator),
  },
  returns: v.object({
    runId: v.id("importRuns"),
    created: v.number(),
    updated: v.number(),
    skipped: v.number(),
    failed: v.number(),
    duplicate: v.boolean(),
    errors: v.array(rowErrorValidator),
  }),
  handler: async (ctx, args) => {
    const { identity } = await requireNationalScope(ctx, ["admin"]);
    if (args.rows.length === 0)
      throw new ConvexError("Import needs at least one row");
    if (args.rows.length > IMPORT_CHUNK_ROWS)
      throw new ConvexError(
        `Import chunks are limited to ${IMPORT_CHUNK_ROWS} rows`,
      );
    if (args.chunkIndex < 0)
      throw new ConvexError("chunkIndex must not be negative");

    const chunkHash = chunkHashOf(args.chunkIndex, args.rows);
    const existing = await ctx.db
      .query("importRuns")
      .withIndex("by_organizationId_and_idempotencyKey", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing) {
      if (
        existing.importType !== "products" ||
        existing.fileHash !== args.fileHash ||
        existing.chunkHash !== chunkHash
      )
        throw new ConvexError(
          "Idempotency key reused with a different payload",
        );
      return {
        runId: existing._id,
        created: existing.createdCount,
        updated: existing.updatedCount,
        skipped: existing.skippedCount,
        failed: existing.failedCount,
        duplicate: true,
        errors: [],
      };
    }

    const validation = await validateProductRows(ctx, args.rows);
    const now = Date.now();
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of validation.valid) {
      const outcome = await upsertProduct(ctx, row, now);
      if (outcome === "created") created += 1;
      else if (outcome === "updated") updated += 1;
      else skipped += 1;

      const productId =
        row.existingProductId ??
        (
          await ctx.db
            .query("products")
            .withIndex("by_code", (q) => q.eq("code", row.productCode))
            .unique()
        )?._id;
      if (!productId)
        throw new ConvexError(
          `Product ${row.productCode} could not be resolved after upsert`,
        );
      const policyVersion = await upsertPolicy(ctx, row, productId, now);
      await ctx.db.patch(productId, { policyVersion, updatedAt: now });
      await upsertBarcode(ctx, row, productId, now);
    }

    const failedRows = new Set(
      validation.errors.map((error) => error.rowNumber),
    );
    const failed = failedRows.size;
    const runId = await ctx.db.insert("importRuns", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      importType: "products",
      runKey: args.runKey,
      chunkIndex: args.chunkIndex,
      fileHash: args.fileHash,
      chunkHash,
      idempotencyKey: args.idempotencyKey,
      actorSubject: identity.tokenIdentifier,
      status: "completed",
      rowCount: validation.rowCount,
      createdCount: created,
      updatedCount: updated,
      skippedCount: skipped,
      failedCount: failed,
      createdAt: now,
      completedAt: now,
    });

    const reportedErrors = validation.errors.slice(0, MAX_IMPORT_ERRORS);
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

    await ctx.db.insert("auditLogs", {
      subject: identity.tokenIdentifier,
      action: "import.products",
      entityType: "importRun",
      entityId: runId,
      details: `created:${created} updated:${updated} skipped:${skipped} failed:${failed}`,
      createdAt: now,
    });

    return {
      runId,
      created,
      updated,
      skipped,
      failed,
      duplicate: false,
      errors: reportedErrors,
    };
  },
});
