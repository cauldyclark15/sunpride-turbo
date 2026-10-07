import { convexTest, type TestConvex } from "convex-test";
import { getFunctionName, type FunctionArgs } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { manilaDate } from "../coverage/validation";
import type { AppRole } from "../lib/roles";
import type { AuthorizedDevice } from "../mobile/types";
import schema from "../schema";
import { modules } from "../test.setup";
import { postMovement, hashPayload } from "../inventory/posting";
import { productValues, row } from "../imports/test_helpers";
import { handleVan } from "./http_handlers";
import { cashApprovalCode, cashApprovalKey } from "./cash";
import {
  normalizeCountCode,
  stockApprovalCode,
  stockApprovalKey,
} from "./stock_count";
import {
  CASH_VARIANCE_REASONS,
  STOCK_VARIANCE_REASONS,
  VAN_PAYMENT_METHODS,
  VOID_REASONS,
} from "./model";
import { voidApprovalCode, voidApprovalKey } from "./voids";

// UTC is still October 5 here, but the service day in Manila is October 6.
const NOW = Date.parse("2026-10-05T16:30:00Z");
const TODAY = "2026-10-06";
const OPENING = 100_000n;
const LOADED = 20_000n;
type T = TestConvex<typeof schema>;
type Operation = FunctionArgs<typeof internal.van.device.applyOne>["operation"];
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
afterEach(() => vi.useRealTimers());

async function fixture(lotTracked = false) {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const t: T = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const root = t.withIdentity({ subject: "root", email: "jcing.jc@gmail.com" });
  await root.mutation(api.domains.profiles.ensure, {});
  await root.mutation(internal.seed.demo, {});
  await root.mutation(api.inventory.setup.foundation, {});
  const state = await t.run(async (ctx) => {
    const unit = (code: string) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: "AREA",
        parentId: rootUnitId,
        status: "active",
        effectiveFrom: 0,
        createdAt: NOW,
        updatedAt: NOW,
      });
    const east = await unit("VAN-EAST"),
      west = await unit("VAN-WEST");
    const product = (await ctx.db
      .query("products")
      .withIndex("by_code", (q) => q.eq("code", "SP-PJ-1L"))
      .unique())!;
    const second = (await ctx.db.query("products").collect()).find(
      (p) => p._id !== product._id,
    )!;
    const locations = await ctx.db.query("inventoryLocations").collect();
    const truck = locations.find((l) => l.type === "truck")!;
    const depot = locations.find(
      (l) => l.type !== "truck" && l.type !== "in_transit",
    )!;
    await ctx.db.patch(truck._id, { orgUnitId: east });
    await ctx.db.patch(depot._id, { orgUnitId: east });
    const policy = (await ctx.db
      .query("productInventoryPolicies")
      .withIndex("by_organizationId_and_productId", (q) =>
        q.eq("organizationId", "sunpride").eq("productId", product._id),
      )
      .unique())!;
    if (!lotTracked) await ctx.db.patch(policy._id, { trackingMode: "none" });
    return { east, west, product, second, truck, depot };
  });
  await root.mutation(api.inventory.setup.postOpeningBalances, {
    idempotencyKey: "van-test-opening",
    sourceReference: "VAN-TEST",
    lines: [
      {
        productId: state.product._id,
        locationId: state.depot._id,
        quantityBase: OPENING,
        ...(lotTracked
          ? {
              lotNumber: "VAN-LOT",
              manufacturedAt: NOW - 86_400_000,
              expiresAt: NOW + 365 * 86_400_000,
            }
          : {}),
      },
    ],
  });
  const lot = lotTracked
    ? await t.run((ctx) =>
        ctx.db
          .query("inventoryLots")
          .withIndex(
            "by_organizationId_and_productId_and_normalizedLotNumber",
            (q) =>
              q
                .eq("organizationId", "sunpride")
                .eq("productId", state.product._id)
                .eq("normalizedLotNumber", "VAN-LOT"),
          )
          .unique(),
      )
    : null;
  let personNumber = 0;
  async function person(
    role: Exclude<AppRole, "super_admin"> = "sales",
    unit = state.east,
  ) {
    const email = `van-${++personNumber}@fixture.test`;
    await root.mutation(api.domains.profiles.invite, {
      email,
      name: email,
      role,
    });
    const identity = t.withIdentity({ subject: email, email });
    await identity.mutation(api.domains.profiles.ensure, {});
    const profile = (await identity.query(api.domains.profiles.current, {}))!;
    await t.run(async (ctx) => {
      await ctx.db.patch(profile._id, { orgUnitId: unit });
      for (const old of await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", profile._id),
        )
        .collect())
        await ctx.db.delete(old._id);
      await ctx.db.insert("employeeAssignments", {
        profileId: profile._id,
        orgUnitId: unit,
        role,
        effectiveFrom: NOW - 1_000_000,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: NOW,
      });
    });
    const deviceId = await t.run((ctx) =>
      ctx.db.insert("registeredDevices", {
        organizationId: "sunpride",
        orgUnitId: unit,
        inventoryTag: email,
        profileId: profile._id,
        boundSubject: profile.authSubject!,
        allowedApp: "VAN_ANDROID",
        platform: "Android",
        model: "test",
        osVersion: "1",
        appVersion: "1",
        publicKey: "fixture-key",
        credentialId: email,
        registeredAt: NOW,
        status: "active",
      }),
    );
    const actor: AuthorizedDevice = {
      deviceId,
      profileId: profile._id,
      subject: profile.authSubject!,
      orgUnitId: unit,
      role,
      scopeFingerprint: "fixture",
    };
    return { identity, profileId: profile._id, actor };
  }
  const seller = await person();
  const admin = await person("admin");
  const vehicleArgs = {
    orgUnitId: state.east,
    vehicleCode: "VAN-001",
    plateNumber: " abc 123 ",
    truckLocationId: state.truck._id,
    homeLocationId: state.depot._id,
  };
  const create = () =>
    admin.identity.mutation(api.van.vehicles.create, vehicleArgs);
  async function anotherVehicle(code = "VAN-002", unit = state.east) {
    const truckId = await t.run(async (ctx) => {
      const {
        _id: _id,
        _creationTime: _creationTime,
        ...truck
      } = (await ctx.db.get(state.truck._id))!;
      void _id;
      void _creationTime;
      return ctx.db.insert("inventoryLocations", {
        ...truck,
        code,
        name: code,
        orgUnitId: unit,
      });
    });
    return root.mutation(api.van.vehicles.create, {
      ...vehicleArgs,
      orgUnitId: unit,
      vehicleCode: code,
      truckLocationId: truckId,
    });
  }
  async function plan(
    vehicleId?: Id<"vehicles">,
    salespersonProfileId = seller.profileId,
    serviceDate = TODAY,
    routeId?: Id<"routes">,
  ) {
    return admin.identity.mutation(api.van.trips.plan, {
      vehicleId: vehicleId ?? (await create()),
      salespersonProfileId,
      serviceDate,
      ...(routeId ? { routeId } : {}),
    });
  }
  async function sheet(tripId: Id<"vanTrips">, expectedBase = LOADED) {
    return admin.identity.mutation(api.van.loads.plan, {
      tripId,
      lines: [
        {
          productId: state.product._id,
          expectedBase,
          ...(lot ? { lotId: lot._id } : {}),
        },
      ],
    });
  }
  let requestNumber = 0;
  const apply = (
    kind: Operation["kind"],
    payload: unknown,
    actor = seller.actor,
    clientRequestId = uuid(++requestNumber),
  ) =>
    t.mutation(internal.van.device.applyOne, {
      actor,
      operation: { kind, payload, clientRequestId },
    });
  const confirm = (
    tripId: Id<"vanTrips">,
    loadId: Id<"vanTripLoads">,
    actualBase = String(LOADED),
    reason?: string,
    actor = seller.actor,
  ) =>
    apply(
      "load.confirm",
      {
        tripId,
        loadId,
        lines: [{ lineNumber: 1, actualBase, ...(reason ? { reason } : {}) }],
      },
      actor,
    );
  const start = (tripId: Id<"vanTrips">, extra: Record<string, unknown> = {}) =>
    apply("trip.start", {
      tripId,
      vehicleConfirmed: true,
      routeConfirmed: true,
      ...extra,
    });
  const damage = (
    tripId: Id<"vanTrips">,
    extra: Record<string, unknown> = {},
  ) =>
    apply("truck.damage", {
      tripId,
      productId: state.product._id,
      quantityBase: "3000",
      reason: "expired",
      ...extra,
    });
  const detail = (tripId: Id<"vanTrips">) =>
    admin.identity.query(api.van.trips.detail, { tripId });
  async function loaded(serviceDate = TODAY) {
    const trip = await plan(await create(), seller.profileId, serviceDate);
    const loadId = await sheet(trip.tripId);
    await confirm(trip.tripId, loadId);
    return { ...trip, loadId };
  }
  const balance = (locationId: Id<"inventoryLocations">) =>
    t.run((ctx) =>
      ctx.db
        .query("inventoryBalances")
        .withIndex("by_organizationId_and_productId_and_locationId", (q) =>
          q
            .eq("organizationId", "sunpride")
            .eq("productId", state.product._id)
            .eq("locationId", locationId),
        )
        .unique(),
    );
  const movements = () =>
    t.run(async (ctx) =>
      (await ctx.db.query("inventoryMovements").collect()).filter(
        (m) => m.movementType !== "opening_balance",
      ),
    );
  const entries = (movementId: string) =>
    t.run(async (ctx) =>
      (await ctx.db.query("inventoryLedgerEntries").collect()).filter(
        (e) => e.movementId === movementId,
      ),
    );
  async function territory(code: string, unit = state.east) {
    return t.run(async (ctx) => {
      const id = await ctx.db.insert("territories", {
        organizationId: "sunpride",
        code,
        name: code,
        status: "active",
        effectiveFrom: 0,
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: "fixture",
      });
      await ctx.db.insert("territoryOwnerships", {
        territoryId: id,
        orgUnitId: unit,
        effectiveFrom: 0,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: NOW,
      });
      return id;
    });
  }
  async function route(code: string, territoryId: Id<"territories">) {
    return t.run(async (ctx) => {
      const id = await ctx.db.insert("routes", {
        organizationId: "sunpride",
        code,
        name: code,
        status: "active",
        effectiveFrom: 0,
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: "fixture",
      });
      await ctx.db.insert("routeTerritories", {
        routeId: id,
        territoryId,
        effectiveFrom: 0,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: NOW,
      });
      return id;
    });
  }
  return {
    t,
    root,
    ...state,
    lot,
    person,
    seller,
    admin,
    vehicleArgs,
    create,
    anotherVehicle,
    plan,
    sheet,
    apply,
    confirm,
    start,
    damage,
    detail,
    loaded,
    balance,
    movements,
    entries,
    territory,
    route,
  };
}

