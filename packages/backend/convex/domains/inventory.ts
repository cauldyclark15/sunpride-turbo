import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireIdentity } from "../lib/auth";

const balance = v.object({
  _id: v.id("inventoryBalances"),
  _creationTime: v.number(),
  productCode: v.string(),
  warehouseCode: v.string(),
  onHand: v.number(),
  reserved: v.number(),
  available: v.number(),
  asOf: v.number(),
});
export const list = query({
  args: { warehouseCode: v.optional(v.string()) },
  returns: v.array(balance),
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    return args.warehouseCode
      ? ctx.db
          .query("inventoryBalances")
          .withIndex("by_warehouse", (q) =>
            q.eq("warehouseCode", args.warehouseCode!),
          )
          .take(100)
      : ctx.db.query("inventoryBalances").take(100);
  },
});
