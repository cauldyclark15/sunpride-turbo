import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireCapability } from "../lib/capabilities";
import { requireNationalScope } from "../lib/scope";

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
    const { profile } = await requireCapability(ctx, "inventory.read");
    // Legacy balances have warehouse codes, not scoped location IDs. Fail closed.
    if (profile.role !== "analyst")
      await requireNationalScope(ctx, [
        "admin",
        "operations",
        "manager",
        "approver",
        "sales",
        "viewer",
      ]);
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