describe("van vehicles and scoped office planning", () => {
  it("creates a normalized active vehicle only for an in-scope van.manage holder", async () => {
    const f = await fixture();
    const id = await f.create();
    expect(await f.t.run((ctx) => ctx.db.get(id))).toMatchObject({
      vehicleCode: "VAN-001",
      plateNumber: "ABC 123",
      status: "active",
      orgUnitId: f.east,
    });
    expect(
      (await f.admin.identity.query(api.van.vehicles.list, {})).map(
        (v) => v._id,
      ),
    ).toEqual([id]);
    const outsider = await f.person("admin", f.west);
    expect(await outsider.identity.query(api.van.vehicles.list, {})).toEqual(
      [],
    );
    await expect(
      outsider.identity.mutation(api.van.vehicles.create, {
        ...f.vehicleArgs,
        vehicleCode: "FOREIGN",
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    for (const role of ["sales", "viewer"] as const) {
      const who = await f.person(role);
      await expect(
        who.identity.mutation(api.van.vehicles.create, {
          ...f.vehicleArgs,
          vehicleCode: role,
        }),
      ).rejects.toThrow();
    }
    await expect(
      f.admin.identity.mutation(api.van.vehicles.create, {
        ...f.vehicleArgs,
        orgUnitId: f.west,
        vehicleCode: "WEST",
      }),
    ).rejects.toThrow(/outside your organizational scope/);
  });

  it("requires a sellable truck and non-truck home, unique code and unique active truck", async () => {
    const f = await fixture();
    await expect(
      f.admin.identity.mutation(api.van.vehicles.create, {
        ...f.vehicleArgs,
        truckLocationId: f.depot._id,
      }),
    ).rejects.toThrow(/sellable truck/);
    await expect(
      f.admin.identity.mutation(api.van.vehicles.create, {
        ...f.vehicleArgs,
        homeLocationId: f.truck._id,
      }),
    ).rejects.toThrow(/depot, not a truck/);
    await f.t.run((ctx) => ctx.db.patch(f.truck._id, { allowsSale: false }));
    await expect(f.create()).rejects.toThrow(/sellable truck/);
    await f.t.run((ctx) => ctx.db.patch(f.truck._id, { allowsSale: true }));
    const id = await f.create();
    await expect(f.create()).rejects.toThrow(/code already exists/);
    await expect(
      f.admin.identity.mutation(api.van.vehicles.create, {
        ...f.vehicleArgs,
        vehicleCode: "VAN-002",
      }),
    ).rejects.toThrow(/already belongs/);
    await f.admin.identity.mutation(api.van.vehicles.setStatus, {
      vehicleId: id,
      status: "inactive",
      reason: "retired",
    });
    const next = await f.admin.identity.mutation(api.van.vehicles.create, {
      ...f.vehicleArgs,
      vehicleCode: "VAN-002",
    });
    expect(
      (
        await f.admin.identity.query(api.van.vehicles.list, {
          status: "inactive",
        })
      ).map((v) => v._id),
    ).toEqual([id]);
    expect(next).not.toBe(id);
  });

  it("cannot reactivate a vehicle when its truck was reassigned to another active vehicle", async () => {
    const f = await fixture();
    const retired = await f.create();
    await f.admin.identity.mutation(api.van.vehicles.setStatus, {
      vehicleId: retired,
      status: "inactive",
      reason: "retired",
    });
    const replacement = await f.admin.identity.mutation(
      api.van.vehicles.create,
      { ...f.vehicleArgs, vehicleCode: "REPLACEMENT" },
    );
    await expect(
      f.admin.identity.mutation(api.van.vehicles.setStatus, {
        vehicleId: retired,
        status: "active",
        reason: "reactivate",
      }),
    ).rejects.toThrow(/already belongs/);
    expect(await f.t.run((ctx) => ctx.db.get(retired))).toMatchObject({
      status: "inactive",
    });
    expect(await f.t.run((ctx) => ctx.db.get(replacement))).toMatchObject({
      status: "active",
    });
  });

  it("finds an active truck owner even after more than twenty retired registrations", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      for (let n = 0; n < 21; n++)
        await ctx.db.insert("vehicles", {
          organizationId: "sunpride",
          orgUnitId: f.east,
          vehicleCode: `RETIRED-${n}`,
          plateNumber: "OLD",
          truckLocationId: f.truck._id,
          homeLocationId: f.depot._id,
          status: "inactive",
          createdBy: "fixture",
          createdAt: NOW,
          updatedAt: NOW,
        });
    });
    await f.create();
    await expect(
      f.admin.identity.mutation(api.van.vehicles.create, {
        ...f.vehicleArgs,
        vehicleCode: "DUPLICATE-TRUCK",
      }),
    ).rejects.toThrow(/already belongs/);
  });

  it.each([
    "2026/10/06",
    "2026-1-06",
    "2026-13-06",
    "2026-10-32",
    "2027-02-29",
  ])("rejects malformed or impossible service day %s", async (date) => {
    const f = await fixture();
    await expect(
      f.plan(await f.create(), f.seller.profileId, date),
    ).rejects.toThrow(/date/i);
    expect(await f.t.run((ctx) => ctx.db.query("vanTrips").collect())).toEqual(
      [],
    );
  });

  it("uses the Manila calendar, refuses yesterday, inactive trucks and invalid salesmen", async () => {
    const f = await fixture();
    expect(manilaDate(NOW)).toBe(TODAY);
    const vehicleId = await f.create();
    await expect(
      f.plan(vehicleId, f.seller.profileId, "2026-10-05"),
    ).rejects.toThrow(/past day/);
    await f.admin.identity.mutation(api.van.vehicles.setStatus, {
      vehicleId,
      status: "inactive",
      reason: "maintenance",
    });
    await expect(f.plan(vehicleId)).rejects.toThrow(/not active/);
    await f.admin.identity.mutation(api.van.vehicles.setStatus, {
      vehicleId,
      status: "active",
      reason: "repaired",
    });
    for (const role of ["admin", "viewer", "approver", "operations"] as const) {
      const who = await f.person(role);
      await expect(f.plan(vehicleId, who.profileId)).rejects.toThrow(
        /active van salesman/,
      );
    }
    const foreign = await f.person("sales", f.west);
    await expect(f.plan(vehicleId, foreign.profileId)).rejects.toThrow(
      /outside your organizational scope/,
    );
    await f.t.run((ctx) =>
      ctx.db.patch(f.seller.profileId, { status: "disabled" }),
    );
    await expect(f.plan(vehicleId)).rejects.toThrow(/active van salesman/);
    await f.t.run((ctx) =>
      ctx.db.patch(f.seller.profileId, { status: "active", authSubject: "" }),
    );
    await expect(f.plan(vehicleId)).rejects.toThrow(/active van salesman/);
    const manager = await f.person("manager");
    expect((await f.plan(vehicleId, manager.profileId)).tripNumber).toBe(
      "TRIP-20261006-VAN-001-1",
    );
  });

  it("enforces one open trip per truck/day and salesman/day, increments numbers after cancellation", async () => {
    const f = await fixture();
    const vehicleId = await f.create();
    const first = await f.plan(vehicleId);
    const secondSeller = await f.person();
    await expect(f.plan(vehicleId, secondSeller.profileId)).rejects.toThrow(
      /truck already has a trip/,
    );
    await expect(f.plan(await f.anotherVehicle())).rejects.toThrow(
      /salesman already has a trip/,
    );
    await f.admin.identity.mutation(api.van.trips.cancel, {
      tripId: first.tripId,
      reason: "reschedule",
    });
    expect((await f.plan(vehicleId)).tripNumber).toBe(
      "TRIP-20261006-VAN-001-2",
    );
    expect(
      (await f.plan(vehicleId, f.seller.profileId, "2026-10-07")).tripNumber,
    ).toBe("TRIP-20261007-VAN-001-1");
  });

  it("gates route.read on the route's current territory, including an inactive route", async () => {
    const f = await fixture();
    const vehicleId = await f.create();
    const foreignRoute = await f.route(
      "FOREIGN",
      await f.territory("WEST", f.west),
    );
    await expect(
      f.plan(vehicleId, f.seller.profileId, TODAY, foreignRoute),
    ).rejects.toThrow(/outside your organizational scope/);
    const route = await f.route("EAST", await f.territory("EAST"));
    await f.t.run((ctx) => ctx.db.patch(route, { status: "inactive" }));
    await expect(
      f.plan(vehicleId, f.seller.profileId, TODAY, route),
    ).rejects.toThrow(/Route is inactive/);
    await f.t.run((ctx) => ctx.db.patch(route, { status: "active" }));
    expect(
      (
        await f.detail(
          (await f.plan(vehicleId, f.seller.profileId, TODAY, route)).tripId,
        )
      ).trip.routeId,
    ).toBe(route);
  });

  it("filters detail/day by scope and sales ownership; cancellation cannot discard posted stock", async () => {
    const f = await fixture();
    const own = await f.plan();
    const otherSeller = await f.person();
    const other = await f.plan(await f.anotherVehicle(), otherSeller.profileId);
    const args = { orgUnitId: f.east, serviceDate: TODAY };
    expect(
      (await f.seller.identity.query(api.van.trips.listForDay, args)).map(
        (t) => t._id,
      ),
    ).toEqual([own.tripId]);
    expect(
      (await f.admin.identity.query(api.van.trips.listForDay, args))
        .map((t) => t._id)
        .sort(),
    ).toEqual([own.tripId, other.tripId].sort());
    await expect(
      f.seller.identity.query(api.van.trips.detail, { tripId: other.tripId }),
    ).rejects.toThrow(/another salesman/);
    const outsider = await f.person("admin", f.west);
    await expect(
      outsider.identity.query(api.van.trips.detail, { tripId: own.tripId }),
    ).rejects.toThrow(/outside your organizational scope/);
    await expect(
      outsider.identity.query(api.van.trips.listForDay, args),
    ).rejects.toThrow(/outside your organizational scope/);
    await expect(
      outsider.identity.mutation(api.van.trips.cancel, {
        tripId: own.tripId,
        reason: "no",
      }),
    ).rejects.toThrow();
    const loadId = await f.sheet(own.tripId);
    await f.confirm(own.tripId, loadId);
    await expect(
      f.admin.identity.mutation(api.van.trips.cancel, {
        tripId: own.tripId,
        reason: "no",
      }),
    ).rejects.toThrow(/has not loaded/);
    expect((await f.detail(own.tripId)).trip.status).toBe("loaded");
    await f.admin.identity.mutation(api.van.trips.cancel, {
      tripId: other.tripId,
      reason: "cancelled",
    });
    expect((await f.detail(other.tripId)).trip.status).toBe("cancelled");
  });
});

