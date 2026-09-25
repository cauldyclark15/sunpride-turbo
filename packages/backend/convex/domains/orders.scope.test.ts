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
    return [await make("AREA-A"), await make("AREA-B")] as const;
  });
  async function actor(
    name: string,
    role: "sales" | "manager" | "approver" | "viewer",
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
  const managerA = await actor("manager-a", "manager");
  const managerB = await actor("manager-b", "manager", b);
  const approverA = await actor("approver-a", "approver");
  const viewerA = await actor("viewer-a", "viewer");
  await t.run(async (ctx) => {
    for (const [code, subject, territory] of [
      ["C-A", "sales-a", "T-A"],
      ["C-B", "sales-b", "T-B"],
    ] as const) {
      await ctx.db.insert("customers", {
        code,
        name: code,
        channel: "Retail",
        territory,
        creditLimit: 100,
        active: true,
        updatedAt: 1,
      });
      const person = await ctx.db
        .query("profiles")
        .withIndex("by_email", (q) => q.eq("email", `${subject}@example.test`))
        .unique();
      if (!person) throw new Error("missing profile");
      await ctx.db.insert("salesAssignments", {
        customerCode: code,
        territory,
        salespersonSubject: person.authSubject,
        active: true,
        updatedAt: 1,
      });
    }
  });
  const args = (clientRequestId: string, customerCode: string) => ({
    clientRequestId,
    customerCode,
    lines: [
      { productCode: "P", description: "Product", quantity: 1, unitPrice: 10 },
    ],
  });
  return {
    t,
    root,
    a,
    b,
    salesA,
    salesB,
    managerA,
    managerB,
    approverA,
    viewerA,
    args,
  };
}

describe("legacy order scope", () => {
  it("refuses an unassigned and cross-region customer, accepts own assignment, and prevents foreign idempotency replay", async () => {
    const f = await fixture();
    await expect(
      f.salesA.mutation(api.domains.orders.create, f.args("cross", "C-B")),
    ).rejects.toThrow();
    await expect(
      f.viewerA.mutation(api.domains.orders.create, f.args("viewer", "C-A")),
    ).rejects.toThrow();
    const id = await f.salesA.mutation(
      api.domains.orders.create,
      f.args("same", "C-A"),
    );
    expect(
      await f.salesA.mutation(api.domains.orders.create, f.args("same", "C-A")),
    ).toBe(id);
    await expect(
      f.salesB.mutation(api.domains.orders.create, f.args("same", "C-B")),
    ).rejects.toThrow();
    const foreign = await f.salesB.mutation(
      api.domains.orders.create,
      f.args("other", "C-B"),
    );
    expect(
      (await f.salesA.query(api.domains.orders.list, {})).map((row) => row._id),
    ).toEqual([id]);
    expect(
      (await f.managerA.query(api.domains.orders.list, {})).map(
        (row) => row._id,
      ),
    ).toEqual([id]);
    expect(
      (await f.root.query(api.domains.orders.list, {})).map((row) => row._id),
    ).toEqual([foreign, id]);
  });

  it("gates decisions on stored customer/creator and separates requester from approver", async () => {
    const f = await fixture();
    const id = await f.salesA.mutation(
      api.domains.orders.create,
      f.args("approval", "C-A"),
    );
    await expect(
      f.managerB.mutation(api.domains.orders.decide, {
        orderId: id,
        decision: "approved",
      }),
    ).rejects.toThrow();
    await expect(
      f.viewerA.mutation(api.domains.orders.decide, {
        orderId: id,
        decision: "approved",
      }),
    ).rejects.toThrow();
    await expect(
      f.salesA.mutation(api.domains.orders.decide, {
        orderId: id,
        decision: "approved",
      }),
    ).rejects.toThrow();
    expect(
      await f.approverA.mutation(api.domains.orders.decide, {
        orderId: id,
        decision: "rejected",
      }),
    ).toBeNull();
  });

  it("denies a manager approving their own order", async () => {
    const f = await fixture();
    const id = await f.managerA.mutation(
      api.domains.orders.create,
      f.args("self", "C-A"),
    );
    await expect(
      f.managerA.mutation(api.domains.orders.decide, {
        orderId: id,
        decision: "approved",
      }),
    ).rejects.toThrow("Requester cannot approve");
  });
});
