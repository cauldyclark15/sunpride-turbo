import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireIdentity } from "../lib/auth";

const product = v.object({
  _id: v.id("products"),
  _creationTime: v.number(),
  code: v.string(),
  name: v.string(),
  category: v.string(),
  uom: v.string(),
  unitPrice: v.number(),
  active: v.boolean(),
  externalId: v.optional(v.string()),
  updatedAt: v.number(),
});
const customer = v.object({
  _id: v.id("customers"),
  _creationTime: v.number(),
  code: v.string(),
  name: v.string(),
  channel: v.string(),
  territory: v.string(),
  creditLimit: v.number(),
  active: v.boolean(),
  externalId: v.optional(v.string()),
  updatedAt: v.number(),
});
const warehouse = v.object({
  _id: v.id("warehouses"),
  _creationTime: v.number(),
  code: v.string(),
  name: v.string(),
  location: v.string(),
  active: v.boolean(),
  externalId: v.optional(v.string()),
  updatedAt: v.number(),
});

export const products = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(product),
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    return ctx.db.query("products").take(Math.min(args.limit ?? 50, 100));
  },
});
export const customers = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(customer),
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    return ctx.db.query("customers").take(Math.min(args.limit ?? 50, 100));
  },
});
export const warehouses = query({
  args: {},
  returns: v.array(warehouse),
  handler: async (ctx) => {
    await requireIdentity(ctx);
    return ctx.db.query("warehouses").take(50);
  },
});