describe("van load sheets and inventory ledger", () => {
  it.each([0, 101])(
    "rejects %i lines and rolls the transaction back",
    async (count) => {
      const f = await fixture();
      const { tripId } = await f.plan();
      await expect(
        f.admin.identity.mutation(api.van.loads.plan, {
          tripId,
          lines: Array.from({ length: count }, () => ({
            productId: f.product._id,
            expectedBase: 1n,
          })),
        }),
      ).rejects.toThrow(/1-100 lines/);
      expect(
        await f.t.run((ctx) => ctx.db.query("vanTripLoads").collect()),
      ).toEqual([]);
      expect((await f.detail(tripId)).trip.status).toBe("planned");
    },
  );

  it("rejects nonpositive, duplicate product/lot and wrong-product lots; accepts distinct lots", async () => {
    const f = await fixture();
    const { tripId } = await f.plan();
    for (const expectedBase of [0n, -1n])
      await expect(f.sheet(tripId, expectedBase)).rejects.toThrow(/positive/);
    await expect(
      f.admin.identity.mutation(api.van.loads.plan, {
        tripId,
        lines: [1, 2].map(() => ({
          productId: f.product._id,
          expectedBase: 1n,
        })),
      }),
    ).rejects.toThrow(/appears once/);
    const lotId = await f.t.run((ctx) =>
      ctx.db.insert("inventoryLots", {
        organizationId: "sunpride",
        productId: f.second._id,
        lotNumber: "OTHER",
        normalizedLotNumber: "OTHER",
        sourceType: "fixture",
        receivedAt: NOW,
        qualityStatus: "released",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    await expect(
      f.admin.identity.mutation(api.van.loads.plan, {
        tripId,
        lines: [{ productId: f.product._id, expectedBase: 1n, lotId }],
      }),
    ).rejects.toThrow(/does not belong/);
    expect((await f.detail(tripId)).load).toBeNull();
    await f.t.run((ctx) => ctx.db.patch(lotId, { productId: f.product._id }));
    await expect(
      f.admin.identity.mutation(api.van.loads.plan, {
        tripId,
        lines: [1, 2].map(() => ({
          productId: f.product._id,
          expectedBase: 1n,
          lotId,
        })),
      }),
    ).rejects.toThrow(/appears once/);
    const loadId = await f.admin.identity.mutation(api.van.loads.plan, {
      tripId,
      lines: [
        { productId: f.product._id, expectedBase: 1n },
        { productId: f.product._id, expectedBase: 1n, lotId },
      ],
    });
    expect((await f.detail(tripId)).load?._id).toBe(loadId);
  });

  it("accepts the full 100-line boundary, transitions to loading, rejects a second sheet", async () => {
    const f = await fixture();
    const { tripId } = await f.plan();
    const products = await f.t.run(async (ctx) => {
      const { _id: _id, _creationTime: _creationTime, ...product } = f.product;
      void _id;
      void _creationTime;
      const ids: Id<"products">[] = [];
      for (let n = 0; n < 100; n++)
        ids.push(
          await ctx.db.insert("products", {
            ...product,
            code: `BOUNDARY-${n}`,
          }),
        );
      return ids;
    });
    const loadId = await f.admin.identity.mutation(api.van.loads.plan, {
      tripId,
      lines: products.map((productId) => ({ productId, expectedBase: 1n })),
    });
    const d = await f.detail(tripId);
    expect(d.trip.status).toBe("loading");
    expect(d.load).toMatchObject({
      _id: loadId,
      status: "planned",
      loadNumber: 1,
    });
    expect(d.lines).toHaveLength(100);
    expect(d.lines.map((l) => l.lineNumber)).toEqual(
      Array.from({ length: 100 }, (_, n) => n + 1),
    );
    await expect(f.sheet(tripId)).rejects.toThrow(/issued once/);
  });

  it("matched actuals post one van_load with depot/truck ledger entries and command metadata", async () => {
    const f = await fixture();
    const { tripId } = await f.plan();
    const loadId = await f.sheet(tripId);
    const result = await f.confirm(tripId, loadId);
    const movementId = result.ack.movementId!;
    expect(result.status).toBe("accepted");
    expect(await f.movements()).toMatchObject([
      { _id: movementId, movementType: "van_load", sourceDocumentId: loadId },
    ]);
    expect(await f.balance(f.depot._id)).toMatchObject({
      availableStockBase: OPENING - LOADED,
      physicalBase: OPENING - LOADED,
    });
    expect(await f.balance(f.truck._id)).toMatchObject({
      availableStockBase: LOADED,
      physicalBase: LOADED,
    });
    const ledger = await f.entries(movementId);
    expect(ledger).toHaveLength(2);
    expect(ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          locationId: f.depot._id,
          stockStatus: "available",
          quantityDeltaBase: -LOADED,
        }),
        expect.objectContaining({
          locationId: f.truck._id,
          stockStatus: "available",
          quantityDeltaBase: LOADED,
        }),
      ]),
    );
    const d = await f.detail(tripId);
    expect(d.trip.status).toBe("loaded");
    expect(d.load).toMatchObject({
      status: "posted",
      movementId,
      commandKey: `van-load:${loadId}`,
      confirmedBy: f.seller.actor.subject,
      confirmedDeviceId: f.seller.actor.deviceId,
    });
    expect(d.lines[0]?.actualBase).toBe(LOADED);
  });

  it.each(["manager", "approver"] as const)(
    "discrepancy waits without stock changes; different scoped %s posts ACTUAL quantities",
    async (role) => {
      const f = await fixture();
      const managerSeller = await f.person("manager");
      const { tripId } = await f.plan(
        await f.create(),
        managerSeller.profileId,
      );
      const loadId = await f.sheet(tripId);
      await expect(
        f.confirm(tripId, loadId, "18000", undefined, managerSeller.actor),
      ).rejects.toThrow(/invalid_request/);
      expect((await f.detail(tripId)).lines[0]?.actualBase).toBeUndefined();
      const result = await f.confirm(
        tripId,
        loadId,
        "18000",
        "short_loaded",
        managerSeller.actor,
      );
      expect(result.ack.movementId).toBeNull();
      expect((await f.detail(tripId)).load?.status).toBe("discrepancy");
      expect(await f.movements()).toEqual([]);
      expect(await f.balance(f.truck._id)).toBeNull();
      await expect(
        managerSeller.identity.mutation(api.van.loads.approve, { tripId }),
      ).rejects.toThrow(/cannot approve/);
      const outsider = await f.person(role, f.west);
      await expect(
        outsider.identity.mutation(api.van.loads.approve, { tripId }),
      ).rejects.toThrow(/outside your organizational scope/);
      const approver = await f.person(role);
      const movementId = await approver.identity.mutation(
        api.van.loads.approve,
        { tripId, note: "count checked" },
      );
      expect(await f.balance(f.truck._id)).toMatchObject({
        availableStockBase: 18_000n,
      });
      expect(await f.balance(f.depot._id)).toMatchObject({
        availableStockBase: 82_000n,
      });
      expect((await f.detail(tripId)).load).toMatchObject({
        status: "posted",
        movementId,
        approvedBy: approver.actor.subject,
        approvalNote: "count checked",
      });
      expect(await f.movements()).toHaveLength(1);
    },
  );

  it("explicit lot load moves the same lot through allocations and lot balances", async () => {
    const f = await fixture(true);
    expect(f.lot).not.toBeNull();
    const { tripId, loadId } = await f.loaded();
    const d = await f.detail(tripId);
    expect(d.lines[0]).toMatchObject({
      lotId: f.lot!._id,
      lotNumber: "VAN-LOT",
    });
    expect(d.load).toMatchObject({ _id: loadId, status: "posted" });
    const lots = await f.t.run((ctx) =>
      ctx.db.query("inventoryLotBalances").collect(),
    );
    expect(lots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lotId: f.lot!._id,
          locationId: f.depot._id,
          availableBase: 80_000n,
        }),
        expect.objectContaining({
          lotId: f.lot!._id,
          locationId: f.truck._id,
          availableBase: LOADED,
        }),
      ]),
    );
    const allocations = await f.t.run((ctx) =>
      ctx.db.query("inventoryAllocations").collect(),
    );
    expect(
      allocations.filter((a) => a.movementId === d.load?.movementId),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lotId: f.lot!._id, quantityBase: LOADED }),
      ]),
    );
  });

  it("cancels an unposted loading trip and its sheet without changing inventory", async () => {
    const f = await fixture();
    const { tripId } = await f.plan();
    const loadId = await f.sheet(tripId);
    await f.admin.identity.mutation(api.van.trips.cancel, {
      tripId,
      reason: "weather",
    });
    expect((await f.detail(tripId)).trip).toMatchObject({
      status: "cancelled",
      cancelReason: "weather",
    });
    expect(await f.t.run((ctx) => ctx.db.get(loadId))).toMatchObject({
      status: "cancelled",
    });
    expect(await f.movements()).toEqual([]);
  });

  it("rolls back earlier line actuals when a later confirmation is invalid or duplicated", async () => {
    const f = await fixture();
    const { tripId } = await f.plan();
    const loadId = await f.admin.identity.mutation(api.van.loads.plan, {
      tripId,
      lines: [
        { productId: f.product._id, expectedBase: 10n },
        { productId: f.second._id, expectedBase: 10n },
      ],
    });
    for (const second of [
      { lineNumber: 2, actualBase: "9" },
      { lineNumber: 1, actualBase: "10" },
    ]) {
      await expect(
        f.apply("load.confirm", {
          tripId,
          loadId,
          lines: [{ lineNumber: 1, actualBase: "10" }, second],
        }),
      ).rejects.toThrow(/invalid_request/);
      expect((await f.detail(tripId)).lines.map((l) => l.actualBase)).toEqual([
        undefined,
        undefined,
      ]);
    }
    expect(await f.movements()).toEqual([]);
    expect(
      await f.t.run((ctx) => ctx.db.query("vanOperations").collect()),
    ).toEqual([]);
  });

  it("malformed confirmation lines reject atomically without operations or stock writes", async () => {
    const f = await fixture();
    const { tripId } = await f.plan();
    const loadId = await f.sheet(tripId);
    for (const lines of [
      [],
      [{ lineNumber: 2, actualBase: "20000" }],
      [{ lineNumber: 1, actualBase: "-1" }],
      [{ lineNumber: 1, actualBase: 20000 }],
      [{ lineNumber: 1, actualBase: "18000", reason: "made_up" }],
    ]) {
      await expect(
        f.apply("load.confirm", { tripId, loadId, lines }),
      ).rejects.toThrow(/invalid_request/);
    }
    expect(await f.movements()).toEqual([]);
    expect(
      await f.t.run((ctx) => ctx.db.query("vanOperations").collect()),
    ).toEqual([]);
    expect((await f.detail(tripId)).lines[0]?.actualBase).toBeUndefined();
  });
});

describe("van signed operations, POS and reconciliation", () => {
  it("refuses start before posting, on the wrong day, without confirmations or with an open session", async () => {
    const f = await fixture();
    const { tripId } = await f.plan();
    await expect(f.start(tripId)).rejects.toThrow(/load_not_posted/);
    const loadId = await f.sheet(tripId);
    await expect(f.start(tripId)).rejects.toThrow(/load_not_posted/);
    await f.confirm(tripId, loadId);
    vi.setSystemTime(Date.parse("2026-10-06T16:30:00Z"));
    await expect(f.start(tripId)).rejects.toThrow(/wrong_date/);
    vi.setSystemTime(NOW);
    for (const extra of [
      { vehicleConfirmed: false },
      { routeConfirmed: false },
      { vehicleConfirmed: null },
      { odometerKm: -1 },
      { odometerKm: "10" },
      { odometerKm: Infinity },
    ])
      await expect(f.start(tripId, extra)).rejects.toThrow(/invalid_request/);
    const sessionId = await f.t.run((ctx) =>
      ctx.db.insert("truckRouteSessions", {
        organizationId: "sunpride",
        truckLocationId: f.truck._id,
        salespersonSubject: "other",
        assignedDeviceId: "other",
        routeCode: "OTHER",
        status: "open",
        openedAt: NOW,
        lastAcknowledgedSequence: 0,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    await expect(f.start(tripId)).rejects.toThrow(/conflict/);
    expect((await f.detail(tripId)).trip.status).toBe("loaded");
    await f.t.run((ctx) =>
      ctx.db.patch(sessionId, { status: "closed", closedAt: NOW }),
    );
    await f.start(tripId);
    expect((await f.detail(tripId)).trip.status).toBe("active");
  });

  it("starts with crew/odometer/device, sells through existing POS, damages, unloads both statuses and closes", async () => {
    const f = await fixture();
    const { tripId } = await f.loaded();
    await f.start(tripId, {
      driverName: " Driver ",
      helperName: " Helper ",
      odometerKm: 12345,
      note: " depart ",
    });
    const trip = (await f.detail(tripId)).trip;
    expect(trip).toMatchObject({
      status: "active",
      startedDeviceId: f.seller.actor.deviceId,
      driverName: "Driver",
      helperName: "Helper",
      startOdometerKm: 12345,
      startNote: "depart",
      startedAt: NOW,
    });
    const session = await f.t.run((ctx) => ctx.db.get(trip.routeSessionId!));
    expect(session).toMatchObject({
      status: "open",
      truckLocationId: f.truck._id,
      assignedDeviceId: f.seller.actor.deviceId,
      salespersonSubject: f.seller.actor.subject,
      lastAcknowledgedSequence: 0,
    });
    const sale = await f.seller.identity.mutation(api.inventory.pos.postSale, {
      clientRequestId: uuid(999),
      customerCode: "CUS-001",
      routeSessionId: trip.routeSessionId!,
      truckLocationId: f.truck._id,
      deviceId: String(f.seller.actor.deviceId),
      deviceSequence: 1,
      lines: [
        {
          productCode: f.product.code,
          description: f.product.name,
          quantityBase: 2000n,
          quantity: 2,
          unitPrice: f.product.unitPrice,
        },
      ],
    });
    expect(sale).toMatchObject({ duplicate: false, nextDeviceSequence: 2 });
    expect(await f.balance(f.truck._id)).toMatchObject({
      availableStockBase: 18_000n,
      physicalBase: 18_000n,
    });
    expect(await f.entries(sale.movementId)).toEqual([
      expect.objectContaining({
        locationId: f.truck._id,
        quantityDeltaBase: -2000n,
      }),
    ]);
    const damage = await f.damage(tripId);
    expect(
      await f.t.run((ctx) =>
        ctx.db.get(damage.ack.movementId as Id<"inventoryMovements">),
      ),
    ).toMatchObject({ movementType: "status_change" });
    expect(await f.balance(f.truck._id)).toMatchObject({
      availableStockBase: 15_000n,
      damagedBase: 3000n,
      physicalBase: 18_000n,
    });
    expect(await f.entries(damage.ack.movementId!)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          locationId: f.truck._id,
          stockStatus: "available",
          quantityDeltaBase: -3000n,
        }),
        expect.objectContaining({
          locationId: f.truck._id,
          stockStatus: "damaged",
          quantityDeltaBase: 3000n,
        }),
      ]),
    );
    await expect(
      f.admin.identity.mutation(api.van.trips.close, { tripId }),
    ).rejects.toThrow(/still holds stock/);
    const unloadId = await f.admin.identity.mutation(
      api.van.trips.returnLeftover,
      { tripId, idempotencyKey: "evening" },
    );
    expect(await f.t.run((ctx) => ctx.db.get(unloadId!))).toMatchObject({
      movementType: "van_unload",
    });
    expect(await f.entries(unloadId!)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          locationId: f.truck._id,
          stockStatus: "available",
          quantityDeltaBase: -15_000n,
        }),
        expect.objectContaining({
          locationId: f.truck._id,
          stockStatus: "damaged",
          quantityDeltaBase: -3000n,
        }),
        expect.objectContaining({
          locationId: f.depot._id,
          stockStatus: "available",
          quantityDeltaBase: 15_000n,
        }),
        expect.objectContaining({
          locationId: f.depot._id,
          stockStatus: "damaged",
          quantityDeltaBase: 3000n,
        }),
      ]),
    );
    expect(await f.balance(f.truck._id)).toMatchObject({
      physicalBase: 0n,
      availableStockBase: 0n,
      damagedBase: 0n,
    });
    expect(await f.balance(f.depot._id)).toMatchObject({
      physicalBase: 98_000n,
      availableStockBase: 95_000n,
      damagedBase: 3000n,
    });
    expect((await f.detail(tripId)).trip.status).toBe("closing");
    await f.admin.identity.mutation(api.van.trips.close, { tripId });
    expect((await f.detail(tripId)).trip).toMatchObject({
      status: "closed",
      closedAt: NOW,
    });
    expect(
      await f.t.run((ctx) => ctx.db.get(trip.routeSessionId!)),
    ).toMatchObject({ status: "closed", closedAt: NOW });
    expect(
      (await f.t.run((ctx) => ctx.db.get(trip.routeSessionId!)))
        ?.leaseExpiresAt,
    ).toBeUndefined();
    const allLedger = await f.t.run((ctx) =>
      ctx.db.query("inventoryLedgerEntries").collect(),
    );
    for (const locationId of [f.depot._id, f.truck._id]) {
      const stock = await f.balance(locationId);
      const physicalSum = allLedger
        .filter(
          (e) => e.locationId === locationId && e.productId === f.product._id,
        )
        .reduce((sum, e) => sum + e.quantityDeltaBase, 0n);
      expect(physicalSum).toBe(stock?.physicalBase);
    }
  });

  it("damage is active-only, requires an enum reason and positive decimal quantity", async () => {
    const f = await fixture();
    const { tripId } = await f.loaded();
    await expect(f.damage(tripId)).rejects.toThrow(/conflict/);
    await f.start(tripId);
    for (const extra of [
      { reason: "unknown" },
      { quantityBase: "0" },
      { quantityBase: "-1" },
      { quantityBase: "1.5" },
      { quantityBase: 1 },
    ])
      await expect(f.damage(tripId, extra)).rejects.toThrow(/invalid_request/);
    expect(await f.balance(f.truck._id)).toMatchObject({
      availableStockBase: LOADED,
      physicalBase: LOADED,
      damagedBase: 0n,
    });
    expect(await f.movements()).toHaveLength(1);
  });

  it("replays trip starts and damage with stable acknowledgements, no duplicate sessions or movements", async () => {
    const f = await fixture();
    const { tripId } = await f.loaded();
    const start = { tripId, vehicleConfirmed: true, routeConfirmed: true };
    const started = await f.apply(
      "trip.start",
      start,
      f.seller.actor,
      uuid(800),
    );
    expect(
      await f.apply("trip.start", start, f.seller.actor, uuid(800)),
    ).toEqual(started);
    await expect(
      f.apply(
        "trip.start",
        { ...start, odometerKm: 50 },
        f.seller.actor,
        uuid(800),
      ),
    ).rejects.toThrow(/conflict/);
    expect(
      await f.t.run((ctx) => ctx.db.query("truckRouteSessions").collect()),
    ).toHaveLength(1);
    const payload = {
      tripId,
      productId: f.product._id,
      reason: "expired",
      quantityBase: "3000",
    };
    const damaged = await f.apply(
      "truck.damage",
      payload,
      f.seller.actor,
      uuid(801),
    );
    vi.setSystemTime(NOW + 1000);
    expect(
      await f.apply("truck.damage", payload, f.seller.actor, uuid(801)),
    ).toEqual(damaged);
    await expect(
      f.apply(
        "truck.damage",
        { ...payload, quantityBase: "4000" },
        f.seller.actor,
        uuid(801),
      ),
    ).rejects.toThrow(/conflict/);
    expect(await f.movements()).toHaveLength(2);
    expect(await f.balance(f.truck._id)).toMatchObject({
      physicalBase: LOADED,
      availableStockBase: 17_000n,
      damagedBase: 3000n,
    });
  });

  it("gates return and close by capability, stored trip scope and lifecycle", async () => {
    const f = await fixture();
    const { tripId } = await f.loaded();
    await expect(
      f.admin.identity.mutation(api.van.trips.returnLeftover, {
        tripId,
        idempotencyKey: "early",
      }),
    ).rejects.toThrow(/active trip/);
    await expect(
      f.admin.identity.mutation(api.van.trips.close, { tripId }),
    ).rejects.toThrow(/not open/);
    await f.start(tripId);
    const foreign = await f.person("admin", f.west);
    for (const who of [f.seller, foreign]) {
      await expect(
        who.identity.mutation(api.van.trips.returnLeftover, {
          tripId,
          idempotencyKey: "denied",
        }),
      ).rejects.toThrow();
      await expect(
        who.identity.mutation(api.van.trips.close, { tripId }),
      ).rejects.toThrow();
    }
    expect(await f.balance(f.truck._id)).toMatchObject({
      physicalBase: LOADED,
    });
    expect((await f.detail(tripId)).trip.status).toBe("active");
  });

  it("VAN-013 replay returns identical ack once, changed payload conflicts, ownership and operate capability fail closed", async () => {
    const f = await fixture();
    const { tripId } = await f.plan();
    const loadId = await f.sheet(tripId);
    const payload = {
      tripId,
      loadId,
      lines: [{ lineNumber: 1, actualBase: "20000" }],
    };
    const requestId = uuid(400);
    const first = await f.apply(
      "load.confirm",
      payload,
      f.seller.actor,
      requestId,
    );
    vi.setSystemTime(NOW + 1000);
    expect(
      await f.apply("load.confirm", payload, f.seller.actor, requestId),
    ).toEqual(first);
    await expect(
      f.apply(
        "load.confirm",
        {
          ...payload,
          lines: [
            { lineNumber: 1, actualBase: "19000", reason: "short_loaded" },
          ],
        },
        f.seller.actor,
        requestId,
      ),
    ).rejects.toThrow(/conflict/);
    expect(await f.movements()).toHaveLength(1);
    expect(
      await f.t.run((ctx) => ctx.db.query("vanOperations").collect()),
    ).toHaveLength(1);
    const other = await f.person();
    await expect(
      f.apply(
        "trip.start",
        { tripId, vehicleConfirmed: true, routeConfirmed: true },
        other.actor,
      ),
    ).rejects.toThrow(/out_of_scope/);
    // An actor snapshot that no longer matches the persisted role/scope is refused outright.
    await expect(
      f.apply("trip.start", { tripId }, { ...f.seller.actor, role: "viewer" }),
    ).rejects.toThrow(/unauthorized/);
    await expect(
      f.apply(
        "trip.start",
        { tripId },
        { ...f.seller.actor, orgUnitId: f.west },
      ),
    ).rejects.toThrow(/unauthorized/);
    // Cached acknowledgements must not bypass a revoked capability or a changed scope.
    await expect(
      f.apply(
        "load.confirm",
        payload,
        { ...f.seller.actor, role: "viewer" },
        requestId,
      ),
    ).rejects.toThrow(/unauthorized/);
    await expect(
      f.apply(
        "load.confirm",
        payload,
        { ...f.seller.actor, orgUnitId: f.west },
        requestId,
      ),
    ).rejects.toThrow(/unauthorized/);
  });
});

