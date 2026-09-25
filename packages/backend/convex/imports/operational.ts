import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import {
  chunkHashOf,
  chunkKey,
  IMPORT_CHUNK_ROWS,
  MAX_IMPORT_ERRORS,
  MAX_IMPORT_ROWS,
  type ImportRow,
  type ImportType,
  type RowError,
} from "./shared";

export type OperationalArgs = {
  runKey: string;
  chunkIndex: number;
  idempotencyKey: string;
  fileHash: string;
  rows: ImportRow[];
  rowCount: number;
  header?: string[];
};

/** Operational templates are fixed, ordered schemas; reject the file before inspecting rows. */
export function validateHeader(
  header: string[] | undefined,
  template: string,
): RowError[] {
  if (header === undefined) return []; // Older API clients send parsed rows only.
  const expected = template.split(",");
  if (
    header.length === expected.length &&
    header.every((name, index) => name === expected[index])
  )
    return [];
  return [
    {
      rowNumber: 1,
      column: "header",
      code: "invalid_format",
      message: `Header must exactly match: ${template}`,
    },
  ];
}

export async function replay(
  ctx: MutationCtx,
  type: ImportType,
  args: OperationalArgs,
  source: string,
) {
  if (
    !args.runKey.trim() ||
    !args.fileHash.trim() ||
    !Number.isInteger(args.chunkIndex) ||
    args.chunkIndex < 0 ||
    args.idempotencyKey !== chunkKey(type, args.runKey, args.chunkIndex)
  )
    throw new ConvexError("Invalid import key");
  if (
    !Number.isInteger(args.rowCount) ||
    args.rowCount < args.rows.length ||
    args.rowCount > MAX_IMPORT_ROWS ||
    args.rows.length < 1 ||
    args.rows.length > IMPORT_CHUNK_ROWS
  )
    throw new ConvexError("too_many_rows: invalid file/chunk size");
  const chunkHash = chunkHashOf(args.chunkIndex, args.rows, source);
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
      existing.importType !== type ||
      existing.fileHash !== args.fileHash ||
      existing.chunkHash !== chunkHash ||
      existing.rowCount !== args.rows.length ||
      existing.fileRowCount !== args.rowCount
    )
      throw new ConvexError("Idempotency key reused with a different payload");
    return { chunkHash, existing };
  }
  const priorRun = await ctx.db
    .query("importRuns")
    .withIndex("by_organizationId_and_runKey", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("runKey", args.runKey),
    )
    .take(200);
  if (
    priorRun.some(
      (run) =>
        run.importType === type &&
        (run.fileHash !== args.fileHash ||
          run.fileRowCount !== args.rowCount ||
          (type === "stock_adjustment" && run.sourceReference !== source)),
    )
  )
    throw new ConvexError("Run key reused with a different file");
  const duplicate = await ctx.db
    .query("importRuns")
    .withIndex("by_organizationId_and_type_and_fileHash", (q) =>
      q
        .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
        .eq("importType", type)
        .eq("fileHash", args.fileHash),
    )
    .first();
  if (duplicate && duplicate.runKey !== args.runKey) {
    if (duplicate.fileRowCount !== args.rowCount)
      throw new ConvexError("File hash reused with a different payload");
    const matchingChunk = await ctx.db
      .query("importRuns")
      .withIndex("by_organizationId_and_runKey", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("runKey", duplicate.runKey),
      )
      .take(200);
    const original = matchingChunk.find(
      (run) => run.importType === type && run.chunkIndex === args.chunkIndex,
    );
    if (original && original.chunkHash !== chunkHash)
      throw new ConvexError("File hash reused with a different payload");
    return { chunkHash, existing: original ?? duplicate };
  }
  return { chunkHash, existing: null };
}

export async function record(
  ctx: MutationCtx,
  type: "stock_adjustment" | "cycle_count",
  args: OperationalArgs,
  chunkHash: string,
  actor: string,
  errors: RowError[],
  fields: {
    sourceReference: string;
    rowKeys?: string[];
    adjustmentType?: string;
    reasonCode?: string;
    locationIds: Id<"inventoryLocations">[];
    adjustmentId?: Id<"inventoryAdjustments">;
    sessionId?: Id<"stockCountSessions">;
  },
) {
  const now = Date.now();
  const failedCount = new Set(errors.map((e) => e.rowNumber)).size;
  const runId = await ctx.db.insert("importRuns", {
    organizationId: SUNPRIDE_ORGANIZATION_ID,
    importType: type,
    runKey: args.runKey,
    chunkIndex: args.chunkIndex,
    fileHash: args.fileHash,
    chunkHash,
    idempotencyKey: args.idempotencyKey,
    actorSubject: actor,
    status: errors.length ? "failed" : "submitted",
    rowCount: args.rows.length,
    fileRowCount: args.rowCount,
    createdCount: errors.length ? 0 : args.rows.length,
    updatedCount: 0,
    skippedCount: 0,
    failedCount,
    createdAt: now,
    completedAt: now,
    ...fields,
  });
  for (const error of errors.slice(0, MAX_IMPORT_ERRORS))
    await ctx.db.insert("importRunErrors", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      runId,
      rowNumber: error.rowNumber,
      ...(error.column ? { column: error.column } : {}),
      code: error.code,
      message: error.message,
      rawRow: JSON.stringify(
        args.rows.find((r) => r.rowNumber === error.rowNumber)?.values ?? {},
      ).slice(0, 500),
      createdAt: now,
    });
  return runId;
}

export function duplicateResult(run: Doc<"importRuns">) {
  return {
    runId: run._id,
    adjustmentId: run.adjustmentId,
    sessionId: run.sessionId,
    accepted: run.createdCount,
    failed: run.failedCount,
    duplicate: true,
    errors: [] as RowError[],
  };
}
