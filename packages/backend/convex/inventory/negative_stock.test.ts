import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { postMovement, type PostMovementInput } from "./posting";

/**
 * SP-0085 (client call CALL-10): negative stock is allowed in distributor
 * operations through an explicit, location-scoped allowance; every negative
 * posting is flagged for reconciliation (ADR-007).
 */
type T = TestConvex<typeof schema>;
const OPENING = 40_000n;
const REFUSED = /negative balance|Insufficient available stock/;

async function provision() {
  const t: T = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const admin = t.withIdentity({
    subject: "negative-admin",
    email: "jcing.jc@gmail.com",
    name: "Negative Admin",
  });
  await admin.mutation(api.domains.profiles.ensure);
  await t.mutation(internal.seed.demo);
  await admin.mutation(api.inventory.setup.foundation);
  const state = await t.run(async (ctx) => {
    const locations = await ctx.db
      .query("inventoryLocations")
      .withIndex("by_organizationId_and_code", (q) =>
        q.eq("organizationId", "sunpride"),
      )
      .take(50);
    return {
      product: await ctx.db
        .query("products")
        .withIndex("by_code", (q) => q.eq("code", "SP-PJ-1L"))
        .unique(),
      truck: locations.find((location) => location.code === "TRUCK-001"),
      inTransit: locations.find((location) => location.type === "in_transit"),
      adminProfile: await ctx.db
        .query("profiles")
        .withIndex("by_email", (q) => q.eq("email", "jcing.jc@gmail.com"))
        .unique(),
    };
  });
  if (!state.product || !state.truck || !state.inTransit || !state.adminProfile)
    throw new Error("Test inventory not seeded");
  await admin.mutation(api.inventory.setup.postOpeningBalances, {
    idempotencyKey: `negative-opening:${state.product._id}`,
    sourceReference: "TEST-CUTOVER-NEG",
    lines: [
      {
        productId: state.product._id,
        locationId: state.truck._id,
        quantityBase: OPENING,
        lotNumber: "OPEN-NEG-2026",
        manufacturedAt: Date.now() - 30 * 86_400_000,
        expiresAt: Date.now() + 335 * 86_400_000,
        unitCostMinor: 10_000n,
      },
    ],
  });
  return {
    t,
    admin,
    product: state.product,
    truck: state.truck,
    inTransit: state.inTransit,
    adminSubject: state.adminProfile.authSubject,
  };
}

async function setTracking(
  t: T,
  productId: Id<"products">,
  trackingMode: "none" | "lot",
) {
  await t.run(async (ctx) => {
    const policy = await ctx.db
      .query("productInventoryPolicies")
      .withIndex("by_organizationId_and_productId", (q) =>
        q.eq("organizationId", "sunpride").eq("productId", productId),
      )
      .unique();
    if (!policy) throw new Error("Policy missing");
    await ctx.db.patch(policy._id, { trackingMode });
  });
}

function outbound(
  productId: Id<"products">,
  locationId: Id<"inventoryLocations">,
  key: string,
  quantityBase: bigint,
  overrides: Partial<PostMovementInput> = {},
): PostMovementInput {
  return {
    idempotencyKey: key,
    payloadHash: key,
    commandType: "test.distributor",
    movementType: "inventory_issue",
    sourceType: "test",
    actorSubject: "distributor-clerk",
    lines: [{ productId, fromLocationId: locationId, quantityBase }],
    ...overrides,
  };
}

function post(t: T, input: PostMovementInput) {
  return t.run(async (ctx) => postMovement(ctx, input));
}

async function balance(
  t: T,
  productId: Id<"products">,
  locationId: Id<"inventoryLocations">,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("inventoryBalances")
      .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
        q
          .eq("organizationId", "sunpride")
          .eq("productId", productId)
          .eq("locationId", locationId),
      )
      .unique(),
  );
}

function withoutSystemFields<D extends { _id: unknown; _creationTime: number }>(
  doc: D,
): Omit<D, "_id" | "_creationTime"> {
  const copy: Record<string, unknown> = { ...doc };
  delete copy._id;
  delete copy._creationTime;
  return copy as Omit<D, "_id" | "_creationTime">;
}

