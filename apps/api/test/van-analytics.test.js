import { beforeAll, afterAll, test, expect } from "bun:test";
import { startHarness } from "./harness.js";
import { analyticsFixture } from "./analytics-fixture.js";
import { install } from "../src/domains/analytics/index.js";
import { rebuildSalesCache } from "../src/domains/analytics/read-model.js";

/** Canonical VAN rows, real Postgres and real analytics HTTP. No demo reset or live DB. */
/** @type {any} */ let h;
/** @type {any} */ let f;
/** @type {any} */ let trip;
/** @type {any} */ let product;
/** @type {any} */ let location;
/** @type {any} */ let cashSale;
/** @type {any} */ let creditSale;
/** @type {any} */ let before;
const id = () => crypto.randomUUID();
/** @param {any} body @param {string} key */
const value = (body, key) =>
  body.kpis.find((/** @type {any} */ k) => k.key === key).value;
/** @param {string} name @param {string} [unit] */
async function page(name, unit = "") {
  const res = await f.get(
    `/api/v1/analytics/${name}?date=${f.today}&from=${f.today}&to=${f.today}${unit ? `&unitId=${unit}` : ""}`,
  );
  const body = /** @type {any} */ (await res.json());
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body;
}
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  f = await analyticsFixture(h, 1);
  before = { today: await page("today"), money: await page("money") };
  const db = h.db;
  [product] = await db`select id from products where code='P1'`;
  [location] =
    await db`insert into inventory_locations(organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production)
    values('fixture',${f.a},'A','VAN-PROOF','Van proof','truck',true,true,true,true,false) returning id`;
  const [vehicle] =
    await db`insert into vehicles(organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by)
    values('fixture',${f.a},'VAN-PROOF','TEST',${location.id},${location.id},'active','fixture') returning id`;
  [trip] =
    await db`insert into van_trips(organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,created_by)
    values('fixture',${f.a},'VAN-PROOF',${vehicle.id},${location.id},${location.id},${f.today},${f.agent},'agent-0','active','fixture') returning id`;
  // Cache is already valid before native facts appear: no queued refresh is needed for visibility.
  await rebuildSalesCache(db, f.today, f.today);
}, 120000);
afterAll(async () => {
  await h?.close();
});
/** @param {number} amount @param {string} method */
async function sale(amount, method) {
  const saleId = id(),
    receipt = { payment: { kind: method, method, dueDate: f.today } };
  await h.db`insert into van_sales(id,trip_id,receipt_number,outlet_id,customer_code,total_centavos,receipt,captured_request)
    values(${saleId},${trip.id},${saleId},${f.store},'C0',${String(amount)},${receipt},${{}})`;
  await h.db`insert into van_sale_lines(sale_id,ordinal,product_id,quantity_base,total_centavos,facts)
    values(${saleId},1,${product.id},1,${String(amount)},${{ name: "Frozen van product", quantityScale: "1", caseBase: "24" }})`;
  await h.db`insert into van_payments(id,trip_id,sale_id,kind,method,amount_centavos,facts)
    values(${id()},${trip.id},${saleId},'sale',${method},${String(amount)},${{}})`;
  return saleId;
}
test("cash and credit appear once on Today, drill-down and Money even with valid order tiles", async () => {
  cashSale = await sale(10025, "cash");
  creditSale = await sale(20123, "credit");
  const today = await page("today"),
    money = await page("money"),
    vans = await page("vans");
  expect(value(today, "salesToday") - value(before.today, "salesToday")).toBe(
    30148,
  );
  expect(
    value(money, "collectionsToday") - value(before.money, "collectionsToday"),
  ).toBe(10025);
  expect(value(money, "arTotal")).toBe(20123);
  expect(
    vans.rows.find((/** @type {any} */ r) => r.tripId === trip.id)
      .salesCentavos,
  ).toBe(30148);
  const sales = await page("sales");
  expect(value(sales, "sales")).toBe(value(today, "salesToday"));
  expect(
    sales.rows.reduce(
      (/** @type {number} */ sum, /** @type {any} */ r) => sum + r.sales,
      0,
    ),
  ).toBe(value(sales, "sales"));
  expect((await page("today")).kpis).toEqual(today.kpis);
}, 30000);
test("a stock-only linked return is visible without inventing a cash refund", async () => {
  const returned = id();
  await h.db`insert into van_returns(id,trip_id,sale_id,return_number,captured_request) values(${returned},${trip.id},${cashSale},${returned},${{}})`;
  await h.db`insert into van_stock_events(trip_id,source_id,kind,product_id,stock_status,delta_base,facts)
    values(${trip.id},${returned},'return',${product.id},'damaged',1,${{ caseBase: "24" }})`;
  expect(
    value(await page("today"), "salesToday") -
      value(before.today, "salesToday"),
  ).toBe(30148);
  expect(
    value(await page("money"), "collectionsToday") -
      value(before.money, "collectionsToday"),
  ).toBe(10025);
  expect(
    (await page("vans")).rows.find(
      (/** @type {any} */ r) => r.tripId === trip.id,
    ).customerReturnedCases,
  ).toBeCloseTo(1 / 24);
});
test("void removes sale value and reverses collection, never double counts cashier hand-in", async () => {
  const [approval] =
    await h.db`insert into van_approval_codes(trip_id,kind,facts_hash,facts,issuer_profile_id,issuer_name)
    values(${trip.id},'void','test',${{}},${f.boss},'Owner') returning id`;
  await h.db`insert into van_sale_voids(sale_id,trip_id,reason,approval_id) values(${cashSale},${trip.id},'wrong_items',${approval.id})`;
  await h.db`insert into van_payments(id,trip_id,sale_id,kind,method,amount_centavos,facts)
    values(${id()},${trip.id},${cashSale},'void_refund','cash','10025',${{}})`;
  expect(
    value(await page("today"), "salesToday") -
      value(before.today, "salesToday"),
  ).toBe(20123);
  expect(value(await page("money"), "collectionsToday")).toBe(
    value(before.money, "collectionsToday"),
  );
  expect(
    (await page("vans")).rows.find(
      (/** @type {any} */ r) => r.tripId === trip.id,
    ).voids,
  ).toBe(1);
});
test("native collection reduces its own credit invoice, not unrelated office debt", async () => {
  await h.db`insert into van_payments(id,trip_id,sale_id,kind,method,amount_centavos,facts)
    values(${id()},${trip.id},${creditSale},'collection','cash','123',${{}})`;
  const money = await page("money");
  expect(value(money, "arTotal")).toBe(20000);
  expect(
    value(money, "collectionsToday") - value(before.money, "collectionsToday"),
  ).toBe(123);
  expect(
    money.rows.find((/** @type {any} */ r) => r.code === "C0").balance,
  ).toBe(20000);
});
test("current store owner and stored truck and trip scope gate every native fact", async () => {
  await h.db`update inventory_locations set org_unit_id=${f.b} where id=${location.id}`;
  const scoped = await page("today", f.a),
    money = await page("money", f.a);
  const baseline = await f.get(
    `/api/v1/analytics/sales?from=${f.today}&to=${f.today}&unitId=${f.a}`,
  );
  const sales = /** @type {any} */ (await baseline.json());
  expect(value(scoped, "salesToday")).toBe(value(sales, "sales"));
  expect(money.rows.some((/** @type {any} */ r) => r.code === "C0")).toBe(
    false,
  );
  await h.db`update inventory_locations set org_unit_id=${f.a} where id=${location.id}`;
  await h.db`update territory_ownerships set org_unit_id=${f.b} where territory_id=(select territory_id from outlet_assignments where outlet_id=${f.store} limit 1)`;
  expect(
    (await page("money", f.a)).rows.some(
      (/** @type {any} */ r) => r.code === "C0",
    ),
  ).toBe(false);
});
