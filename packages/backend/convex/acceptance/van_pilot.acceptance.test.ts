import { convexTest, type TestConvex } from "convex-test";
import type { FunctionArgs } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import type { AuthorizedDevice } from "../mobile/types";
import { SAMPLE_PEOPLE } from "../beta/sample_data";

// QSR-002 (SP-0120): the server half of the van-sales UAT day in
// docs/qa/VAN_SALES_UAT_SCENARIOS.md, run on the beta sample data the UAT uses
// (beta/sample:seed + beta/sample:planVanDay), with the sample testers' roles.
// Wednesday 7 Oct 2026, 10:00 Manila.
const NOW = Date.parse("2026-10-07T02:00:00Z");
const LATER = NOW + 60_000;
const SECRET_ENV = "MOBILE_CURSOR_SECRET";
type T = TestConvex<typeof schema>;
type Operation = FunctionArgs<typeof internal.van.device.applyOne>["operation"];
type Boot = {
  trip: {
    tripId: Id<"vanTrips">;
    tripNumber: string;
    status: string;
    truckLocationId: Id<"inventoryLocations">;
  } | null;
  load: {
    loadId: Id<"vanTripLoads">;
    status: string;
    lines: {
      lineNumber: number;
      productId: Id<"products">;
      productCode: string;
      quantityScale: string;
      expectedBase: string;
    }[];
  } | null;
  truckStock: {
    productId: string;
    availableBase: string;
    damagedBase: string;
  }[];
  customers: unknown[];
  priceLines?: { priceListId: string; productId: string }[];
  policy: {
    voidApproval: { key: string | null };
    cashReconciliation: { key: string | null; toleranceMinor: string };
  };
};
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const previousSecret = process.env[SECRET_ENV];
afterEach(() => {
  vi.useRealTimers();
  if (previousSecret === undefined) delete process.env[SECRET_ENV];
  else process.env[SECRET_ENV] = previousSecret;
});

function tester(t: T, key: string) {
  const person = SAMPLE_PEOPLE.find((row) => row.key === key)!;
  return t.withIdentity({
    subject: key,
    issuer: "https://auth.test",
    email: person.email,
    name: person.name,
  });
}

/** The sample deployment after the testers signed in and the lead planned the van day. */
async function sampleVanDay() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env[SECRET_ENV] = "uat-van-day-secret-not-a-real-value";
  const t: T = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  await t.mutation(internal.beta.sample.seed, {});
  const van = tester(t, "van");
  const supervisor = tester(t, "manager");
  const operations = tester(t, "operations");
  const sellerId = await van.mutation(api.domains.profiles.ensure, {});
  await supervisor.mutation(api.domains.profiles.ensure, {});
  await operations.mutation(api.domains.profiles.ensure, {});
  // The second seed run attaches each signed-in tester to their unit and route.
  await t.mutation(internal.beta.sample.seed, {});
  vi.setSystemTime(LATER);
  const planned = (await t.mutation(internal.beta.sample.planVanDay, {}))!;
  const seller = (await t.run((ctx) => ctx.db.get(sellerId)))!;
  const deviceId = await t.run((ctx) =>
    ctx.db.insert("registeredDevices", {
      organizationId: "sunpride",
      orgUnitId: seller.orgUnitId!,
      inventoryTag: "H10P-UAT",
      profileId: sellerId,
      boundSubject: seller.authSubject,
      allowedApp: "VAN_ANDROID",
      platform: "Android",
      model: "H10P",
      osVersion: "14",
      appVersion: "1",
      publicKey: "fixture-key",
      credentialId: "H10P-UAT",
      registeredAt: NOW,
      status: "active",
    }),
  );
  const actor: AuthorizedDevice = {
    deviceId,
    profileId: sellerId,
    subject: seller.authSubject!,
    orgUnitId: seller.orgUnitId!,
    role: "sales",
    scopeFingerprint: "uat",
  };
  const bootstrap = async () =>
    (await t.query(internal.van.device.bootstrap, {
      actor,
      now: Date.now(),
    })) as unknown as Boot;
  const apply = (
    kind: Operation["kind"],
    payload: unknown,
    clientRequestId: string,
  ) =>
    t.mutation(internal.van.device.applyOne, {
      actor,
      operation: { kind, payload, clientRequestId },
    });
  const balances = (locationId: Id<"inventoryLocations">) =>
    t.run(async (ctx) =>
      (await ctx.db.query("inventoryBalances").collect()).filter(
        (row) => row.locationId === locationId,
      ),
    );
  const depot = await t.run(async (ctx) =>
    (await ctx.db.query("inventoryLocations").collect()).find(
      (row) => row.code === "SMP-DEPOT-CEBU",
    )!,
  );
  const movements = () =>
    t.run(async (ctx) =>
      (await ctx.db.query("inventoryMovements").collect()).filter(
        (row) => row.movementType !== "opening_balance",
      ),
    );
  return {
    t,
    van,
    supervisor,
    operations,
    planned,
    actor,
    bootstrap,
    apply,
    balances,
    depot,
    movements,
  };
}

