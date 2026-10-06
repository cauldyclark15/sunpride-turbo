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
import { handleVan } from "./http_handlers";

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
      reason: "crushed",
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
      reason: "crushed",
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
});
