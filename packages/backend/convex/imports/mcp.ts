import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { mergeDraftImport, type DraftImportRow } from "../coverage/plans";
import {
  assertOutletsScoped,
  bounded,
  employeeAt,
  localDate,
  MAX_PLAN_ROWS,
  planAccess,
  planRows,
} from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { outletRows, resolveOutletScopeAt } from "../outlets/validation";
import { at, routeAt, routeSalespeople } from "../territories/route_validation";
import { resolveTerritoryOwnerAt } from "../territories/validation";
import {
  cell,
  chunkHashOf,
  chunkKey,
  IMPORT_CHUNK_ROWS,
  importRowValidator,
  normalizeCode,
  parseCsvInteger,
  rowError,
  rowErrorValidator,
  type ImportRow,
  type RowError,
} from "./shared";

export const MCP_HEADERS = {
  mcp_visits:
    "employee_code,territory_code,route_code,outlet_code,customer_code,service_date,frequency,sequence,duration_minutes,objectives",
  route_sheet:
    "employee_code,territory_code,route_code,outlet_code,customer_code,frequency,sequence,duration_minutes,objectives",
} as const;
const formatValidator = v.union(
  v.literal("mcp_visits"),
  v.literal("route_sheet"),
);
type Format = keyof typeof MCP_HEADERS;
const input = {
  planId: v.id("coveragePlans"),
  format: formatValidator,
  header: v.array(v.string()),
  rows: v.array(importRowValidator),
  fileHash: v.string(),
  rowCount: v.number(),
};
const acceptedValidator = v.object({
  rowNumber: v.number(),
  employeeId: v.id("profiles"),
  territoryId: v.id("territories"),
  routeId: v.optional(v.id("routes")),
  outletId: v.id("outlets"),
  customerId: v.optional(v.id("customers")),
});
const resultValidator = v.object({
  accepted: v.array(acceptedValidator),
  rejected: v.array(rowErrorValidator),
  fileHash: v.string(),
  rowCount: v.number(),
});
type Ctx = QueryCtx | MutationCtx;

async function authorizedPlan(
  ctx: Ctx,
  planId: Id<"coveragePlans">,
  key: "mcp.plan" | "mcp.read",
) {
  const plan = await ctx.db.get(planId);
  if (!plan || plan.organizationId !== SUNPRIDE_ORGANIZATION_ID)
    throw new ConvexError("Plan not found");
  const access = await planAccess(ctx, plan, key);
  const authoring = await employeeAt(
    ctx,
    plan.assigneeProfileId,
    Math.max(plan.effectiveFrom, Date.now()),
  );
  await requireCapability(ctx, key, authoring.orgUnitId!);
  if (authoring.orgUnitId !== plan.orgUnitId)
    throw new ConvexError("Assignee unit changed; revise plan");
  const existing = await planRows(ctx, planId);
  await assertOutletsScoped(
    ctx,
    [
      ...existing.outlets.map((row) => row.outletId),
      ...existing.slots.flatMap((row) => (row.outletId ? [row.outletId] : [])),
    ],
    key,
  );
  return { plan, existing, actor: access.identity.tokenIdentifier };
}

