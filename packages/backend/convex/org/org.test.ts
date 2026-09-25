import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

async function fixture() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = t.withIdentity({ subject: "root", email: "jcing.jc@gmail.com" });
  await root.mutation(api.domains.profiles.ensure, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  return { t, root, rootUnitId };
}

describe("effective organization tree", () => {
  it("reparents prospectively without changing an earlier as-of tree", async () => {
    const { root, rootUnitId } = await fixture();
    const from = Date.now() + 100_000;
    const a = await root.mutation(api.org.mutations.create, {
      code: "A",
      name: "A",
      typeCode: "REGION",
      parentId: rootUnitId,
      effectiveFrom: from,
    });
    const b = await root.mutation(api.org.mutations.create, {
      code: "B",
      name: "B",
      typeCode: "REGION",
      parentId: rootUnitId,
      effectiveFrom: from,
    });
    const c = await root.mutation(api.org.mutations.create, {
      code: "C",
      name: "C",
      typeCode: "AREA",
      parentId: a,
      effectiveFrom: from,
    });
    await root.mutation(api.org.mutations.reparent, {
      unitId: c,
      parentId: b,
      effectiveFrom: from + 1000,
      reason: "reorg",
    });
    const old = await root.query(api.org.queries.tree, { asOf: from + 500 });
    const later = await root.query(api.org.queries.tree, { asOf: from + 1500 });
    expect(old.find((node) => node._id === c)?.parentId).toBe(a);
    expect(later.find((node) => node._id === c)?.parentId).toBe(b);
    await expect(
      root.mutation(api.org.mutations.reparent, {
        unitId: a,
        parentId: c,
        effectiveFrom: from + 2000,
        reason: "cycle",
      }),
    ).rejects.toThrow(/level|cycle/);
    await expect(
      root.mutation(api.org.mutations.create, {
        code: "C",
        name: "duplicate",
        typeCode: "AREA",
        parentId: a,
        effectiveFrom: from,
      }),
    ).rejects.toThrow(/code/);
  });
  it("backfills legacy edges and assignments idempotently", async () => {
    const { t, root, rootUnitId } = await fixture();
    const employeeEmail = "legacy@example.test";
    await root.mutation(api.domains.profiles.invite, {
      email: employeeEmail,
      role: "viewer",
    });
    const employee = t.withIdentity({
      subject: "legacy",
      email: employeeEmail,
    });
    await employee.mutation(api.domains.profiles.ensure, {});
    const person = (await employee.query(api.domains.profiles.current, {}))!;
    const unitId = await t.run(async (ctx) => {
      const now = Date.now() - 1000;
      const id = await ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code: "LEGACY",
        name: "Legacy",
        typeCode: "REGION",
        parentId: rootUnitId,
        status: "active",
        effectiveFrom: now,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(person._id, { orgUnitId: id, effectiveFrom: now });
      const initial = await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", person._id),
        )
        .first();
      if (initial) await ctx.db.delete(initial._id);
      return id;
    });
    const edges = await t.mutation(
      internal.migrations.backfillOrganizationEdges,
      { cursor: null },
    );
    const assignments = await t.mutation(
      internal.migrations.backfillEmployeeAssignments,
      { cursor: null },
    );
    expect(edges.count).toBe(1);
    expect(assignments.count).toBeGreaterThan(0);
    expect(
      (
        await t.mutation(internal.migrations.backfillOrganizationEdges, {
          cursor: null,
        })
      ).count,
    ).toBe(0);
    expect(
      (
        await t.mutation(internal.migrations.backfillEmployeeAssignments, {
          cursor: null,
        })
      ).count,
    ).toBe(0);
    expect(
      (await root.query(api.org.queries.tree, { asOf: Date.now() })).find(
        (u) => u._id === unitId,
      )?.parentId,
    ).toBe(rootUnitId);
  });
  it("keeps a deactivated unit in its historical interval", async () => {
    const { t, root, rootUnitId } = await fixture();
    const from = Date.now() + 1000;
    const id = await root.mutation(api.org.mutations.create, {
      code: "OLD",
      name: "Old",
      typeCode: "REGION",
      parentId: rootUnitId,
      effectiveFrom: from,
    });
    const to = from + 1000;
    await root.mutation(api.org.mutations.deactivate, {
      unitId: id,
      effectiveTo: to,
      reason: "retired",
    });
    await t.run((ctx) => ctx.db.patch(id, { status: "inactive" }));
    expect(
      (await root.query(api.org.queries.tree, { asOf: from + 500 })).some(
        (u) => u._id === id,
      ),
    ).toBe(true);
    expect(
      (await root.query(api.org.queries.tree, { asOf: to })).some(
        (u) => u._id === id,
      ),
    ).toBe(false);
  });
});
