import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

describe("authenticated operational workflow", () => {
  it("locks bootstrap authority to the configured super admin email", async () => {
    const t = convexTest(schema, modules);
    const uninvited = t.withIdentity({
      subject: "user-first-arrival",
      email: "first@sunpride.local",
      name: "First Arrival",
    });
    await expect(
      uninvited.mutation(api.domains.profiles.ensure),
    ).rejects.toThrow("has not been invited");

    const migration = await t.mutation(
      internal.migrations.bootstrapSuperAdmin,
      {},
    );
    expect(migration.email).toBe("jcing.jc@gmail.com");

    const superAdmin = t.withIdentity({
      subject: "bootstrap-super-admin",
      email: "JCING.JC@gmail.com",
      name: "JC",
    });
    await superAdmin.mutation(api.domains.profiles.ensure);
    await superAdmin.mutation(api.domains.profiles.invite, {
      email: "viewer@sunpride.local",
      name: "Viewer",
      role: "viewer",
    });
    await t
      .withIdentity({
        subject: "user-viewer",
        email: "viewer@sunpride.local",
        name: "Viewer",
      })
      .mutation(api.domains.profiles.ensure);
    const profiles = await t.run(async (ctx) =>
      ctx.db.query("profiles").collect(),
    );
    expect(
      profiles.find((profile) => profile.email === "jcing.jc@gmail.com")?.role,
    ).toBe("super_admin");
    expect(
      profiles.find((profile) => profile.email === "viewer@sunpride.local")
        ?.role,
    ).toBe("viewer");
  });

  it("creates an order, workflow, audit event, and metrics exactly once", async () => {
    const t = convexTest(schema, modules);
    const user = t.withIdentity({
      subject: "sales-1",
      email: "sales@sunpride.local",
      name: "Sales One",
    });
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("accessInvitations", {
        email: "sales@sunpride.local",
        role: "sales",
        status: "pending",
        invitedBy: "test:bootstrap",
        invitedAt: now,
        updatedAt: now,
      });
    });
    await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
    const root = await t.mutation(
      internal.migrations.seedOrganizationFoundation,
      {},
    );
    await user.mutation(api.domains.profiles.ensure);
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_email", (q) => q.eq("email", "sales@sunpride.local"))
        .unique();
      if (!profile) throw new Error("Missing sales profile");
      await ctx.db.patch(profile._id, { orgUnitId: root.rootUnitId });
      await ctx.db.insert("customers", {
        code: "CUS-001",
        name: "Customer",
        channel: "Retail",
        territory: "NCR",
        creditLimit: 1000,
        active: true,
        updatedAt: 1,
      });
      await ctx.db.insert("salesAssignments", {
        salespersonSubject: profile.authSubject,
        customerCode: "CUS-001",
        territory: "NCR",
        active: true,
        updatedAt: 1,
      });
    });
    const args = {
      clientRequestId: "device-order-001",
      customerCode: "CUS-001",
      offlineCreatedAt: 1,
      lines: [
        {
          productCode: "SP-PJ-1L",
          description: "Pineapple Juice",
          quantity: 2,
          unitPrice: 100,
        },
      ],
    };
    const first = await user.mutation(api.domains.orders.create, args);
    const duplicate = await user.mutation(api.domains.orders.create, args);
    expect(duplicate).toBe(first);
    const state = await t.run(async (ctx) => ({
      orders: await ctx.db.query("orders").collect(),
      lines: await ctx.db.query("orderLines").collect(),
      workflows: await ctx.db.query("workflowInstances").collect(),
      audits: await ctx.db.query("auditLogs").collect(),
      metrics: await ctx.db.query("metrics").collect(),
    }));
    expect(state.orders).toHaveLength(1);
    expect(state.lines).toHaveLength(1);
    expect(state.workflows).toHaveLength(1);
    expect(
      state.audits.filter((audit) => audit.action === "order.created"),
    ).toHaveLength(1);
    expect(state.metrics[0]?.openOrderCount).toBe(1);
    expect(state.metrics[0]?.pendingApprovalCount).toBe(1);
    expect(state.metrics[0]?.salesToday).toBe(200);
  });
});