function checkInput(
  format: Format,
  header: string[],
  rows: ImportRow[],
  fileHash: string,
  rowCount: number,
  chunkIndex?: number,
) {
  if (!fileHash.trim() || fileHash.length > 150)
    throw new ConvexError("Invalid file hash");
  if (
    header.join(",") !== MCP_HEADERS[format] ||
    header.length !== MCP_HEADERS[format].split(",").length
  )
    throw new ConvexError(
      `invalid_format: header must exactly match ${MCP_HEADERS[format]}`,
    );
  if (
    !Number.isSafeInteger(rowCount) ||
    rowCount < 1 ||
    rowCount > MAX_PLAN_ROWS ||
    rows.length < 1 ||
    rows.length > (chunkIndex === undefined ? MAX_PLAN_ROWS : IMPORT_CHUNK_ROWS)
  )
    throw new ConvexError(
      "too_many_rows: file/chunk must contain 1–500/100 rows",
    );
  if (
    chunkIndex !== undefined &&
    (!Number.isSafeInteger(chunkIndex) ||
      chunkIndex < 0 ||
      chunkIndex >= Math.ceil(rowCount / IMPORT_CHUNK_ROWS))
  )
    throw new ConvexError("Invalid chunk index");
  const numbers = new Set<number>();
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.rowNumber) ||
      row.rowNumber < 2 ||
      row.rowNumber > 10_001 ||
      numbers.has(row.rowNumber)
    )
      throw new ConvexError("Invalid or duplicate spreadsheet row number");
    numbers.add(row.rowNumber);
    if (
      Object.keys(row.values).some((key) => !header.includes(key)) ||
      Object.values(row.values).some((value) => value.length > 500)
    )
      throw new ConvexError("Invalid row columns or cell length");
  }
}

async function match<T>(
  promise: Promise<T[]>,
  row: ImportRow,
  column: string,
  errors: RowError[],
): Promise<T | null> {
  const found = await promise;
  if (found.length !== 1)
    errors.push(
      rowError(
        row.rowNumber,
        "unknown_reference",
        found.length ? "Ambiguous local code" : "Unknown local code",
        column,
      ),
    );
  return found.length === 1 ? found[0]! : null;
}

