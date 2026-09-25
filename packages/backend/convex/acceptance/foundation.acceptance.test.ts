import { convexTest, type TestConvex } from "convex-test";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";

type Test = TestConvex<typeof schema>;
const page = { cursor: null, numItems: 100 };

type Evidence = {
  action: string;
  entityId: string;
  reason: string;
  subject: string;
};

async function story() {
  // Freeze Date only: Convex's scheduler keeps its real timers, while all effective
  // boundaries and assignment transitions remain deterministic in this story.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-25T02:00:00.000Z"));
  const t = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = t.withIdentity({
    subject: "foundation-root",
    email: "jcing.jc@gmail.com",
    name: "Foundation root",
  });
  await root.mutation(api.domains.profiles.ensure, {});
  const rootSubject = (await root.query(api.domains.profiles.current, {}))!
    .authSubject;
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const evidence: Evidence[] = [];
  const start = Date.now() + 1_000;
  async function unit(
    code: string,
    typeCode: string,
    parentId: Id<"orgUnits">,
  ) {
    const reason = `Create ${code}`;
    const id = await root.mutation(api.org.mutations.create, {
      code,
      name: code.replaceAll("-", " "),
      typeCode,
      parentId,
      effectiveFrom: start,
      reason,
    });
    evidence.push({
      action: "org.created",
      entityId: id,
      reason,
      subject: rootSubject,
    });
    return id;
  }
  const north = await unit("NORTH", "REGION", rootUnitId);
  const south = await unit("SOUTH", "REGION", rootUnitId);
  const northArea1 = await unit("NORTH-AREA-1", "AREA", north);
  const northArea2 = await unit("NORTH-AREA-2", "AREA", north);
  const southArea1 = await unit("SOUTH-AREA-1", "AREA", south);
  vi.setSystemTime(start + 1_000);

  const teamReason = "Form North Area 1 team";
  const northTeam = await root.mutation(api.teams.mutations.create, {
    code: "NORTH-TEAM",
    name: "North field team",
    orgUnitId: northArea1,
    effectiveFrom: Date.now() + 1_000,
    reason: teamReason,
  });
  evidence.push({
    action: "team.created",
    entityId: northTeam,
    reason: teamReason,
    subject: rootSubject,
  });

  async function person(
    label: string,
    role: "admin" | "manager" | "sales",
    orgUnitId: Id<"orgUnits">,
  ) {
    const email = `${label}@foundation.test`;
    const invitationId = await root.mutation(api.domains.profiles.invite, {
      email,
      name: label,
      role,
    });
    const actor = t.withIdentity({ subject: label, email, name: label });
    const profileId = await actor.mutation(api.domains.profiles.ensure, {});
    const subject = (await actor.query(api.domains.profiles.current, {}))!
      .authSubject;
    const reason = `Place ${label}`;
    await root.mutation(api.people.mutations.assign, {
      profileId,
      orgUnitId,
      role,
      reason,
    });
    evidence.push({
      action: "person.assigned",
      entityId: profileId,
      reason,
      subject: rootSubject,
    });
    return { actor, profileId, subject, invitationId, email, role };
  }
  const northAdmin = await person("north-admin", "admin", north);
  const northManager = await person("north-manager", "manager", northArea1);
  const southManager = await person("south-manager", "manager", southArea1);
  const sales = await person("north-sales", "sales", northArea2);

  await t.mutation(internal.seed.demo, {});
  await root.mutation(api.inventory.setup.foundation, {});
  const product = (
    await root.query(api.domains.masterData.products, { limit: 1 })
  )[0];
  if (!product?.baseUomId) throw new Error("Seeded product/UOM missing");
  await root.mutation(api.inventory.policies.upsertProductPolicy, {
    productId: product._id,
    baseUomId: product.baseUomId,
    quantityScale: 1_000n,
    quantityPrecision: 3,
    trackingMode: "none",
    allocationPolicy: "fifo",
    allowMixedLotsPerLine: false,
    qualityReleaseRequired: false,
    expiryDateRequired: false,
    manufactureDateRequired: false,
    minimumRemainingShelfLifeDays: 0,
    costingMethod: "weighted_average",
  });
  const locations = await root.query(api.inventory.queries.locations, {});
  if (locations.length < 2)
    throw new Error("Expected two seeded inventory locations");
  const [northLocation, southLocation] = locations;
  if (!northLocation || !southLocation)
    throw new Error("Missing seeded location");
  for (const [locationId, orgUnitId, reason] of [
    [northLocation._id, northArea1, "Map North location"],
    [southLocation._id, southArea1, "Map South location"],
  ] as const) {
    await root.mutation(api.inventory.location_scope.assign, {
      locationId,
      orgUnitId,
      reason,
    });
    evidence.push({
      action: "inventory.location_scope.assigned",
      entityId: locationId,
      reason,
      subject: rootSubject,
    });
  }
  return {
    t,
    root,
    rootSubject,
    rootUnitId,
    north,
    south,
    northArea1,
    northArea2,
    southArea1,
    northTeam,
    northAdmin,
    northManager,
    southManager,
    sales,
    northLocation,
    southLocation,
    evidence,
  };
}