describe("van actor withdrawn after device proof verification", () => {
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const snapshot = (f: Fixture) =>
    f.t.run(async (ctx) => ({
      trips: await ctx.db.query("vanTrips").collect(),
      loads: await ctx.db.query("vanTripLoads").collect(),
      lines: await ctx.db.query("vanTripLoadLines").collect(),
      operations: await ctx.db.query("vanOperations").collect(),
      sessions: await ctx.db.query("truckRouteSessions").collect(),
      movements: await ctx.db.query("inventoryMovements").collect(),
      balances: await ctx.db.query("inventoryBalances").collect(),
      audit: await ctx.db.query("auditLogs").collect(),
    }));
  const withdrawals: [string, (f: Fixture) => Promise<void>][] = [
    [
      "device suspended",
      (f) =>
        f.t.run(async (ctx) => {
          await ctx.db.patch(f.seller.actor.deviceId, { status: "suspended" });
        }),
    ],
    [
      "device revoked",
      (f) =>
        f.t.run(async (ctx) => {
          await ctx.db.patch(f.seller.actor.deviceId, { status: "revoked" });
        }),
    ],
    [
      "profile deactivated",
      (f) =>
        f.t.run(async (ctx) => {
          await ctx.db.patch(f.seller.profileId, { status: "disabled" });
        }),
    ],
    [
      "profile scope withdrawn",
      (f) =>
        f.t.run(async (ctx) => {
          await ctx.db.patch(f.seller.profileId, { orgUnitId: f.west });
        }),
    ],
    [
      "role changed",
      (f) =>
        f.t.run(async (ctx) => {
          await ctx.db.patch(f.seller.profileId, { role: "viewer" });
        }),
    ],
    [
      "effective assignment moved",
      (f) =>
        f.t.run(async (ctx) => {
          const rows = await ctx.db
            .query("employeeAssignments")
            .withIndex("by_profileId_and_effectiveFrom", (q) =>
              q.eq("profileId", f.seller.profileId),
            )
            .collect();
          for (const row of rows)
            await ctx.db.patch(row._id, { effectiveTo: NOW - 1 });
          await ctx.db.insert("employeeAssignments", {
            profileId: f.seller.profileId,
            orgUnitId: f.west,
            role: "sales",
            effectiveFrom: NOW - 1,
            actorSubject: "fixture",
            reason: "fixture",
            createdAt: NOW,
          });
        }),
    ],
  ];

  it.each(withdrawals)(
    "%s: a new operation and a replay are refused with zero writes; bootstrap is refused",
    async (_name, withdraw) => {
      const f = await fixture();
      const { tripId, loadId } = await f.loaded();
      const confirmPayload = {
        tripId,
        loadId,
        lines: [{ lineNumber: 1, actualBase: String(LOADED) }],
      };
      // The load confirmation was accepted earlier under uuid(1).
      await withdraw(f);
      const before = await snapshot(f);
      await expect(
        f.apply(
          "trip.start",
          { tripId, vehicleConfirmed: true, routeConfirmed: true },
          f.seller.actor,
          uuid(900),
        ),
      ).rejects.toThrow(/unauthorized/);
      await expect(
        f.apply("load.confirm", confirmPayload, f.seller.actor, uuid(1)),
      ).rejects.toThrow(/unauthorized/);
      await expect(f.damage(tripId)).rejects.toThrow(/unauthorized/);
      await expect(
        f.t.query(internal.van.device.bootstrap, {
          actor: f.seller.actor,
          now: NOW,
        }),
      ).rejects.toThrow(/unauthorized/);
      expect(await snapshot(f)).toEqual(before);
      expect((await f.detail(tripId)).trip.status).toBe("loaded");
    },
  );

  it("refuses an identity that is not the device's bound subject", async () => {
    const f = await fixture();
    const { tripId } = await f.loaded();
    const before = await snapshot(f);
    await expect(
      f.t
        .withIdentity({ subject: "someone-else" })
        .mutation(internal.van.device.applyOne, {
          actor: f.seller.actor,
          operation: {
            kind: "trip.start",
            clientRequestId: uuid(901),
            payload: { tripId, vehicleConfirmed: true, routeConfirmed: true },
          },
        }),
    ).rejects.toThrow(/unauthorized/);
    expect(await snapshot(f)).toEqual(before);
  });

  it("the production HTTP push refuses a suspension committed after proof verification", async () => {
    const f = await fixture();
    const { tripId } = await f.loaded();
    const text = JSON.stringify({
      type: "van.push.request",
      contractVersion: 1,
      deviceId: f.seller.actor.deviceId,
      operations: [
        {
          kind: "trip.start",
          clientRequestId: uuid(902),
          payload: { tripId, vehicleConfirmed: true, routeConfirmed: true },
        },
      ],
    });
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const request = new Request("https://example.convex.site/van/v1/push", {
      method: "POST",
      body: text,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer jwt",
        "x-mobile-contract-version": "1",
        "x-mobile-device-id": f.seller.actor.deviceId,
        "x-mobile-app": "VAN_ANDROID",
        "x-mobile-nonce": uuid(903),
        "x-mobile-timestamp": String(NOW),
        "x-mobile-signature": "signed",
        "x-mobile-body-digest": digest,
      },
    });
    const caller = f.t.withIdentity({
      tokenIdentifier: f.seller.actor.subject,
    });
    type Call = (fn: unknown, args: unknown) => Promise<unknown>;
    const mutate = caller.mutation as unknown as Call,
      read = caller.query as unknown as Call;
    const before = await snapshot(f);
    // Only the proof boundary is replaced: it verifies, then the device is suspended in a
    // separately committed transaction before the operation runs.
    const ctx = {
      auth: {
        getUserIdentity: async () => ({
          tokenIdentifier: f.seller.actor.subject,
        }),
      },
      runMutation: async (fn: never, args: unknown) => {
        const name = getFunctionName(fn);
        if (name.startsWith("mobile/rate_limits:")) return 0;
        if (name === "mobile/device_auth:authorize") {
          await f.t.run(async (c) => {
            await c.db.patch(f.seller.actor.deviceId, { status: "suspended" });
          });
          return f.seller.actor;
        }
        return mutate(fn, args);
      },
      runQuery: async (fn: unknown, args: unknown) => read(fn, args),
    } as unknown as ActionCtx;
    const response = await handleVan(ctx, request, "push");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
    const after = await snapshot(f);
    expect(after.trips).toEqual(before.trips);
    expect(after.operations).toEqual(before.operations);
    expect(after.movements).toEqual(before.movements);
    expect(after.sessions).toEqual(before.sessions);
    expect((await f.detail(tripId)).trip.status).toBe("loaded");
  });
});