async function validate(
  ctx: Ctx,
  plan: Doc<"coveragePlans">,
  existing: Awaited<ReturnType<typeof planRows>>,
  format: Format,
  rows: ImportRow[],
) {
  const accepted: {
    rowNumber: number;
    employeeId: Id<"profiles">;
    territoryId: Id<"territories">;
    routeId?: Id<"routes">;
    outletId: Id<"outlets">;
    customerId?: Id<"customers">;
  }[] = [];
  const additions: DraftImportRow[] = [];
  const rejected: RowError[] = [];
  const seen = new Set<string>();
  const oldOutlets = new Set(existing.outlets.map((row) => row.outletId));
  const oldSlots = new Set(
    existing.slots
      .filter((row) => row.outletId)
      .map((row) => `${row.serviceDate}:${row.outletId}`),
  );
  const newOutlets = new Set<Id<"outlets">>();
  const visitCount = existing.slots.length;
  for (const row of rows) {
    const errors: RowError[] = [];
    const code = (name: string) => normalizeCode(cell(row, name));
    for (const name of [
      "employee_code",
      "territory_code",
      "outlet_code",
      "frequency",
      "sequence",
      "duration_minutes",
      ...(format === "mcp_visits" ? ["service_date"] : []),
    ])
      if (!cell(row, name))
        errors.push(
          rowError(
            row.rowNumber,
            "required_missing",
            `${name} is required`,
            name,
          ),
        );
    const employee = code("employee_code")
      ? await match(
          ctx.db
            .query("profiles")
            .withIndex("by_employeeCode", (q) =>
              q.eq("employeeCode", code("employee_code")),
            )
            .take(2),
          row,
          "employee_code",
          errors,
        )
      : null;
    if (
      employee &&
      (employee._id !== plan.assigneeProfileId || employee.status !== "active")
    )
      errors.push(
        rowError(
          row.rowNumber,
          "scope_denied",
          "Employee is not the plan assignee",
          "employee_code",
        ),
      );
    const territory = code("territory_code")
      ? await match(
          ctx.db
            .query("territories")
            .withIndex("by_organizationId_and_code", (q) =>
              q
                .eq("organizationId", plan.organizationId)
                .eq("code", code("territory_code")),
            )
            .take(2),
          row,
          "territory_code",
          errors,
        )
      : null;
    const route = code("route_code")
      ? await match(
          ctx.db
            .query("routes")
            .withIndex("by_organizationId_and_code", (q) =>
              q
                .eq("organizationId", plan.organizationId)
                .eq("code", code("route_code")),
            )
            .take(2),
          row,
          "route_code",
          errors,
        )
      : null;
    const outlet = code("outlet_code")
      ? await match(
          ctx.db
            .query("outlets")
            .withIndex("by_organizationId_and_code", (q) =>
              q
                .eq("organizationId", plan.organizationId)
                .eq("code", code("outlet_code")),
            )
            .take(2),
          row,
          "outlet_code",
          errors,
        )
      : null;
    const customer = code("customer_code")
      ? await match(
          ctx.db
            .query("customers")
            .withIndex("by_code", (q) => q.eq("code", code("customer_code")))
            .take(2),
          row,
          "customer_code",
          errors,
        )
      : null;
    if (territory?.status !== "active" && territory)
      errors.push(
        rowError(
          row.rowNumber,
          "inactive_reference",
          "Territory inactive",
          "territory_code",
        ),
      );
    if (route?.status !== "active" && route)
      errors.push(
        rowError(
          row.rowNumber,
          "inactive_reference",
          "Route inactive",
          "route_code",
        ),
      );
    if (outlet?.status === "inactive")
      errors.push(
        rowError(
          row.rowNumber,
          "inactive_reference",
          "Outlet inactive",
          "outlet_code",
        ),
      );
    if (customer && !customer.active)
      errors.push(
        rowError(
          row.rowNumber,
          "inactive_reference",
          "Customer inactive",
          "customer_code",
        ),
      );
    const date = cell(row, "service_date");
    let instant: number | undefined;
    if (format === "mcp_visits" && date) {
      try {
        instant = localDate(date);
        if (
          !date.startsWith(`${plan.localMonth}-`) ||
          instant < plan.effectiveFrom ||
          instant >= plan.effectiveTo
        )
          throw new Error("outside plan");
      } catch {
        errors.push(
          rowError(
            row.rowNumber,
            "invalid_date",
            "Service date must be a valid Manila date in the plan period",
            "service_date",
          ),
        );
      }
    }
    const frequency = cell(row, "frequency").toLowerCase();
    if (
      !["weekly", "biweekly", "monthly", "custom"].includes(frequency) ||
      (format === "route_sheet" && frequency === "custom")
    )
      errors.push(
        rowError(
          row.rowNumber,
          "invalid_format",
          "Frequency must be weekly, biweekly or monthly (custom requires a dated visit)",
          "frequency",
        ),
      );
    const sequence = parseCsvInteger(cell(row, "sequence"));
    const duration = parseCsvInteger(cell(row, "duration_minutes"));
    if (sequence === null || sequence <= 0)
      errors.push(
        rowError(
          row.rowNumber,
          "invalid_format",
          "Positive integer sequence required",
          "sequence",
        ),
      );
    if (duration === null || duration <= 0)
      errors.push(
        rowError(
          row.rowNumber,
          "invalid_format",
          "Positive integer duration required",
          "duration_minutes",
        ),
      );
    const objectives = cell(row, "objectives")
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean);
    if (objectives.some((x) => x.length > 500))
      errors.push(
        rowError(
          row.rowNumber,
          "invalid_format",
          "Objective too long",
          "objectives",
        ),
      );
    if (outlet && territory) {
      // Current ownership is an authorization boundary even for a future service date.
      try {
        const current = await resolveOutletScopeAt(ctx, outlet._id, Date.now());
        await requireCapability(ctx, "mcp.plan", current.orgUnitId);
        const authoring = await resolveOutletScopeAt(
          ctx,
          outlet._id,
          Math.max(plan.effectiveFrom, Date.now()),
        );
        await requireCapability(ctx, "mcp.plan", authoring.orgUnitId);
        if (
          authoring.assignment?.territoryId !== territory._id ||
          authoring.assignment.routeId !== route?._id
        )
          errors.push(
            rowError(
              row.rowNumber,
              "assignment_mismatch",
              "Outlet territory/route differs from current assignment",
              "outlet_code",
            ),
          );
        if (instant !== undefined) {
          const dated = await resolveOutletScopeAt(ctx, outlet._id, instant);
          await requireCapability(ctx, "mcp.plan", dated.orgUnitId);
          if (
            dated.assignment?.territoryId !== territory._id ||
            dated.assignment.routeId !== route?._id
          )
            errors.push(
              rowError(
                row.rowNumber,
                "assignment_mismatch",
                "Outlet territory/route differs on service date",
                "service_date",
              ),
            );
        }
      } catch {
        errors.push(
          rowError(
            row.rowNumber,
            "scope_denied",
            "Outlet or dated assignment outside scope",
            "outlet_code",
          ),
        );
      }
      const links = await outletRows(ctx, "outletCustomerLinks", outlet._id);
      const link = at(
        links,
        instant ?? Math.max(plan.effectiveFrom, Date.now()),
      );
      if (customer && link?.customerId !== customer._id)
        errors.push(
          rowError(
            row.rowNumber,
            "customer_mismatch",
            "Customer is not the effective outlet link",
            "customer_code",
          ),
        );
      if (link && !customer) {
        const linked = await ctx.db.get(link.customerId);
        if (!linked?.active)
          errors.push(
            rowError(
              row.rowNumber,
              "inactive_reference",
              "Linked customer inactive",
              "outlet_code",
            ),
          );
      }
    }
    if (territory) {
      const asOf = instant ?? Math.max(plan.effectiveFrom, Date.now());
      const owner = await resolveTerritoryOwnerAt(ctx, territory._id, asOf);
      if (!owner || owner.orgUnitId !== plan.orgUnitId)
        errors.push(
          rowError(
            row.rowNumber,
            "scope_denied",
            "Territory not owned by assignee unit",
            "territory_code",
          ),
        );
      if (route) {
        try {
          const active = await routeAt(ctx, route._id, asOf);
          if (active.association?.territoryId !== territory._id)
            throw new Error("route territory mismatch");
          const people = at(await routeSalespeople(ctx, route._id), asOf);
          if (people?.profileId !== plan.assigneeProfileId)
            throw new Error("route salesperson mismatch");
        } catch {
          errors.push(
            rowError(
              row.rowNumber,
              "assignment_mismatch",
              "Route not assigned to territory/assignee at date",
              "route_code",
            ),
          );
        }
      } else if (!code("route_code")) {
        const people = await bounded(
          ctx.db
            .query("territorySalespeople")
            .withIndex("by_territoryId_and_effectiveFrom", (q) =>
              q.eq("territoryId", territory._id),
            )
            .take(MAX_PLAN_ROWS + 1),
          "Territory salesperson history",
        );
        if (at(people, asOf)?.profileId !== plan.assigneeProfileId)
          errors.push(
            rowError(
              row.rowNumber,
              "assignment_mismatch",
              "Territory not assigned to assignee at date",
              "territory_code",
            ),
          );
      }
    }
    if (instant !== undefined) {
      try {
        const assignment = await employeeAt(
          ctx,
          plan.assigneeProfileId,
          instant,
        );
        if (assignment.orgUnitId !== plan.orgUnitId)
          throw new Error("unit mismatch");
      } catch {
        errors.push(
          rowError(
            row.rowNumber,
            "scope_denied",
            "Assignee not assigned to plan unit on service date",
            "service_date",
          ),
        );
      }
    }
    if (outlet) {
      const key =
        format === "mcp_visits" ? `${date}:${outlet._id}` : `${outlet._id}`;
      if (
        seen.has(key) ||
        (format === "mcp_visits"
          ? oldSlots.has(key)
          : oldOutlets.has(outlet._id))
      )
        errors.push(
          rowError(
            row.rowNumber,
            "duplicate_in_file",
            "Duplicate draft outlet/visit, including earlier chunks",
            "outlet_code",
          ),
        );
      if (
        oldOutlets.size +
          newOutlets.size +
          (oldOutlets.has(outlet._id) || newOutlets.has(outlet._id) ? 0 : 1) >
          MAX_PLAN_ROWS ||
        visitCount + (format === "mcp_visits" ? accepted.length + 1 : 0) >
          MAX_PLAN_ROWS
      )
        errors.push(
          rowError(
            row.rowNumber,
            "too_many_rows",
            "Plan exceeds 500 rows",
            "outlet_code",
          ),
        );
    }
    if (errors.length) {
      rejected.push(...errors);
      continue;
    }
    if (outlet) {
      const key =
        format === "mcp_visits" ? `${date}:${outlet._id}` : `${outlet._id}`;
      seen.add(key);
      if (!oldOutlets.has(outlet._id)) newOutlets.add(outlet._id);
    }
    if (
      !employee ||
      !territory ||
      !outlet ||
      sequence === null ||
      duration === null
    )
      continue;
    accepted.push({
      rowNumber: row.rowNumber,
      employeeId: employee._id,
      territoryId: territory._id,
      routeId: route?._id,
      outletId: outlet._id,
      customerId: customer?._id,
    });
    additions.push({
      outletId: outlet._id,
      territoryId: territory._id,
      routeId: route?._id,
      serviceDate: format === "mcp_visits" ? date : undefined,
      frequency: frequency as DraftImportRow["frequency"],
      sequence,
      durationMinutes: duration,
      objectives,
    });
  }
  return { accepted, rejected, additions };
}

