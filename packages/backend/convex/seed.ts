import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

export const demo = internalMutation({
  args: {},
  returns: v.object({ seeded: v.boolean() }),
  handler: async (ctx) => {
    const existing = await ctx.db.query("products").take(1);
    if (existing.length > 0) return { seeded: false };
    const now = Date.now();
    const products = [
      {
        code: "SP-PJ-1L",
        name: "Sunpride Pineapple Juice 1L",
        category: "Juice",
        uom: "CASE",
        unitPrice: 1188,
        active: true,
        updatedAt: now,
      },
      {
        code: "SP-OJ-1L",
        name: "Sunpride Orange Juice 1L",
        category: "Juice",
        uom: "CASE",
        unitPrice: 1248,
        active: true,
        updatedAt: now,
      },
      {
        code: "SP-MJ-1L",
        name: "Sunpride Mango Juice 1L",
        category: "Juice",
        uom: "CASE",
        unitPrice: 1296,
        active: true,
        updatedAt: now,
      },
      {
        code: "SP-AP-250",
        name: "Sunpride Apple Juice 250ml",
        category: "Juice",
        uom: "CASE",
        unitPrice: 936,
        active: true,
        updatedAt: now,
      },
    ];
    for (const product of products) await ctx.db.insert("products", product);
    const customers = [
      {
        code: "CUS-001",
        name: "Metro Retail Makati",
        channel: "Modern Trade",
        territory: "NCR South",
        creditLimit: 500000,
        active: true,
        updatedAt: now,
      },
      {
        code: "CUS-002",
        name: "FreshMart Quezon City",
        channel: "Modern Trade",
        territory: "NCR North",
        creditLimit: 350000,
        active: true,
        updatedAt: now,
      },
      {
        code: "CUS-003",
        name: "Cebu Food Distributors",
        channel: "Distributor",
        territory: "Central Visayas",
        creditLimit: 750000,
        active: true,
        updatedAt: now,
      },
    ];
    for (const customer of customers)
      await ctx.db.insert("customers", customer);
    const warehouse = await ctx.db.insert("warehouses", {
      code: "WH-MNL",
      name: "Manila Distribution Center",
      location: "Muntinlupa, Metro Manila",
      active: true,
      updatedAt: now,
    });
    void warehouse;
    for (const [index, product] of products.entries())
      await ctx.db.insert("inventoryBalances", {
        productCode: product.code,
        warehouseCode: "WH-MNL",
        onHand: 240 - index * 37,
        reserved: 18 + index * 4,
        available: 222 - index * 41,
        asOf: now,
      });
    await ctx.db.insert("metrics", {
      key: "global",
      productCount: products.length,
      customerCount: customers.length,
      lowStockCount: 1,
      openOrderCount: 0,
      pendingApprovalCount: 0,
      salesToday: 0,
      updatedAt: now,
    });
    return { seeded: true };
  },
});
