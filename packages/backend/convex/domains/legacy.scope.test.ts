import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

async function fixture() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const root = t.withIdentity({ subject: "root", email: "jcing.jc@gmail.com" });
  await root.mutation(api.domains.profiles.ensure, {});
  const [a, b] = await t.run(async (ctx) => {
    const make = (code: string) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: "AREA",
        parentId: rootUnitId,
        status: "active",
        effectiveFrom: 0,
        createdAt: 1,
        updatedAt: 1,
      });
    return [await make("A"), await make("B")] as const;
  });
  async function actor(
    name: string,
    role: "sales" | "manager" | "approver" | "admin" | "viewer" | "analyst",
    unit = a,
  ) {
    const email = `${name}@example.test`;
    await root.mutation(api.domains.profiles.invite, { email, role });
    const who = t.withIdentity({ subject: name, email });
    const id = await who.mutation(api.domains.profiles.ensure, {});
    await t.run((ctx) => ctx.db.patch(id, { orgUnitId: unit }));
    return who;
  }
  const salesA = await actor("sales-a", "sales");
  const salesB = await actor("sales-b", "sales", b);
  const approverA = await actor("approver-a", "approver");
  const approverB = await actor("approver-b", "approver", b);
  const adminA = await actor("admin-a", "admin");
  const adminNational = await actor("admin-national", "admin", rootUnitId);
  const viewerA = await actor("viewer-a", "viewer");
  const analystA = await actor("analyst-a", "analyst");
  await t.run(async (ctx) => {
    for (const [code, name, unit] of [
      ["C-A", "sales-a", a],
      ["C-B", "sales-b", b],
    ] as const) {
      await ctx.db.insert("customers", {
        code,
        name: code,
        channel: "Retail",
        territory: code,
        creditLimit: 100,
        active: true,
        updatedAt: 1,
      });
      const owner = await ctx.db
        .query("profiles")
        .withIndex("by_email", (q) => q.eq("email", `${name}@example.test`))
        .unique();
      if (!owner) throw new Error("No owner");
      await ctx.db.insert("salesAssignments", {
        salespersonSubject: owner.authSubject,
        customerCode: code,
        territory: code,
        active: true,
        updatedAt: 1,
      });
      const warehouseId = await ctx.db.insert("warehouses", {
        code: `W-${code}`,
        name: code,
        location: code,
        active: true,
        updatedAt: 1,
      });
      await ctx.db.insert("inventoryLocations", {
        organizationId: "sunpride",
        orgUnitId: unit,
        warehouseId,
        siteCode: code,
        code,
        name: code,
        type: "warehouse",
        active: true,
        allowsPicking: true,
        allowsReceiving: true,
        allowsSale: false,
        allowsProduction: false,
        createdAt: 1,
        updatedAt: 1,
      });
    }
    await ctx.db.insert("inventoryBalances", {
      productCode: "P",
      warehouseCode: "W-C-B",
      onHand: 100,
      reserved: 0,
      available: 100,
      asOf: 1,
    });
    await ctx.db.insert("products", {
      code: "P",
      name: "P",
      category: "Grocery",
      uom: "EA",
      unitPrice: 1,
      active: true,
      updatedAt: 1,
    });
    await ctx.db.insert("connectorHeartbeats", {
      connectorId: "sap",
      status: "online",
      adapter: "mock",
      lastSeenAt: 1,
    });
  });
  return {
    t,
    root,
    a,
    b,
    salesA,
    salesB,
    approverA,
    approverB,
    adminA,
    adminNational,
    viewerA,
    analystA,
  };
}

describe("legacy scoped readers", () => {
  it("pending exposes only in-scope order workflows to approvers, never viewer or requester", async () => {
    const f = await fixture();
    const line = [
      { productCode: "P", description: "P", quantity: 1, unitPrice: 1 },
    ];
    await f.salesA.mutation(api.domains.orders.create, {
      clientRequestId: "a",
      customerCode: "C-A",
      lines: line,
    });
    await f.salesB.mutation(api.domains.orders.create, {
      clientRequestId: "b",
      customerCode: "C-B",
      lines: line,
    });
    await f.t.run((ctx) =>
      ctx.db.insert("workflowInstances", {
        entityType: "unknown",
        entityId: "unmapped",
        workflowType: "other",
        status: "pending",
        currentStep: 1,
        requestedBy: "external",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    expect(
      await f.approverA.query(api.domains.workflows.pending, {}),
    ).toHaveLength(1);
    expect(
      await f.approverB.query(api.domains.workflows.pending, {}),
    ).toHaveLength(1);
    await expect(
      f.viewerA.query(api.domains.workflows.pending, {}),
    ).rejects.toThrow();
    await expect(
      f.salesA.query(api.domains.workflows.pending, {}),
    ).rejects.toThrow();
  });

  it("customers and warehouses exclude the other area while the catalog uses an explicit capability", async () => {
    const f = await fixture();
    expect(
      (await f.viewerA.query(api.domains.masterData.customers, {})).map(
        (c) => c.code,
      ),
    ).toEqual(["C-A"]);
    expect(
      (await f.salesA.query(api.domains.masterData.customers, {})).map(
        (c) => c.code,
      ),
    ).toEqual(["C-A"]);
    expect(
      (await f.viewerA.query(api.domains.masterData.warehouses, {})).map(
        (w) => w.code,
      ),
    ).toEqual(["W-C-A"]);
    expect(
      await f.viewerA.query(api.domains.masterData.products, {}),
    ).toHaveLength(1);
  });

  it("legacy balances reject regional callers; dashboard returns only restricted zeros while national and analyst see global metrics", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.insert("metrics", {
        key: "global",
        productCount: 4,
        customerCount: 5,
        lowStockCount: 2,
        openOrderCount: 3,
        pendingApprovalCount: 1,
        salesToday: 100,
        updatedAt: 123,
      }),
    );
    await expect(
      f.viewerA.query(api.domains.inventory.list, {}),
    ).rejects.toThrow();
    const restricted = {
      productCount: 0,
      customerCount: 0,
      lowStockCount: 0,
      openOrderCount: 0,
      pendingApprovalCount: 0,
      salesToday: 0,
      updatedAt: 0,
      restricted: true,
    };
    expect(await f.viewerA.query(api.domains.dashboard.summary, {})).toEqual(
      restricted,
    );
    expect(await f.adminA.query(api.domains.dashboard.summary, {})).toEqual(
      restricted,
    );
    expect(await f.salesA.query(api.domains.dashboard.summary, {})).toEqual(
      restricted,
    );
    expect(await f.root.query(api.domains.inventory.list, {})).toHaveLength(1);
    const national = await f.root.query(api.domains.dashboard.summary, {});
    expect(national).toMatchObject({
      productCount: 4,
      customerCount: 5,
      salesToday: 100,
      restricted: false,
    });
    expect(
      await f.adminNational.query(api.domains.dashboard.summary, {}),
    ).toEqual(national);
    expect(await f.analystA.query(api.domains.dashboard.summary, {})).toEqual(
      national,
    );
  });

  it("connector status requires integration.read and national scope", async () => {
    const f = await fixture();
    await expect(
      f.adminA.query(api.domains.admin.connectorHealth, {}),
    ).rejects.toThrow();
    await expect(
      f.viewerA.query(api.domains.admin.connectorHealth, {}),
    ).rejects.toThrow();
    expect(
      await f.root.query(api.domains.admin.connectorHealth, {}),
    ).toHaveLength(1);
  });
});
