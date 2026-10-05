import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
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

type AuditRow = {
  subject: string;
  action: string;
  entityType: string;
  entityId: string;
  details?: string;
};
// Inspect the authored audit content (strings only), never system ids or numeric timestamps:
// a creation time such as 1791211210000 contains "121" without being a coordinate.
function auditLeaks(
  logs: AuditRow[],
  coordinates: number[],
  callerText: string[],
) {
  const leaks: string[] = [];
  for (const log of logs) {
    for (const value of [
      log.subject,
      log.action,
      log.entityType,
      log.entityId,
      log.details ?? "",
    ]) {
      // Numbers delimited by non-alphanumerics only, so an id such as "k7121ab" is not a coordinate.
      for (const token of value.match(
        /(?<![\w.])-?\d+(?:\.\d+)?(?![\w]|\.\d)/g,
      ) ?? [])
        if (coordinates.includes(Number(token))) leaks.push(token);
      for (const text of callerText)
        if (value.toLowerCase().includes(text.toLowerCase())) leaks.push(text);
    }
  }
  return leaks;
}

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
    const logs = await f.t.run(async (ctx) => [
      ...(await ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "outletPin").eq("entityId", first),
        )
        .take(20)),
      ...(await ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "outletPin").eq("entityId", second),
        )
        .take(20)),
    ]);
    expect(logs.map((log) => [log.action, log.details])).toEqual([
      ["outlet.pin_proposed", "Pin proposed"],
      ["outlet.pin_verified", "Pin reviewed"],
      ["outlet.pin_proposed", "Pin proposed"],
      ["outlet.pin_verified", "Pin reviewed"],
    ]);
    expect(
      auditLeaks(
        logs,
        [14.6, 121, 14.7, 121.1],
        ["site survey", "survey", "ground survey", "moved entrance"],
      ),
    ).toEqual([]);
  });

  it("audit leak check ignores timestamps containing 121 but still catches coordinates and caller text", () => {
    const base = {
      subject: "issuer|root",
      action: "outlet.pin_proposed",
      entityType: "outletPin",
      entityId: "k17912112100121abc",
    };
    // Timestamps live outside the inspected fields, so a 121-bearing creation time is ignored.
    const timestamped = {
      ...base,
      details: "Pin proposed",
      createdAt: 1791211210000,
      _creationTime: 1791211210000.5,
    };
    expect(auditLeaks([timestamped], [14.6, 121], ["site survey"])).toEqual([]);
    expect(
      auditLeaks(
        [{ ...base, details: "Pin proposed at 14.6, 121.0" }],
        [14.6, 121],
        [],
      ),
    ).toEqual(["14.6", "121.0"]);
    expect(
      auditLeaks(
        [{ ...base, details: "Pin proposed: Site Survey" }],
        [14.6, 121],
        ["site survey"],
      ),
    ).toEqual(["site survey"]);
  });

  it("real pin audit rows created at a 121-bearing instant pass the structural check", async () => {
    vi.useFakeTimers({ now: 1_791_211_210_000, toFake: ["Date"] });
    try {
      const f = await setup();
      const id = await create(f, "TS121");
      const pinId = await f.root.mutation(
        api.outlets.verification.propose,
        propose(id),
      );
      const logs = await f.t.run((ctx) =>
        ctx.db
          .query("auditLogs")
          .withIndex("by_entity", (q) =>
            q.eq("entityType", "outletPin").eq("entityId", pinId),
          )
          .take(20),
      );
      expect(logs).toHaveLength(1);
      expect(String(logs[0]!.createdAt)).toContain("121");
      // The former substring assertion would have failed here on the timestamp alone.
      expect(JSON.stringify(logs)).toContain("121");
      expect(auditLeaks(logs, [14.6, 121], ["site survey"])).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
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
