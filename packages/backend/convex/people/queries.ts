import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { query } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import { collectScopeUnitIds } from "../lib/scope";
import { topology } from "../org/validation";
import schema from "../schema";

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(schema.doc("profiles")),
  handler: async (ctx, args) => {
    const { profile } = await requireCapability(ctx, "people.read");
    if (args.paginationOpts.numItems < 1 || args.paginationOpts.numItems > 100)
      throw new ConvexError("Page size must be 1–100");
    const scope =
      profile.role === "super_admin" || profile.role === "analyst"
        ? null
        : profile.orgUnitId
          ? new Set(await collectScopeUnitIds(ctx, profile.orgUnitId))
          : new Set();
    const result = await ctx.db.query("profiles").paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.filter(
        (p) => !scope || (p.orgUnitId && scope.has(p.orgUnitId)),
      ),
    };
  },
});

export const supervisorOptions = query({
  args: {
    orgUnitId: v.id("orgUnits"),
    search: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(schema.doc("profiles")),
  handler: async (ctx, args) => {
    await requireCapability(ctx, "people.read", args.orgUnitId);
    if (
      !Number.isInteger(args.paginationOpts.numItems) ||
      args.paginationOpts.numItems < 1 ||
      args.paginationOpts.numItems > 50
    )
      throw new ConvexError("Page size must be 1–50");
    const nodes = await topology(ctx, Date.now());
    const parents = new Map(nodes.map((node) => [node._id, node.parentId]));
    if (!parents.has(args.orgUnitId))
      throw new ConvexError("Inactive organization unit");
    const { profile } = await requireCapability(ctx, "people.read");
    const scope =
      profile.role === "super_admin" || profile.role === "analyst"
        ? null
        : new Set(
            profile.orgUnitId
              ? await collectScopeUnitIds(ctx, profile.orgUnitId)
              : [],
          );
    const ancestors = new Set<string>();
    let cursor = args.orgUnitId;
    while (cursor) {
      ancestors.add(cursor);
      const parent = parents.get(cursor);
      if (!parent) break;
      cursor = parent;
    }
    const prefix = args.search?.trim().toLocaleLowerCase() ?? "";
    const result = await ctx.db.query("profiles").paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.filter(
        (person) =>
          person.status === "active" &&
          (person.role === "manager" ||
            person.role === "admin" ||
            person.role === "super_admin") &&
          person.orgUnitId !== undefined &&
          ancestors.has(person.orgUnitId) &&
          (!scope || scope.has(person.orgUnitId)) &&
          (!prefix ||
            [person.name, person.email, person.employeeCode ?? ""].some(
              (value) => value.toLocaleLowerCase().startsWith(prefix),
            )),
      ),
    };
  },
});

export const history = query({
  args: { profileId: v.id("profiles") },
  returns: v.array(schema.doc("employeeAssignments")),
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.profileId);
    if (!target) throw new ConvexError("Profile not found");
    if (target.orgUnitId)
      await requireCapability(ctx, "people.read", target.orgUnitId);
    else {
      const { profile } = await requireCapability(ctx, "people.read");
      if (profile.role !== "super_admin")
        throw new ConvexError(
          "Requested scope is outside your organizational scope",
        );
    }
    const { profile } = await requireCapability(ctx, "people.read");
    const scope =
      profile.role === "super_admin" || profile.role === "analyst"
        ? null
        : new Set(
            profile.orgUnitId
              ? await collectScopeUnitIds(ctx, profile.orgUnitId)
              : [],
          );
    const rows = await ctx.db
      .query("employeeAssignments")
      .withIndex("by_profileId_and_effectiveFrom", (q) =>
        q.eq("profileId", target._id),
      )
      .take(500);
    return rows.filter(
      (row) => !scope || (row.orgUnitId && scope.has(row.orgUnitId)),
    );
  },
});
