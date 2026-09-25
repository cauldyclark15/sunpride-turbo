import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

type Test = TestConvex<typeof schema>;
type Role = "admin" | "manager" | "viewer" | "sales" | "analyst";

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = t.withIdentity({ subject: "root", email: "jcing.jc@gmail.com" });
  await root.mutation(api.domains.profiles.ensure, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const from = Date.now() + 10000;
  const east = await root.mutation(api.org.mutations.create, {
    code: "EAST",
    name: "East",
    typeCode: "REGION",
    parentId: rootUnitId,
    effectiveFrom: from,
  });
  const west = await root.mutation(api.org.mutations.create, {
    code: "WEST",
    name: "West",
    typeCode: "REGION",
    parentId: rootUnitId,
    effectiveFrom: from,
  });
  await t.run(async (ctx) => {
    for (const id of [east, west]) {
      await ctx.db.patch(id, {
        effectiveFrom: Date.now() - 1000,
        parentId: rootUnitId,
      });
      const edge = await ctx.db
        .query("orgUnitParentEdges")
        .withIndex("by_unitId_and_effectiveFrom", (q) => q.eq("unitId", id))
        .first();
      if (edge)
        await ctx.db.patch(edge._id, { effectiveFrom: Date.now() - 1000 });
    }
  });
  return { t, root, rootUnitId, east, west };
}

async function person(
  t: Test,
  root: Awaited<ReturnType<typeof setup>>["root"],
  email: string,
  role: Role,
  unitId: Awaited<ReturnType<typeof setup>>["east"],
) {
  await root.mutation(api.domains.profiles.invite, { email, role });
  const actor = t.withIdentity({ subject: email, email });
  await actor.mutation(api.domains.profiles.ensure, {});
  const id = (await actor.query(api.domains.profiles.current, {}))!._id;
  await root.mutation(api.people.mutations.assign, {
    profileId: id,
    orgUnitId: unitId,
    role,
    reason: "initial assignment",
  });
  return { actor, id };
}

const page = { cursor: null, numItems: 100 };

async function team(
  f: Awaited<ReturnType<typeof setup>>,
  code = "TEAM-1",
  unitId = f.east,
) {
  return f.root.mutation(api.teams.mutations.create, {
    code,
    name: "Field team",
    orgUnitId: unitId,
    effectiveFrom: Date.now() + 1000,
    reason: "formation",
  });
}

