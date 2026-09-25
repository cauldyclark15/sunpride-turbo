import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";

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
  const [east, west, customer, inactive] = await t.run(async (ctx) => {
    const unit = (code: string) =>
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
    const east = await unit("OUT-EAST");
    const west = await unit("OUT-WEST");
    const customer = await ctx.db.insert("customers", {
      code: "SHARED",
      name: "Shared",
      channel: "GT",
      territory: "",
      creditLimit: 0,
      active: true,
      updatedAt: now,
    });
    const inactive = await ctx.db.insert("customers", {
      code: "OLD",
      name: "Old",
      channel: "GT",
      territory: "",
      creditLimit: 0,
      active: false,
      updatedAt: now,
    });
    return [east, west, customer, inactive] as const;
  });
  return { t, root, east, west, customer, inactive };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function actor(
  f: Fixture,
  role: "admin" | "manager",
  unitId: Id<"orgUnits">,
  suffix: string,
) {
  const email = `${suffix}@example.test`;
  await f.root.mutation(api.domains.profiles.invite, { email, role });
  const user = f.t.withIdentity({ subject: suffix, email });
  await user.mutation(api.domains.profiles.ensure, {});
  const id = (await user.query(api.domains.profiles.current, {}))!._id;
  await f.t.run((ctx) =>
    ctx.db.patch(id, { orgUnitId: unitId, role, updatedAt: Date.now() }),
  );
  return user;
}
function create(f: Fixture, code: string, custodianOrgUnitId = f.east) {
  return f.root.mutation(api.outlets.mutations.create, {
    code,
    name: code,
    custodianOrgUnitId,
    status: "prospect",
    reason: "new store",
  });
}
const change = (
  outletId: Id<"outlets">,
  customerId: Id<"customers">,
  effectiveFrom: number,
) => ({
  outletId,
  customerId,
  effectiveFrom,
  source: "local",
  reason: "link approved",
});
const propose = (
  outletId: Id<"outlets">,
  latitude = 14.6,
  longitude = 121,
) => ({
  outletId,
  latitude,
  longitude,
  source: "survey",
  reason: "site survey",
});

