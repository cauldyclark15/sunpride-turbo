import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import type { AuthorizedDevice } from "../mobile/types";
import type { AppRole } from "../lib/roles";
import { LOCATION_POLICY, liveStatus, manilaDateOf } from "./model";

// 2026-09-28 12:00 Asia/Manila: inside field working hours.
const NOW = Date.parse("2026-09-28T04:00:00Z");
const TODAY = manilaDateOf(NOW);
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type T = TestConvex<typeof schema>;
afterEach(() => vi.useRealTimers());

const ping = (n: number, at: number, extra: Record<string, unknown> = {}) => ({
  clientPingId: uuid(n),
  recordedAt: at,
  latitude: 10.3157 + n / 10_000,
  longitude: 123.8854,
  accuracyMeters: 12,
  speedMetersPerSecond: 5,
  headingDegrees: 90,
  batteryPercent: 80,
  mockLocation: false,
  provider: "fused" as const,
  trigger: "moving" as const,
  ...extra,
});

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const t: T = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const unit = (code: string, parentId?: Id<"orgUnits">) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: parentId ? "AREA" : "NATIONAL",
        ...(parentId ? { parentId } : {}),
        status: "active",
        effectiveFrom: NOW - 10_000_000,
        createdAt: NOW,
        updatedAt: NOW,
      });
    const root = await unit("SUNPRIDE");
    const cebu = await unit("CEBU", root);
    const north = await unit("CEBU-N", cebu);
    const luzon = await unit("LUZON", root);
    const person = async (
      name: string,
      role: AppRole,
      orgUnitId: Id<"orgUnits">,
    ) => {
      const profile = await ctx.db.insert("profiles", {
        authSubject: `https://auth.test|${name}`,
        name,
        email: `${name}@test.local`,
        role,
        status: "active",
        orgUnitId,
        updatedAt: NOW,
      });
      await ctx.db.insert("employeeAssignments", {
        profileId: profile,
        orgUnitId,
        role,
        effectiveFrom: NOW - 10_000_000,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: NOW,
      });
      return profile;
    };
    const sales = await person("sales", "sales", north);
    const seller = await person("seller", "sales", north);
    const manager = await person("manager", "manager", cebu);
    const outsider = await person("outsider", "manager", luzon);
    const analyst = await person("analyst", "analyst", root);
    const viewer = await person("viewer", "viewer", cebu);
    const device = (
      profileId: Id<"profiles">,
      tag: string,
      app: "ANDROID" | "VAN_ANDROID",
    ) =>
      ctx.db.insert("registeredDevices", {
        organizationId: "sunpride",
        orgUnitId: north,
        inventoryTag: tag,
        profileId,
        boundSubject: `https://auth.test|${tag}`,
        allowedApp: app,
        platform: "android",
        model: "test",
        osVersion: "1",
        appVersion: "1",
        publicKey: "key",
        credentialId: tag,
        registeredAt: NOW,
        status: "active",
      });
    const fieldDevice = await device(sales, "sales", "ANDROID");
    const vanDevice = await device(seller, "seller", "VAN_ANDROID");
    const location = (code: string, type: "warehouse" | "truck") =>
      ctx.db.insert("inventoryLocations", {
        organizationId: "sunpride",
        orgUnitId: north,
        siteCode: "CEB",
        code,
        name: code,
        type,
        active: true,
        allowsPicking: true,
        allowsReceiving: true,
        allowsSale: type === "truck",
        allowsProduction: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
    const depot = await location("DEPOT", "warehouse");
    const truckLocation = await location("TRUCK-1", "truck");
    const vehicle = await ctx.db.insert("vehicles", {
      organizationId: "sunpride",
      orgUnitId: north,
      vehicleCode: "TRK-1",
      plateNumber: "GAC 4521",
      truckLocationId: truckLocation,
      homeLocationId: depot,
      status: "active",
      createdBy: "fixture",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const trip = (status: "active" | "loading", startedAt?: number) =>
      ctx.db.insert("vanTrips", {
        organizationId: "sunpride",
        orgUnitId: north,
        tripNumber: `TRIP-${status}`,
        vehicleId: vehicle,
        truckLocationId: truckLocation,
        sourceLocationId: depot,
        serviceDate: TODAY,
        salespersonProfileId: seller,
        salespersonSubject: "https://auth.test|seller",
        status,
        ...(startedAt ? { startedAt } : {}),
        createdBy: "fixture",
        createdAt: NOW,
        updatedAt: NOW,
      });
    const activeTrip = await trip("active", NOW - 3_600_000);
    const plannedTrip = await trip("loading");
    return {
      root,
      cebu,
      north,
      luzon,
      sales,
      seller,
      manager,
      outsider,
      analyst,
      viewer,
      fieldDevice,
      vanDevice,
      vehicle,
      activeTrip,
      plannedTrip,
    };
  });
  const as = (name: string) =>
    t.withIdentity({
      subject: name,
      issuer: "https://auth.test",
      tokenIdentifier: `https://auth.test|${name}`,
    });
  const fieldActor: AuthorizedDevice = {
    deviceId: ids.fieldDevice,
    profileId: ids.sales,
    orgUnitId: ids.north,
    role: "sales",
    subject: "https://auth.test|sales",
    scopeFingerprint: "fixture",
  };
  const vanActor: AuthorizedDevice = {
    deviceId: ids.vanDevice,
    profileId: ids.seller,
    orgUnitId: ids.north,
    role: "sales",
    subject: "https://auth.test|seller",
    scopeFingerprint: "fixture",
  };
  const field = (pings: ReturnType<typeof ping>[]) =>
    as("sales").mutation(internal.location.ingest.applyBatch, {
      actor: fieldActor,
      kind: "field",
      pings,
    });
  const van = (pings: Record<string, unknown>[]) =>
    as("seller").mutation(internal.location.ingest.applyBatch, {
      actor: vanActor,
      kind: "van",
      pings: pings as ReturnType<typeof ping>[],
    });
  return { t, ids, as, field, van, fieldActor, vanActor };
}

describe("location ingestion (field)", () => {
  it("stores pings, updates the live row and is idempotent per device", async () => {
    const f = await fixture();
    const first = await f.field([
      ping(1, NOW - 120_000),
      ping(2, NOW - 60_000, { trigger: "still", speedMetersPerSecond: 0 }),
    ]);
    expect(first.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    const replay = await f.field([
      ping(2, NOW - 60_000, { trigger: "still", speedMetersPerSecond: 0 }),
    ]);
    expect(replay).toEqual([{ clientPingId: uuid(2), status: "duplicate" }]);
    const changed = await f.field([ping(2, NOW - 30_000)]);
    expect(changed[0]).toMatchObject({ status: "rejected", code: "conflict" });
    const { pings, live } = await f.t.run(async (ctx) => ({
      pings: await ctx.db.query("locationPings").collect(),
      live: await ctx.db.query("liveLocations").collect(),
    }));
    expect(pings).toHaveLength(2);
    expect(pings[0]).toMatchObject({
      kind: "field",
      profileId: f.ids.sales,
      deviceId: f.ids.fieldDevice,
      orgUnitId: f.ids.north,
      serviceDate: TODAY,
      receivedAt: NOW,
      batteryPercent: 80,
      mockLocation: false,
    });
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      subjectKey: `field:${f.ids.sales}`,
      recordedAt: NOW - 60_000,
      trigger: "still",
      trackingEnded: false,
    });
  });

  it("keeps the newest live position when an older buffered ping arrives later", async () => {
    const f = await fixture();
    await f.field([ping(1, NOW - 60_000)]);
    await f.field([ping(2, NOW - 600_000)]);
    const live = await f.t.run((ctx) =>
      ctx.db.query("liveLocations").collect(),
    );
    expect(live[0]!.recordedAt).toBe(NOW - 60_000);
  });

  it("refuses rate-limited, stale, future, after-hours and malformed pings", async () => {
    const f = await fixture();
    const night = Date.parse("2026-09-28T14:30:00Z"); // 22:30 Manila
    const results = await f.field([
      ping(1, NOW - 60_000),
      ping(2, NOW - 55_000), // 5 s after ping 1
      ping(3, NOW - LOCATION_POLICY.maxAgeMs - 1),
      ping(4, NOW + LOCATION_POLICY.maxFutureSkewMs + 1),
      ping(5, night - 86_400_000),
      ping(6, NOW - 30_000, { latitude: 91 }),
      ping(7, NOW - 50_000, { trigger: "stop" }), // start/stop are never throttled
    ]);
    expect(results.map((r) => r.code ?? r.status)).toEqual([
      "accepted",
      "too_frequent",
      "too_old",
      "invalid_request",
      "outside_work_hours",
      "invalid_request",
      "accepted",
    ]);
    const live = await f.t.run((ctx) =>
      ctx.db.query("liveLocations").collect(),
    );
    expect(live[0]!.trackingEnded).toBe(true);
    expect(liveStatus(live[0]!, NOW)).toBe("offline");
  });

  it("rejects duplicate IDs within one batch and someone else's visit", async () => {
    const f = await fixture();
    const otherVisit = await f.t.run(async (ctx) => {
      const outlet = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: "O1",
        name: "Store",
        status: "active",
        custodianOrgUnitId: f.ids.north,
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: "fixture",
      });
      return ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: uuid(900),
        assigneeProfileId: f.ids.seller,
        outletId: outlet,
        orgUnitId: f.ids.north,
        serviceDate: TODAY,
        source: "unplanned",
        intents: ["sell"],
        state: "checked-in",
        productivity: "pending",
        createdAt: NOW,
        lastServerTime: NOW,
      });
    });
    const results = await f.field([
      ping(1, NOW - 60_000),
      ping(1, NOW - 30_000),
      ping(3, NOW - 120_000, { visitId: otherVisit }),
    ]);
    expect(results.map((r) => r.code ?? r.status)).toEqual([
      "accepted",
      "invalid_request",
      "out_of_scope",
    ]);
  });

  it("re-checks the device in the writing transaction (suspended after the proof)", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.patch(f.ids.fieldDevice, { status: "suspended" }),
    );
    await expect(f.field([ping(1, NOW - 60_000)])).rejects.toThrow(
      /unauthorized/,
    );
    const count = await f.t.run(
      async (ctx) => (await ctx.db.query("locationPings").collect()).length,
    );
    expect(count).toBe(0);
  });

  it("refuses a van device on the field writer", async () => {
    const f = await fixture();
    await expect(
      f.as("seller").mutation(internal.location.ingest.applyBatch, {
        actor: f.vanActor,
        kind: "field",
        pings: [ping(1, NOW - 60_000)],
      }),
    ).rejects.toThrow(/unauthorized/);
  });
});

