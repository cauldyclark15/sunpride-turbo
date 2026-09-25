import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";

type Fixture = Awaited<ReturnType<typeof setup>>;
const page = { cursor: null, numItems: 100 };
async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = t.withIdentity({ subject: "root", email: "jcing.jc@gmail.com" });
  await root.mutation(api.domains.profiles.ensure, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const now = Date.now() - 100000;
  const [east, west] = await t.run(async (ctx) => {
    const add = (code: string) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: "REGION",
        parentId: rootUnitId,
        status: "active" as const,
        effectiveFrom: now,
        createdAt: now,
        updatedAt: now,
      });
    return [await add("G04-EAST"), await add("G04-WEST")];
  });
  return { t, root, east, west, rootUnitId };
}
async function person(
  f: Fixture,
  role: "admin" | "analyst" | "sales",
  unitId: Id<"orgUnits">,
  suffix: string,
) {
  const email = `${suffix}@example.test`;
  await f.root.mutation(api.domains.profiles.invite, { email, role });
  const actor = f.t.withIdentity({ subject: suffix, email });
  await actor.mutation(api.domains.profiles.ensure, {});
  const id = (await actor.query(api.domains.profiles.current, {}))!._id;
  await f.t.run((ctx) =>
    ctx.db.patch(id, { orgUnitId: unitId, role, updatedAt: Date.now() }),
  );
  return { actor, id };
}
function make(
  f: Fixture,
  code: string,
  orgUnitId = f.east,
  from = Date.now() + 1000,
) {
  return f.root.mutation(api.territories.mutations.create, {
    code,
    name: code,
    orgUnitId,
    effectiveFrom: from,
    reason: "coverage created",
  });
}
async function startNow(f: Fixture, id: Id<"territories">) {
  await f.t.run(async (ctx) => {
    await ctx.db.patch(id, { effectiveFrom: Date.now() - 10000 });
    const owner = await ctx.db
      .query("territoryOwnerships")
      .withIndex("by_territoryId_and_effectiveFrom", (q) =>
        q.eq("territoryId", id),
      )
      .first();
    if (owner)
      await ctx.db.patch(owner._id, { effectiveFrom: Date.now() - 10000 });
  });
}