describe("outlet master and verified pin authority", () => {
  it("scopes bounded pages and denies cross-region outlet, customer link and pin even with a shared customer", async () => {
    const f = await setup();
    const east = await create(f, "EAST");
    const west = await create(f, "WEST", f.west);
    const from = Date.now() + 1000;
    for (const outletId of [east, west])
      await f.root.mutation(
        api.outlets.mutations.changeCustomerLink,
        change(outletId, f.customer, from),
      );
    const eastAdmin = await actor(f, "admin", f.east, "out-east");
    expect(
      (
        await eastAdmin.query(api.outlets.queries.list, {
          paginationOpts: { cursor: null, numItems: 1 },
        })
      ).page.map((row) => row._id),
    ).toEqual([east]);
    expect(
      (
        await eastAdmin.query(api.outlets.queries.list, {
          paginationOpts: { cursor: null, numItems: 100 },
        })
      ).page.map((row) => row._id),
    ).toEqual([east]);
    await expect(
      eastAdmin.query(api.outlets.queries.detail, { outletId: west }),
    ).rejects.toThrow(/scope/);
    await expect(
      eastAdmin.query(api.outlets.queries.customerHistory, { outletId: west }),
    ).rejects.toThrow(/scope/);
    await expect(
      eastAdmin.query(api.outlets.queries.pinHistory, { outletId: west }),
    ).rejects.toThrow(/scope/);
    await expect(
      eastAdmin.mutation(
        api.outlets.mutations.changeCustomerLink,
        change(west, f.customer, from + 2000),
      ),
    ).rejects.toThrow(/scope/);
    await expect(
      eastAdmin.mutation(api.outlets.verification.propose, propose(west)),
    ).rejects.toThrow(/scope/);
    const pinId = await f.root.mutation(
      api.outlets.verification.propose,
      propose(west),
    );
    await expect(
      eastAdmin.mutation(api.outlets.verification.decide, {
        pinId,
        decision: "verified",
        reason: "review",
      }),
    ).rejects.toThrow(/scope/);
    await expect(
      eastAdmin.query(api.outlets.queries.list, {
        paginationOpts: { cursor: null, numItems: 101 },
      }),
    ).rejects.toThrow(/Page size/);
  });

  it("uses the persisted territory assignment owner over the custodian for every gate", async () => {
    const f = await setup();
    const id = await create(f, "MOVED", f.east);
    const territoryId = await f.root.mutation(
      api.territories.mutations.create,
      {
        code: "OUT-WEST",
        name: "West",
        orgUnitId: f.west,
        effectiveFrom: Date.now() + 1000,
        reason: "coverage",
      },
    );
    await f.t.run(async (ctx) => {
      const from = Date.now() - 5000;
      await ctx.db.patch(territoryId, { effectiveFrom: from });
      const owner = await ctx.db
        .query("territoryOwnerships")
        .withIndex("by_territoryId_and_effectiveFrom", (q) =>
          q.eq("territoryId", territoryId),
        )
        .first();
      await ctx.db.patch(owner!._id, { effectiveFrom: from });
      await ctx.db.insert("outletAssignments", {
        outletId: id,
        territoryId,
        effectiveFrom: from,
        actorSubject: "fixture",
        reason: "coverage",
        createdAt: from,
      });
    });
    const east = await actor(f, "admin", f.east, "assigned-east");
    const west = await actor(f, "admin", f.west, "assigned-west");
    await expect(
      east.query(api.outlets.queries.detail, { outletId: id }),
    ).rejects.toThrow(/scope/);
    await expect(
      east.mutation(api.outlets.verification.propose, propose(id)),
    ).rejects.toThrow(/scope/);
    expect(
      (
        await east.query(api.outlets.queries.list, {
          paginationOpts: { cursor: null, numItems: 25 },
        })
      ).page,
    ).toEqual([]);
    expect(
      (await west.query(api.outlets.queries.detail, { outletId: id })).outlet
        ._id,
    ).toBe(id);
  });

  it("creates a prospect without customer and refuses inactive customer links", async () => {
    const f = await setup();
    const id = await create(f, "LEAD");
    expect(
      (await f.root.query(api.outlets.queries.detail, { outletId: id }))
        .customerLink,
    ).toBeNull();
    await expect(
      f.root.mutation(
        api.outlets.mutations.changeCustomerLink,
        change(id, f.inactive, Date.now() + 1000),
      ),
    ).rejects.toThrow(/not active/);
    await expect(create(f, "LEAD")).rejects.toThrow(/Duplicate/);
  });

  it("keeps customer links half-open, retaining history on a scheduled change", async () => {
    const f = await setup();
    const id = await create(f, "LINKS");
    const second = await f.t.run((ctx) =>
      ctx.db.insert("customers", {
        code: "SECOND",
        name: "Second",
        channel: "GT",
        territory: "",
        creditLimit: 0,
        active: true,
        updatedAt: Date.now(),
      }),
    );
    const from = Date.now() + 1000;
    const to = from + 1000;
    await f.root.mutation(
      api.outlets.mutations.changeCustomerLink,
      change(id, f.customer, from),
    );
    await f.root.mutation(
      api.outlets.mutations.changeCustomerLink,
      change(id, second, to),
    );
    expect(
      (
        await f.root.query(api.outlets.queries.detail, {
          outletId: id,
          asOf: to - 1,
        })
      ).customerLink?.customerId,
    ).toBe(f.customer);
    expect(
      (
        await f.root.query(api.outlets.queries.detail, {
          outletId: id,
          asOf: to,
        })
      ).customerLink?.customerId,
    ).toBe(second);
    expect(
      (
        await f.root.query(api.outlets.queries.customerHistory, {
          outletId: id,
        })
      ).map((row) => row.effectiveTo),
    ).toEqual([to, undefined]);
  });

  it("requires an independent reviewer and a reason; pin versions stay half-open and audit omits coordinates", async () => {
    const f = await setup();
    const id = await create(f, "PINS");
    const reviewer = await actor(f, "manager", f.east, "pin-reviewer");
    const first = await f.root.mutation(
      api.outlets.verification.propose,
      propose(id),
    );
    expect(
      (await f.root.query(api.outlets.queries.detail, { outletId: id })).pin,
    ).toBeNull();
    await expect(
      f.root.mutation(api.outlets.verification.decide, {
        pinId: first,
        decision: "verified",
        reason: "same",
      }),
    ).rejects.toThrow(/Independent/);
    await expect(
      reviewer.mutation(api.outlets.verification.decide, {
        pinId: first,
        decision: "verified",
        reason: " ",
      }),
    ).rejects.toThrow(/required/);
    await reviewer.mutation(api.outlets.verification.decide, {
      pinId: first,
      decision: "verified",
      reason: "ground survey",
    });
    const second = await f.root.mutation(
      api.outlets.verification.propose,
      propose(id, 14.7, 121.1),
    );
    await reviewer.mutation(api.outlets.verification.decide, {
      pinId: second,
      decision: "verified",
      reason: "moved entrance",
    });
    const pins = await f.root.query(api.outlets.queries.pinHistory, {
      outletId: id,
    });
    expect(pins.map((row) => row.status)).toEqual(["verified", "verified"]);
    expect(pins[0]?.effectiveTo).toBe(pins[1]?.effectiveFrom);
    expect(
      (
        await f.root.query(api.outlets.queries.detail, {
          outletId: id,
          asOf: pins[0]!.effectiveTo! - 1,
        })
      ).pin?._id,
    ).toBe(first);
    expect(
      (
        await f.root.query(api.outlets.queries.detail, {
          outletId: id,
          asOf: pins[1]!.effectiveFrom,
        })
      ).pin?._id,
    ).toBe(second);
    const logs = await f.t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "outletPin").eq("entityId", first),
        )
        .take(20),
    );
    expect(JSON.stringify(logs)).not.toContain("14.6");
    expect(JSON.stringify(logs)).not.toContain("121");
  });

  it("rejects invalid WGS84/radius and records rejected proposals without effective pins", async () => {
    const f = await setup();
    const id = await create(f, "INVALID");
    for (const [latitude, longitude] of [
      [91, 0],
      [0, -181],
      [NaN, 0],
    ])
      await expect(
        f.root.mutation(
          api.outlets.verification.propose,
          propose(id, latitude, longitude),
        ),
      ).rejects.toThrow(/WGS84/);
    await expect(
      f.root.mutation(api.outlets.verification.propose, {
        ...propose(id),
        radiusMeters: 501,
      }),
    ).rejects.toThrow(/radius/);
    const pinId = await f.root.mutation(
      api.outlets.verification.propose,
      propose(id),
    );
    const reviewer = await actor(f, "manager", f.east, "reject-reviewer");
    await reviewer.mutation(api.outlets.verification.decide, {
      pinId,
      decision: "rejected",
      reason: "inaccurate",
    });
    expect(
      (await f.root.query(api.outlets.queries.detail, { outletId: id })).pin,
    ).toBeNull();
    expect(
      (await f.root.query(api.outlets.queries.pinHistory, { outletId: id }))[0]
        ?.status,
    ).toBe("rejected");
  });
});
