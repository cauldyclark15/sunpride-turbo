import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
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
import {
  assertFreshSnapshot,
  snapshotIsStale,
  submitCount,
} from "../inventory/counts";
import { requireLocationCapability } from "../inventory/location_scope";
import { requireCapability } from "../lib/capabilities";
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
  "count_reference,location_code,product_code,stock_status,lot_number,counted_quantity,finding,note";
type Observation = {
  lineId: Id<"stockCountLines">;
  rowNumber: number;
  countedBase: bigint;
  finding?:
    "over" | "missing" | "damaged" | "expired" | "wrong_lot" | "wrong_location";
  note?: string;
};
const FINDINGS = new Set([
  "over",
  "missing",
  "damaged",
  "expired",
  "wrong_lot",
  "wrong_location",
]);

async function validate(ctx: QueryCtx | MutationCtx, rows: ImportRow[]) {
  const errors: RowError[] = [],
    observations: Observation[] = [];
  if (rows.length === 0)
    return {
      errors: [
        rowError(
          1,
          ERROR_CODES.requiredMissing,
          "Count CSV needs at least one row",
        ),
      ],
      observations,
      session: null,
      ref: "",
      expected: [] as Doc<"stockCountLines">[],
    };
  const ref = cell(rows[0]!, "count_reference");
  const session = ref
    ? await ctx.db
        .query("stockCountSessions")
        .withIndex("by_organizationId_and_countNumber", (q) =>
          q
            .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
            .eq("countNumber", ref),
        )
        .unique()
    : null;
  let expected: Doc<"stockCountLines">[] = [];
  if (session) {
    try {
      await requireLocationCapability(
        ctx,
        "inventory.count.submit",
        session.locationId,
      );
    } catch {
      errors.push(
        rowError(
          rows[0]?.rowNumber ?? 1,
          ERROR_CODES.scopeDenied,
          "Count location outside scope",
          "location_code",
        ),
      );
    }
    if (session.countType !== "cycle" || session.status !== "counting")
      errors.push(
        rowError(
          rows[0]?.rowNumber ?? 1,
          "count_not_open",
          "Cycle count is not counting",
          "count_reference",
        ),
      );
    expected = await ctx.db
      .query("stockCountLines")
      .withIndex("by_organizationId_and_sessionId", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("sessionId", session._id),
      )
      .take(101);
    if (expected.length > 100)
      errors.push(
        rowError(
          rows[0]?.rowNumber ?? 1,
          "session_too_large",
          "Count session exceeds 100 lines",
        ),
      );
    // A restored quantity is still stale if the posting engine advanced its version.
    if (
      expected.length <= 100 &&
      (await snapshotIsStale(ctx, session, expected))
    )
      errors.push(
        rowError(
          rows[0]?.rowNumber ?? 1,
          "stale_snapshot",
          "Snapshot changed; recount required",
        ),
      );
  } else
    errors.push(
      rowError(
        rows[0]?.rowNumber ?? 1,
        ERROR_CODES.unknownReference,
        "Unknown count reference",
        "count_reference",
      ),
    );
  if (rows.length > MAX_IMPORT_ROWS)
    errors.push(
      rowError(
        rows[0]?.rowNumber ?? 1,
        ERROR_CODES.tooManyRows,
        "File exceeds 5000 rows",
      ),
    );
  const seen = new Set<Id<"stockCountLines">>();
  for (const row of rows.slice(0, MAX_IMPORT_ROWS)) {
    const e: RowError[] = [];
    for (const name of [
      "count_reference",
      "location_code",
      "product_code",
      "stock_status",
      "counted_quantity",
    ])
      requiredCell(row, name, e);
    if (cell(row, "count_reference") && cell(row, "count_reference") !== ref)
      e.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.invalidFormat,
          "Mixed count references",
          "count_reference",
        ),
      );
    const location = session ? await ctx.db.get(session.locationId) : null;
    if (location && normalizeCode(cell(row, "location_code")) !== location.code)
      e.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.unknownReference,
          "Location differs from session",
          "location_code",
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
          "Missing inventory policy",
          "product_code",
        ),
      );
    const lotCode = normalizeCode(cell(row, "lot_number"));
    if (policy?.trackingMode === "lot" && !lotCode)
      e.push(
        rowError(row.rowNumber, "lot_required", "Lot required", "lot_number"),
      );
    if (policy && policy.trackingMode !== "lot" && lotCode)
      e.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.invalidFormat,
          "Lot not allowed",
          "lot_number",
        ),
      );
    const lot =
      product && lotCode
        ? await ctx.db
            .query("inventoryLots")
            .withIndex(
              "by_organizationId_and_productId_and_normalizedLotNumber",
              (q) =>
                q
                  .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
                  .eq("productId", product._id)
                  .eq("normalizedLotNumber", lotCode),
            )
            .unique()
        : null;
    const status = cell(row, "stock_status").toLowerCase();
    const line = expected.find(
      (l) =>
        l.productId === product?._id &&
        l.stockStatus === status &&
        (l.lotId ?? null) === (lot?._id ?? null),
    );
    if (product && !line)
      e.push(
        rowError(
          row.rowNumber,
          "count_line_missing",
          "Not an expected count line",
          "product_code",
        ),
      );
    if (line) {
      if (seen.has(line._id))
        e.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.duplicateInFile,
            "Count line repeated",
            "product_code",
          ),
        );
      seen.add(line._id);
    }
    let counted = 0n;
    if (cell(row, "counted_quantity")) {
      try {
        counted = parseQuantity(
          cell(row, "counted_quantity"),
          DEFAULT_QUANTITY_SCALE,
        );
        if (counted < 0n) throw new Error();
      } catch {
        e.push(
          rowError(
            row.rowNumber,
            ERROR_CODES.invalidFormat,
            "Count must be nonnegative base quantity",
            "counted_quantity",
          ),
        );
      }
    }
    const finding = cell(row, "finding").toLowerCase();
    if (finding && !FINDINGS.has(finding))
      e.push(
        rowError(
          row.rowNumber,
          ERROR_CODES.invalidFormat,
          "Invalid finding",
          "finding",
        ),
      );
    if (e.length) {
      errors.push(...e);
      continue;
    }
    if (line)
      observations.push({
        lineId: line._id,
        rowNumber: row.rowNumber,
        countedBase: counted,
        ...(finding ? { finding: finding as Observation["finding"] } : {}),
        ...(cell(row, "note") ? { note: cell(row, "note") } : {}),
      });
  }
  if (session && expected.length <= 100)
    for (const line of expected)
      if (!seen.has(line._id))
        errors.push(
          rowError(
            rows[0]?.rowNumber ?? 1,
            "count_incomplete",
            "Expected count line omitted",
            "count_reference",
          ),
        );
  return { errors, observations, session, ref, expected };
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
    snapshotAt: v.optional(v.number()),
    lines: v.array(
      v.object({
        rowNumber: v.number(),
        countedBase: v.int64(),
        status: v.string(),
      }),
    ),
    approvalPartitions: v.optional(
      v.array(
        v.object({
          rowNumber: v.number(),
          productCode: v.string(),
          baseUomCode: v.string(),
          locationCode: v.string(),
          stockStatus: v.string(),
          lotNumber: v.optional(v.string()),
          expectedBase: v.int64(),
          countedBase: v.int64(),
          varianceBase: v.int64(),
          gainBase: v.int64(),
          lossBase: v.int64(),
          projectedBase: v.int64(),
        }),
      ),
    ),
    zeroVarianceCount: v.optional(v.number()),
    proposedMovementLines: v.optional(v.number()),
  }),
  handler: async (ctx, { rows, header }) => {
    const { identity } = await requireCapability(ctx, "inventory.count.submit");
    const headerErrors = validateHeader(header, HEADER);
    const result = headerErrors.length ? null : await validate(ctx, rows);
    const errors = headerErrors.length ? headerErrors : result!.errors;
    let approvalPartitions:
      | Array<{
          rowNumber: number;
          productCode: string;
          baseUomCode: string;
          locationCode: string;
          stockStatus: string;
          lotNumber?: string;
          expectedBase: bigint;
          countedBase: bigint;
          varianceBase: bigint;
          gainBase: bigint;
          lossBase: bigint;
          projectedBase: bigint;
        }>
      | undefined;
    if (
      result?.session &&
      ["submitted", "reviewed", "approved", "posted"].includes(
        result.session.status,
      ) &&
      result.session.createdBy !== identity.tokenIdentifier
    ) {
      try {
        await requireLocationCapability(
          ctx,
          "inventory.count.approve",
          result.session.locationId,
        );
        const location = await ctx.db.get(result.session.locationId);
        approvalPartitions = [];
        for (const observation of result.observations) {
          const line = result.expected.find(
            (expected) => expected._id === observation.lineId,
          )!;
          const product = await ctx.db.get(line.productId);
          const uom = product?.baseUomId
            ? await ctx.db.get(product.baseUomId)
            : null;
          const lot = line.lotId ? await ctx.db.get(line.lotId) : null;
          const variance = observation.countedBase - line.systemBase;
          approvalPartitions.push({
            rowNumber: observation.rowNumber,
            productCode: product?.code ?? "",
            baseUomCode: uom?.code ?? "",
            locationCode: location?.code ?? "",
            stockStatus: line.stockStatus,
            lotNumber: lot?.lotNumber,
            expectedBase: line.systemBase,
            countedBase: observation.countedBase,
            varianceBase: variance,
            gainBase: variance > 0n ? variance : 0n,
            lossBase: variance < 0n ? -variance : 0n,
            projectedBase: observation.countedBase,
          });
        }
      } catch {
        /* A counter never receives expected quantities through this preview. */
      }
    }
    return {
      rowCount: rows.length,
      accepted: errors.length ? 0 : result!.observations.length,
      errorCount: errors.length,
      errors: errors.slice(0, MAX_IMPORT_ERRORS),
      snapshotAt: result?.session?.snapshotAt,
      lines:
        result?.observations.map((observation) => ({
          rowNumber: observation.rowNumber,
          countedBase: observation.countedBase,
          status: errors.length ? "blocked" : "valid",
        })) ?? [],
      ...(approvalPartitions
        ? {
            approvalPartitions,
            zeroVarianceCount: approvalPartitions.filter(
              (part) => part.varianceBase === 0n,
            ).length,
            proposedMovementLines: approvalPartitions.filter(
              (part) => part.varianceBase !== 0n,
            ).length,
          }
        : {}),
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
    const { identity } = await requireCapability(ctx, "inventory.count.submit");
    if (validateHeader(args.header, HEADER).length)
      throw new ConvexError("invalid_format: header must match count template");
    const ref = cell(args.rows[0]!, "count_reference");
    const { existing, chunkHash } = await replay(ctx, "cycle_count", args, ref);
    if (existing) {
      for (const locationId of existing.locationIds ?? [])
        await requireLocationCapability(
          ctx,
          "inventory.count.submit",
          locationId,
        );
      return duplicateResult(existing);
    }
    const result = await validate(ctx, args.rows);
    if (!result.errors.length && result.session) {
      await assertFreshSnapshot(ctx, result.session, result.expected);
      await submitCount(ctx, {
        sessionId: result.session._id,
        lines: result.observations,
      });
    }
    const runId = await record(
      ctx,
      "cycle_count",
      args,
      chunkHash,
      identity.tokenIdentifier,
      result.errors,
      {
        sourceReference: ref,
        locationIds: result.session ? [result.session.locationId] : [],
        sessionId: result.errors.length ? undefined : result.session?._id,
      },
    );
    return {
      runId,
      adjustmentId: undefined,
      sessionId: result.errors.length ? undefined : result.session?._id,
      accepted: result.errors.length ? 0 : result.observations.length,
      failed: new Set(result.errors.map((e) => e.rowNumber)).size,
      duplicate: false,
      errors: result.errors.slice(0, MAX_IMPORT_ERRORS),
    };
  },
});