const byProduct = (rows: Doc<"inventoryBalances">[]) =>
  new Map(rows.map((row) => [row.productId as string, row]));

describe(
  "van-sales UAT day on the beta sample data",
  { timeout: 30_000 },
  () => {
    it("VUAT-E2E-01 sample van day: download, confirm load, start, record damage, approve codes, unload leftovers and close", async () => {
      const f = await sampleVanDay();

      // VUAT-SET-02 / VUAT-LOAD-01: the handheld downloads the planned trip, its
      // 10-line load sheet, the route's customers, prices and the approval keys.
      const morning = await f.bootstrap();
      expect(morning.trip).toMatchObject({
        tripId: f.planned.tripId,
        tripNumber: f.planned.tripNumber,
        status: "loading",
      });
      expect(morning.load?.status).toBe("planned");
      expect(morning.load?.lines).toHaveLength(10);
      // The complete priced catalog: every loaded product carries a price on
      // each price list the route's customers use (two sample lists today).
      const priceLines = morning.priceLines ?? [];
      const priceLists = new Set(priceLines.map((line) => line.priceListId));
      expect(priceLists.size).toBeGreaterThan(0);
      for (const listId of priceLists) {
        const priced = new Set(
          priceLines
            .filter((line) => line.priceListId === listId)
            .map((line) => line.productId),
        );
        for (const line of morning.load!.lines) {
          expect(priced.has(line.productId)).toBe(true);
        }
      }
      expect(morning.customers.length).toBeGreaterThan(0);
      expect(morning.policy.voidApproval.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(morning.policy.cashReconciliation).toMatchObject({
        toleranceMinor: "5000",
        key: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      });
      expect(morning.truckStock).toEqual([]);
      const depotBefore = byProduct(await f.balances(f.depot._id));

      // VUAT-LOAD-01: every line counted as expected posts one van_load at once.
      const load = morning.load!;
      const confirm = {
        tripId: f.planned.tripId,
        loadId: load.loadId,
        lines: load.lines.map((line) => ({
          lineNumber: line.lineNumber,
          actualBase: line.expectedBase,
        })),
      };
      const loaded = await f.apply("load.confirm", confirm, uuid(1));
      expect(loaded.ack.movementId).not.toBeNull();
      const truckId = morning.trip!.truckLocationId;
      const truck = byProduct(await f.balances(truckId));
      const depotAfterLoad = byProduct(await f.balances(f.depot._id));
      for (const line of load.lines) {
        const expected = BigInt(line.expectedBase);
        expect(truck.get(line.productId)).toMatchObject({
          availableStockBase: expected,
          physicalBase: expected,
        });
        expect(
          (depotBefore.get(line.productId)?.availableStockBase ?? 0n) -
            (depotAfterLoad.get(line.productId)?.availableStockBase ?? 0n),
        ).toBe(expected);
      }

      // VUAT-SYNC-02: the same operation sent again (lost acknowledgement) is the
      // same acknowledgement and moves no stock twice; a changed body is refused.
      expect(await f.apply("load.confirm", confirm, uuid(1))).toEqual(loaded);
      await expect(
        f.apply(
          "load.confirm",
          { ...confirm, lines: confirm.lines.slice(1) },
          uuid(1),
        ),
      ).rejects.toThrow(/conflict/);
      expect(await f.movements()).toHaveLength(1);

      // VUAT-LOAD-03: start the trip after the load is posted.
      const started = await f.apply(
        "trip.start",
        {
          tripId: f.planned.tripId,
          vehicleConfirmed: true,
          routeConfirmed: true,
          driverName: "Nonoy Pepito",
          odometerKm: 48210,
        },
        uuid(2),
      );
      expect(started.status).toBe("accepted");
      expect((await f.bootstrap()).trip?.status).toBe("active");

      // VUAT-DMG-01: one expired piece below the approval threshold needs no photo
      // and moves from sellable to damaged on the truck at once.
      const damaged = load.lines[0]!;
      const one = BigInt(damaged.quantityScale);
      const damage = { tripId: f.planned.tripId, productId: damaged.productId };
      const recorded = await f.apply(
        "truck.damage",
        { ...damage, quantityBase: String(one), reason: "expired" },
        uuid(3),
      );
      expect(recorded.ack.movementId).not.toBeNull();
      expect(
        await f.apply(
          "truck.damage",
          { ...damage, quantityBase: String(one), reason: "expired" },
          uuid(3),
        ),
      ).toEqual(recorded);
      // A visible-damage reason without an uploaded photo is refused, nothing moves.
      await expect(
        f.apply(
          "truck.damage",
          { ...damage, quantityBase: String(one), reason: "crushed" },
          uuid(4),
        ),
      ).rejects.toThrow(/photo_required/);
      const afterDamage = byProduct(await f.balances(truckId)).get(
        damaged.productId,
      )!;
      expect(afterDamage).toMatchObject({
        availableStockBase: BigInt(damaged.expectedBase) - one,
        damagedBase: one,
        physicalBase: BigInt(damaged.expectedBase),
      });
      const onPhone = (await f.bootstrap()).truckStock.find(
        (row) => row.productId === damaged.productId,
      );
      expect(onPhone).toEqual({
        productId: damaged.productId,
        availableBase: String(BigInt(damaged.expectedBase) - one),
        damagedBase: String(one),
      });

      // VUAT-VOID-01 / VUAT-CASH-02: the Cebu supervisor issues the codes the seller
      // types in; the seller can never approve their own void or cash count.
      const cash = {
        tripNumber: f.planned.tripNumber,
        expectedMinor: "1250000",
        declaredMinor: "1243000",
        reasonCode: "change_error",
      };
      await expect(
        f.van.mutation(api.van.cash.issueApprovalCode, cash),
      ).rejects.toThrow();
      const cashCode = await f.supervisor.mutation(
        api.van.cash.issueApprovalCode,
        cash,
      );
      expect(cashCode).toMatchObject({
        code: expect.stringMatching(/^\d{8}$/),
        varianceMinor: "-7000",
      });
      // Handheld receipt numbers are <trip number>-<device tag>-<sequence>.
      const voidArgs = {
        receiptNumber: `${f.planned.tripNumber}-1A2B3C4D-0001`,
        totalMinor: "45600",
        reasonCode: "wrong_quantity",
      };
      await expect(
        f.van.mutation(api.van.voids.issueApprovalCode, voidArgs),
      ).rejects.toThrow();
      expect(
        await f.supervisor.mutation(api.van.voids.issueApprovalCode, voidArgs),
      ).toMatchObject({ code: expect.stringMatching(/^\d{8}$/) });

      // VUAT-CLOSE-02: the office cannot close while the truck holds stock; the
      // warehouse takes the leftovers (sellable and damaged apart), then closes.
      await expect(
        f.operations.mutation(api.van.trips.close, {
          tripId: f.planned.tripId,
        }),
      ).rejects.toThrow(/still holds stock/);
      await expect(
        f.van.mutation(api.van.trips.returnLeftover, {
          tripId: f.planned.tripId,
          idempotencyKey: "evening",
        }),
      ).rejects.toThrow();
      const unloadId = await f.operations.mutation(
        api.van.trips.returnLeftover,
        {
          tripId: f.planned.tripId,
          idempotencyKey: "evening",
        },
      );
      expect(unloadId).not.toBeNull();
      await f.operations.mutation(api.van.trips.close, {
        tripId: f.planned.tripId,
      });
      for (const row of await f.balances(truckId))
        expect(row).toMatchObject({
          physicalBase: 0n,
          availableStockBase: 0n,
          damagedBase: 0n,
        });
      const depotAfterClose = byProduct(await f.balances(f.depot._id));
      for (const line of load.lines) {
        const before = depotBefore.get(line.productId)!;
        const after = depotAfterClose.get(line.productId)!;
        expect(after.physicalBase).toBe(before.physicalBase);
        const back = line.productId === damaged.productId ? one : 0n;
        expect((after.damagedBase ?? 0n) - (before.damagedBase ?? 0n)).toBe(
          back,
        );
      }
      // Ledger entries still add up to the balances on the truck and at the depot.
      const ledger = await f.t.run((ctx) =>
        ctx.db.query("inventoryLedgerEntries").collect(),
      );
      for (const locationId of [truckId, f.depot._id])
        for (const row of await f.balances(locationId))
          expect(
            ledger
              .filter(
                (entry) =>
                  entry.locationId === locationId &&
                  entry.productId === row.productId,
              )
              .reduce((sum, entry) => sum + entry.quantityDeltaBase, 0n),
          ).toBe(row.physicalBase);

      // The closed trip leaves the handheld; a late replay of the start is still the
      // same acknowledgement, and new work on the closed trip is refused.
      const evening = await f.bootstrap();
      expect(evening.trip).toBeNull();
      expect(
        await f.apply(
          "trip.start",
          {
            tripId: f.planned.tripId,
            vehicleConfirmed: true,
            routeConfirmed: true,
            driverName: "Nonoy Pepito",
            odometerKm: 48210,
          },
          uuid(2),
        ),
      ).toEqual(started);
      await expect(
        f.apply(
          "truck.damage",
          { ...damage, quantityBase: String(one), reason: "expired" },
          uuid(5),
        ),
      ).rejects.toThrow();
    });

    it("VUAT-E2E-02 sample load discrepancy waits for the Cebu supervisor and posts the counted quantities", async () => {
      const f = await sampleVanDay();
      const load = (await f.bootstrap()).load!;
      const short = load.lines[0]!;
      const counted = BigInt(short.expectedBase) - BigInt(short.quantityScale);
      const lines = load.lines.map((line) => ({
        lineNumber: line.lineNumber,
        actualBase: line.expectedBase,
      }));
      lines[0] = { lineNumber: short.lineNumber, actualBase: String(counted) };
      const payload = { tripId: f.planned.tripId, loadId: load.loadId, lines };
      // A changed line without a reason is refused and writes nothing.
      await expect(f.apply("load.confirm", payload, uuid(10))).rejects.toThrow(
        /invalid_request/,
      );
      lines[0] = { ...lines[0], reason: "short_loaded" } as (typeof lines)[0];
      const ack = await f.apply("load.confirm", payload, uuid(11));
      expect(ack.ack.movementId).toBeNull();
      const waiting = await f.bootstrap();
      expect(waiting.load?.status).toBe("discrepancy");
      expect(waiting.truckStock).toEqual([]);
      expect(await f.movements()).toEqual([]);
      // Not loaded yet, so the trip cannot start.
      await expect(
        f.apply(
          "trip.start",
          {
            tripId: f.planned.tripId,
            vehicleConfirmed: true,
            routeConfirmed: true,
          },
          uuid(12),
        ),
      ).rejects.toThrow(/load_not_posted/);
      // The seller cannot approve the load; the supervisor of the seller's area can.
      await expect(
        f.van.mutation(api.van.loads.approve, { tripId: f.planned.tripId }),
      ).rejects.toThrow();
      const movementId = await f.supervisor.mutation(api.van.loads.approve, {
        tripId: f.planned.tripId,
        note: "counted with the checker",
      });
      expect(movementId).not.toBeNull();
      const posted = await f.bootstrap();
      expect(posted.trip?.status).toBe("loaded");
      expect(
        posted.truckStock.find((row) => row.productId === short.productId),
      ).toMatchObject({ availableBase: String(counted), damagedBase: "0" });
    });
  },
);
