import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import {
  attachmentProblem,
  formatCustomerCode,
  validateCodeFormat,
} from "./enrolment";

type Role = "admin" | "manager" | "sales" | "operations";

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
    const make = (code: string) =>
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
    return [await make("N-EAST"), await make("N-WEST")] as const;
  });
  const territory = await root.mutation(api.territories.mutations.create, {
    code: "N-E",
    name: "East",
    orgUnitId: east,
    effectiveFrom: Date.now() + 2000,
    reason: "coverage",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(territory, { effectiveFrom: past });
    const owner = await ctx.db
      .query("territoryOwnerships")
      .withIndex("by_territoryId_and_effectiveFrom", (q) =>
        q.eq("territoryId", territory),
      )
      .first();
    await ctx.db.patch(owner!._id, { effectiveFrom: past });
  });
  async function person(role: Role, unitId: Id<"orgUnits">, suffix: string) {
    const email = `${suffix}@example.test`;
    await root.mutation(api.domains.profiles.invite, { email, role });
    const user = t.withIdentity({ subject: suffix, email, name: suffix });
    await user.mutation(api.domains.profiles.ensure, {});
    const id = (await user.query(api.domains.profiles.current, {}))!._id;
    await t.run((ctx) =>
      ctx.db.patch(id, { orgUnitId: unitId, role, updatedAt: Date.now() }),
    );
    return { user, id };
  }
  const sales = await person("sales", east, "dsp-east");
  await t.run((ctx) =>
    ctx.db.insert("territorySalespeople", {
      territoryId: territory,
      profileId: sales.id,
      effectiveFrom: past,
      actorSubject: "seed",
      reason: "seed",
      createdAt: past,
    }),
  );
  const file = (type: string) =>
    t.run((ctx) => ctx.storage.store(new Blob(["evidence"], { type })));
  return { t, root, east, west, territory, sales, person, file };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

async function proposal(
  f: Fixture,
  overrides: Partial<{
    clientRequestId: string;
    name: string;
    territoryId: Id<"territories">;
    photoStorageIds: Id<"_storage">[];
    cisStorageId: Id<"_storage">;
  }> = {},
) {
  return {
    clientRequestId: "req-1",
    name: "Aling Nena Store",
    address: "12 Rizal St, Quezon City",
    channel: "Sari-sari",
    contactName: "Nena",
    contactPhone: "0917 000 0000",
    latitude: 14.65,
    longitude: 121.03,
    territoryId: f.territory,
    photoStorageIds: [await f.file("image/jpeg")],
    ...overrides,
  };
}

