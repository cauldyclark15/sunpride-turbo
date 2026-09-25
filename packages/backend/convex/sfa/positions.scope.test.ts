import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

describe("positions catalog capability", () => {
  it("allows regional admins to read list and standards, denies viewer/sales, and validates position organization", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
    const { rootUnitId } = await t.mutation(
      internal.migrations.seedOrganizationFoundation,
      {},
    );
    const root = t.withIdentity({
      subject: "root",
      email: "jcing.jc@gmail.com",
    });
    await root.mutation(api.domains.profiles.ensure, {});
    const area = await t.run((ctx) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code: "A",
        name: "A",
        typeCode: "AREA",
        parentId: rootUnitId,
        status: "active",
        effectiveFrom: 0,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const position = await t.run((ctx) =>
      ctx.db.insert("positions", {
        organizationId: "sunpride",
        code: "P",
        label: "Position",
        category: "field",
        active: true,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    for (const role of ["admin", "viewer", "sales"] as const) {
      const email = `${role}@example.test`;
      await root.mutation(api.domains.profiles.invite, { email, role });
      const actor = t.withIdentity({ subject: role, email });
      const id = await actor.mutation(api.domains.profiles.ensure, {});
      await t.run((ctx) => ctx.db.patch(id, { orgUnitId: area }));
      if (role === "admin") {
        expect(await actor.query(api.sfa.positions.list, {})).toHaveLength(1);
        expect(
          await actor.query(api.sfa.positions.standards, {
            positionId: position,
          }),
        ).toEqual([]);
      } else {
        await expect(actor.query(api.sfa.positions.list, {})).rejects.toThrow();
        await expect(
          actor.query(api.sfa.positions.standards, { positionId: position }),
        ).rejects.toThrow();
      }
    }
    expect(await root.query(api.sfa.positions.list, {})).toHaveLength(1);
    expect(
      await root.query(api.sfa.positions.standards, { positionId: position }),
    ).toEqual([]);
    const foreign = await t.run((ctx) =>
      ctx.db.insert("positions", {
        organizationId: "foreign",
        code: "F",
        label: "Foreign",
        category: "field",
        active: true,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await expect(
      root.query(api.sfa.positions.standards, { positionId: foreign }),
    ).rejects.toThrow("Position not found");
  });
});