describe("van bootstrap projection", () => {
  it("returns today's own open trip only; prioritizes active; empty state contains nulls and empty arrays", async () => {
    const f = await fixture();
    const empty = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(empty).toMatchObject({
      type: "van.bootstrap.response",
      contractVersion: 1,
      serviceDate: TODAY,
      trip: null,
      load: null,
      products: [],
      customers: [],
      truckStock: [],
    });
    const own = await f.plan();
    expect(
      (
        await f.t.query(internal.van.device.bootstrap, {
          actor: f.seller.actor,
          now: NOW,
        })
      ).trip!.tripId,
    ).toBe(own.tripId);
    const other = await f.person();
    expect(
      (
        await f.t.query(internal.van.device.bootstrap, {
          actor: other.actor,
          now: NOW,
        })
      ).trip,
    ).toBeNull();
    // Legacy/migration data can contain multiple candidates. Projection chooses active.
    const activeId = await f.t.run(async (ctx) => {
      const {
        _id: _id,
        _creationTime: _creationTime,
        ...trip
      } = (await ctx.db.get(own.tripId))!;
      void _id;
      void _creationTime;
      return ctx.db.insert("vanTrips", {
        ...trip,
        tripNumber: "LEGACY-ACTIVE",
        status: "active",
      });
    });
    expect(
      (
        await f.t.query(internal.van.device.bootstrap, {
          actor: f.seller.actor,
          now: NOW,
        })
      ).trip!.tripId,
    ).toBe(activeId);
    expect(
      (
        await f.t.query(internal.van.device.bootstrap, {
          actor: f.seller.actor,
          now: NOW + 86_400_000,
        })
      ).trip,
    ).toBeNull();
    await f.t.run(async (ctx) => {
      await ctx.db.patch(activeId, { status: "closed" });
      await ctx.db.patch(own.tripId, { status: "cancelled" });
    });
    expect(
      (
        await f.t.query(internal.van.device.bootstrap, {
          actor: f.seller.actor,
          now: NOW,
        })
      ).trip,
    ).toBeNull();
  });

  it("includes load-line products before posting, active barcodes and stock as decimal strings", async () => {
    const f = await fixture();
    const { tripId } = await f.plan();
    const loadId = await f.sheet(tripId);
    const before = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(before.products).toEqual([
      expect.objectContaining({
        productId: f.product._id,
        code: f.product.code,
        quantityScale: "1000",
      }),
    ]);
    expect(before.load!.lines[0]).toMatchObject({
      expectedBase: "20000",
      actualBase: null,
    });
    expect(before.truckStock).toEqual([]);
    await f.t.run(async (ctx) => {
      const policy = (await ctx.db
        .query("productInventoryPolicies")
        .withIndex("by_organizationId_and_productId", (q) =>
          q.eq("organizationId", "sunpride").eq("productId", f.product._id),
        )
        .unique())!;
      for (const [barcode, active] of [
        ["480000000001", true],
        ["480000000002", false],
      ] as const)
        await ctx.db.insert("productBarcodes", {
          organizationId: "sunpride",
          productId: f.product._id,
          barcode,
          active,
          uomId: policy.baseUomId,
          source: "fixture",
          createdAt: NOW,
          updatedAt: NOW,
        });
    });
    await f.confirm(tripId, loadId);
    const after = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(after.products[0].barcodes).toContain("480000000001");
    expect(after.truckStock).toEqual([
      { productId: f.product._id, availableBase: "20000", damagedBase: "0" },
    ]);
    expect(after.load!.lines[0]).toMatchObject({
      expectedBase: "20000",
      actualBase: "20000",
    });
    expect(() => JSON.stringify(after)).not.toThrow();
  });

  it("tells the handheld which unit each barcode scans into and how many base units one scan is (VAN-009)", async () => {
    const f = await fixture();
    const { tripId } = await f.plan();
    await f.sheet(tripId);
    await f.t.run(async (ctx) => {
      const policy = (await ctx.db
        .query("productInventoryPolicies")
        .withIndex("by_organizationId_and_productId", (q) =>
          q.eq("organizationId", "sunpride").eq("productId", f.product._id),
        )
        .unique())!;
      // The van sells in the product's base unit, so conversions apply.
      await ctx.db.patch(f.product._id, { baseUomId: policy.baseUomId });
      const unit = (code: string, active = true) =>
        ctx.db.insert("unitsOfMeasure", {
          organizationId: "sunpride",
          code,
          name: code,
          dimension: "count",
          decimalPlaces: 0,
          active,
          createdAt: NOW,
          updatedAt: NOW,
        });
      const box = await unit("BOX12");
      const tray = await unit("TRAY");
      const retired = await unit("OLD", false);
      await ctx.db.insert("uomConversions", {
        organizationId: "sunpride",
        productId: f.product._id,
        fromUomId: box,
        toUomId: policy.baseUomId,
        numerator: 12n,
        denominator: 1n,
        roundingMode: "exact",
        effectiveFrom: 0,
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      // History first: an inactive row must not crowd out later active ones.
      for (let i = 0; i < 25; i++)
        await ctx.db.insert("productBarcodes", {
          organizationId: "sunpride",
          productId: f.product._id,
          barcode: `RETIRED-${i}`,
          active: false,
          uomId: policy.baseUomId,
          source: "fixture",
          createdAt: NOW,
          updatedAt: NOW,
        });
      for (const [barcode, uomId] of [
        ["4800000000017", policy.baseUomId],
        ["14800000000016", box],
        ["4800000000031", tray],
        ["4800000000048", retired],
      ] as const)
        await ctx.db.insert("productBarcodes", {
          organizationId: "sunpride",
          productId: f.product._id,
          barcode,
          active: true,
          uomId,
          source: "fixture",
          createdAt: NOW,
          updatedAt: NOW,
        });
    });
    const boot = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    const product = boot.products[0];
    expect(product.barcodes).toEqual([
      "4800000000017",
      "14800000000016",
      "4800000000031",
    ]);
    expect(product.barcodeUnits).toEqual([
      {
        barcode: "4800000000017",
        uomCode: product.uomCode,
        baseQuantity: "1000",
      },
      { barcode: "14800000000016", uomCode: "BOX12", baseQuantity: "12000" },
      // No conversion: the unit is named but no quantity is guessed.
      { barcode: "4800000000031", uomCode: "TRAY", baseQuantity: null },
    ]);
  });

  it("fails the bootstrap loudly instead of truncating an oversized barcode history", async () => {
    const f = await fixture();
    const { tripId } = await f.plan();
    await f.sheet(tripId);
    await f.t.run(async (ctx) => {
      const policy = (await ctx.db
        .query("productInventoryPolicies")
        .withIndex("by_organizationId_and_productId", (q) =>
          q.eq("organizationId", "sunpride").eq("productId", f.product._id),
        )
        .unique())!;
      for (let i = 0; i < 51; i++)
        await ctx.db.insert("productBarcodes", {
          organizationId: "sunpride",
          productId: f.product._id,
          barcode: `B-${i}`,
          active: i === 50,
          uomId: policy.baseUomId,
          source: "fixture",
          createdAt: NOW,
          updatedAt: NOW,
        });
    });
    await expect(
      f.t.query(internal.van.device.bootstrap, {
        actor: f.seller.actor,
        now: NOW,
      }),
    ).rejects.toThrow(/reference_data_too_large/);
  });

  it("orders current route customers by sequence, adds covered unplanned customers, excludes expired/inactive/foreign outlets", async () => {
    const f = await fixture();
    const territory = await f.territory("COVERED"),
      foreign = await f.territory("FOREIGN", f.west);
    const route = await f.route("ROUTE", territory),
      otherRoute = await f.route("OTHER", territory);
    const { tripId } = await f.plan(
      await f.create(),
      f.seller.profileId,
      TODAY,
      route,
    );
    await f.t.run(async (ctx) => {
      const history = {
        effectiveFrom: NOW - 10_000,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: NOW,
      };
      await ctx.db.insert("territorySalespeople", {
        territoryId: territory,
        profileId: f.seller.profileId,
        kind: "primary",
        ...history,
      });
      // A coverage row alone must never grant cross-organizational outlet visibility.
      await ctx.db.insert("territorySalespeople", {
        territoryId: foreign,
        profileId: f.seller.profileId,
        kind: "secondary",
        ...history,
      });
      const outlet = async (
        code: string,
        territoryId = territory,
        routeId: Id<"routes"> | null = route,
        sequence = 1,
        status: Doc<"outlets">["status"] = "active",
      ) => {
        const id = await ctx.db.insert("outlets", {
          organizationId: "sunpride",
          code,
          name: code,
          address: `Address ${code}`,
          status,
          custodianOrgUnitId: f.east,
          createdBy: "fixture",
          createdAt: NOW,
          updatedAt: NOW,
        });
        const assignmentId = await ctx.db.insert("outletAssignments", {
          outletId: id,
          territoryId,
          ...(routeId ? { routeId } : {}),
          sequence,
          ...history,
        });
        return { id, assignmentId };
      };
      await outlet("SECOND", territory, route, 2);
      await outlet("FIRST", territory, route, 1);
      await outlet("UNPLANNED", territory, null);
      await outlet("FOREIGN", foreign);
      await outlet("INACTIVE", territory, route, 0, "inactive");
      const moved = await outlet("MOVED", territory, route, 0);
      await ctx.db.patch(moved.assignmentId, { effectiveTo: NOW - 1 });
      await ctx.db.insert("outletAssignments", {
        outletId: moved.id,
        territoryId: territory,
        routeId: otherRoute,
        ...history,
        effectiveFrom: NOW - 1,
      });
      const retired = await outlet("EXPIRED");
      await ctx.db.patch(retired.assignmentId, { effectiveTo: NOW - 1 });
    });
    const view = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(view.trip!.tripId).toBe(tripId);
    expect(
      view.customers.map(
        (c: { code: string; source: string; sequence: number | null }) => [
          c.code,
          c.source,
          c.sequence,
        ],
      ),
    ).toEqual([
      ["FIRST", "route", 1],
      ["SECOND", "route", 2],
      ["MOVED", "unplanned", null],
      ["UNPLANNED", "unplanned", null],
    ]);
  });

  it("sends the office payment methods and each customer's current credit terms (VAN-012)", async () => {
    const f = await fixture();
    const territory = await f.territory("CREDIT");
    const route = await f.route("CREDIT-ROUTE", territory);
    await f.plan(await f.create(), f.seller.profileId, TODAY, route);
    const outlets = await f.t.run(async (ctx) => {
      const make = async (code: string, sequence: number) => {
        const id = await ctx.db.insert("outlets", {
          organizationId: "sunpride",
          code,
          name: code,
          status: "active",
          custodianOrgUnitId: f.east,
          createdBy: "fixture",
          createdAt: NOW,
          updatedAt: NOW,
        });
        await ctx.db.insert("outletAssignments", {
          outletId: id,
          territoryId: territory,
          routeId: route,
          sequence,
          effectiveFrom: NOW - 10_000,
          actorSubject: "fixture",
          reason: "fixture",
          createdAt: NOW,
        });
        return id;
      };
      return {
        terms: await make("TERMS", 1),
        ended: await make("ENDED", 2),
        cash: await make("CASH", 3),
      };
    });
    const set = (
      outletId: Id<"outlets">,
      terms: { termsDays: number; creditLimitMinor: bigint } | null,
      effectiveFrom: number,
    ) =>
      f.t.mutation(internal.van.credit.setOutletCreditTerms, {
        outletId,
        terms,
        effectiveFrom,
        sourceRef: "fixture credit memo",
        actorSubject: "fixture",
      });
    await set(
      outlets.terms,
      { termsDays: 30, creditLimitMinor: 500_000n },
      NOW - 5_000,
    );
    // A future change is not visible yet; the current terms stay.
    await set(
      outlets.terms,
      { termsDays: 7, creditLimitMinor: 1_000n },
      NOW + 5_000,
    );
    await set(
      outlets.ended,
      { termsDays: 15, creditLimitMinor: 200_000n },
      NOW - 5_000,
    );
    await set(outlets.ended, null, NOW - 1_000);
    await expect(
      set(outlets.cash, { termsDays: 0, creditLimitMinor: 1n }, NOW),
    ).rejects.toThrow(/invalid_terms_days/);
    await expect(
      set(outlets.cash, { termsDays: 181, creditLimitMinor: 1n }, NOW),
    ).rejects.toThrow(/invalid_terms_days/);
    await expect(
      set(outlets.cash, { termsDays: 30, creditLimitMinor: 0n }, NOW),
    ).rejects.toThrow(/invalid_credit_limit/);
    await expect(
      set(outlets.terms, { termsDays: 30, creditLimitMinor: 1n }, NOW - 5_000),
    ).rejects.toThrow(/terms_already_scheduled/);

    const view = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(view.policy.paymentMethods).toEqual(
      VAN_PAYMENT_METHODS.map((method) => ({ ...method })),
    );
    expect(
      view.customers.map((c: { code: string; credit: unknown }) => [
        c.code,
        c.credit,
      ]),
    ).toEqual([
      ["TERMS", { termsDays: 30, availableMinor: "500000" }],
      ["ENDED", null],
      ["CASH", null],
    ]);
    const later = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW + 6_000,
    });
    expect(
      later.customers.find((c: { code: string }) => c.code === "TERMS")!.credit,
    ).toEqual({ termsDays: 7, availableMinor: "1000" });
    // SP-0105: each customer names the list that prices it (its outlet channel's list, else
    // the van Route Sales list).
    const priceList = (code: string, channelKey: string) =>
      f.t.run((ctx) =>
        ctx.db.insert("priceLists", {
          organizationId: "sunpride",
          code,
          name: code,
          channelKey,
          currency: "PHP",
          status: "active",
          source: "office",
          effectiveFrom: 0,
          updatedAt: NOW,
        }),
      );
    const routeList = await priceList("RS", "route sales");
    const keyList = await priceList("KA", "key accounts");
    await f.t.run((ctx) =>
      ctx.db.patch(outlets.terms, { channel: "Key Accounts" }),
    );
    const priced = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(
      priced.customers.map((c: { code: string; priceListId: unknown }) => [
        c.code,
        c.priceListId,
      ]),
    ).toEqual([
      ["TERMS", keyList],
      ["ENDED", routeList],
      ["CASH", routeList],
    ]);
    // The empty (no trip) bootstrap still tells the phone which methods exist.
    const other = await f.person();
    expect(
      (
        await f.t.query(internal.van.device.bootstrap, {
          actor: other.actor,
          now: NOW,
        })
      ).policy.paymentMethods.map((m: { code: string }) => m.code),
    ).toEqual(["cash", "check", "gcash", "bank_transfer", "credit"]);
  });
});