describe("new-store enrolment (CALL-07)", () => {
  it("creates a provisional, visitable outlet with a pending pin and replays idempotently", async () => {
    const f = await setup();
    const args = await proposal(f);
    const first = await f.sales.user.mutation(
      api.outlets.enrolment.propose,
      args,
    );
    expect(first).toMatchObject({
      provisionalCode: "PROV-000001",
      replayed: false,
    });
    const replay = await f.sales.user.mutation(
      api.outlets.enrolment.propose,
      args,
    );
    expect(replay).toEqual({ ...first, replayed: true });
    const state = await f.t.run(async (ctx) => ({
      outlet: await ctx.db.get(first.outletId),
      pins: await ctx.db.query("outletPins").collect(),
      assignments: await ctx.db.query("outletAssignments").collect(),
      events: await ctx.db.query("outletEnrolmentEvents").collect(),
      outlets: await ctx.db.query("outlets").collect(),
    }));
    expect(state.outlets).toHaveLength(1);
    expect(state.outlet).toMatchObject({
      code: "PROV-000001",
      status: "active",
      enrolmentStatus: "provisional",
      custodianOrgUnitId: f.east,
      channel: "Sari-sari",
      contacts: [{ name: "Nena", phone: "0917 000 0000" }],
    });
    expect(state.pins).toMatchObject([
      { status: "pending", source: "new_store_enrolment" },
    ]);
    expect(state.assignments).toMatchObject([
      { outletId: first.outletId, territoryId: f.territory },
    ]);
    expect(state.events).toMatchObject([
      { kind: "proposed", outletCode: "PROV-000001", actorName: "dsp-east" },
    ]);
    // The salesperson sees the new store in their scoped outlet list.
    const list = await f.sales.user.query(api.outlets.queries.list, {
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(list.page.map((o) => o._id)).toEqual([first.outletId]);
    await expect(
      f.sales.user.mutation(api.outlets.enrolment.propose, {
        ...args,
        name: "Different store",
      }),
    ).rejects.toThrow(/reused/);
  });

  it("requires a CIS or photo, valid files, the field's own territory and a contact", async () => {
    const f = await setup();
    await expect(
      f.sales.user.mutation(
        api.outlets.enrolment.propose,
        await proposal(f, { photoStorageIds: [] }),
      ),
    ).rejects.toThrow(/customer information sheet or a store photo/);
    // A PDF customer information sheet alone is enough.
    const pdf = await f.file("application/pdf");
    await f.sales.user.mutation(
      api.outlets.enrolment.propose,
      await proposal(f, { photoStorageIds: [], cisStorageId: pdf }),
    );
    await expect(
      f.sales.user.mutation(api.outlets.enrolment.propose, {
        ...(await proposal(f, { clientRequestId: "req-2" })),
        contactName: " ",
      }),
    ).rejects.toThrow(/Contact name required/);
    const other = await f.person("sales", f.east, "dsp-other");
    await expect(
      other.user.mutation(
        api.outlets.enrolment.propose,
        await proposal(f, { clientRequestId: "req-3" }),
      ),
    ).rejects.toThrow(/outside salesperson assignment/);
    // Without a territory the store lands in the proposer's own unit, unassigned.
    const unassigned = await other.user.mutation(
      api.outlets.enrolment.propose,
      {
        ...(await proposal(f, { clientRequestId: "req-4" })),
        territoryId: undefined,
      },
    );
    const outlet = await f.t.run((ctx) => ctx.db.get(unassigned.outletId));
    expect(outlet?.custodianOrgUnitId).toBe(f.east);
  });

  it("lets an in-scope manager approve, issuing the next free system code and verifying the pin", async () => {
    const f = await setup();
    const { enrolmentId, outletId } = await f.sales.user.mutation(
      api.outlets.enrolment.propose,
      await proposal(f),
    );
    // An imported store already holds SP000001: the sequence skips it.
    await f.root.mutation(api.outlets.mutations.create, {
      code: "SP000001",
      name: "Imported",
      custodianOrgUnitId: f.east,
      status: "active",
      reason: "import",
    });
    const westManager = await f.person("manager", f.west, "mgr-west");
    const eastManager = await f.person("manager", f.east, "mgr-east");
    const eastAdmin = await f.person("admin", f.east, "adm-east");
    const decision = {
      enrolmentId,
      decision: "approved" as const,
      reason: "CIS checked",
    };
    await expect(
      f.sales.user.mutation(api.outlets.enrolment.decide, decision),
    ).rejects.toThrow(/Insufficient permission/);
    await expect(
      eastAdmin.user.mutation(api.outlets.enrolment.decide, decision),
    ).rejects.toThrow(/Insufficient permission/);
    await expect(
      westManager.user.mutation(api.outlets.enrolment.decide, decision),
    ).rejects.toThrow(/outside your organizational scope/);
    await expect(
      eastManager.user.mutation(api.outlets.enrolment.decide, {
        ...decision,
        reason: " ",
      }),
    ).rejects.toThrow(/Reason required/);
    expect(
      (
        await westManager.user.query(api.outlets.enrolment.pending, {
          paginationOpts: { cursor: null, numItems: 10 },
        })
      ).page,
    ).toEqual([]);
    const queue = await eastManager.user.query(api.outlets.enrolment.pending, {
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(queue.page).toHaveLength(1);
    expect(queue.page[0]).toMatchObject({
      proposerName: "dsp-east",
      cisUrl: null,
    });
    expect(queue.page[0]!.photoUrls).toHaveLength(1);

    expect(
      await eastManager.user.mutation(api.outlets.enrolment.decide, decision),
    ).toEqual({ code: "SP000002" });
    await expect(
      eastManager.user.mutation(api.outlets.enrolment.decide, decision),
    ).rejects.toThrow(/already decided/);
    const state = await f.t.run(async (ctx) => ({
      outlet: await ctx.db.get(outletId),
      enrolment: await ctx.db.get(enrolmentId),
      pin: await ctx.db.query("outletPins").first(),
    }));
    expect(state.outlet).toMatchObject({
      code: "SP000002",
      status: "active",
      enrolmentStatus: "approved",
    });
    expect(state.enrolment).toMatchObject({
      status: "approved",
      assignedCode: "SP000002",
      decisionReason: "CIS checked",
    });
    expect(state.pin).toMatchObject({
      status: "verified",
      reviewerReason: "CIS checked",
    });
    // Admins and leaders see the change; the proposer sees only their own.
    const adminFeed = await eastAdmin.user.query(
      api.outlets.enrolment.notifications,
      {},
    );
    expect(adminFeed.map((e) => e.kind)).toEqual(["approved", "proposed"]);
    expect(adminFeed[0]).toMatchObject({
      outletCode: "SP000002",
      actorName: "mgr-east",
    });
    const westAdmin = await f.person("admin", f.west, "adm-west");
    expect(
      await westAdmin.user.query(api.outlets.enrolment.notifications, {}),
    ).toEqual([]);
    const other = await f.person("sales", f.east, "dsp-other");
    expect(
      await other.user.query(api.outlets.enrolment.notifications, {}),
    ).toEqual([]);
    expect(
      (await f.sales.user.query(api.outlets.enrolment.notifications, {}))
        .length,
    ).toBe(2);
    const mine = await f.sales.user.query(api.outlets.enrolment.mine, {
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(mine.page[0]!.enrolment.status).toBe("approved");
  });

  it("never lets the proposer decide, and rejection deactivates the provisional store", async () => {
    const f = await setup();
    const manager = await f.person("manager", f.east, "mgr-east");
    const own = await manager.user.mutation(api.outlets.enrolment.propose, {
      ...(await proposal(f, { clientRequestId: "mgr-1" })),
      territoryId: undefined,
    });
    await expect(
      manager.user.mutation(api.outlets.enrolment.decide, {
        enrolmentId: own.enrolmentId,
        decision: "approved",
        reason: "mine",
      }),
    ).rejects.toThrow(/proposer cannot decide/);
    const { enrolmentId, outletId } = await f.sales.user.mutation(
      api.outlets.enrolment.propose,
      await proposal(f),
    );
    expect(
      await manager.user.mutation(api.outlets.enrolment.decide, {
        enrolmentId,
        decision: "rejected",
        reason: "Store does not exist",
      }),
    ).toEqual({ code: "PROV-000002" });
    const state = await f.t.run(async (ctx) => ({
      outlet: await ctx.db.get(outletId),
      assignment: await ctx.db
        .query("outletAssignments")
        .withIndex("by_outletId_and_effectiveFrom", (q) =>
          q.eq("outletId", outletId),
        )
        .first(),
      pin: await ctx.db
        .query("outletPins")
        .withIndex("by_outletId_and_status", (q) => q.eq("outletId", outletId))
        .first(),
    }));
    expect(state.outlet).toMatchObject({
      status: "inactive",
      enrolmentStatus: "rejected",
      code: "PROV-000002",
    });
    expect(state.assignment?.effectiveTo).toBeDefined();
    expect(state.pin).toMatchObject({ status: "rejected" });
  });

  it("keeps the code format configurable by administrators only; salespeople stay view-only", async () => {
    const f = await setup();
    const admin = await f.person("admin", f.east, "adm-east");
    const manager = await f.person("manager", f.east, "mgr-east");
    expect(
      await f.sales.user.query(api.outlets.enrolment.codeFormat, {}),
    ).toEqual({ prefix: "SP", digits: 6, example: "SP000001" });
    await expect(
      f.sales.user.mutation(api.outlets.enrolment.setCodeFormat, {
        prefix: "SN",
        digits: 4,
      }),
    ).rejects.toThrow(/Insufficient permission/);
    await expect(
      admin.user.mutation(api.outlets.enrolment.setCodeFormat, {
        prefix: "s-1",
        digits: 4,
      }),
    ).rejects.toThrow(/Code prefix/);
    await admin.user.mutation(api.outlets.enrolment.setCodeFormat, {
      prefix: "sn",
      digits: 4,
    });
    const { enrolmentId } = await f.sales.user.mutation(
      api.outlets.enrolment.propose,
      await proposal(f),
    );
    expect(
      await manager.user.mutation(api.outlets.enrolment.decide, {
        enrolmentId,
        decision: "approved",
        reason: "ok",
      }),
    ).toEqual({ code: "SN0001" });
    // Salespeople cannot create or edit master/set-up records directly.
    await expect(
      f.sales.user.mutation(api.outlets.mutations.create, {
        code: "TYPED-1",
        name: "Typed code",
        custodianOrgUnitId: f.east,
        status: "active",
        reason: "x",
      }),
    ).rejects.toThrow(/Insufficient permission/);
  });

  it("formats codes and validates the format", () => {
    expect(formatCustomerCode("SP", 6, 42)).toBe("SP000042");
    expect(() => formatCustomerCode("SP", 4, 10000)).toThrow(/exhausted/);
    expect(() => validateCodeFormat("SP", 3)).toThrow(/digits/);
    expect(() => validateCodeFormat("PROV", 6)).toThrow(/reserved/);
    expect(() => validateCodeFormat("9X", 6)).toThrow(/prefix/);
    expect(() => validateCodeFormat("SP", 6)).not.toThrow();
  });

  it("accepts image photos and image/PDF information sheets up to 10 MB", () => {
    const file = (contentType?: string, size = 1000) => ({ size, contentType });
    expect(attachmentProblem(file("image/jpeg"), "photo")).toBeNull();
    expect(attachmentProblem(file(), "photo")).toBeNull();
    expect(attachmentProblem(file("application/pdf"), "cis")).toBeNull();
    expect(attachmentProblem(file("application/pdf"), "photo")).toMatch(
      /must be an image/,
    );
    expect(attachmentProblem(file("text/plain"), "cis")).toMatch(
      /image or PDF/,
    );
    expect(
      attachmentProblem(file("image/png", 11 * 1024 * 1024), "photo"),
    ).toMatch(/10 MB/);
    expect(attachmentProblem(null, "cis")).toMatch(/not found/);
  });

  it("serves every declared index on the new tables", async () => {
    const f = await setup();
    const { enrolmentId, outletId } = await f.sales.user.mutation(
      api.outlets.enrolment.propose,
      await proposal(f),
    );
    await f.t.run(async (ctx) => {
      const enrolment = (await ctx.db.get(enrolmentId))!;
      expect(
        await ctx.db
          .query("outletEnrolments")
          .withIndex("by_organizationId_and_status_and_proposedAt", (q) =>
            q.eq("organizationId", "sunpride").eq("status", "pending"),
          )
          .collect(),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("outletEnrolments")
          .withIndex("by_proposedByProfileId_and_proposedAt", (q) =>
            q.eq("proposedByProfileId", f.sales.id),
          )
          .collect(),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("outletEnrolments")
          .withIndex("by_proposedBy_and_clientRequestId", (q) =>
            q
              .eq("proposedBy", enrolment.proposedBy)
              .eq("clientRequestId", "req-1"),
          )
          .unique(),
      ).not.toBeNull();
      expect(
        await ctx.db
          .query("outletEnrolments")
          .withIndex("by_outletId", (q) => q.eq("outletId", outletId))
          .unique(),
      ).not.toBeNull();
      expect(
        await ctx.db
          .query("outletEnrolmentEvents")
          .withIndex("by_organizationId_and_createdAt", (q) =>
            q.eq("organizationId", "sunpride"),
          )
          .collect(),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("outletCodeSettings")
          .withIndex("by_organizationId", (q) =>
            q.eq("organizationId", "sunpride"),
          )
          .unique(),
      ).toMatchObject({ nextProvisionalSequence: 2, nextSequence: 1 });
    });
  });
});