async function allFlags(t: T) {
  return t.run(async (ctx) => ctx.db.query("negativeStockFlags").collect());
}

describe("distributor negative stock (SP-0085)", () => {
  it("still refuses to oversell when the location has no allowance", async () => {
    const { t, product, truck } = await provision();
    await setTracking(t, product._id, "none");
    await expect(
      post(t, outbound(product._id, truck._id, "no-allowance", OPENING + 1n)),
    ).rejects.toThrow(REFUSED);
    expect((await balance(t, product._id, truck._id))?.physicalBase).toBe(
      OPENING,
    );
    expect(await allFlags(t)).toEqual([]);
  });

  it("lets an allowed distributor sale go below zero and flags it for reconciliation", async () => {
    const { t, admin, product, truck } = await provision();
    await setTracking(t, product._id, "none");
    await admin.mutation(api.inventory.negative_stock.setAllowance, {
      locationId: truck._id,
      active: true,
      movementTypes: ["inventory_issue", "pos_sale"],
      sourceRef: "CALL-10 2026-10-02",
    });
    await post(t, outbound(product._id, truck._id, "within-stock", 30_000n));
    expect(await allFlags(t)).toEqual([]);
    const first = await post(
      t,
      outbound(product._id, truck._id, "below-zero", 15_000n),
    );
    let after = await balance(t, product._id, truck._id);
    expect(after?.physicalBase).toBe(-5_000n);
    expect(after?.availableBase).toBe(-5_000n);
    expect(after?.availableStockBase).toBe(-5_000n);
    await post(t, outbound(product._id, truck._id, "deeper", 1_000n));
    after = await balance(t, product._id, truck._id);
    expect(after?.physicalBase).toBe(-6_000n);
    const flags = await allFlags(t);
    expect(flags).toHaveLength(2);
    expect(flags[0]).toMatchObject({
      movementId: first.movementId,
      movementType: "inventory_issue",
      quantityBase: 15_000n,
      balanceAfterBase: -5_000n,
      shortfallBase: 5_000n,
      status: "open",
      postedBy: "distributor-clerk",
    });
    expect(flags[1]).toMatchObject({
      balanceAfterBase: -6_000n,
      shortfallBase: 1_000n,
    });
    const ledger = await t.run(async (ctx) =>
      ctx.db
        .query("inventoryLedgerEntries")
        .withIndex("by_organizationId_and_movementId", (q) =>
          q.eq("organizationId", "sunpride").eq("movementId", first.movementId),
        )
        .collect(),
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      quantityBeforeBase: 10_000n,
      quantityAfterBase: -5_000n,
    });
    const { page: listed } = await admin.query(
      api.inventory.negative_stock.flags,
      { paginationOpts: { numItems: 50, cursor: null } },
    );
    expect(listed.map((flag) => flag.balanceAfter)).toEqual(
      expect.arrayContaining(["-5", "-6"]),
    );
    expect(listed[0]?.currentAvailable).toBe("-6");
  });

  it("keeps every other movement type, status and lot-tracked product non-negative", async () => {
    const { t, admin, product, truck } = await provision();
    await admin.mutation(api.inventory.negative_stock.setAllowance, {
      locationId: truck._id,
      active: true,
      movementTypes: ["pos_sale"],
      sourceRef: "CALL-10",
    });
    // Lot-tracked products keep exact lot balances, allowance or not.
    await expect(
      post(
        t,
        outbound(product._id, truck._id, "lot-oversell", OPENING + 1n, {
          movementType: "pos_sale",
        }),
      ),
    ).rejects.toThrow();
    await setTracking(t, product._id, "none");
    // Not named in the allowance.
    await expect(
      post(t, outbound(product._id, truck._id, "issue-oversell", OPENING + 1n)),
    ).rejects.toThrow(REFUSED);
    await expect(
      post(
        t,
        outbound(product._id, truck._id, "adjust-oversell", OPENING + 1n, {
          movementType: "inventory_adjustment",
        }),
      ),
    ).rejects.toThrow(REFUSED);
    // Non-available statuses never go negative.
    await expect(
      post(t, {
        ...outbound(product._id, truck._id, "hold-oversell", 1n, {
          movementType: "pos_sale",
        }),
        lines: [
          {
            productId: product._id,
            fromLocationId: truck._id,
            fromStockStatus: "quality_hold",
            quantityBase: 1n,
          },
        ],
      }),
    ).rejects.toThrow("negative balance");
    expect((await balance(t, product._id, truck._id))?.physicalBase).toBe(
      OPENING,
    );
    expect(await allFlags(t)).toEqual([]);
  });

  it("enforces the optional limit and refuses reservations against a negative balance", async () => {
    const { t, admin, product, truck } = await provision();
    await setTracking(t, product._id, "none");
    await admin.mutation(api.inventory.negative_stock.setAllowance, {
      locationId: truck._id,
      active: true,
      movementTypes: ["pos_sale"],
      limitBase: 2_000n,
      sourceRef: "CALL-10",
    });
    await expect(
      post(
        t,
        outbound(product._id, truck._id, "past-limit", OPENING + 2_001n, {
          movementType: "pos_sale",
        }),
      ),
    ).rejects.toThrow("Negative stock limit exceeded");
    await post(
      t,
      outbound(product._id, truck._id, "at-limit", OPENING + 2_000n, {
        movementType: "pos_sale",
      }),
    );
    expect((await balance(t, product._id, truck._id))?.availableBase).toBe(
      -2_000n,
    );
    await expect(
      admin.mutation(api.inventory.reservations.create, {
        idempotencyKey: "reserve-negative",
        reservationType: "sales_order",
        sourceType: "sales_order",
        sourceDocumentId: "SO-NEG",
        lines: [
          { productId: product._id, locationId: truck._id, quantityBase: 1n },
        ],
      }),
    ).rejects.toThrow();
  });

  it("stops applying once the allowance is switched off", async () => {
    const { t, admin, product, truck } = await provision();
    await setTracking(t, product._id, "none");
    const args = {
      locationId: truck._id,
      movementTypes: ["inventory_issue" as const],
      sourceRef: "CALL-10",
    };
    const id = await admin.mutation(api.inventory.negative_stock.setAllowance, {
      ...args,
      active: true,
    });
    expect(
      await admin.mutation(api.inventory.negative_stock.setAllowance, {
        ...args,
        active: false,
      }),
    ).toBe(id);
    await expect(
      post(t, outbound(product._id, truck._id, "switched-off", OPENING + 1n)),
    ).rejects.toThrow(REFUSED);
    const [row] = await admin.query(api.inventory.negative_stock.allowances, {
      locationIds: [truck._id],
    });
    expect(row).toMatchObject({ active: false, version: 2 });
  });

  it("receives into a negative balance and resolves the flag only when covered, by someone else", async () => {
    const { t, admin, product, truck, adminSubject } = await provision();
    await setTracking(t, product._id, "none");
    await admin.mutation(api.inventory.negative_stock.setAllowance, {
      locationId: truck._id,
      active: true,
      movementTypes: ["inventory_issue"],
      sourceRef: "CALL-10",
    });
    await post(
      t,
      outbound(product._id, truck._id, "other-short", OPENING + 1_000n),
    );
    await post(
      t,
      outbound(product._id, truck._id, "own-short", 1_000n, {
        actorSubject: adminSubject,
      }),
    );
    const [otherFlag, ownFlag] = await allFlags(t);
    await expect(
      admin.mutation(api.inventory.negative_stock.resolveFlag, {
        flagId: otherFlag!._id,
        note: "Too early",
      }),
    ).rejects.toThrow("still below zero");
    // A receipt that only partly covers the shortfall is still accepted.
    await post(t, {
      idempotencyKey: "partial-receipt",
      payloadHash: "partial-receipt",
      commandType: "test.receipt",
      movementType: "goods_receipt",
      sourceType: "test",
      actorSubject: "warehouse",
      lines: [
        {
          productId: product._id,
          toLocationId: truck._id,
          quantityBase: 500n,
          unitCostMinor: 12_000n,
        },
      ],
    });
    expect((await balance(t, product._id, truck._id))?.physicalBase).toBe(
      -1_500n,
    );
    await post(t, {
      idempotencyKey: "full-receipt",
      payloadHash: "full-receipt",
      commandType: "test.receipt",
      movementType: "goods_receipt",
      sourceType: "test",
      actorSubject: "warehouse",
      lines: [
        {
          productId: product._id,
          toLocationId: truck._id,
          quantityBase: 4_000n,
          unitCostMinor: 12_000n,
        },
      ],
    });
    const covered = await balance(t, product._id, truck._id);
    expect(covered?.physicalBase).toBe(2_500n);
    expect(covered?.availableBase).toBe(2_500n);
    // What remains is valued at the covering receipt's cost.
    expect(covered?.weightedAverageCostMinor).toBe(12_000n);
    await expect(
      admin.mutation(api.inventory.negative_stock.resolveFlag, {
        flagId: ownFlag!._id,
        note: "Mine",
      }),
    ).rejects.toThrow("cannot resolve");
    await expect(
      admin.mutation(api.inventory.negative_stock.resolveFlag, {
        flagId: otherFlag!._id,
        note: "  ",
      }),
    ).rejects.toThrow("resolution note");
    await admin.mutation(api.inventory.negative_stock.resolveFlag, {
      flagId: otherFlag!._id,
      note: "Covered by receipt",
    });
    expect(
      (
        await admin.query(api.inventory.negative_stock.flags, {
          status: "resolved",
          paginationOpts: { numItems: 50, cursor: null },
        })
      ).page,
    ).toMatchObject([
      { id: otherFlag!._id, resolutionNote: "Covered by receipt" },
    ]);
    await expect(
      admin.mutation(api.inventory.negative_stock.resolveFlag, {
        flagId: otherFlag!._id,
        note: "Again",
      }),
    ).rejects.toThrow("already resolved");
  });

  it("accepts a costlier partial receipt into negative stock and keeps the ledger equal to the balance value", async () => {
    const { t, admin, product, truck } = await provision();
    await setTracking(t, product._id, "none");
    await t.run(async (ctx) => {
      const policy = await ctx.db
        .query("productInventoryPolicies")
        .withIndex("by_organizationId_and_productId", (q) =>
          q.eq("organizationId", "sunpride").eq("productId", product._id),
        )
        .unique();
      await ctx.db.patch(policy!._id, { qualityReleaseRequired: false });
    });
    await admin.mutation(api.inventory.negative_stock.setAllowance, {
      locationId: truck._id,
      active: true,
      movementTypes: ["inventory_issue"],
      sourceRef: "CALL-10",
    });
    await post(
      t,
      outbound(product._id, truck._id, "short-1000", OPENING + 1_000n),
    );
    const short = await balance(t, product._id, truck._id);
    expect(short?.physicalBase).toBe(-1_000n);
    const shortValue = short!.inventoryValueMinor!;
    const shortCost = short!.weightedAverageCostMinor;
    expect(shortValue < 0n).toBe(true);

    async function ledgerValue() {
      const entries = await t.run(async (ctx) =>
        ctx.db
          .query("inventoryLedgerEntries")
          .withIndex(
            "by_organizationId_and_productId_and_locationId_and_effectiveAt",
            (q) =>
              q
                .eq("organizationId", "sunpride")
                .eq("productId", product._id)
                .eq("locationId", truck._id),
          )
          .collect(),
      );
      return entries.reduce(
        (sum, entry) => sum + (entry.valueDeltaMinor ?? 0n),
        0n,
      );
    }
    expect(await ledgerValue()).toBe(shortValue);

    // A receipt that covers only part of the shortfall at a much higher cost
    // improves physical stock and must not be refused for its valuation.
    const partial = await admin.mutation(api.inventory.receipts.post, {
      idempotencyKey: "costly-partial",
      receiptType: "purchase_order",
      receivingLocationId: truck._id,
      lines: [
        {
          productId: product._id,
          quantityBase: 100n,
          unitCostMinor: (shortCost ?? 10_000n) * 12n,
        },
      ],
    });
    expect(partial.movement.duplicate).toBe(false);
    const partly = await balance(t, product._id, truck._id);
    expect(partly?.physicalBase).toBe(-900n);
    // The remaining shortfall keeps the cost it was issued at; its value only
    // moves towards zero.
    expect(partly?.inventoryValueMinor).toBe((shortValue * 900n) / 1_000n);
    expect(partly?.weightedAverageCostMinor).toBe(shortCost);
    expect(await ledgerValue()).toBe(partly?.inventoryValueMinor);

    // Crossing zero values only the surplus at the receipt cost.
    await admin.mutation(api.inventory.receipts.post, {
      idempotencyKey: "covering",
      receiptType: "purchase_order",
      receivingLocationId: truck._id,
      lines: [
        { productId: product._id, quantityBase: 1_400n, unitCostMinor: 9_000n },
      ],
    });
    const covered = await balance(t, product._id, truck._id);
    expect(covered?.physicalBase).toBe(500n);
    expect(covered?.availableBase).toBe(500n);
    expect(covered?.weightedAverageCostMinor).toBe(9_000n);
    expect(await ledgerValue()).toBe(covered?.inventoryValueMinor);
  });

  it("restricts who may grant an allowance and where", async () => {
    const { t, admin, truck, inTransit } = await provision();
    await expect(
      admin.mutation(api.inventory.negative_stock.setAllowance, {
        locationId: inTransit._id,
        active: true,
        movementTypes: ["pos_sale"],
        sourceRef: "CALL-10",
      }),
    ).rejects.toThrow("warehouse, zone, bin or truck");
    for (const bad of [
      { movementTypes: [] as [], limitBase: undefined, sourceRef: "CALL-10" },
      {
        movementTypes: ["pos_sale" as const],
        limitBase: 0n,
        sourceRef: "CALL-10",
      },
      {
        movementTypes: ["pos_sale" as const],
        limitBase: undefined,
        sourceRef: " ",
      },
    ])
      await expect(
        admin.mutation(api.inventory.negative_stock.setAllowance, {
          locationId: truck._id,
          active: true,
          ...bad,
        }),
      ).rejects.toThrow();
    await admin.mutation(api.domains.profiles.invite, {
      email: "ops@example.test",
      role: "operations",
    });
    const ops = t.withIdentity({ subject: "ops", email: "ops@example.test" });
    await ops.mutation(api.domains.profiles.ensure);
    expect(
      await admin.query(api.inventory.negative_stock.canManageAllowances, {}),
    ).toBe(true);
    expect(
      await ops.query(api.inventory.negative_stock.canManageAllowances, {}),
    ).toBe(false);
    await expect(
      ops.mutation(api.inventory.negative_stock.setAllowance, {
        locationId: truck._id,
        active: true,
        movementTypes: ["pos_sale"],
        sourceRef: "CALL-10",
      }),
    ).rejects.toThrow();
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("negativeStockAllowances").collect(),
      ),
    ).toEqual([]);
  });

  it("never lets newer foreign flags or allowances hide a regional user's own", async () => {
    const { t, admin, product, truck } = await provision();
    const root = await t.mutation(
      internal.migrations.seedOrganizationFoundation,
      {},
    );
    const { area, foreign } = await t.run(async (ctx) => {
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
      const area = await unit("AREA-NEG-OWN");
      const other = await unit("AREA-NEG-FOREIGN");
      await ctx.db.patch(truck._id, { orgUnitId: area });
      const foreign = await ctx.db.insert("inventoryLocations", {
        ...withoutSystemFields(truck),
        code: "TRUCK-FOREIGN",
        name: "Foreign truck",
        orgUnitId: other,
      });
      return { area, foreign };
    });
    await admin.mutation(api.domains.profiles.invite, {
      email: "neg-regional@example.test",
      name: "Regional",
      role: "manager",
    });
    const regional = t.withIdentity({
      subject: "neg-regional@example.test",
      email: "neg-regional@example.test",
      name: "Regional",
    });
    await regional.mutation(api.domains.profiles.ensure);
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_email", (q) =>
          q.eq("email", "neg-regional@example.test"),
        )
        .unique();
      await ctx.db.patch(profile!._id, { orgUnitId: area });
    });
    await setTracking(t, product._id, "none");
    for (const locationId of [truck._id, foreign])
      await admin.mutation(api.inventory.negative_stock.setAllowance, {
        locationId,
        active: true,
        movementTypes: ["inventory_issue"],
        sourceRef: "CALL-10",
      });
    // One authorized open flag, then sixty newer ones at a foreign location.
    await post(t, outbound(product._id, truck._id, "own-short", OPENING + 1n));
    for (let index = 0; index < 60; index += 1)
      await post(t, outbound(product._id, foreign, `foreign-${index}`, 1n));
    expect(await allFlags(t)).toHaveLength(61);

    // Allowances: exact lookups after the scope check.
    const allowed = await regional.query(
      api.inventory.negative_stock.allowances,
      { locationIds: [truck._id, foreign] },
    );
    expect(allowed.map((row) => row.locationCode)).toEqual(["TRUCK-001"]);
    const many = await t.run(async (ctx) => {
      const ids = [];
      for (let index = 0; index < 201; index += 1)
        ids.push(
          await ctx.db.insert("inventoryLocations", {
            ...withoutSystemFields(truck),
            code: `TRUCK-X${index}`,
          }),
        );
      return ids;
    });
    await expect(
      regional.query(api.inventory.negative_stock.allowances, {
        locationIds: many,
      }),
    ).rejects.toThrow("at most 200");

    // Flags: the first page is all foreign, so it is empty but not done; the
    // caller pages on and finds its own flag.
    const first = await regional.query(api.inventory.negative_stock.flags, {
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(first.page).toEqual([]);
    expect(first.isDone).toBe(false);
    const second = await regional.query(api.inventory.negative_stock.flags, {
      paginationOpts: { numItems: 50, cursor: first.continueCursor },
    });
    expect(second.page.map((flag) => flag.locationCode)).toEqual(["TRUCK-001"]);
    expect(second.isDone).toBe(true);
    // The national admin sees everything, newest first.
    const national = await admin.query(api.inventory.negative_stock.flags, {
      paginationOpts: { numItems: 100, cursor: null },
    });
    expect(national.page).toHaveLength(61);
    expect(national.page.at(-1)?.locationCode).toBe("TRUCK-001");
    await expect(
      admin.query(api.inventory.negative_stock.flags, {
        paginationOpts: { numItems: 101, cursor: null },
      }),
    ).rejects.toThrow("Page size");
  });

  it("serves every declared index on the additive tables", async () => {
    const { t, admin, product, truck } = await provision();
    await setTracking(t, product._id, "none");
    await admin.mutation(api.inventory.negative_stock.setAllowance, {
      locationId: truck._id,
      active: true,
      movementTypes: ["inventory_issue"],
      sourceRef: "CALL-10",
    });
    const { movementId } = await post(
      t,
      outbound(product._id, truck._id, "index-smoke", OPENING + 1n),
    );
    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query("negativeStockAllowances")
          .withIndex("by_organizationId_and_locationId", (q) =>
            q.eq("organizationId", "sunpride").eq("locationId", truck._id),
          )
          .unique(),
      ).not.toBeNull();
      expect(
        await ctx.db
          .query("negativeStockFlags")
          .withIndex("by_organizationId_and_status_and_createdAt", (q) =>
            q
              .eq("organizationId", "sunpride")
              .eq("status", "open")
              .gte("createdAt", 0),
          )
          .collect(),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("negativeStockFlags")
          .withIndex("by_organizationId_and_movementId", (q) =>
            q.eq("organizationId", "sunpride").eq("movementId", movementId),
          )
          .unique(),
      ).not.toBeNull();
    });
  });
});
