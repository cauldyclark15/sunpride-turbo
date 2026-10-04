import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { audit, normalizeCode } from "../org/validation";
import {
  assertActiveOutlet,
  requireOutletCapability,
} from "../outlets/validation";
import {
  accountFor,
  cleanHeader,
  cleanPricing,
  headerDTO,
  usableProduct,
} from "./model";
import {
  callSheetHeaderValidator,
  callSheetTemplateLineValidator,
  MAX_CALL_SHEET_LINES,
} from "./validators";

const nullableText = v.union(v.string(), v.null());
export const headerDTOValidator = v.object({
  accountName: v.string(),
  address: nullableText,
  buyerName: nullableText,
  contactNumber: nullableText,
  accountInCharge: nullableText,
  receivingInCharge: nullableText,
  distributorName: nullableText,
  distributorSchedule: nullableText,
  foc: nullableText,
  pricing: nullableText,
});
const productOption = v.object({
  productId: v.id("products"),
  code: v.string(),
  name: v.string(),
  uom: v.string(),
  category: v.string(),
});

/** Null when the caller may not read the outlet; never leaks which check failed. */
async function readableOutlet(ctx: QueryCtx, outletId: Id<"outlets">) {
  try {
    return await requireOutletCapability(ctx, "outlet.read", outletId);
  } catch (error) {
    if (error instanceof ConvexError) return null;
    throw error;
  }
}

