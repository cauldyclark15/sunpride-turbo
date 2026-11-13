import { afterAll, beforeAll, expect, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import { seedDemo } from "../../../packages/db/seed/index.js";
import { domainInstallers } from "../src/domains/index.js";
import { cashExpectation, expectedStock } from "../src/domains/van/facts.js";
import { applyOperation } from "../src/domains/van/operations.js";
import { decideDamage } from "../src/domains/van/commands.js";
import { stockCountCode } from "../src/domains/van/approvals.js";
import { OpRejected } from "../src/core/sync.js";
import { actorFor } from "../src/core/context.js";
import { bind, deviceKey, nativeSignIn, startHarness } from "./harness.js";

/**
 * r6van6 VAN-079 (SP-0169): the end-of-day counts of a normal trip that had a damage report.
 * Lane trip SMP-TRIP-2026-11-13-0: the seller recorded 12 PC crushed (over the limit, so it waited for a supervisor),
 * counted the cash while it waited, and the office refused that cash count for good ("Decide pending damage before
 * counting", evidence_pending_review) although the cash matched to the centavo. The supervisor then REJECTED the
 * damage (12 PC back to sellable), and the phone counted the stock against its last download (sellable 186 instead of
 * the office's 198): stock_conflict "Expected stock changed or count is incomplete".
 * Now: cash does not wait for damage decisions; the stock count waits (temporary, sent again) while one is pending;
 * a count made against stock the office has since changed is still refused (the phone says why and lets the seller
 * count again) and a fresh count is accepted.
 */
/** @type {import('./harness.js').Harness} */ let h;
/** @type {any} */ let trip;
/** @type {any} */ let seller;
/** @type {any} */ let boss;
/** @type {string} */ let deviceId;

beforeAll(async () => {
  h = await startHarness({ installers: domainInstallers });
  await seedDemo(h.db, { days: 7 });
  const [van] =
    await h.db`select id,user_id,email from profiles where email='van@sunpride.test'`;
  const password = "r6van6-proof-password";
  await h.db`update users set password_hash=${await Bun.password.hash(password, { algorithm: "argon2id" })} where id=${van.user_id}`;
  await h.db`delete from registered_devices where profile_id=${van.id} and app='van-android'`;
  const phone = await deviceKey();
  const signIn = await nativeSignIn(h, van.email, password, "van-android", {
    keyId: phone.keyId,
    publicKeySpki: phone.publicKeySpki,
  });
  expect(signIn.res.status).toBe(200);
  const [row] =
    await h.db`select id from registered_devices where profile_id=${van.id} and app='van-android'`;
  deviceId = row.id;
  expect((await bind(h, signIn.body.accessToken, row.id, phone)).body.bindingStatus).toBe("bound");
  [trip] =
    await h.db`select * from van_trips where salesperson_profile_id=${van.id} and status='active' and deleted_at is null order by service_date desc limit 1`;
  expect(trip).toBeDefined();
  await h.db`update van_trips set started_device_id=null where id=${trip.id}`;
  seller = await actorFor(h.db, van.user_id);
  const [manager] =
    await h.db`select user_id from profiles where email='manager@sunpride.test'`;
  boss = await actorFor(h.db, manager.user_id);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

/** Applies one phone operation the way sync push does; answers its result. @param {string} opType @param {any} payload */
async function send(opType, payload) {
  const now = Date.now();
  const op = { opType, clientOpId: crypto.randomUUID(), clientTime: now, payload: { ...payload, deviceTime: now }, dependsOn: [] };
  try {
    const ack = await tx(h.db, (/** @type {any} */ db) =>
      applyOperation(
        {
          db,
          actor: seller,
          device: { id: deviceId },
          op,
          payload: op.payload,
          now,
          change: async () => {},
          publish() {},
          enqueue: async () => {},
          reject: (/** @type {string} */ code) => {
            throw new OpRejected(code);
          },
        },
        {},
      ),
    );
    return { status: "applied", ack };
  } catch (e) {
    if (e instanceof OpRejected) return { status: "rejected", code: e.code, retryable: e.retryable === true };
    throw e;
  }
}

/** The phone's stock count over the lines it shows (no difference). @param {any[]} lines */
function stockCount(lines) {
  const id = crypto.randomUUID();
  const input = lines.map((e) => ({
    productId: e.productId,
    status: e.status,
    expectedBase: String(e.expectedBase),
    countedBase: String(e.expectedBase),
    varianceBase: "0",
    reasonCode: "",
  }));
  return {
    tripId: trip.id,
    reconciliationId: id,
    countCode: stockCountCode(trip.id, id, input),
    varianceLines: 0,
    shortBase: "0",
    overBase: "0",
    lines: input,
    approval: { method: "none" },
    lotLines: [],
  };
}

/** Denominations for an exact amount. @param {bigint} minor */
function cashCount(minor) {
  const counts = [];
  let left = minor;
  for (const d of [100000n, 50000n, 20000n, 10000n, 5000n, 2000n, 1000n, 500n, 100n, 25n, 10n, 5n, 1n]) {
    const n = left / d;
    if (n > 0n) counts.push({ denominationMinor: String(d), count: String(n) });
    left -= n * d;
  }
  return {
    tripId: trip.id,
    reconciliationId: crypto.randomUUID(),
    currency: "PHP",
    expectedMinor: String(minor),
    declaredMinor: String(minor),
    varianceMinor: "0",
    counts,
    cashSales: 0,
    voidedSales: 0,
    otherPayments: [],
    approval: { method: "none" },
  };
}

test("VAN-079: a trip with a damage report waiting, then rejected, counts its cash and stock cleanly", async () => {
  const before = await expectedStock(h.db, trip.id);
  const line = before
    .filter((e) => e.status === "available")
    .sort((a, b) => Number(b.expectedBase - a.expectedBase))[0];
  expect(line.expectedBase).toBeGreaterThan(12n);
  // Damage over the limit (12 PC crushed, with its photo) waits for a supervisor.
  const digest = "d".repeat(64);
  await h.db`insert into files(id,owner_id,purpose,sha256,mime,size,device_id,created_by,status,path,stored_at,created_at)
    values(${crypto.randomUUID()},${trip.id},'truck-damage',${digest},'image/jpeg',100,${deviceId},${seller.userId},'stored','fixture.jpg',now(),greatest(now(),${trip.created_at}::timestamptz))`;
  const damage = await send("truck.damage", {
    tripId: trip.id,
    productId: line.productId,
    quantityBase: "12",
    reason: "crushed",
    photoSha256: digest,
  });
  expect(damage.status).toBe("applied");
  const [record] =
    await h.db`select status from van_damage_records where id=${damage.ack.entityId}`;
  expect(record.status).toBe("pending_approval");

  // The cash count does not depend on the damage decision: accepted at once (was refused for good).
  const cash = await send("cash.reconcile", cashCount(await cashExpectation(h.db, trip.id)));
  expect(cash).toMatchObject({ status: "applied" });

  // The phone's last download: sellable already 12 lower while the damage waits.
  const phoneView = await expectedStock(h.db, trip.id);
  // While the damage waits, the stock count waits too (temporary: the phone keeps it and sends it again).
  expect(await send("stock.reconcile", stockCount(phoneView))).toEqual({
    status: "rejected",
    code: "evidence_pending_review",
    retryable: true,
  });

  // The supervisor rejects the damage after the cash is counted (was refused: "The trip is counted").
  await tx(h.db, (/** @type {any} */ db) =>
    decideDamage(db, boss, { damageId: damage.ack.entityId, decision: "reject", note: "Sealed case, sell it" }),
  );
  const office = await expectedStock(h.db, trip.id);
  expect(office.find((e) => e.productId === line.productId && e.status === "available")?.expectedBase).toBe(
    line.expectedBase,
  );
  // A count against the phone's old view is refused with stock_conflict (the phone then says why and recounts)...
  expect(await send("stock.reconcile", stockCount(phoneView))).toMatchObject({
    status: "rejected",
    code: "stock_conflict",
    retryable: false,
  });
  // ...and the count over the office's current stock is accepted.
  const fresh = await send("stock.reconcile", stockCount(office));
  expect(fresh.status).toBe("applied");
  const [counts] =
    await h.db`select (select count(*) from van_cash_counts where trip_id=${trip.id})::int as cash, (select count(*) from van_stock_counts where trip_id=${trip.id})::int as stock`;
  expect(counts).toEqual({ cash: 1, stock: 1 });
}, 120_000);