export const preview = query({
  args: input,
  returns: resultValidator,
  handler: async (ctx, args) => {
    checkInput(
      args.format,
      args.header,
      args.rows,
      args.fileHash,
      args.rowCount,
    );
    const { plan, existing } = await authorizedPlan(
      ctx,
      args.planId,
      "mcp.plan",
    );
    if (plan.status !== "draft")
      throw new ConvexError("Only draft plans can change");
    const result = await validate(ctx, plan, existing, args.format, args.rows);
    return {
      accepted: result.accepted,
      rejected: result.rejected,
      fileHash: args.fileHash,
      rowCount: args.rowCount,
    };
  },
});

export const commit = mutation({
  args: { ...input, chunkIndex: v.number(), sourceReference: v.string() },
  returns: v.object({
    runId: v.id("importRuns"),
    acceptedCount: v.number(),
    rejectedCount: v.number(),
    errors: v.array(rowErrorValidator),
    duplicate: v.boolean(),
  }),
  handler: async (ctx, args) => {
    checkInput(
      args.format,
      args.header,
      args.rows,
      args.fileHash,
      args.rowCount,
      args.chunkIndex,
    );
    const { plan, existing, actor } = await authorizedPlan(
      ctx,
      args.planId,
      "mcp.plan",
    );
    if (plan.status !== "draft")
      throw new ConvexError("Only draft plans can change");
    if (!args.sourceReference.trim() || args.sourceReference.length > 150)
      throw new ConvexError("Source reference required (max 150)");
    const runKey = `${args.planId}:${args.fileHash}`;
    const key = chunkKey("mcp", runKey, args.chunkIndex);
    const digest = chunkHashOf(
      args.chunkIndex,
      args.rows,
      JSON.stringify({ format: args.format, header: args.header }),
    );
    const prior = await ctx.db
      .query("importRuns")
      .withIndex("by_organizationId_and_idempotencyKey", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("idempotencyKey", key),
      )
      .unique();
    if (prior) {
      if (
        prior.importType !== "mcp" ||
        prior.mcpPlanId !== args.planId ||
        prior.chunkHash !== digest ||
        prior.fileRowCount !== args.rowCount
      )
        throw new ConvexError(
          "Idempotency key reused with a different payload",
        );
      return {
        runId: prior._id,
        acceptedCount: prior.createdCount,
        rejectedCount: prior.failedCount,
        errors: [],
        duplicate: true,
      };
    }
    const previous = await ctx.db
      .query("importRuns")
      .withIndex("by_organizationId_and_runKey", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("runKey", runKey),
      )
      .take(6);
    if (
      previous.some(
        (run) =>
          run.importType !== "mcp" ||
          run.mcpPlanId !== args.planId ||
          run.fileRowCount !== args.rowCount,
      )
    )
      throw new ConvexError("Run key reused with a different file");
    const result = await validate(ctx, plan, existing, args.format, args.rows);
    if (!result.accepted.length)
      throw new ConvexError("All rows rejected; nothing to commit");
    await mergeDraftImport(ctx, plan, actor, result.additions);
    const now = Date.now();
    const failed = new Set(result.rejected.map((error) => error.rowNumber))
      .size;
    const runId = await ctx.db.insert("importRuns", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      importType: "mcp",
      mcpPlanId: args.planId,
      runKey,
      chunkIndex: args.chunkIndex,
      fileHash: args.fileHash,
      chunkHash: digest,
      idempotencyKey: key,
      actorSubject: actor,
      status: "completed",
      sourceReference: args.sourceReference,
      rowCount: args.rows.length,
      fileRowCount: args.rowCount,
      createdCount: result.accepted.length,
      updatedCount: 0,
      skippedCount: 0,
      failedCount: failed,
      createdAt: now,
      completedAt: now,
    });
    for (const error of result.rejected)
      await ctx.db.insert("importRunErrors", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        runId,
        rowNumber: error.rowNumber,
        column: error.column,
        code: error.code,
        message: error.message,
        rawRow: JSON.stringify(
          args.rows.find((row) => row.rowNumber === error.rowNumber)?.values ??
            {},
        ).slice(0, 500),
        createdAt: now,
      });
    return {
      runId,
      acceptedCount: result.accepted.length,
      rejectedCount: failed,
      errors: result.rejected,
      duplicate: false,
    };
  },
});