describe("van damage evidence and approval (VAN-020)", () => {
  const sha = (n: number) => n.toString(16).padStart(64, "0");
  async function photo(
    f: Awaited<ReturnType<typeof fixture>>,
    n: number,
    actor = f.seller.actor,
  ) {
    const storageId = await f.t.run((ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([0xff, 0xd8, n])])),
    );
    expect(
      await f.t.mutation(internal.van.damage.registerPhoto, {
        actor,
        sha256: sha(n),
        storageId,
        size: 3,
      }),
    ).toBe(true);
    return sha(n);
  }
  async function active(f: Awaited<ReturnType<typeof fixture>>) {
    const trip = await f.loaded();
    await f.start(trip.tripId);
    return trip;
  }
  const records = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.t.run((ctx) => ctx.db.query("vanDamageRecords").collect());

  it("requires an uploaded photo of the same seller for visible-damage reasons", async () => {
    const f = await fixture();
    const { tripId } = await active(f);
    await expect(f.damage(tripId, { reason: "crushed" })).rejects.toThrow(
      /photo_required/,
    );
    await expect(
      f.damage(tripId, { reason: "crushed", photoSha256: sha(1) }),
    ).rejects.toThrow(/photo_required/);
    await expect(
      f.damage(tripId, { reason: "expired", photoSha256: "XYZ" }),
    ).rejects.toThrow(/invalid_request/);
    const other = await f.person();
    await photo(f, 2, other.actor);
    await expect(
      f.damage(tripId, { reason: "crushed", photoSha256: sha(2) }),
    ).rejects.toThrow(/photo_required/);
    expect(await f.movements()).toHaveLength(1);

    const own = await photo(f, 3);
    // A repeated upload of the same digest is a no-op for the same seller.
    await f.t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob([new Uint8Array(1)]));
      expect(
        await ctx.runMutation(internal.van.damage.registerPhoto, {
          actor: f.seller.actor,
          sha256: own,
          storageId,
          size: 1,
        }),
      ).toBe(false);
    });
    const ack = await f.damage(tripId, { reason: "crushed", photoSha256: own });
    const [record] = await records(f);
    expect(ack.ack.entityId).toBe(record!._id);
    expect(record).toMatchObject({
      tripId,
      reason: "crushed",
      quantityBase: 3000n,
      quantityScale: 1000n,
      status: "recorded",
      needsApproval: false,
      movementId: ack.ack.movementId,
      recordedBy: f.seller.actor.subject,
    });
    const stored = await f.t.run((ctx) => ctx.db.get(record!.photoId!));
    expect(stored).toMatchObject({ sha256: own, damageRecordId: record!._id });
    // One photo proves one record.
    await expect(
      f.damage(tripId, { reason: "leaking", photoSha256: own }),
    ).rejects.toThrow(/invalid_request/);
    expect(await f.balance(f.truck._id)).toMatchObject({
      availableStockBase: LOADED - 3000n,
      damagedBase: 3000n,
    });
  });

  it("holds records at the approval threshold for a supervisor, with a photo, and shows them on the device", async () => {
    const f = await fixture();
    const { tripId } = await active(f);
    await f.damage(tripId, { quantityBase: "11999" });
    // 12 whole units (scale 1000) or more needs a supervisor, and so a photo.
    await expect(f.damage(tripId, { quantityBase: "12000" })).rejects.toThrow(
      /photo_required/,
    );
    await expect(
      f.damage(tripId, { quantityBase: "1", reason: "other" }),
    ).rejects.toThrow(/photo_required/);
    expect((await records(f)).map((r) => [r.quantityBase, r.status])).toEqual([
      [11_999n, "recorded"],
    ]);
    expect(await f.balance(f.truck._id)).toMatchObject({
      availableStockBase: LOADED - 11_999n,
      damagedBase: 11_999n,
    });
  });

  async function pendingRecord(lotTracked = false) {
    const f = await fixture(lotTracked);
    const trip = await active(f);
    const shot = await photo(f, 7);
    const ack = await f.damage(trip.tripId, {
      quantityBase: "12000",
      reason: "spoiled",
      note: "Sour smell",
      photoSha256: shot,
    });
    const damageId = ack.ack.entityId as Id<"vanDamageRecords">;
    const approver = await f.person("approver");
    return { f, trip, damageId, approver, movementId: ack.ack.movementId };
  }

  it("bootstraps the damage policy and the trip's records", async () => {
    const { f, damageId } = await pendingRecord();
    const boot = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(boot.policy.damagePolicy).toEqual({
      photoRequiredReasons: ["crushed", "leaking", "spoiled", "other"],
      approvalFromUnits: 12,
      photoMaxBytes: 90_000,
    });
    expect(boot.damageRecords).toEqual([
      {
        damageId,
        clientRequestId: expect.any(String),
        productId: f.product._id,
        uomCode: "CASE",
        quantityScale: "1000",
        quantityBase: "12000",
        reason: "spoiled",
        status: "pending_approval",
        recordedAt: NOW,
        decisionNote: null,
      },
    ]);
  });

  it("lets only an in-scope supervisor who is not the recorder decide", async () => {
    const { f, damageId, approver } = await pendingRecord();
    const decide = (
      who: { identity: typeof f.root },
      decision: "approve" | "reject",
      note?: string,
    ) =>
      who.identity.mutation(api.van.damage.decide, {
        damageId,
        decision,
        ...(note ? { note } : {}),
      });
    await expect(decide(f.seller, "approve")).rejects.toThrow(
      /Insufficient permission/,
    );
    await expect(decide(f.admin, "approve")).rejects.toThrow(
      /Insufficient permission/,
    );
    const west = await f.person("manager", f.west);
    await expect(decide(west, "approve")).rejects.toThrow(/outside your/);
    await f.t.run(async (ctx) => {
      const profile = (await ctx.db.get(approver.profileId))!;
      await ctx.db.patch(damageId, { recordedBy: profile.authSubject! });
    });
    await expect(decide(approver, "approve")).rejects.toThrow(
      /recorded the damage cannot decide/,
    );
    await f.t.run((ctx) =>
      ctx.db.patch(damageId, { recordedBy: f.seller.actor.subject }),
    );
    const before = await f.balance(f.truck._id);
    await decide(approver, "approve", "Seen the photo");
    expect(await f.t.run((ctx) => ctx.db.get(damageId))).toMatchObject({
      status: "approved",
      decisionNote: "Seen the photo",
      decidedAt: NOW,
    });
    expect(await f.balance(f.truck._id)).toEqual(before);
    await expect(decide(approver, "reject", "late")).rejects.toThrow(
      /not waiting for approval/,
    );
  });

  it("rejects with a reason through a separate reversal movement, never editing the original", async () => {
    const { f, damageId, approver, movementId } = await pendingRecord();
    await expect(
      approver.identity.mutation(api.van.damage.decide, {
        damageId,
        decision: "reject",
      }),
    ).rejects.toThrow(/Say why/);
    const original = await f.t.run((ctx) =>
      ctx.db.get(movementId as Id<"inventoryMovements">),
    );
    await approver.identity.mutation(api.van.damage.decide, {
      damageId,
      decision: "reject",
      note: "Only the label is torn",
    });
    const record = (await f.t.run((ctx) => ctx.db.get(damageId)))!;
    expect(record.status).toBe("rejected");
    expect(record.reversalMovementId).toBeDefined();
    expect(
      await f.t.run((ctx) =>
        ctx.db.get(movementId as Id<"inventoryMovements">),
      ),
    ).toEqual(original);
    expect(await f.entries(record.reversalMovementId!)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          locationId: f.truck._id,
          stockStatus: "damaged",
          quantityDeltaBase: -12_000n,
        }),
        expect.objectContaining({
          locationId: f.truck._id,
          stockStatus: "available",
          quantityDeltaBase: 12_000n,
        }),
      ]),
    );
    expect(await f.balance(f.truck._id)).toMatchObject({
      availableStockBase: LOADED,
      damagedBase: 0n,
      physicalBase: LOADED,
    });
    const boot = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(boot.damageRecords[0]).toMatchObject({
      status: "rejected",
      decisionNote: "Only the label is torn",
    });
  });

  it("reverses at the depot once the truck's damaged stock went back", async () => {
    const { f, trip, damageId, approver } = await pendingRecord();
    await f.admin.identity.mutation(api.van.trips.returnLeftover, {
      tripId: trip.tripId,
      idempotencyKey: "evening",
    });
    const depotBefore = (await f.balance(f.depot._id))!;
    await approver.identity.mutation(api.van.damage.decide, {
      damageId,
      decision: "reject",
      note: "Fine on recount",
    });
    expect(await f.balance(f.depot._id)).toMatchObject({
      availableStockBase: depotBefore.availableStockBase! + 12_000n,
      damagedBase: depotBefore.damagedBase! - 12_000n,
    });
  });

  it("lists records for review within scope, with photo links and decide rights", async () => {
    const { f, damageId, approver } = await pendingRecord();
    const list = (
      who: { identity: typeof f.root },
      status?: "pending_approval",
    ) =>
      who.identity.query(api.van.damage.listForReview, {
        ...(status ? { status } : {}),
        paginationOpts: { numItems: 20, cursor: null },
      });
    const mine = await list(approver, "pending_approval");
    expect(mine.page).toHaveLength(1);
    expect(mine.page[0]).toMatchObject({
      damageId,
      productCode: "SP-PJ-1L",
      quantityBase: 12_000n,
      reason: "spoiled",
      note: "Sour smell",
      status: "pending_approval",
      canDecide: true,
    });
    expect(mine.page[0]!.photoUrl).toEqual(expect.any(String));
    expect((await list(f.seller)).page[0]).toMatchObject({
      damageId,
      canDecide: false,
    });
    const otherSeller = await f.person();
    expect((await list(otherSeller)).page).toEqual([]);
    const west = await f.person("manager", f.west);
    expect((await list(west)).page).toEqual([]);
    expect((await list({ identity: f.root })).page).toHaveLength(1);
  });
  const lotNamed = (
    f: Awaited<ReturnType<typeof fixture>>,
    lotNumber: string,
  ) =>
    f.t.run((ctx) =>
      ctx.db
        .query("inventoryLots")
        .withIndex(
          "by_organizationId_and_productId_and_normalizedLotNumber",
          (q) =>
            q
              .eq("organizationId", "sunpride")
              .eq("productId", f.product._id)
              .eq("normalizedLotNumber", lotNumber),
        )
        .unique(),
    );
  const allocationsOf = (
    f: Awaited<ReturnType<typeof fixture>>,
    movementId: Id<"inventoryMovements">,
  ) =>
    f.t.run(async (ctx) =>
      (await ctx.db.query("inventoryAllocations").collect()).filter(
        (a) => a.movementId === movementId,
      ),
    );

  it("never restores another trip's damage when rejecting a returned record", async () => {
    // Release-check counterexample: yesterday's record went back to the depot; today the
    // same truck carries a different trip's damaged stock.
    const { f, trip, damageId, approver } = await pendingRecord();
    await f.admin.identity.mutation(api.van.trips.returnLeftover, {
      tripId: trip.tripId,
      idempotencyKey: "day-1-unload",
    });
    await f.admin.identity.mutation(api.van.trips.close, {
      tripId: trip.tripId,
    });
    const day1 = (await f.t.run((ctx) => ctx.db.get(trip.tripId)))!;
    vi.setSystemTime(NOW + 86_400_000);
    const next = await f.plan(day1.vehicleId, f.seller.profileId, "2026-10-07");
    await f.confirm(next.tripId, await f.sheet(next.tripId));
    await f.start(next.tripId);
    const today = await f.damage(next.tripId, {
      quantityBase: "12000",
      reason: "spoiled",
      photoSha256: await photo(f, 8),
    });
    const truckBefore = await f.balance(f.truck._id);
    const depotBefore = (await f.balance(f.depot._id))!;
    expect(truckBefore).toMatchObject({
      availableStockBase: LOADED - 12_000n,
      damagedBase: 12_000n,
    });
    await approver.identity.mutation(api.van.damage.decide, {
      damageId,
      decision: "reject",
      note: "Old batch found intact",
    });
    expect(await f.balance(f.truck._id)).toEqual(truckBefore);
    expect(await f.balance(f.depot._id)).toMatchObject({
      availableStockBase: depotBefore.availableStockBase! + 12_000n,
      damagedBase: depotBefore.damagedBase! - 12_000n,
    });
    const record = (await f.t.run((ctx) => ctx.db.get(damageId)))!;
    expect(
      (await f.entries(record.reversalMovementId!)).every(
        (e) => e.locationId === f.depot._id,
      ),
    ).toBe(true);
    expect(
      (await f.t.run((ctx) =>
        ctx.db.get(today.ack.entityId as Id<"vanDamageRecords">),
      ))!.status,
    ).toBe("pending_approval");
  });

  it("reverses exactly the record's own lots, on the truck and at the depot", async () => {
    // Release-check counterexample: an unrelated, earlier-expiring damaged lot at the depot.
    const { f, trip, damageId, approver, movementId } =
      await pendingRecord(true);
    await f.root.mutation(api.inventory.setup.postOpeningBalances, {
      idempotencyKey: "other-lot-opening",
      sourceReference: "OTHER-LOT",
      lines: [
        {
          productId: f.product._id,
          locationId: f.depot._id,
          quantityBase: 12_000n,
          lotNumber: "EARLIER-UNRELATED",
          manufacturedAt: NOW - 86_400_000,
          expiresAt: NOW + 100 * 86_400_000,
        },
      ],
    });
    const other = (await lotNamed(f, "EARLIER-UNRELATED"))!;
    await f.t.run((ctx) =>
      postMovement(ctx, {
        idempotencyKey: "other-lot-damage",
        payloadHash: hashPayload({ other: other._id }),
        commandType: "test.fixture",
        movementType: "status_change",
        sourceType: "test_fixture",
        actorSubject: f.admin.actor.subject,
        lines: [
          {
            productId: f.product._id,
            quantityBase: 12_000n,
            fromLocationId: f.depot._id,
            toLocationId: f.depot._id,
            fromStockStatus: "available",
            toStockStatus: "damaged",
            allocations: [
              { lotId: other._id, quantityBase: 12_000n, userSelected: true },
            ],
          },
        ],
      }),
    );
    const unload = await f.admin.identity.mutation(
      api.van.trips.returnLeftover,
      {
        tripId: trip.tripId,
        idempotencyKey: "lot-unload",
      },
    );
    // The return keeps the truck's lots, so the record's lot is findable at the depot.
    expect(
      (await allocationsOf(f, unload!)).map((a) => [
        a.lotId,
        a.fromStockStatus,
        a.quantityBase,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [f.lot!._id, "available", LOADED - 12_000n],
        [f.lot!._id, "damaged", 12_000n],
      ]),
    );
    await approver.identity.mutation(api.van.damage.decide, {
      damageId,
      decision: "reject",
      note: "Recorded lot found intact",
    });
    const record = (await f.t.run((ctx) => ctx.db.get(damageId)))!;
    const original = await allocationsOf(
      f,
      movementId as Id<"inventoryMovements">,
    );
    const reversal = await allocationsOf(f, record.reversalMovementId!);
    expect(original.map((a) => a.lotId)).toEqual([f.lot!._id]);
    expect(
      reversal.map((a) => [a.lotId, a.quantityBase, a.reversesAllocationId]),
    ).toEqual([[f.lot!._id, 12_000n, original[0]!._id]]);
    const otherDamaged = await f.t.run((ctx) =>
      ctx.db
        .query("inventoryLotBalances")
        .withIndex(
          "by_organizationId_and_lotId_and_locationId_and_stockStatus",
          (q) =>
            q
              .eq("organizationId", "sunpride")
              .eq("lotId", other._id)
              .eq("locationId", f.depot._id)
              .eq("stockStatus", "damaged"),
        )
        .unique(),
    );
    expect(otherDamaged!.physicalBase).toBe(12_000n);
  });

  it("records an actually expired lot as expired, expired lots first, and returns it", async () => {
    // Release-check counterexample: generic FEFO skipped the expired lot and refused.
    const f = await fixture(true);
    await f.root.mutation(api.inventory.setup.postOpeningBalances, {
      idempotencyKey: "expiring-opening",
      sourceReference: "SOON-EXPIRY",
      lines: [
        {
          productId: f.product._id,
          locationId: f.depot._id,
          quantityBase: 20_000n,
          lotNumber: "EXPIRING-TODAY",
          manufacturedAt: NOW - 86_400_000,
          expiresAt: NOW + 60_000,
        },
      ],
    });
    const lot = (await lotNamed(f, "EXPIRING-TODAY"))!;
    const trip = await f.plan();
    const load = await f.admin.identity.mutation(api.van.loads.plan, {
      tripId: trip.tripId,
      lines: [
        { productId: f.product._id, expectedBase: 20_000n, lotId: lot._id },
      ],
    });
    await f.confirm(trip.tripId, load);
    await f.start(trip.tripId);
    vi.setSystemTime(NOW + 120_000);
    const ack = await f.damage(trip.tripId, {
      quantityBase: "1000",
      reason: "expired",
    });
    expect(
      (
        await allocationsOf(f, ack.ack.movementId as Id<"inventoryMovements">)
      ).map((a) => [a.lotId, a.quantityBase]),
    ).toEqual([[lot._id, 1000n]]);
    expect(await f.balance(f.truck._id)).toMatchObject({
      availableStockBase: 19_000n,
      damagedBase: 1000n,
    });
    // The expired lot (sellable and damaged) still goes back to the depot at day end.
    await f.admin.identity.mutation(api.van.trips.returnLeftover, {
      tripId: trip.tripId,
      idempotencyKey: "expired-unload",
    });
    expect(await f.balance(f.truck._id)).toMatchObject({ physicalBase: 0n });
  });

  it("keeps the recorded selling unit on history after the product's unit changes", async () => {
    // Release-check counterexample: 12 CASE became 12 EACH after a product import.
    const { f } = await pendingRecord();
    const result = await f.root.mutation(api.imports.products.commitProducts, {
      runKey: "uom-change",
      chunkIndex: 0,
      idempotencyKey: "products:uom-change:0",
      fileHash: "fixture-uom",
      rows: [
        row(
          productValues({
            product_code: f.product.code,
            name: f.product.name,
            base_uom: "EACH",
            selling_uoms: "EACH",
            barcode: "",
            tracking_mode: "none",
            allocation_policy: "fifo",
            shelf_life_days: "",
            expiry_required: "N",
            manufacture_date_required: "N",
            minimum_remaining_shelf_life_days: "0",
            external_id: "",
          }),
        ),
      ],
    });
    expect(result.failed).toBe(0);
    const boot = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(
      boot.products.find(
        (p: { productId: string }) => p.productId === f.product._id,
      )?.uomCode,
    ).toBe("EACH");
    expect(boot.damageRecords[0]).toMatchObject({
      uomCode: "CASE",
      quantityScale: "1000",
      quantityBase: "12000",
    });
  });
});

