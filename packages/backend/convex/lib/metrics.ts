import type { MutationCtx } from "../_generated/server";

export async function adjustMetrics(
  ctx: MutationCtx,
  patch: Partial<{
    productCount: number;
    customerCount: number;
    lowStockCount: number;
    openOrderCount: number;
    pendingApprovalCount: number;
    salesToday: number;
  }>,
) {
  const existing = await ctx.db
    .query("metrics")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .unique();
  const base = existing ?? {
    productCount: 0,
    customerCount: 0,
    lowStockCount: 0,
    openOrderCount: 0,
    pendingApprovalCount: 0,
    salesToday: 0,
  };
  const next = {
    ...base,
    ...Object.fromEntries(
      Object.entries(patch).map(([key, delta]) => [
        key,
        Math.max(
          0,
          Number(base[key as keyof typeof base] ?? 0) + Number(delta),
        ),
      ]),
    ),
    updatedAt: Date.now(),
  };
  if (existing) await ctx.db.patch(existing._id, next);
  else
    await ctx.db.insert("metrics", {
      key: "global",
      productCount: next.productCount,
      customerCount: next.customerCount,
      lowStockCount: next.lowStockCount,
      openOrderCount: next.openOrderCount,
      pendingApprovalCount: next.pendingApprovalCount,
      salesToday: next.salesToday,
      updatedAt: next.updatedAt,
    });
}