async function canManage(ctx: QueryCtx, outletId: Id<"outlets">) {
  try {
    await requireOutletCapability(ctx, "outlet.manage", outletId);
    return true;
  } catch (error) {
    if (error instanceof ConvexError) return false;
    throw error;
  }
}

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(
      v.object({
        outletId: v.id("outlets"),
        outletCode: v.string(),
        outletName: v.string(),
        accountName: v.string(),
        lineCount: v.number(),
        revision: v.number(),
        updatedAt: v.number(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { paginationOpts }) => {
    await requireCapability(ctx, "outlet.read");
    if (
      !Number.isInteger(paginationOpts.numItems) ||
      paginationOpts.numItems < 1 ||
      paginationOpts.numItems > 50
    )
      throw new ConvexError("Page size must be 1–50");
    const result = await ctx.db
      .query("callSheetAccounts")
      .withIndex("by_organizationId_and_updatedAt", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .order("desc")
      .paginate(paginationOpts);
    const page = [];
    for (const row of result.page) {
      const scope = await readableOutlet(ctx, row.outletId);
      if (!scope) continue;
      page.push({
        outletId: row.outletId,
        outletCode: scope.outlet.code,
        outletName: scope.outlet.name,
        accountName: row.header.accountName,
        lineCount: row.lines.length,
        revision: row.revision,
        updatedAt: row.updatedAt,
      });
    }
    return {
      page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const outletByCode = query({
  args: { code: v.string() },
  returns: v.union(
    v.object({ id: v.id("outlets"), code: v.string(), name: v.string() }),
    v.null(),
  ),
  handler: async (ctx, { code }) => {
    await requireCapability(ctx, "outlet.read");
    let normalized: string;
    try {
      normalized = normalizeCode(code);
    } catch {
      return null;
    }
    const outlet = await ctx.db
      .query("outlets")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("code", normalized),
      )
      .unique();
    if (!outlet || !(await readableOutlet(ctx, outlet._id))) return null;
    return { id: outlet._id, code: outlet.code, name: outlet.name };
  },
});

export const detail = query({
  args: { outletId: v.id("outlets") },
  returns: v.object({
    outlet: v.object({
      id: v.id("outlets"),
      code: v.string(),
      name: v.string(),
      address: nullableText,
      status: v.string(),
    }),
    canEdit: v.boolean(),
    account: v.union(
      v.object({
        revision: v.number(),
        updatedAt: v.number(),
        header: headerDTOValidator,
        lines: v.array(
          v.object({
            productId: v.id("products"),
            code: v.string(),
            name: v.string(),
            uom: v.string(),
            pricing: nullableText,
            active: v.boolean(),
          }),
        ),
      }),
      v.null(),
    ),
  }),
  handler: async (ctx, { outletId }) => {
    const { outlet } = await requireOutletCapability(
      ctx,
      "outlet.read",
      outletId,
    );
    const account = await accountFor(ctx, outletId);
    const lines = [];
    for (const line of account?.lines ?? []) {
      const product = await ctx.db.get(line.productId);
      lines.push({
        productId: line.productId,
        code: product?.code ?? "",
        name: product?.name ?? "Removed product",
        uom: product?.uom ?? "",
        pricing: line.pricing ?? null,
        active: usableProduct(product),
      });
    }
    return {
      outlet: {
        id: outlet._id,
        code: outlet.code,
        name: outlet.name,
        address: outlet.address ?? null,
        status: outlet.status,
      },
      canEdit: await canManage(ctx, outletId),
      account: account
        ? {
            revision: account.revision,
            updatedAt: account.updatedAt,
            header: headerDTO(account.header),
            lines,
          }
        : null,
    };
  },
});

/** Product picker for the account's rows; outlet managers only. */
export const productSearch = query({
  args: { prefix: v.string() },
  returns: v.array(productOption),
  handler: async (ctx, { prefix }) => {
    await requireCapability(ctx, "outlet.manage");
    const code = prefix.trim().toUpperCase();
    if (!code || code.length > 40) return [];
    const rows = await ctx.db
      .query("products")
      .withIndex("by_code", (q) =>
        q.gte("code", code).lt("code", `${code}\uffff`),
      )
      .take(50);
    return rows
      .filter(usableProduct)
      .slice(0, 20)
      .map((p) => ({
        productId: p._id,
        code: p.code,
        name: p.name,
        uom: p.uom,
        category: p.category,
      }));
  },
});

export const save = mutation({
  args: {
    outletId: v.id("outlets"),
    expectedRevision: v.union(v.number(), v.null()),
    header: callSheetHeaderValidator,
    lines: v.array(callSheetTemplateLineValidator),
  },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const { identity, outlet } = await requireOutletCapability(
      ctx,
      "outlet.manage",
      args.outletId,
    );
    assertActiveOutlet(outlet);
    if (args.lines.length > MAX_CALL_SHEET_LINES)
      throw new ConvexError(
        `A call sheet holds at most ${MAX_CALL_SHEET_LINES} products`,
      );
    if (
      new Set(args.lines.map((line) => line.productId)).size !==
      args.lines.length
    )
      throw new ConvexError("Each product can appear once");
    const lines = [];
    for (const line of args.lines) {
      if (!usableProduct(await ctx.db.get(line.productId)))
        throw new ConvexError("Product is inactive or unknown");
      const pricing = cleanPricing(line.pricing);
      lines.push({
        productId: line.productId,
        ...(pricing ? { pricing } : {}),
      });
    }
    const header = cleanHeader(args.header);
    const existing = await accountFor(ctx, args.outletId);
    if ((existing?.revision ?? null) !== args.expectedRevision)
      throw new ConvexError(
        "This call sheet changed since you opened it. Reload and try again.",
      );
    const now = Date.now();
    const revision = (existing?.revision ?? 0) + 1;
    const row = {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      outletId: args.outletId,
      revision,
      header,
      lines,
      updatedAt: now,
      updatedBy: identity.tokenIdentifier,
    };
    if (existing) {
      await ctx.db.insert("callSheetAccountRevisions", {
        organizationId: SUNPRIDE_ORGANIZATION_ID,
        outletId: args.outletId,
        revision: existing.revision,
        productIds: existing.lines.map((line) => line.productId),
        effectiveFrom: existing.updatedAt,
        supersededAt: now,
      });
      await ctx.db.replace(existing._id, row);
    } else await ctx.db.insert("callSheetAccounts", row);
    await audit(
      ctx,
      identity.tokenIdentifier,
      existing ? "call_sheet.account_updated" : "call_sheet.account_created",
      "outlet",
      args.outletId,
      `revision ${revision}, ${lines.length} products`,
      now,
    );
    return { revision };
  },
});