describe("location ingestion (van)", () => {
  it("accepts pings only for the seller's active trip and keys the live row by truck", async () => {
    const f = await fixture();
    const results = await f.van([
      { ...ping(1, NOW - 60_000), tripId: f.ids.activeTrip },
      { ...ping(2, NOW - 30_000), tripId: f.ids.plannedTrip },
      { ...ping(3, NOW - 7_200_000), tripId: f.ids.activeTrip }, // before trip start
      { ...ping(4, NOW - 20_000), tripId: "not-a-trip" },
    ]);
    expect(results.map((r) => r.code ?? r.status)).toEqual([
      "accepted",
      "trip_not_active",
      "trip_not_active",
      "out_of_scope",
    ]);
    const live = await f.t.run((ctx) =>
      ctx.db.query("liveLocations").collect(),
    );
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      kind: "van",
      subjectKey: `van:${f.ids.vehicle}`,
      vehicleId: f.ids.vehicle,
      tripId: f.ids.activeTrip,
    });
  });

  it("refuses another seller's trip and a revoked van device", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.patch(f.ids.activeTrip, { salespersonProfileId: f.ids.sales }),
    );
    const results = await f.van([
      { ...ping(1, NOW - 60_000), tripId: f.ids.activeTrip },
    ]);
    expect(results[0]).toMatchObject({ code: "out_of_scope" });
    await f.t.run((ctx) =>
      ctx.db.patch(f.ids.vanDevice, { status: "revoked" }),
    );
    await expect(
      f.van([{ ...ping(2, NOW - 30_000), tripId: f.ids.activeTrip }]),
    ).rejects.toThrow(/unauthorized/);
  });
});

