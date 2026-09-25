import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";

async function fixture() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const admin = t.withIdentity({
    subject: "root-count",
    email: "jcing.jc@gmail.com",
    name: "Root",
  });
  await admin.mutation(api.domains.profiles.ensure, {});
  await t.mutation(internal.seed.demo, {});
  await admin.mutation(api.inventory.setup.foundation, {});
  const [aUnit, bUnit] = await t.run(async (ctx) => {
    const unit = (code: string) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: "AREA",
        parentId: root.rootUnitId,
        status: "active" as const,
        effectiveFrom: 0,
        createdAt: 1,
        updatedAt: 1,
      });
    return [await unit("AREA-COUNT-A"), await unit("AREA-COUNT-B")] as const;
  });
  const locations = await t.run((ctx) =>
    ctx.db.query("inventoryLocations").take(10),
  );
  if (locations.length < 2) throw new Error("Locations not seeded");
  const [a, b] = locations;
  if (!a || !b) throw new Error("Locations not seeded");
  await t.run(async (ctx) => {
    await ctx.db.patch(a._id, { orgUnitId: aUnit });
    await ctx.db.patch(b._id, { orgUnitId: bUnit });
  });
  async function actor(
    email: string,
    role: "manager" | "viewer" | "sales" | "approver",
    unit = aUnit,
  ) {
    await admin.mutation(api.domains.profiles.invite, {
      email,
      name: email,
      role,
    });
    const who = t.withIdentity({ subject: email, email, name: email });
    await who.mutation(api.domains.profiles.ensure, {});
    await t.run(async (ctx) => {
      const p = await ctx.db
        .query("profiles")
        .withIndex("by_email", (q) => q.eq("email", email))
        .unique();
      if (!p) throw new Error("Missing profile");
      await ctx.db.patch(p._id, { orgUnitId: unit });
    });
    return who;
  }
  return { t, admin, a, b, aUnit, bUnit, actor };
}

describe("stock count session location scope", () => {
  it("denies viewer/sales start and submit, manager outside region, and forged location", async () => {
    const f = await fixture();
    const viewer = await f.actor("viewer-count@example.test", "viewer");
    const sales = await f.actor("sales-count@example.test", "sales");
    const manager = await f.actor("manager-count@example.test", "manager");
    const start = (locationId: typeof f.a._id) => ({
      locationId,
      countType: "cycle" as const,
      blindCount: true,
    });
    for (const who of [viewer, sales])
      await expect(
        who.mutation(api.inventory.counts.start, start(f.a._id)),
      ).rejects.toThrow();
    await expect(
      manager.mutation(api.inventory.counts.start, start(f.b._id)),
    ).rejects.toThrow();
    const sessionId = await manager.mutation(
      api.inventory.counts.start,
      start(f.a._id),
    );
    for (const who of [viewer, sales])
      await expect(
        who.mutation(api.inventory.counts.submit, { sessionId, lines: [] }),
      ).rejects.toThrow();
    expect(
      (await manager.query(api.inventory.counts.list, {})).map((s) => s._id),
    ).toContain(sessionId);
    const other = await f.admin.mutation(
      api.inventory.counts.start,
      start(f.b._id),
    );
    expect(
      (await manager.query(api.inventory.counts.list, {})).map((s) => s._id),
    ).not.toContain(other);
    await expect(
      manager.query(api.inventory.counts.detail, { sessionId: other }),
    ).rejects.toThrow();
  });

  it("redacts blind expected and variance for counter, reveals after submit, refuses own approval", async () => {
    const f = await fixture();
    const counter = await f.actor("counter@example.test", "manager");
    const approver = await f.actor("reviewer@example.test", "approver");
    const sessionId = await counter.mutation(api.inventory.counts.start, {
      locationId: f.a._id,
      countType: "cycle",
      blindCount: true,
    });
    const before = await counter.query(api.inventory.counts.detail, {
      sessionId,
    });
    for (const line of before.lines) {
      expect(line.systemBase).toBeUndefined();
      expect(line.varianceBase).toBeUndefined();
    }
    const reviewerView = await approver.query(api.inventory.counts.detail, {
      sessionId,
    });
    expect(
      reviewerView.lines.every((line) => line.systemBase !== undefined),
    ).toBe(true);
    await counter.mutation(api.inventory.counts.submit, {
      sessionId,
      lines: reviewerView.lines.map((line) => ({
        lineId: line.lineId,
        countedBase: 0n,
      })),
    });
    const after = await counter.query(api.inventory.counts.detail, {
      sessionId,
    });
    expect(
      after.lines.every(
        (line) =>
          line.systemBase !== undefined && line.varianceBase !== undefined,
      ),
    ).toBe(true);
    await expect(
      counter.mutation(api.inventory.counts.approveAndPost, {
        sessionId,
        idempotencyKey: "self-count",
        reasonCode: "COUNT",
      }),
    ).rejects.toThrow("Counter cannot approve");
  });

  it("rejects an out-of-scope approval after location reassignment", async () => {
    const f = await fixture();
    const manager = await f.actor("manager-reassigned@example.test", "manager");
    const sessionId = await manager.mutation(api.inventory.counts.start, {
      locationId: f.a._id,
      countType: "cycle",
      blindCount: false,
    });
    const detail = await manager.query(api.inventory.counts.detail, {
      sessionId,
    });
    await manager.mutation(api.inventory.counts.submit, {
      sessionId,
      lines: detail.lines.map((line) => ({
        lineId: line.lineId,
        countedBase: 0n,
      })),
    });
    await f.t.run((ctx) => ctx.db.patch(f.a._id, { orgUnitId: f.bUnit }));
    const approver = await f.actor(
      "approver-reassigned@example.test",
      "approver",
    );
    await expect(
      approver.mutation(api.inventory.counts.approveAndPost, {
        sessionId,
        idempotencyKey: "reassigned",
        reasonCode: "COUNT",
      }),
    ).rejects.toThrow();
  });
});