// VAN-021: one vector from packages/domain-contracts/fixtures/van-v1/void-approval.json
// (TEST-ONLY secret); the contracts and Android suites check every vector in that file.
// Runtime-only Convex secret (not a Turbo build input), read by name like mobile/cursor.ts.
const SECRET_ENV = "MOBILE_CURSOR_SECRET";
const VOID_VECTOR = {
  secret: "test-only-van-void-secret-0123456789abcdef",
  tripId: "k57trip0000000000000000000000001",
  key: "6Heg4RirM2SuTt_Pjg5QZwyqg_P-Szkdlxli4UBfz1Y",
  receiptNumber: "TRIP-20261007-V014-1-1A2B3C4D-0001",
  totalMinor: 123450n,
  reasonCode: "wrong_items",
  code: "30814695",
};

describe("van sale void approval (VAN-021)", () => {
  const previous = process.env[SECRET_ENV];
  afterEach(() => {
    if (previous === undefined) delete process.env[SECRET_ENV];
    else process.env[SECRET_ENV] = previous;
  });
  const configure = () => {
    process.env[SECRET_ENV] = VOID_VECTOR.secret;
  };
  const receipt = (tripNumber: string, sequence = "0001") =>
    `${tripNumber}-1A2B3C4D-${sequence}`;

  it("derives the shared cross-language key and code vector", async () => {
    configure();
    expect(await voidApprovalKey(VOID_VECTOR.tripId)).toBe(VOID_VECTOR.key);
    expect(await voidApprovalCode(VOID_VECTOR.key, VOID_VECTOR)).toBe(
      VOID_VECTOR.code,
    );
    // Every bound field changes the code.
    for (const changed of [
      { ...VOID_VECTOR, totalMinor: 123451n },
      { ...VOID_VECTOR, reasonCode: "other" },
      { ...VOID_VECTOR, receiptNumber: receipt("TRIP-X") },
      { ...VOID_VECTOR, tripId: "k57trip0000000000000000000000002" },
    ])
      expect(await voidApprovalCode(VOID_VECTOR.key, changed)).not.toBe(
        VOID_VECTOR.code,
      );
    delete process.env[SECRET_ENV];
    expect(await voidApprovalKey(VOID_VECTOR.tripId)).toBeNull();
  });

  it("sends void reasons, the approval rule and the trip key in the bootstrap; no key without a trip or secret", async () => {
    configure();
    const f = await fixture();
    const empty = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(empty.policy.voidReasons).toEqual([...VOID_REASONS]);
    expect(empty.policy.voidApproval).toEqual({
      required: true,
      thresholdMinor: "0",
      key: null,
    });
    const { tripId } = await f.loaded();
    const view = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(view.policy.voidApproval).toEqual({
      required: true,
      thresholdMinor: "0",
      key: await voidApprovalKey(tripId),
    });
    expect(view.policy.voidApproval.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    delete process.env[SECRET_ENV];
    const unconfigured = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(unconfigured.policy.voidApproval.key).toBeNull();
  });

  it("issues the code a supervisor in scope reads to the seller, audited without the code", async () => {
    configure();
    const f = await fixture();
    const { tripId, tripNumber } = await f.loaded();
    const manager = await f.person("manager");
    const receiptNumber = receipt(tripNumber);
    const issued = await manager.identity.mutation(
      api.van.voids.issueApprovalCode,
      {
        receiptNumber: ` ${receiptNumber.toLowerCase()} `,
        totalMinor: "123450",
        reasonCode: "wrong_items",
      },
    );
    const key = (await voidApprovalKey(tripId))!;
    expect(issued).toEqual({
      code: await voidApprovalCode(key, {
        tripId,
        receiptNumber,
        totalMinor: 123450n,
        reasonCode: "wrong_items",
      }),
      tripNumber,
      receiptNumber,
      totalMinor: "123450",
      reasonCode: "wrong_items",
    });
    const audits = await f.t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "vanTrip").eq("entityId", tripId),
        )
        .collect(),
    );
    const approval = audits.find(
      (row) => row.action === "van.void.approval_issued",
    )!;
    expect(approval.details).toBe(`${receiptNumber}|123450|wrong_items`);
    expect(JSON.stringify(audits)).not.toContain(issued.code);
    // An approver role also qualifies.
    const approver = await f.person("approver");
    await expect(
      approver.identity.mutation(api.van.voids.issueApprovalCode, {
        receiptNumber,
        totalMinor: "1",
        reasonCode: "customer_cancelled",
      }),
    ).resolves.toMatchObject({ receiptNumber });
  });

  it("refuses the seller, roles without the capability, other regions, bad input, trips off the road and a missing secret", async () => {
    configure();
    const f = await fixture();
    const sellerManager = await f.person("manager");
    const { tripNumber } = await f.loaded();
    const own = await f.plan(
      await f.anotherVehicle("VAN-009"),
      sellerManager.profileId,
    );
    const valid = {
      receiptNumber: receipt(tripNumber),
      totalMinor: "5000",
      reasonCode: "wrong_quantity",
    };
    const issue = (
      who: { identity: typeof f.seller.identity },
      args: Partial<typeof valid> = {},
    ) =>
      who.identity.mutation(api.van.voids.issueApprovalCode, {
        ...valid,
        ...args,
      });
    await expect(issue(f.seller)).rejects.toThrow(/Insufficient permission/);
    await expect(issue(await f.person("operations"))).rejects.toThrow(
      /Insufficient permission/,
    );
    await expect(issue(await f.person("manager", f.west))).rejects.toThrow(
      /outside your organizational scope/,
    );
    const manager = await f.person("manager");
    await expect(
      issue(manager, { receiptNumber: "not-a-receipt" }),
    ).rejects.toThrow(/not a van receipt/);
    await expect(
      issue(manager, { receiptNumber: receipt("TRIP-NOPE") }),
    ).rejects.toThrow(/No trip matches/);
    await expect(issue(manager, { totalMinor: "-1" })).rejects.toThrow(
      /receipt total/,
    );
    await expect(issue(manager, { reasonCode: "because" })).rejects.toThrow(
      /void reason/,
    );
    // A planned trip (not loaded) is not on the road yet.
    await expect(
      issue(manager, { receiptNumber: receipt(own.tripNumber) }),
    ).rejects.toThrow(/not on the road/);
    // A manager who is the trip's seller cannot approve their own void.
    const ownLoad = await f.sheet(own.tripId);
    await f.confirm(
      own.tripId,
      ownLoad,
      String(LOADED),
      undefined,
      sellerManager.actor,
    );
    await expect(
      issue(sellerManager, { receiptNumber: receipt(own.tripNumber) }),
    ).rejects.toThrow(/your own sale/);
    delete process.env[SECRET_ENV];
    await expect(issue(manager)).rejects.toThrow(/not configured/);
  });
});

// VAN-022: one vector from packages/domain-contracts/fixtures/van-v1/cash-approval.json
// (TEST-ONLY secret); the contracts and Android suites check every vector in that file.
const CASH_VECTOR = {
  secret: "test-only-van-void-secret-0123456789abcdef",
  tripId: "k57trip0000000000000000000000001",
  key: "PnoIS45xGmCnubWwLVAmPBjjgF-prN3ykOOEvfv5zsY",
  expectedMinor: 1234550n,
  declaredMinor: 1234500n,
  reasonCode: "counting_error",
  code: "93406719",
};

