import { afterAll, beforeAll, expect, test } from "bun:test";
import { seedDemo } from "../../../packages/db/seed/index.js";
import { domainInstallers } from "../src/domains/index.js";
import { assertTruckStock, expectedStock } from "../src/domains/van/facts.js";
import { deviceCommand } from "../src/domains/org/devices.js";
import { actorFor } from "../src/core/context.js";
import { bind, deviceKey, nativeSignIn, startHarness } from "./harness.js";

/**
 * r6van4 (SP-0169 VAN-074/075/078/083/086): proofs on the real sample seed and the real API composition.
 * - The sample day's truck stock ledger agrees with the truck balance, so a stock count / trip close is not refused
 *   with "Canonical truck stock changed" (the seeded second load had no van_stock_events).
 * - The handheld bundle names truck stock the office will not let leave for a sale (a quarantined batch refused
 *   van sale SI-000000005 at upload after the phone had printed it).
 * - Pausing a phone answers "device_suspended" (This phone is paused) instead of ending the session.
 */
/** @type {import('./harness.js').Harness} */ let h;
const PASSWORD = "r6van4-proof-password";

beforeAll(async () => {
  h = await startHarness({ installers: domainInstallers });
  await seedDemo(h.db, { days: 7 });
}, 240_000);
afterAll(async () => {
  await h?.close();
});

test("every sample trip on the road: stock ledger matches its truck balance (stock count and close are not refused)", async () => {
  const trips =
    // The truck balance belongs to the trip on the road now; yesterday's unloaded trip on the same truck is not compared.
    await h.db`select distinct on (truck_location_id) * from van_trips where status in ('active','loaded','loading') and deleted_at is null
      order by truck_location_id, service_date desc`;
  expect(trips.length).toBeGreaterThan(0);
  /** @type {string[]} */ const refused = [];
  for (const trip of trips)
    try {
      await assertTruckStock(h.db, trip, await expectedStock(h.db, trip.id));
    } catch (e) {
      refused.push(`${trip.trip_number}: ${/** @type {any} */ (e).message}`);
    }
  expect(refused).toEqual([]);
});

test("the handheld bundle holds back a quarantined truck batch from selling", async () => {
  const [lot] =
    await h.db`select b.lot_id,b.product_id,b.available_base::text q,t.id trip_id from inventory_lot_balances b join van_trips t on t.truck_location_id=b.location_id
      where t.status not in ('closed','cancelled') and b.stock_status='available' and b.available_base>0 order by b.available_base desc limit 1`;
  expect(lot).toBeDefined();
  const { heldStock } = await import("../src/domains/van/projection.js");
  expect(typeof heldStock).toBe("function");
  const [trip] = await h.db`select * from van_trips where id=${lot.trip_id}`;
  const balances =
    await h.db`select * from inventory_balances where location_id=${trip.truck_location_id} and deleted_at is null`;
  const before = await /** @type {any} */ (heldStock)(h.db, trip, balances);
  expect(before.find((/** @type {any} */ x) => x.productId === lot.product_id)).toBeUndefined();
  await h.db`update inventory_lots set quality_status='quarantined' where id=${lot.lot_id}`;
  const after = await /** @type {any} */ (heldStock)(h.db, trip, balances);
  const held = after.find((/** @type {any} */ x) => x.productId === lot.product_id);
  expect(held).toBeDefined();
  expect(BigInt(/** @type {any} */ (held).quantityBase)).toBeGreaterThanOrEqual(BigInt(lot.q));
});

test("VAN-086: a paused phone is told it is paused (403 device_suspended), keeps its session and resumes when reinstated", async () => {
  const [van] =
    await h.db`select id,user_id,email from profiles where email='van@sunpride.test'`;
  expect(van).toBeDefined();
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });
  await h.db`update users set password_hash=${hash} where id=${van.user_id}`;
  await h.db`delete from registered_devices where profile_id=${van.id} and app='van-android'`;
  const phone = await deviceKey();
  const signIn = await nativeSignIn(h, van.email, PASSWORD, "van-android", {
    keyId: phone.keyId,
    publicKeySpki: phone.publicKeySpki,
  });
  expect(signIn.res.status).toBe(200);
  const [row] =
    await h.db`select id from registered_devices where profile_id=${van.id} and app='van-android'`;
  const bound = await bind(h, signIn.body.accessToken, row.id, phone);
  expect(bound.body.bindingStatus).toBe("bound");
  const refresh = () =>
    h.fetch("/api/auth/refresh", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${signIn.body.sessionToken}`,
      },
      body: JSON.stringify({
        version: 2,
        app: "van-android",
        deviceKeyId: phone.keyId,
        integrity: { rooted: false, tampered: false, source: "TEST fixture" },
      }),
    });
  expect((await refresh()).status).toBe(200);
  const [admin] =
    await h.db`select user_id from profiles where role='admin' and status='active' order by created_at limit 1`;
  const actor = await actorFor(h.db, admin.user_id);
  const ctx = { db: h.db, actor, now: Date.now() };
  await deviceCommand(/** @type {any} */ (ctx), "suspend", {
    deviceId: row.id,
    reason: "other",
  });
  // The phone's current access ends at once.
  const me = await h.fetch("/api/me", {
    headers: { authorization: `Bearer ${signIn.body.accessToken}` },
  });
  expect(me.status).toBe(401);
  const paused = await refresh();
  expect(paused.status).toBe(403);
  expect((/** @type {any} */ (await paused.json())).error.code).toBe(
    "device_suspended",
  );
  await deviceCommand(/** @type {any} */ (ctx), "reinstate", {
    deviceId: row.id,
    reason: "found",
  });
  expect((await refresh()).status).toBe(200);
});
