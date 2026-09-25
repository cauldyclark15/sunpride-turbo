import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import { readableLocationIds } from "../inventory/location_scope";
import { customerAccessible } from "./orders";
import { ConvexError } from "convex/values";
import schema from "../schema";

export const products = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(schema.doc("products")),
  handler: async (ctx, args) => {
    await requireCapability(ctx, "inventory.read");
    return ctx.db.query("products").take(Math.min(args.limit ?? 50, 100));
  },
});
export const customers = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(schema.doc("customers")),
  handler: async (ctx, args) => {
    const { identity, profile } = await requireCapability(ctx, "report.read");
    const rows = await ctx.db
      .query("customers")
      .take(Math.min(args.limit ?? 50, 100));
    const visible = [];
    for (const row of rows)
      if (
        await customerAccessible(
          ctx,
          row,
          profile,
          identity.tokenIdentifier,
          profile.role === "sales",
        )
      )
        visible.push(row);
    return visible;
  },
});
export const warehouses = query({
  args: {},
  returns: v.array(schema.doc("warehouses")),
  handler: async (ctx) => {
    const readable = await readableLocationIds(ctx);
    const locations = await ctx.db.query("inventoryLocations").take(501);
    if (locations.length > 500)
      throw new ConvexError("Location catalog exceeds supported limit");
    const warehouseIds = new Set<string>();
    for (const location of locations)
      if (location.warehouseId && (await readable(location._id)))
        warehouseIds.add(location.warehouseId);
    const warehouses = await ctx.db.query("warehouses").take(50);
    return warehouses.filter((warehouse) => warehouseIds.has(warehouse._id));
  },
});