type Story = Awaited<ReturnType<typeof story>>;
let f: Story;

async function writeSnapshot(t: Test) {
  return t.run(async (ctx) => ({
    units: await ctx.db.query("orgUnits").collect(),
    edges: await ctx.db.query("orgUnitParentEdges").collect(),
    profiles: await ctx.db.query("profiles").collect(),
    assignments: await ctx.db.query("employeeAssignments").collect(),
    locations: await ctx.db.query("inventoryLocations").collect(),
    teams: await ctx.db.query("teams").collect(),
    memberships: await ctx.db.query("teamMemberships").collect(),
    adjustments: await ctx.db.query("inventoryAdjustments").collect(),
    adjustmentLines: await ctx.db.query("inventoryAdjustmentLines").collect(),
    counts: await ctx.db.query("stockCountSessions").collect(),
    countLines: await ctx.db.query("stockCountLines").collect(),
    audit: await ctx.db.query("auditLogs").collect(),
  }));
}

describe.sequential("#115 SFD-012 foundation acceptance (public API)", () => {
  beforeAll(async () => {
    f = await story();
  });
  afterAll(() => vi.useRealTimers());

  it("1. bootstraps regions, areas, team, invited roles and effective assignments", async () => {
    const tree = await f.root.query(api.org.queries.tree, { asOf: Date.now() });
    expect(tree.find((u) => u._id === f.northArea1)?.parentId).toBe(f.north);
    expect(tree.find((u) => u._id === f.southArea1)?.parentId).toBe(f.south);
    expect(
      (await f.root.query(api.teams.queries.detail, { teamId: f.northTeam }))
        .team.orgUnitId,
    ).toBe(f.northArea1);
    for (const { actor, profileId, role } of [
      f.northAdmin,
      f.northManager,
      f.southManager,
      f.sales,
    ]) {
      const current = await actor.query(api.domains.profiles.current, {});
      expect(current?._id).toBe(profileId);
      expect(current?.role).toBe(role);
      expect(current?.orgUnitId).toBeDefined();
    }
  });

  it("2. preserves as-of parent edges and half-open person assignment intervals", async () => {
    const today = Date.now();
    const future = today + 20_000;
    const reason = "Prospective North Area 1 transfer to South";
    await f.root.mutation(api.org.mutations.reparent, {
      unitId: f.northArea1,
      parentId: f.south,
      effectiveFrom: future,
      reason,
    });
    f.evidence.push({
      action: "org.reparented",
      entityId: f.northArea1,
      reason,
      subject: f.rootSubject,
    });
    const oldTree = await f.root.query(api.org.queries.tree, { asOf: today });
    const futureTree = await f.root.query(api.org.queries.tree, {
      asOf: future,
    });
    expect(oldTree.find((u) => u._id === f.northArea1)?.parentId).toBe(f.north);
    expect(futureTree.find((u) => u._id === f.northArea1)?.parentId).toBe(
      f.south,
    );

    const moveReason = "Move North sales rep into Area 1";
    await f.root.mutation(api.people.mutations.assign, {
      profileId: f.sales.profileId,
      orgUnitId: f.northArea1,
      role: "sales",
      reason: moveReason,
    });
    f.evidence.push({
      action: "person.assigned",
      entityId: f.sales.profileId,
      reason: moveReason,
      subject: f.rootSubject,
    });
    const history = await f.root.query(api.people.queries.history, {
      profileId: f.sales.profileId,
    });
    const first = history.find((row) => row.orgUnitId === f.northArea2);
    const second = history.find((row) => row.orgUnitId === f.northArea1);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.effectiveTo).toBe(second?.effectiveFrom);
    expect(first!.effectiveFrom).toBeLessThan(second!.effectiveFrom);
    expect(second?.effectiveTo).toBeUndefined();
  });

  it("3. filters people, org, teams, adjustments and counts in both directions", async () => {
    const southAdjustment = await f.root.mutation(
      api.inventory.adjustments.request,
      {
        adjustmentType: "correction",
        reasonCode: "SOUTH-ACCEPTANCE",
        lines: [
          {
            productId: (
              await f.root.query(api.domains.masterData.products, { limit: 1 })
            )[0]!._id,
            locationId: f.southLocation._id,
            stockStatus: "available",
            varianceBase: 1_000n,
          },
        ],
      },
    );
    const southCount = await f.root.mutation(api.inventory.counts.start, {
      locationId: f.southLocation._id,
      countType: "cycle",
      blindCount: true,
    });
    for (const [manager, own, other, ownPerson, otherPerson] of [
      [
        f.northManager.actor,
        f.northArea1,
        f.southArea1,
        f.northManager.profileId,
        f.southManager.profileId,
      ],
      [
        f.southManager.actor,
        f.southArea1,
        f.northArea1,
        f.southManager.profileId,
        f.northManager.profileId,
      ],
    ] as const) {
      const people = (
        await manager.query(api.people.queries.list, { paginationOpts: page })
      ).page;
      const tree = await manager.query(api.org.queries.tree, {
        asOf: Date.now(),
      });
      const teams = (
        await manager.query(api.teams.queries.list, { paginationOpts: page })
      ).page;
      expect(people.map((p) => p._id)).toContain(ownPerson);
      expect(people.map((p) => p._id)).not.toContain(otherPerson);
      expect(tree.map((u) => u._id)).toContain(own);
      expect(tree.map((u) => u._id)).not.toContain(other);
      expect(teams.map((t) => t._id).includes(f.northTeam)).toBe(
        own === f.northArea1,
      );
    }
    expect(
      (
        await f.northManager.actor.query(api.inventory.adjustments.list, {})
      ).map((a) => a._id),
    ).not.toContain(southAdjustment);
    expect(
      (await f.northManager.actor.query(api.inventory.counts.list, {})).map(
        (c) => c._id,
      ),
    ).not.toContain(southCount);
    expect(
      (
        await f.southManager.actor.query(api.inventory.adjustments.list, {})
      ).map((a) => a._id),
    ).toContain(southAdjustment);
    expect(
      (await f.southManager.actor.query(api.inventory.counts.list, {})).map(
        (c) => c._id,
      ),
    ).toContain(southCount);
  });

  it("3b. inventory.counts.start audits a successful South count", async () => {
    const sessionId = await f.root.mutation(api.inventory.counts.start, {
      locationId: f.southLocation._id,
      countType: "cycle",
      blindCount: true,
    });
    const audit = await f.t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(
      audit.some(
        (entry) =>
          entry.entityId === sessionId && entry.subject === f.rootSubject,
      ),
    ).toBe(true);
  });

  it("4. rejects five cross-scope writes without any row or audit side effects", async () => {
    const product = (
      await f.root.query(api.domains.masterData.products, { limit: 1 })
    )[0];
    if (!product) throw new Error("Seeded product missing");
    const attempts = [
      () =>
        f.northAdmin.actor.mutation(api.people.mutations.assign, {
          profileId: f.southManager.profileId,
          orgUnitId: f.northArea1,
          role: "manager",
          reason: "Illicit South pull",
        }),
      () =>
        f.northAdmin.actor.mutation(api.org.mutations.edit, {
          unitId: f.southArea1,
          name: "North takeover",
          reason: "Illicit South edit",
        }),
      () =>
        f.northAdmin.actor.mutation(api.teams.mutations.addMember, {
          teamId: f.northTeam,
          profileId: f.southManager.profileId,
          effectiveFrom: Date.now() + 2_000,
          reason: "Illicit South member",
        }),
      () =>
        f.northAdmin.actor.mutation(api.inventory.adjustments.request, {
          adjustmentType: "correction",
          reasonCode: "CROSS-SCOPE",
          lines: [
            {
              productId: product._id,
              locationId: f.southLocation._id,
              stockStatus: "available" as const,
              varianceBase: 1_000n,
            },
          ],
        }),
      () =>
        f.northAdmin.actor.mutation(api.inventory.counts.start, {
          locationId: f.southLocation._id,
          countType: "cycle",
          blindCount: true,
        }),
    ];
    for (const attempt of attempts) {
      const before = await writeSnapshot(f.t);
      await expect(attempt()).rejects.toThrow();
      expect(await writeSnapshot(f.t)).toEqual(before);
    }
  });

  it("5. ties each reason-bearing transition to the server-derived caller in audit", async () => {
    const audits = await f.t.run((ctx) => ctx.db.query("auditLogs").collect());
    for (const expected of f.evidence) {
      expect(
        audits.filter(
          (row) =>
            row.action === expected.action &&
            row.entityId === expected.entityId &&
            (row.action === "inventory.location_scope.assigned"
              ? JSON.parse(row.details ?? "{}").reason === expected.reason
              : row.details === expected.reason) &&
            row.subject === expected.subject,
        ),
        `${expected.action} ${expected.entityId}: ${expected.reason}`,
      ).toHaveLength(1);
    }
    // Invitations have no reason argument: verify their separate actor audit contract.
    for (const invited of [
      f.northAdmin,
      f.northManager,
      f.southManager,
      f.sales,
    ]) {
      expect(audits).toContainEqual(
        expect.objectContaining({
          action: "access.invited",
          entityId: invited.invitationId,
          subject: f.rootSubject,
          details: `${invited.email}:${invited.role}`,
        }),
      );
      expect(audits).toContainEqual(
        expect.objectContaining({
          action: "profile.provisioned",
          entityId: invited.profileId,
          subject: invited.subject,
        }),
      );
    }
  });

  it("6. denies sales the people reader and org writer, but returns a restricted dashboard", async () => {
    await expect(
      f.sales.actor.query(api.people.queries.list, { paginationOpts: page }),
    ).rejects.toThrow();
    const before = await writeSnapshot(f.t);
    await expect(
      f.sales.actor.mutation(api.org.mutations.edit, {
        unitId: f.northArea1,
        name: "Illicit edit",
        reason: "Sales cannot manage org",
      }),
    ).rejects.toThrow();
    expect(await writeSnapshot(f.t)).toEqual(before);
    expect(
      (await f.sales.actor.query(api.domains.dashboard.summary, {})).restricted,
    ).toBe(true);
  });
});