describe("live map visibility", () => {
  async function seeded() {
    const f = await fixture();
    await f.field([ping(1, NOW - 60_000)]);
    await f.van([{ ...ping(2, NOW - 90_000), tripId: f.ids.activeTrip }]);
    return f;
  }

  it("shows people and trucks in scope with status from age", async () => {
    const f = await seeded();
    const view = await f.as("manager").query(api.location.queries.live, {
      now: NOW,
    });
    expect(view.selfOnly).toBe(false);
    expect(
      view.positions.map((p) => [p.kind, p.name, p.status, p.vehicleLabel]),
    ).toEqual([
      ["field", "sales", "moving", null],
      ["van", "seller", "moving", "TRK-1 · GAC 4521"],
    ]);
    const later = await f.as("manager").query(api.location.queries.live, {
      now: NOW + LOCATION_POLICY.staleAfterMs,
    });
    expect(later.positions.map((p) => p.status)).toEqual(["stale", "stale"]);
    const trucks = await f.as("manager").query(api.location.queries.live, {
      now: NOW,
      kind: "van",
    });
    expect(trucks.positions.map((p) => p.kind)).toEqual(["van"]);
  });

  it("hides positions outside the caller's current scope", async () => {
    const f = await seeded();
    const outsider = await f.as("outsider").query(api.location.queries.live, {
      now: NOW,
    });
    expect(outsider.positions).toEqual([]);
    await expect(
      f.as("outsider").query(api.location.queries.live, {
        now: NOW,
        orgUnitId: f.ids.north,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    await expect(
      f.as("outsider").query(api.location.queries.trail, {
        profileId: f.ids.sales,
        serviceDate: TODAY,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    // The person moved to another region: the old supervisor no longer sees them.
    await f.t.run((ctx) =>
      ctx.db.patch(f.ids.sales, { orgUnitId: f.ids.luzon }),
    );
    const manager = await f.as("manager").query(api.location.queries.live, {
      now: NOW,
    });
    expect(manager.positions.map((p) => p.kind)).toEqual(["van"]);
  });

  it("lets sales see only themselves, analysts everyone, and denies viewers", async () => {
    const f = await seeded();
    const self = await f.as("sales").query(api.location.queries.live, {
      now: NOW,
    });
    expect(self.selfOnly).toBe(true);
    expect(self.positions.map((p) => p.name)).toEqual(["sales"]);
    await expect(
      f.as("sales").query(api.location.queries.trail, {
        profileId: f.ids.seller,
        serviceDate: TODAY,
      }),
    ).rejects.toThrow(/outside your organizational scope/);
    const analyst = await f.as("analyst").query(api.location.queries.live, {
      now: NOW,
    });
    expect(analyst.positions).toHaveLength(2);
    await expect(
      f.as("viewer").query(api.location.queries.live, { now: NOW }),
    ).rejects.toThrow(/Insufficient permission/);
  });

  it("returns a day trail with the day's check-ins as stops", async () => {
    const f = await seeded();
    await f.field([ping(5, NOW - 30 * 60_000), ping(6, NOW - 20 * 60_000)]);
    await f.t.run(async (ctx) => {
      const outlet = await ctx.db.insert("outlets", {
        organizationId: "sunpride",
        code: "O1",
        name: "Colon Grocery",
        status: "active",
        custodianOrgUnitId: f.ids.north,
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: "fixture",
      });
      await ctx.db.insert("outletPins", {
        outletId: outlet,
        latitude: 10.3,
        longitude: 123.9,
        radiusMeters: 50,
        source: "fixture",
        status: "verified",
        effectiveFrom: NOW - 10_000_000,
        proposedBy: "fixture",
        proposedAt: NOW,
        createdAt: NOW,
      });
      await ctx.db.insert("visitExecutions", {
        organizationId: "sunpride",
        clientVisitId: uuid(900),
        assigneeProfileId: f.ids.sales,
        outletId: outlet,
        orgUnitId: f.ids.north,
        serviceDate: TODAY,
        source: "unplanned",
        intents: ["sell"],
        state: "checked-out",
        productivity: "pending",
        createdAt: NOW - 25 * 60_000,
        checkedInAt: NOW - 25 * 60_000,
        checkedOutAt: NOW - 5 * 60_000,
        lastServerTime: NOW,
      });
    });
    const trail = await f.as("manager").query(api.location.queries.trail, {
      profileId: f.ids.sales,
      serviceDate: TODAY,
    });
    expect(trail.pings.map((p) => p.recordedAt)).toEqual([
      NOW - 30 * 60_000,
      NOW - 20 * 60_000,
      NOW - 60_000,
    ]);
    expect(trail.stops).toEqual([
      expect.objectContaining({
        outletName: "Colon Grocery",
        latitude: 10.3,
        longitude: 123.9,
        pinned: true,
        checkedInAt: NOW - 25 * 60_000,
      }),
    ]);
    const pins = await f.as("manager").query(api.location.queries.storePins, {
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(pins.page.map((p) => p.name)).toEqual(["Colon Grocery"]);
    const outsiderPins = await f
      .as("outsider")
      .query(api.location.queries.storePins, {
        paginationOpts: { numItems: 50, cursor: null },
      });
    expect(outsiderPins.page).toEqual([]);
  });
});

describe("retention", () => {
  it("deletes pings and live rows older than 90 days", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const base = {
        organizationId: "sunpride",
        kind: "field" as const,
        profileId: f.ids.sales,
        orgUnitId: f.ids.north,
        serviceDate: TODAY,
        latitude: 10,
        longitude: 123,
        accuracyMeters: 5,
        speedMetersPerSecond: null,
        headingDegrees: null,
        batteryPercent: null,
        mockLocation: false,
        provider: "gps" as const,
        trigger: "still" as const,
        receivedAt: NOW,
      };
      await ctx.db.insert("locationPings", {
        ...base,
        clientPingId: "old",
        recordedAt: NOW - LOCATION_POLICY.retentionMs - 1,
      });
      await ctx.db.insert("locationPings", {
        ...base,
        clientPingId: "new",
        recordedAt: NOW - 1_000,
      });
      await ctx.db.insert("liveLocations", {
        ...base,
        subjectKey: "field:old",
        trackingEnded: false,
        recordedAt: NOW - LOCATION_POLICY.retentionMs - 1,
      });
    });
    const result = await f.t.mutation(
      internal.location.ingest.purgeExpired,
      {},
    );
    expect(result).toEqual({ deleted: 2, more: false });
    const left = await f.t.run(async (ctx) => ({
      pings: (await ctx.db.query("locationPings").collect()).map(
        (row) => row.clientPingId,
      ),
      live: (await ctx.db.query("liveLocations").collect()).length,
    }));
    expect(left).toEqual({ pings: ["new"], live: 0 });
  });
});
