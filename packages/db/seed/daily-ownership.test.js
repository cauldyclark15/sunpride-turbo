import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { createDb, tx } from "../src/client.js";
import { migrate } from "../src/migrate.js";
import { seedDemo } from "./index.js";
import { advanceDemo, guardBalances } from "./daily.js";
import { at, BATCH, ident, rowId } from "./store.js";

/** @type {import('../src/client.js').Db} */ let db;
/** @type {import('../src/client.js').Db} */ let admin;
let database = "";
/** @type {any} */ let source;
/** @type {any} */ let foreignBefore;
const foreignLot = crypto.randomUUID();
const foreignBalance = crypto.randomUUID();
const day = "2026-10-20";
beforeAll(async () => {
  setSystemTime(new Date(at(day, 720)));
  const base = (
    await Bun.file(`${process.env.HOME}/.sunpride-keys/pg-lane-core-url`).text()
  ).trim();
  const u = new URL(base);
  admin = createDb(base, { max: 1 });
  database = `sunpride_lane_core_guard_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.unsafe(`create database ${ident(database)}`);
  u.pathname = `/${database}`;
  db = createDb(u.toString(), { max: 1 });
  await migrate(db);
  await seedDemo(db, { days: 3, anchorDate: "2026-10-19" });
  [source] =
    await db`select b.product_id,b.lot_id,b.location_id from inventory_lot_balances b where b.location_id=${rowId("inventory_locations", "depot")} and b.available_base>0 order by b.product_id,b.lot_id limit 1`;
  if (!source) throw new Error("Sample stock fixture is missing");
  // A separate tester-owned lot row: no ownership marker is invented. Zero stock
  // keeps the canonical ledger reconciled while reproducing the live false positive.
  await db`insert into inventory_lots(id,organization_id,product_id,lot_number,normalized_lot_number,source_type,received_at,expires_at,quality_status,unit_cost_minor) values(${foreignLot},'sunpride',${source.product_id},'TESTER-RETAINED','TESTER-RETAINED','tester',now(),now()+interval '1 year','released',1)`;
  await db`insert into inventory_lot_balances(id,organization_id,product_id,lot_id,location_id,stock_status,physical_base,reserved_base,available_base,expiry_sort_key,receipt_sequence,version) values(${foreignBalance},'sunpride',${source.product_id},${foreignLot},${source.location_id},'available',0,0,0,9999999999999,999999,1)`;
  [foreignBefore] =
    await db`select * from inventory_lot_balances where id=${foreignBalance}`;
}, 120000);

afterAll(async () => {
  try {
    await db?.close();
    if (database && admin)
      await admin.unsafe(`drop database ${ident(database)} with (force)`);
    await admin?.close();
  } finally {
    setSystemTime();
  }
}, 120000);

const line = () => ({
  productId: source.product_id,
  fromLocationId: source.location_id,
  toLocationId: null,
  quantityBase: 1,
  uom: "PC",
  lotId: source.lot_id,
  stockStatus: "available",
});

test("F-025 unrelated tester lot cannot block an explicit sample lot, but its exact key stays protected", async () => {
  await guardBalances(db, [line()]);
  await expect(
    guardBalances(db, [{ ...line(), lotId: foreignLot }]),
  ).rejects.toThrow("Demo refused to change non-sample stock");
  await expect(guardBalances(db, [{ ...line(), lotId: null }])).rejects.toThrow(
    "Demo refused to change non-sample stock",
  );
  expect(
    (
      await db`select * from inventory_lot_balances where id=${foreignBalance}`
    )[0],
  ).toEqual(foreignBefore);
});

test("F-025 a non-sample aggregate balance remains forbidden even when the explicit lot is owned", async () => {
  await expect(
    tx(db, async (t) => {
      const [balance] =
        await t`select id from inventory_balances where product_id=${source.product_id} and location_id=${source.location_id}`;
      const removed =
        await t`delete from sample_data_rows where batch=${BATCH} and table_name='inventory_balances' and row_id=${balance.id} returning id`;
      expect(removed).toHaveLength(1);
      await guardBalances(t, [line()]);
    }),
  ).rejects.toThrow("Demo refused to change non-sample stock");
});

test("F-025 public daily close/advance preserves unrelated tester stock and replays exactly once", async () => {
  const first = await advanceDemo(db, { date: day });
  expect(first.advanced).toBe(1);
  const [after] =
    await db`select * from inventory_lot_balances where id=${foreignBalance}`;
  expect(after).toEqual(foreignBefore);
  expect(
    await db`select id from sample_data_rows where table_name='inventory_lot_balances' and row_id=${foreignBalance}`,
  ).toHaveLength(0);
  const [closed] =
    await db`select count(*)::int n from van_trips where service_date<'2026-10-20' and status='closed'`;
  expect(closed.n).toBeGreaterThan(0);
  const [control] = await db`select count(*)::int n from inventory_movements`;
  expect((await advanceDemo(db, { date: day })).advanced).toBe(0);
  expect(
    (await db`select count(*)::int n from inventory_movements`)[0],
  ).toEqual(control);
  expect(
    (
      await db`select * from inventory_lot_balances where id=${foreignBalance}`
    )[0],
  ).toEqual(foreignBefore);
}, 30000);
