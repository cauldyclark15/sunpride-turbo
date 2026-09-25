import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";

const page = { numItems: 100, cursor: null };
async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = t.withIdentity({ subject: "root", email: "jcing.jc@gmail.com" });
  await root.mutation(api.domains.profiles.ensure, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const past = Date.now() - 100000;
  const [east, west] = await t.run(async (ctx) => {
    const add = (code: string) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: "REGION",
        parentId: rootUnitId,
        status: "active" as const,
        effectiveFrom: past,
        createdAt: past,
        updatedAt: past,
      });
    return [await add("ROUTE-EAST"), await add("ROUTE-WEST")];
  });
  async function person(
    role: "admin" | "sales" | "analyst",
    unitId: Id<"orgUnits">,
    suffix: string,
  ) {
    const email = `${suffix}@example.test`;
    await root.mutation(api.domains.profiles.invite, { email, role });
    const actor = t.withIdentity({ subject: suffix, email });
    await actor.mutation(api.domains.profiles.ensure, {});
    const id = (await actor.query(api.domains.profiles.current, {}))!._id;
    await t.run((ctx) =>
      ctx.db.patch(id, { orgUnitId: unitId, role, updatedAt: Date.now() }),
    );
    return { actor, id };
  }
  async function territory(code: string, unitId = east) {
    const id = await root.mutation(api.territories.mutations.create, {
      code,
      name: code,
      orgUnitId: unitId,
      effectiveFrom: Date.now() + 1000,
      reason: "territory setup",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { effectiveFrom: past });
      const owner = await ctx.db
        .query("territoryOwnerships")
        .withIndex("by_territoryId_and_effectiveFrom", (q) =>
          q.eq("territoryId", id),
        )
        .first();
      if (owner) await ctx.db.patch(owner._id, { effectiveFrom: past });
    });
    return id;
  }
  async function route(territoryId: Id<"territories">, code: string) {
    const id = await root.mutation(api.territories.routes.create, {
      territoryId,
      code,
      name: code,
      weekdayTemplate: [1, 3],
      cycleDays: 14,
      effectiveFrom: Date.now() + 1000,
      reason: "route setup",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { effectiveFrom: past });
      const row = await ctx.db
        .query("routeTerritories")
        .withIndex("by_routeId_and_effectiveFrom", (q) => q.eq("routeId", id))
        .first();
      if (row) await ctx.db.patch(row._id, { effectiveFrom: past });
    });
    return id;
  }
  return { t, root, east, west, person, territory, route };
}
describe("scoped effective-dated routes", () => {
  it("limits salesperson reads to currently assigned route or territory", async () => {
    const f = await setup(),
      territoryId = await f.territory("SALES");
    const assigned = await f.route(territoryId, "OWN"),
      other = await f.route(territoryId, "OTHER");
    const seller = await f.person("sales", f.east, "coverage-seller");
    await expect(
      seller.actor.query(api.territories.routes.detail, { routeId: assigned }),
    ).rejects.toThrow(/assigned coverage/);
    const assignmentId = await f.root.mutation(
      api.territories.routes.assignSalesperson,
      {
        routeId: assigned,
        profileId: seller.id,
        primary: true,
        effectiveFrom: Date.now() + 1000,
        reason: "cover",
      },
    );
    await f.t.run((ctx) =>
      ctx.db.patch(assignmentId, { effectiveFrom: Date.now() - 1000 }),
    );
    expect(
      (
        await seller.actor.query(api.territories.routes.list, {
          territoryId,
          paginationOpts: page,
        })
      ).page.map((r) => r._id),
    ).toEqual([assigned]);
    await expect(
      seller.actor.query(api.territories.routes.detail, { routeId: other }),
    ).rejects.toThrow(/assigned coverage/);
    expect(
      (
        await seller.actor.query(api.territories.routes.detail, {
          routeId: assigned,
        })
      ).route._id,
    ).toBe(assigned);
  });
  it("denies cross-region guessed detail, mutation, list and either direction of move", async () => {
    const f = await setup();
    const a = await f.territory("EAST"),
      b = await f.territory("WEST", f.west);
    const r1 = await f.route(a, "E-1"),
      r2 = await f.route(b, "W-1");
    const east = await f.person("admin", f.east, "route-admin");
    expect(
      (
        await east.actor.query(api.territories.routes.list, {
          territoryId: a,
          paginationOpts: page,
        })
      ).page.map((r) => r._id),
    ).toEqual([r1]);
    await expect(
      east.actor.query(api.territories.routes.detail, { routeId: r2 }),
    ).rejects.toThrow(/scope/);
    await expect(
      east.actor.mutation(api.territories.routes.edit, {
        routeId: r2,
        name: "stolen",
        reason: "guess",
      }),
    ).rejects.toThrow(/scope/);
    for (const [routeId, territoryId] of [
      [r1, b],
      [r2, a],
    ] as const)
      await expect(
        east.actor.mutation(api.territories.routes.move, {
          routeId,
          territoryId,
          effectiveFrom: Date.now() + 10000,
          reason: "unauthorized",
        }),
      ).rejects.toThrow(/scope/);
  });
  it("enforces normalized code collisions within territory, allows code across territories and blocks move collision", async () => {
    const f = await setup(),
      a = await f.territory("A"),
      b = await f.territory("B");
    const r = await f.route(a, "DUP");
    await expect(f.route(a, " dup ")).rejects.toThrow(/Duplicate/);
    const other = await f.route(b, "DUP");
    expect(other).not.toBe(r);
    await expect(
      f.root.mutation(api.territories.routes.move, {
        routeId: r,
        territoryId: b,
        effectiveFrom: Date.now() + 10000,
        reason: "collision",
      }),
    ).rejects.toThrow(/Duplicate/);
  });
  it("preserves half-open as-of move history and audits server actor and reason", async () => {
    const f = await setup(),
      a = await f.territory("A"),
      b = await f.territory("B");
    const routeId = await f.route(a, "MOVING");
    const when = Date.now() + 20000;
    await f.root.mutation(api.territories.routes.move, {
      routeId,
      territoryId: b,
      effectiveFrom: when,
      reason: "reorganize",
    });
    expect(
      (
        await f.root.query(api.territories.routes.detail, {
          routeId,
          asOf: when - 1,
        })
      ).territory?.territoryId,
    ).toBe(a);
    expect(
      (
        await f.root.query(api.territories.routes.detail, {
          routeId,
          asOf: when,
        })
      ).territory?.territoryId,
    ).toBe(b);
    expect(
      (
        await f.root.query(api.territories.routes.history, { routeId })
      ).territories.map((r) => [r.territoryId, r.effectiveTo]),
    ).toEqual([
      [a, when],
      [b, undefined],
    ]);
    const logs = await f.t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "route").eq("entityId", routeId),
        )
        .collect(),
    );
    expect(logs.map((log) => [log.action, log.subject, log.details])).toEqual([
      ["route.created", "https://convex.test|root", "route setup"],
      ["route.moved", "https://convex.test|root", "reorganize"],
    ]);
  });
  it("rejects primary and same-person overlaps, accepts adjacent assignments and end boundary", async () => {
    const f = await setup(),
      a = await f.territory("A"),
      routeId = await f.route(a, "STAFF");
    const first = await f.person("sales", f.east, "seller-one"),
      second = await f.person("sales", f.east, "seller-two");
    const from = Date.now() + 10000,
      end = from + 10000;
    const id = await f.root.mutation(api.territories.routes.assignSalesperson, {
      routeId,
      profileId: first.id,
      primary: true,
      effectiveFrom: from,
      effectiveTo: end,
      reason: "start",
    });
    await expect(
      f.root.mutation(api.territories.routes.assignSalesperson, {
        routeId,
        profileId: second.id,
        primary: true,
        effectiveFrom: from + 1,
        reason: "overlap",
      }),
    ).rejects.toThrow(/Overlapping/);
    await expect(
      f.root.mutation(api.territories.routes.assignSalesperson, {
        routeId,
        profileId: first.id,
        primary: false,
        effectiveFrom: from + 1,
        reason: "duplicate",
      }),
    ).rejects.toThrow(/Overlapping/);
    const next = await f.root.mutation(
      api.territories.routes.assignSalesperson,
      {
        routeId,
        profileId: second.id,
        primary: true,
        effectiveFrom: end,
        reason: "handover",
      },
    );
    await f.root.mutation(api.territories.routes.endSalespersonAssignment, {
      assignmentId: next,
      effectiveTo: end + 10000,
      reason: "ended",
    });
    expect(
      (
        await f.root.query(api.territories.routes.detail, {
          routeId,
          asOf: end - 1,
        })
      ).salespeople.map((r) => r._id),
    ).toEqual([id]);
    expect(
      (
        await f.root.query(api.territories.routes.detail, {
          routeId,
          asOf: end + 10000,
        })
      ).salespeople,
    ).toEqual([]);
  });
  it("duplicates schedule metadata only, rejects blank reason, validates templates and analyst writes", async () => {
    const f = await setup(),
      a = await f.territory("A"),
      r = await f.route(a, "SOURCE");
    const analyst = await f.person("analyst", f.east, "route-analyst");
    const copy = await f.root.mutation(
      api.territories.routes.duplicateTemplate,
      {
        routeId: r,
        territoryId: a,
        code: "COPY",
        name: "Copy",
        effectiveFrom: Date.now() + 1000,
        reason: "reuse schedule",
      },
    );
    const doc = await f.t.run((ctx) => ctx.db.get(copy));
    expect(doc).toMatchObject({
      code: "COPY",
      weekdayTemplate: [1, 3],
      cycleDays: 14,
    });
    expect(
      (await f.root.query(api.territories.routes.history, { routeId: copy }))
        .salespeople,
    ).toEqual([]);
    expect(
      await f.t.run((ctx) =>
        ctx.db
          .query("outletAssignments")
          .withIndex("by_routeId_and_effectiveFrom", (q) =>
            q.eq("routeId", copy),
          )
          .collect(),
      ),
    ).toEqual([]);
    await expect(
      analyst.actor.mutation(api.territories.routes.edit, {
        routeId: r,
        name: "No",
        reason: "no",
      }),
    ).rejects.toThrow(/permission/);
    await expect(
      f.root.mutation(api.territories.routes.edit, {
        routeId: r,
        name: "No",
        reason: " ",
      }),
    ).rejects.toThrow(/Reason/);
    await expect(
      f.root.mutation(api.territories.routes.edit, {
        routeId: r,
        name: "No",
        weekdayTemplate: [1, 1],
        reason: "bad",
      }),
    ).rejects.toThrow(/weekday/);
  });
});