const historyRow = v.object({
  runId: v.id("importRuns"),
  chunkIndex: v.number(),
  fileHash: v.string(),
  sourceReference: v.optional(v.string()),
  createdAt: v.number(),
  acceptedCount: v.number(),
  rejectedCount: v.number(),
  errors: v.array(rowErrorValidator),
});
export const history = query({
  args: {
    planId: v.id("coveragePlans"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(historyRow),
  handler: async (ctx, { planId, paginationOpts }) => {
    if (
      !Number.isSafeInteger(paginationOpts.numItems) ||
      paginationOpts.numItems < 1 ||
      paginationOpts.numItems > 20
    )
      throw new ConvexError("Page size must be 1–20");
    await authorizedPlan(ctx, planId, "mcp.read");
    const runs = await ctx.db
      .query("importRuns")
      .withIndex("by_organizationId_and_type_and_fileHash", (q) =>
        q
          .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
          .eq("importType", "mcp"),
      )
      .take(1001);
    if (runs.length > 1000)
      throw new ConvexError("MCP import history exceeds bounded scan");
    const scoped = runs
      .filter((run) => run.mcpPlanId === planId)
      .sort((a, b) => b.createdAt - a.createdAt || b.chunkIndex - a.chunkIndex);
    const start =
      paginationOpts.cursor === null ? 0 : Number(paginationOpts.cursor);
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start > scoped.length ||
      (paginationOpts.cursor !== null &&
        String(start) !== paginationOpts.cursor)
    )
      throw new ConvexError("Invalid history cursor");
    const end = Math.min(scoped.length, start + paginationOpts.numItems);
    const page = [];
    for (const run of scoped.slice(start, end)) {
      const errors = await ctx.db
        .query("importRunErrors")
        .withIndex("by_organizationId_and_runId_and_rowNumber", (q) =>
          q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("runId", run._id),
        )
        .take(101);
      if (errors.length > 100)
        throw new ConvexError("Import errors exceed page limit");
      page.push({
        runId: run._id,
        chunkIndex: run.chunkIndex,
        fileHash: run.fileHash,
        sourceReference: run.sourceReference,
        createdAt: run.createdAt,
        acceptedCount: run.createdCount,
        rejectedCount: run.failedCount,
        errors: errors.map(({ rowNumber, column, code, message }) => ({
          rowNumber,
          column,
          code,
          message,
        })),
      });
    }
    return { page, isDone: end === scoped.length, continueCursor: String(end) };
  },
});