describe("van end-of-trip cash reconciliation approval (VAN-022)", () => {
  const previous = process.env[SECRET_ENV];
  afterEach(() => {
    if (previous === undefined) delete process.env[SECRET_ENV];
    else process.env[SECRET_ENV] = previous;
  });
  const configure = () => {
    process.env[SECRET_ENV] = CASH_VECTOR.secret;
  };

  it("derives the shared cross-language key and code, separate from the void key", async () => {
    configure();
    expect(await cashApprovalKey(CASH_VECTOR.tripId)).toBe(CASH_VECTOR.key);
    expect(await cashApprovalKey(CASH_VECTOR.tripId)).not.toBe(
      await voidApprovalKey(CASH_VECTOR.tripId),
    );
    expect(await cashApprovalCode(CASH_VECTOR.key, CASH_VECTOR)).toBe(
      CASH_VECTOR.code,
    );
    for (const changed of [
      { ...CASH_VECTOR, expectedMinor: 1234551n },
      { ...CASH_VECTOR, declaredMinor: 1234501n },
      { ...CASH_VECTOR, reasonCode: "other" },
      { ...CASH_VECTOR, tripId: "k57trip0000000000000000000000002" },
    ])
      expect(await cashApprovalCode(CASH_VECTOR.key, changed)).not.toBe(
        CASH_VECTOR.code,
      );
    delete process.env[SECRET_ENV];
    expect(await cashApprovalKey(CASH_VECTOR.tripId)).toBeNull();
  });

  it("sends the variance reasons, tolerance and trip key in the bootstrap; no key without a trip or secret", async () => {
    configure();
    const f = await fixture();
    const empty = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(empty.policy.cashReconciliation).toEqual({
      approvalRequired: true,
      toleranceMinor: "5000",
      reasons: [...CASH_VARIANCE_REASONS],
      key: null,
    });
    const { tripId } = await f.loaded();
    const view = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(view.policy.cashReconciliation.key).toBe(
      await cashApprovalKey(tripId),
    );
    expect(view.policy.cashReconciliation.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    delete process.env[SECRET_ENV];
    const unconfigured = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(unconfigured.policy.cashReconciliation.key).toBeNull();
  });

  it("issues the code a supervisor in scope reads to the seller, audited without the code", async () => {
    configure();
    const f = await fixture();
    const { tripId, tripNumber } = await f.loaded();
    await f.start(tripId);
    const manager = await f.person("manager");
    const issued = await manager.identity.mutation(
      api.van.cash.issueApprovalCode,
      {
        tripNumber: ` ${tripNumber.toLowerCase()} `,
        expectedMinor: "1234550",
        declaredMinor: "1220000",
        reasonCode: "lost_or_stolen",
      },
    );
    const key = (await cashApprovalKey(tripId))!;
    expect(issued).toEqual({
      code: await cashApprovalCode(key, {
        tripId,
        expectedMinor: 1234550n,
        declaredMinor: 1220000n,
        reasonCode: "lost_or_stolen",
      }),
      tripNumber,
      expectedMinor: "1234550",
      declaredMinor: "1220000",
      varianceMinor: "-14550",
      reasonCode: "lost_or_stolen",
    });
    const audits = await f.t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "vanTrip").eq("entityId", tripId),
        )
        .collect(),
    );
    const approval = audits.find(
      (row) => row.action === "van.cash.approval_issued",
    )!;
    expect(approval.details).toBe("1234550|1220000|-14550|lost_or_stolen");
    expect(JSON.stringify(audits)).not.toContain(issued.code);
    // An approver also qualifies, and an over-count is approved the same way.
    const approver = await f.person("approver");
    await expect(
      approver.identity.mutation(api.van.cash.issueApprovalCode, {
        tripNumber,
        expectedMinor: "0",
        declaredMinor: "6000",
        reasonCode: "customer_overpaid",
      }),
    ).resolves.toMatchObject({ varianceMinor: "6000" });
  });

  it("refuses the seller, roles without the capability, other regions, bad input, trips not on the road and a missing secret", async () => {
    configure();
    const f = await fixture();
    const sellerManager = await f.person("manager");
    const { tripId, tripNumber } = await f.loaded();
    const valid = {
      tripNumber,
      expectedMinor: "500000",
      declaredMinor: "490000",
      reasonCode: "counting_error",
    };
    const issue = (
      who: { identity: typeof f.seller.identity },
      args: Partial<typeof valid> = {},
    ) =>
      who.identity.mutation(api.van.cash.issueApprovalCode, {
        ...valid,
        ...args,
      });
    const manager = await f.person("manager");
    // Loaded but not started: no cash to count yet.
    await expect(issue(manager)).rejects.toThrow(/not on the road/);
    await f.start(tripId);
    await expect(issue(f.seller)).rejects.toThrow(/Insufficient permission/);
    await expect(issue(await f.person("operations"))).rejects.toThrow(
      /Insufficient permission/,
    );
    await expect(issue(await f.person("manager", f.west))).rejects.toThrow(
      /outside your organizational scope/,
    );
    await expect(issue(manager, { tripNumber: " " })).rejects.toThrow(
      /trip number/,
    );
    await expect(issue(manager, { tripNumber: "TRIP-NOPE" })).rejects.toThrow(
      /No trip matches/,
    );
    await expect(issue(manager, { expectedMinor: "-1" })).rejects.toThrow(
      /expected cash/,
    );
    await expect(issue(manager, { declaredMinor: "12.50" })).rejects.toThrow(
      /counted cash/,
    );
    await expect(
      issue(manager, { declaredMinor: valid.expectedMinor }),
    ).rejects.toThrow(/no approval is needed/);
    await expect(issue(manager, { reasonCode: "because" })).rejects.toThrow(
      /difference reason/,
    );
    // A manager who is the trip's seller cannot approve their own count.
    const own = await f.plan(
      await f.anotherVehicle("VAN-009"),
      sellerManager.profileId,
    );
    await f.t.run(async (ctx) => {
      await ctx.db.patch(own.tripId, { status: "active" });
    });
    await expect(
      issue(sellerManager, { tripNumber: own.tripNumber }),
    ).rejects.toThrow(/your own cash count/);
    delete process.env[SECRET_ENV];
    await expect(issue(manager)).rejects.toThrow(/not configured/);
  });
});

// VAN-023: the first vector from packages/domain-contracts/fixtures/van-v1/stock-approval.json
// (TEST-ONLY secret); the contracts and Android suites check every vector in that file.
const STOCK_VECTOR = {
  secret: "test-only-van-void-secret-0123456789abcdef",
  tripId: "k57trip0000000000000000000000001",
  key: "ftgd8nUKPhvNhRTGW3T2lRGvsHPZ_3xpnUU3FN3kvLA",
  countCode: "7ACD2B0FA14F",
  varianceLines: 2,
  shortBase: 2n,
  overBase: 3n,
  code: "87972425",
};

describe("van end-of-trip stock reconciliation approval (VAN-023)", () => {
  const previous = process.env[SECRET_ENV];
  afterEach(() => {
    if (previous === undefined) delete process.env[SECRET_ENV];
    else process.env[SECRET_ENV] = previous;
  });
  const configure = () => {
    process.env[SECRET_ENV] = STOCK_VECTOR.secret;
  };

  it("derives the shared cross-language key and code, separate from the void and cash keys", async () => {
    configure();
    const key = await stockApprovalKey(STOCK_VECTOR.tripId);
    expect(key).toBe(STOCK_VECTOR.key);
    expect(key).not.toBe(await voidApprovalKey(STOCK_VECTOR.tripId));
    expect(key).not.toBe(await cashApprovalKey(STOCK_VECTOR.tripId));
    expect(await stockApprovalCode(STOCK_VECTOR.key, STOCK_VECTOR)).toBe(
      STOCK_VECTOR.code,
    );
    for (const changed of [
      { ...STOCK_VECTOR, countCode: "000000000000" },
      { ...STOCK_VECTOR, varianceLines: 3 },
      { ...STOCK_VECTOR, shortBase: 3n },
      { ...STOCK_VECTOR, overBase: 2n },
      { ...STOCK_VECTOR, tripId: "k57trip0000000000000000000000002" },
    ])
      expect(await stockApprovalCode(STOCK_VECTOR.key, changed)).not.toBe(
        STOCK_VECTOR.code,
      );
    expect(normalizeCountCode(" abcd-ef12 3456 ")).toBe("ABCDEF123456");
    expect(normalizeCountCode("ABCD-EF12-345")).toBeNull();
    expect(normalizeCountCode("ABCD-EF12-345G")).toBeNull();
    delete process.env[SECRET_ENV];
    expect(await stockApprovalKey(STOCK_VECTOR.tripId)).toBeNull();
  });

  it("sends the variance reasons, approval rule and trip key in the bootstrap; no key without a trip or secret", async () => {
    configure();
    const f = await fixture();
    const empty = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(empty.policy.stockReconciliation).toEqual({
      approvalRequired: true,
      reasons: [...STOCK_VARIANCE_REASONS],
      key: null,
    });
    const { tripId } = await f.loaded();
    const view = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(view.policy.stockReconciliation.key).toBe(
      await stockApprovalKey(tripId),
    );
    expect(view.policy.stockReconciliation.key).not.toBe(
      view.policy.cashReconciliation.key,
    );
    delete process.env[SECRET_ENV];
    const unconfigured = await f.t.query(internal.van.device.bootstrap, {
      actor: f.seller.actor,
      now: NOW,
    });
    expect(unconfigured.policy.stockReconciliation.key).toBeNull();
  });

  it("issues the code a supervisor in scope reads to the seller, audited without the code", async () => {
    configure();
    const f = await fixture();
    const { tripId, tripNumber } = await f.loaded();
    await f.start(tripId);
    const manager = await f.person("manager");
    const issued = await manager.identity.mutation(
      api.van.stock_count.issueApprovalCode,
      {
        tripNumber: ` ${tripNumber.toLowerCase()} `,
        countCode: "1a2b-3c4d-5e6f",
        varianceLines: 2,
        shortBase: "5",
        overBase: "1",
      },
    );
    const key = (await stockApprovalKey(tripId))!;
    expect(issued).toEqual({
      code: await stockApprovalCode(key, {
        tripId,
        countCode: "1A2B3C4D5E6F",
        varianceLines: 2,
        shortBase: 5n,
        overBase: 1n,
      }),
      tripNumber,
      countCode: "1A2B3C4D5E6F",
      varianceLines: 2,
      shortBase: "5",
      overBase: "1",
    });
    const audits = await f.t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) =>
          q.eq("entityType", "vanTrip").eq("entityId", tripId),
        )
        .collect(),
    );
    const approval = audits.find(
      (row) => row.action === "van.stock.approval_issued",
    )!;
    expect(approval.details).toBe("1A2B3C4D5E6F|2|5|1");
    expect(JSON.stringify(audits)).not.toContain(issued.code);
    // An approver also qualifies; an over-only count is approved the same way.
    const approver = await f.person("approver");
    await expect(
      approver.identity.mutation(api.van.stock_count.issueApprovalCode, {
        tripNumber,
        countCode: "FFFFFFFFFFFF",
        varianceLines: 1,
        shortBase: "0",
        overBase: "4",
      }),
    ).resolves.toMatchObject({ overBase: "4", shortBase: "0" });
  });

  it("refuses the seller, roles without the capability, other regions, bad input, trips not on the road and a missing secret", async () => {
    configure();
    const f = await fixture();
    const sellerManager = await f.person("manager");
    const { tripId, tripNumber } = await f.loaded();
    const valid = {
      tripNumber,
      countCode: "ABCDEF123456",
      varianceLines: 1,
      shortBase: "2",
      overBase: "0",
    };
    const issue = (
      who: { identity: typeof f.seller.identity },
      args: Partial<typeof valid> = {},
    ) =>
      who.identity.mutation(api.van.stock_count.issueApprovalCode, {
        ...valid,
        ...args,
      });
    const manager = await f.person("manager");
    // Loaded but not started: nothing sold yet, so nothing to reconcile.
    await expect(issue(manager)).rejects.toThrow(/not on the road/);
    await f.start(tripId);
    await expect(issue(f.seller)).rejects.toThrow(/Insufficient permission/);
    await expect(issue(await f.person("operations"))).rejects.toThrow(
      /Insufficient permission/,
    );
    await expect(issue(await f.person("manager", f.west))).rejects.toThrow(
      /outside your organizational scope/,
    );
    await expect(issue(manager, { tripNumber: " " })).rejects.toThrow(
      /trip number/,
    );
    await expect(issue(manager, { tripNumber: "TRIP-NOPE" })).rejects.toThrow(
      /No trip matches/,
    );
    await expect(issue(manager, { countCode: "ABCDEF12345" })).rejects.toThrow(
      /count code/,
    );
    await expect(issue(manager, { varianceLines: 0 })).rejects.toThrow(
      /lines differ/,
    );
    await expect(issue(manager, { varianceLines: 1.5 })).rejects.toThrow(
      /lines differ/,
    );
    await expect(issue(manager, { shortBase: "-1" })).rejects.toThrow(
      /units short/,
    );
    await expect(issue(manager, { overBase: "1.5" })).rejects.toThrow(
      /units over/,
    );
    await expect(
      issue(manager, { shortBase: "0", overBase: "0" }),
    ).rejects.toThrow(/no approval is needed/);
    // A manager who is the trip's seller cannot approve their own count.
    const own = await f.plan(
      await f.anotherVehicle("VAN-009"),
      sellerManager.profileId,
    );
    await f.t.run(async (ctx) => {
      await ctx.db.patch(own.tripId, { status: "active" });
    });
    await expect(
      issue(sellerManager, { tripNumber: own.tripNumber }),
    ).rejects.toThrow(/your own stock count/);
    delete process.env[SECRET_ENV];
    await expect(issue(manager)).rejects.toThrow(/not configured/);
  });
});
