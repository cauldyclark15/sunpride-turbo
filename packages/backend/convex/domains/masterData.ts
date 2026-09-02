import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireIdentity } from "../lib/auth";
import schema from "../schema";

export const products = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(schema.doc("products")),
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    return ctx.db.query("products").take(Math.min(args.limit ?? 50, 100));
  },
});
export const customers = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(schema.doc("customers")),
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    return ctx.db.query("customers").take(Math.min(args.limit ?? 50, 100));
  },
});
export const warehouses = query({
  args: {},
  returns: v.array(schema.doc("warehouses")),
  handler: async (ctx) => {
    await requireIdentity(ctx);
    return ctx.db.query("warehouses").take(50);
  },
});