describe("effective-dated territories", () => {
  it("filters regional view and detail by stored current owner, not requested region", async () => {
    const f = await setup();
    const east = await make(f, "EAST");
    const west = await make(f, "WEST", f.west);
    await startNow(f, east);
    await startNow(f, west);
    const admin = await person(f, "admin", f.east, "e-admin");
    expect(
      (
        await admin.actor.query(api.territories.queries.list, {
          paginationOpts: page,
        })
      ).page.map((t) => t._id),
    ).toEqual([east]);
    await expect(
      admin.actor.query(api.territories.queries.detail, { territoryId: west }),
    ).rejects.toThrow(/scope/);
    expect(
      (
        await admin.actor.query(api.territories.queries.detail, {
          territoryId: east,
        })
      ).owner?.orgUnitId,
    ).toBe(f.east);
  });

  it("refuses unauthorized transfers out of and into another region", async () => {
    const f = await setup();
    const east = await make(f, "EAST");
    const west = await make(f, "WEST", f.west);
    await startNow(f, east);
    await startNow(f, west);
    const admin = await person(f, "admin", f.east, "transfer-admin");
    for (const [territoryId, orgUnitId] of [
      [east, f.west],
      [west, f.east],
    ] as const)
      await expect(
        admin.actor.mutation(api.territories.mutations.transferOwner, {
          territoryId,
          orgUnitId,
          effectiveFrom: Date.now() + 5000,
          reason: "move",
        }),
      ).rejects.toThrow(/scope/);
  });

  it("resolves historic owner and salesperson as-of without granting future assignments today", async () => {
    const f = await setup();
    const id = await make(f, "HISTORY");
    await startNow(f, id);
    const seller = await person(f, "sales", f.east, "seller-history");
    const from = Date.now() + 10000;
    const transfer = from + 10000;
    const assignmentId = await f.root.mutation(
      api.territories.mutations.assignSalesperson,
      {
        territoryId: id,
        profileId: seller.id,
        effectiveFrom: from,
        effectiveTo: transfer,
        reason: "coverage",
      },
    );
    expect(
      await f.root.query(api.territories.queries.salespeopleAt, {
        territoryId: id,
        asOf: Date.now(),
      }),
    ).toEqual([]);
    expect(
      (
        await f.root.query(api.territories.queries.salespeopleAt, {
          territoryId: id,
          asOf: from,
        })
      ).map((x) => x._id),
    ).toEqual([assignmentId]);
    await f.root.mutation(api.territories.mutations.transferOwner, {
      territoryId: id,
      orgUnitId: f.west,
      effectiveFrom: transfer,
      reason: "regional change",
    });
    const history = await f.root.query(
      api.territories.queries.ownershipHistory,
      { territoryId: id },
    );
    expect(history.map((row) => row.orgUnitId)).toEqual([f.east, f.west]);
    expect(
      (
        await f.root.query(api.territories.queries.detail, {
          territoryId: id,
          asOf: transfer - 1,
        })
      ).owner?.orgUnitId,
    ).toBe(f.east);
    expect(
      (
        await f.root.query(api.territories.queries.detail, {
          territoryId: id,
          asOf: transfer,
        })
      ).owner?.orgUnitId,
    ).toBe(f.west);
    expect(
      await f.root.query(api.territories.queries.salespeopleAt, {
        territoryId: id,
        asOf: transfer,
      }),
    ).toEqual([]);
    const eastAdmin = await person(f, "admin", f.east, "still-east");
    expect(
      (
        await eastAdmin.actor.query(api.territories.queries.list, {
          paginationOpts: page,
        })
      ).page.map((row) => row._id),
    ).toContain(id);
    expect(
      (
        await eastAdmin.actor.query(api.territories.queries.detail, {
          territoryId: id,
          asOf: transfer,
        })
      ).owner?.orgUnitId,
    ).toBe(f.west);
    const westAdmin = await person(f, "admin", f.west, "future-west");
    await expect(
      westAdmin.actor.query(api.territories.queries.detail, {
        territoryId: id,
      }),
    ).rejects.toThrow(/scope/);
  });

  it("rejects overlapping assignments and retired units, permits adjacent half-open intervals", async () => {
    const f = await setup();
    const id = await make(f, "INTERVAL");
    await startNow(f, id);
    const seller = await person(f, "sales", f.east, "seller-interval");
    const from = Date.now() + 10000;
    const end = from + 10000;
    const args = {
      territoryId: id,
      profileId: seller.id,
      effectiveFrom: from,
      effectiveTo: end,
      reason: "join",
    };
    await f.root.mutation(api.territories.mutations.assignSalesperson, args);
    await expect(
      f.root.mutation(api.territories.mutations.assignSalesperson, {
        ...args,
        effectiveFrom: from + 1,
      }),
    ).rejects.toThrow(/Overlapping/);
    const second = await f.root.mutation(
      api.territories.mutations.assignSalesperson,
      {
        ...args,
        effectiveFrom: end,
        effectiveTo: end + 10000,
      },
    );
    await f.root.mutation(api.territories.mutations.endSalespersonAssignment, {
      assignmentId: second,
      effectiveTo: end + 9000,
      reason: "coverage ended",
    });
    expect(
      await f.root.query(api.territories.queries.salespeopleAt, {
        territoryId: id,
        asOf: end + 9000,
      }),
    ).toEqual([]);
    await expect(
      f.root.mutation(api.territories.mutations.transferOwner, {
        territoryId: id,
        orgUnitId: f.west,
        effectiveFrom: end + 1,
        reason: "blocked by salesperson",
      }),
    ).rejects.toThrow();
    await f.t.run((ctx) => ctx.db.patch(f.west, { status: "inactive" }));
    await expect(
      f.root.mutation(api.territories.mutations.transferOwner, {
        territoryId: id,
        orgUnitId: f.west,
        effectiveFrom: end + 20000,
        reason: "retired",
      }),
    ).rejects.toThrow();
  });

  it("audits actor and reason for each transition and rejects analyst writes", async () => {
    const f = await setup();
    const id = await make(f, "AUDIT");
    await startNow(f, id);
    const analyst = await person(f, "analyst", f.east, "analyst-territory");
    expect(
      (
        await analyst.actor.query(api.territories.queries.detail, {
          territoryId: id,
        })
      ).territory.code,
    ).toBe("AUDIT");
    await expect(
      analyst.actor.mutation(api.territories.mutations.edit, {
        territoryId: id,
        name: "No",
        reason: "attempt",
      }),
    ).rejects.toThrow(/permission/);
    await f.root.mutation(api.territories.mutations.edit, {
      territoryId: id,
      name: "Renamed",
      reason: "new label",
    });
    const logs = await f.t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "territory").eq("entityId", id),
        )
        .collect(),
    );
    expect(logs.map((log) => [log.action, log.subject, log.details])).toEqual([
      ["territory.created", "https://convex.test|root", "coverage created"],
      ["territory.edited", "https://convex.test|root", "new label"],
    ]);
    await expect(
      f.root.mutation(api.territories.mutations.edit, {
        territoryId: id,
        name: "No",
        reason: " ",
      }),
    ).rejects.toThrow(/Reason/);
  });

  it("keeps normalized codes unique including inactive territories", async () => {
    const f = await setup();
    const id = await make(f, "same");
    await startNow(f, id);
    await f.root.mutation(api.territories.mutations.deactivate, {
      territoryId: id,
      effectiveTo: Date.now() + 5000,
      reason: "retirement",
    });
    await expect(make(f, " SAME ")).rejects.toThrow(/Duplicate/);
    await expect(make(f, "same", f.west)).rejects.toThrow(/Duplicate/);
    // Once retirement takes effect, the last stored owner still gates historical reads.
    await f.t.run(async (ctx) => {
      await ctx.db.patch(id, { effectiveTo: Date.now() - 1 });
      const owner = await ctx.db
        .query("territoryOwnerships")
        .withIndex("by_territoryId_and_effectiveFrom", (q) =>
          q.eq("territoryId", id),
        )
        .first();
      if (owner) await ctx.db.patch(owner._id, { effectiveTo: Date.now() - 1 });
    });
    await f.root.mutation(internal.territories.mutations.applyProjection, {
      territoryId: id,
    });
    expect(
      (
        await f.root.query(api.territories.queries.detail, {
          territoryId: id,
          asOf: Date.now() - 5000,
        })
      ).territory.status,
    ).toBe("inactive");
  });
});
