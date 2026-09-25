import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { query } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds } from "../lib/scope";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import schema from "../schema";
import { topology } from "./validation";

export const tree = query({
  args: { asOf: v.number() },
  returns: v.array(schema.doc("orgUnits")),
  handler: async (ctx, args) => {
    const { profile } = await requireCapability(ctx, "org.read");
    const scope =
      profile.role === "super_admin" || profile.role === "analyst"
        ? null
        : profile.orgUnitId
          ? new Set(await collectScopeUnitIds(ctx, profile.orgUnitId))
          : new Set();
    const nodes = await topology(ctx, args.asOf);
    return scope
      ? nodes
          .filter((node) => scope.has(node._id))
          .map((node) => ({
            ...node,
            parentId:
              node.parentId && scope.has(node.parentId)
                ? node.parentId
                : undefined,
          }))
      : nodes;
  },
});

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("orgUnits")),
  handler: async (ctx, args) => {
    const { profile } = await requireCapability(ctx, "org.read");
    if (args.paginationOpts.numItems < 1 || args.paginationOpts.numItems > 100)
      throw new ConvexError("Page size must be 1–100");
    const scope =
      profile.role === "super_admin" || profile.role === "analyst"
        ? null
        : profile.orgUnitId
          ? new Set(await collectScopeUnitIds(ctx, profile.orgUnitId))
          : new Set();
    const result = await ctx.db
      .query("orgUnits")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID),
      )
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page
        .filter((u) => !scope || scope.has(u._id))
        .map((u) => ({
          ...u,
          parentId:
            scope && u.parentId && !scope.has(u.parentId)
              ? undefined
              : u.parentId,
        })),
    };
  },
});