describe("effective-dated teams and scoped access", () => {
  it("creates and lists by current subtree; other region is invisible to list and detail", async () => {
    const f = await setup();
    const eastAdmin = await person(
      f.t,
      f.root,
      "east-admin@example.test",
      "admin",
      f.east,
    );
    const westAdmin = await person(
      f.t,
      f.root,
      "west-admin@example.test",
      "admin",
      f.west,
    );
    const eastTeam = await team(f);
    const westTeam = await team(f, "WEST-TEAM", f.west);
    expect(
      (
        await eastAdmin.actor.query(api.teams.queries.list, {
          paginationOpts: page,
        })
      ).page.map((t) => t._id),
    ).toEqual([eastTeam]);
    expect(
      (
        await westAdmin.actor.query(api.teams.queries.list, {
          paginationOpts: page,
        })
      ).page.map((t) => t._id),
    ).toEqual([westTeam]);
    await expect(
      eastAdmin.actor.query(api.teams.queries.detail, { teamId: westTeam }),
    ).rejects.toThrow(/scope/);
    const record = await f.t.run((ctx) => ctx.db.get(eastTeam));
    expect(record?.code).toBe("TEAM-1");
    expect(record?.createdBy).toBeTruthy();
    expect(
      (
        await f.t.run((ctx) =>
          ctx.db
            .query("auditLogs")
            .withIndex("by_entity", (q) =>
              q.eq("entityType", "team").eq("entityId", eastTeam),
            )
            .collect(),
        )
      ).some((e) => e.action === "team.created"),
    ).toBe(true);
  });

  it("refuses normalized duplicate immutable codes and invalid effective dates", async () => {
    const f = await setup();
    await team(f, "same");
    await expect(team(f, " SAME ")).rejects.toThrow(/Duplicate/);
    await expect(
      f.root.mutation(api.teams.mutations.create, {
        code: "late",
        name: "Late",
        orgUnitId: f.east,
        effectiveFrom: Date.now() - 1000,
        reason: "backdate",
      }),
    ).rejects.toThrow(/future-effective/);
  });

  it("shows only current members in detail and gates member history to team scope", async () => {
    const f = await setup();
    const member = await person(
      f.t,
      f.root,
      "member@example.test",
      "viewer",
      f.east,
    );
    const westViewer = await person(
      f.t,
      f.root,
      "west-viewer@example.test",
      "viewer",
      f.west,
    );
    const id = await team(f);
    const membershipId = await f.root.mutation(api.teams.mutations.addMember, {
      teamId: id,
      profileId: member.id,
      effectiveFrom: Date.now() + 2000,
      reason: "join",
    });
    await f.t.run(async (ctx) => {
      await ctx.db.patch(id, { effectiveFrom: Date.now() - 1000 });
      await ctx.db.patch(membershipId, { effectiveFrom: Date.now() - 500 });
    });
    expect(
      (
        await member.actor.query(api.teams.queries.detail, { teamId: id })
      ).members.map((m) => m.profile._id),
    ).toEqual([member.id]);
    await expect(
      westViewer.actor.query(api.teams.queries.memberHistory, {
        teamId: id,
        profileId: member.id,
      }),
    ).rejects.toThrow(/scope/);
    await f.root.mutation(api.teams.mutations.removeMember, {
      teamId: id,
      profileId: member.id,
      effectiveTo: Date.now() + 1000,
      reason: "leave",
    });
    const audit = await f.t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "teamMembership").eq("entityId", membershipId),
        )
        .collect(),
    );
    expect(audit.map((e) => e.action)).toEqual([
      "team.member_added",
      "team.member_removed",
    ]);
  });

  it("refuses same-team overlap but permits multiple teams and retains removal history", async () => {
    const f = await setup();
    const member = await person(
      f.t,
      f.root,
      "member@example.test",
      "sales",
      f.east,
    );
    const first = await team(f);
    const second = await team(f, "TEAM-2");
    const start = Date.now() + 2000;
    const membershipId = await f.root.mutation(api.teams.mutations.addMember, {
      teamId: first,
      profileId: member.id,
      effectiveFrom: start,
      reason: "join",
    });
    await f.root.mutation(api.teams.mutations.addMember, {
      teamId: second,
      profileId: member.id,
      effectiveFrom: start,
      reason: "also join",
    });
    await expect(
      f.root.mutation(api.teams.mutations.addMember, {
        teamId: first,
        profileId: member.id,
        effectiveFrom: start + 1000,
        reason: "duplicate",
      }),
    ).rejects.toThrow(/Overlapping/);
    const end = start + 1000;
    await f.root.mutation(api.teams.mutations.removeMember, {
      teamId: first,
      profileId: member.id,
      effectiveTo: end,
      reason: "leave",
    });
    await f.root.mutation(api.teams.mutations.addMember, {
      teamId: first,
      profileId: member.id,
      effectiveFrom: end,
      reason: "rejoin",
    });
    await expect(
      member.actor.query(api.teams.queries.memberHistory, {
        teamId: first,
        profileId: member.id,
      }),
    ).rejects.toThrow(/permission/); // sales does not hold people.read
    const rows = await f.root.query(api.teams.queries.memberHistory, {
      teamId: first,
      profileId: member.id,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!._id).toBe(membershipId);
    expect(rows[0]!.effectiveTo).toBe(rows[1]!.effectiveFrom);
    expect(rows[0]!.reason).toBe("join");
    expect(rows[1]!.actorSubject).toBeTruthy();
  });

  it("checks member subtree and both owning and member-unit write scopes", async () => {
    const f = await setup();
    const eastAdmin = await person(
      f.t,
      f.root,
      "east-admin@example.test",
      "admin",
      f.east,
    );
    const westMember = await person(
      f.t,
      f.root,
      "west-member@example.test",
      "viewer",
      f.west,
    );
    const eastMember = await person(
      f.t,
      f.root,
      "east-member@example.test",
      "viewer",
      f.east,
    );
    const id = await team(f);
    await expect(
      f.root.mutation(api.teams.mutations.addMember, {
        teamId: id,
        profileId: westMember.id,
        effectiveFrom: Date.now() + 2000,
        reason: "cross",
      }),
    ).rejects.toThrow(/outside team hierarchy/);
    await expect(
      eastAdmin.actor.mutation(api.teams.mutations.addMember, {
        teamId: id,
        profileId: westMember.id,
        effectiveFrom: Date.now() + 2000,
        reason: "pull",
      }),
    ).rejects.toThrow(/scope/);
    await eastAdmin.actor.mutation(api.teams.mutations.addMember, {
      teamId: id,
      profileId: eastMember.id,
      effectiveFrom: Date.now() + 2000,
      reason: "join",
    });
  });

  it("enforces supervisor manager/admin role and containing unit", async () => {
    const f = await setup();
    const viewer = await person(
      f.t,
      f.root,
      "viewer@example.test",
      "viewer",
      f.east,
    );
    const westManager = await person(
      f.t,
      f.root,
      "west-manager@example.test",
      "manager",
      f.west,
    );
    const eastManager = await person(
      f.t,
      f.root,
      "east-manager@example.test",
      "manager",
      f.east,
    );
    await expect(
      f.root.mutation(api.teams.mutations.create, {
        code: "NO-VIEWER",
        name: "No",
        orgUnitId: f.east,
        supervisorProfileId: viewer.id,
        effectiveFrom: Date.now() + 1000,
        reason: "test",
      }),
    ).rejects.toThrow(/manager or administrator/);
    await expect(
      f.root.mutation(api.teams.mutations.create, {
        code: "NO-WEST",
        name: "No",
        orgUnitId: f.east,
        supervisorProfileId: westManager.id,
        effectiveFrom: Date.now() + 1000,
        reason: "test",
      }),
    ).rejects.toThrow(/outside team hierarchy/);
    const id = await f.root.mutation(api.teams.mutations.create, {
      code: "VALID",
      name: "Valid",
      orgUnitId: f.east,
      supervisorProfileId: eastManager.id,
      effectiveFrom: Date.now() + 1000,
      reason: "test",
    });
    expect(
      (await f.root.query(api.teams.queries.detail, { teamId: id })).team
        .supervisorProfileId,
    ).toBe(eastManager.id);
    await expect(
      f.root.mutation(api.teams.mutations.edit, {
        teamId: id,
        name: "Changed",
        supervisorProfileId: westManager.id,
        reason: "swap",
      }),
    ).rejects.toThrow(/outside team hierarchy/);
  });

  it("denies viewer/sales writes, allows analyst cross-region read but never write", async () => {
    const f = await setup();
    const viewer = await person(
      f.t,
      f.root,
      "viewer@example.test",
      "viewer",
      f.east,
    );
    const seller = await person(
      f.t,
      f.root,
      "seller@example.test",
      "sales",
      f.east,
    );
    const analyst = await person(
      f.t,
      f.root,
      "analyst@example.test",
      "analyst",
      f.east,
    );
    const id = await team(f, "WEST-TEAM", f.west);
    const args = { teamId: id, name: "No", reason: "unauthorized" };
    for (const actor of [viewer.actor, seller.actor, analyst.actor])
      await expect(
        actor.mutation(api.teams.mutations.edit, args),
      ).rejects.toThrow();
    expect(
      (
        await analyst.actor.query(api.teams.queries.list, {
          paginationOpts: page,
        })
      ).page.map((t) => t._id),
    ).toContain(id);
    expect(
      (await analyst.actor.query(api.teams.queries.detail, { teamId: id })).team
        ._id,
    ).toBe(id);
  });

  it("deactivation closes memberships without deletion and preserves audit history", async () => {
    const f = await setup();
    const member = await person(
      f.t,
      f.root,
      "member@example.test",
      "viewer",
      f.east,
    );
    const id = await team(f);
    const start = Date.now() + 2000;
    await f.root.mutation(api.teams.mutations.addMember, {
      teamId: id,
      profileId: member.id,
      effectiveFrom: start,
      reason: "join",
    });
    const end = start + 1000;
    await f.root.mutation(api.teams.mutations.deactivate, {
      teamId: id,
      effectiveTo: end,
      reason: "retired",
    });
    const detail = await f.root.query(api.teams.queries.detail, { teamId: id });
    expect(detail.team.effectiveTo).toBe(end);
    const rows = await f.root.query(api.teams.queries.memberHistory, {
      teamId: id,
      profileId: member.id,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.effectiveTo).toBe(end);
    expect(
      (
        await f.t.run((ctx) =>
          ctx.db
            .query("auditLogs")
            .withIndex("by_entity", (q) =>
              q.eq("entityType", "team").eq("entityId", id),
            )
            .collect(),
        )
      ).some((e) => e.action === "team.deactivated"),
    ).toBe(true);
    await expect(
      f.root.mutation(api.teams.mutations.addMember, {
        teamId: id,
        profileId: member.id,
        effectiveFrom: end,
        reason: "too late",
      }),
    ).rejects.toThrow();
  });
});
