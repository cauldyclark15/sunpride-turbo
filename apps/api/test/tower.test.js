import { beforeAll, afterAll, test, expect } from "bun:test";
import { startHarness } from "./harness.js";
import { analyticsFixture } from "./analytics-fixture.js";
import { install } from "../src/domains/analytics/index.js";
import { rebuildSalesCache } from "../src/domains/analytics/read-model.js";
import { visitSummary } from "../src/domains/analytics/data.js";
/** @type {any} */ let h;
/** @type {any} */ let f;
beforeAll(async () => { h = await startHarness({ installers:[install] }); f = await analyticsFixture(h); });
afterAll(async () => { await h?.close(); });

test("F-601 two outlets sharing an accounting customer retain explicit source identity across live, cache, sales and Outlet 360", async () => {
  const [other] = await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values('fixture','SHARED','Shared account second store','active',${f.a},'GT','fixture') returning id`;
  const [customer] = await h.db`select id from customers where code='C0'`;
  await h.db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason) values(${other.id},${customer.id},'fixture','2020-01-01','fixture','fixture')`;
  const [order] = await h.db`select id from orders where customer_code='C0' order by created_at desc limit 1`;
  await h.db`update orders set outlet_id=${other.id} where id=${order.id}`;
  const facts = await h.db`select store_id from analytics_sales_facts where order_id=${order.id}`;
  expect(facts).toHaveLength(2); expect(facts.every((/** @type {any} */ r) => r.store_id === other.id)).toBe(true);
  const unassigned = await h.db`select store_id from analytics_sales_facts where customer_code='C0' and order_id<>${order.id}`;
  expect(unassigned.every((/** @type {any} */ r) => r.store_id === null)).toBe(true);
  for (const mode of ['live','cache']) {
    if(mode==='cache') await rebuildSalesCache(h.db,f.start,f.today);
    const r = await f.get(`/api/v1/analytics/sales?from=${f.start}&to=${f.today}&groupBy=store`); expect(r.status).toBe(200);
    const body = await r.json(); expect(body.rows.find((/** @type {any} */ r)=>r.key===other.id).sales).toBe(10636);
    const store = await (await f.get(`/api/v1/analytics/store?storeId=${other.id}&from=${f.start}&to=${f.today}`)).json();
    expect(store.kpis.find((/** @type {any} */ k)=>k.key==='salesPeriod').value).toBe(10636);
  }
  await h.db`update outlets set custodian_org_unit_id=${f.b} where id=${other.id}`;
  const scoped = await (await f.get(`/api/v1/analytics/sales?from=${f.start}&to=${f.today}&groupBy=store&unitId=${f.a}`)).json();
  expect(scoped.rows.some((/** @type {any} */ r)=>r.key===other.id)).toBe(false);
});

test("F-605 merchandising and collection are productive without an order; strike, dwell and market span are distinct", () => {
  /** @param {number} n @param {string} start @param {string} end @param {number} orders @param {boolean} productive @param {boolean} [onPlan] */
  const v=(n,start,end,orders,productive,onPlan=true)=>({id:n,assignee_profile_id:'a',service_date:'2026-10-20',planned_visit_id:n,started_at:`2026-10-20T${start}:00+08:00`,ended_at:`2026-10-20T${end}:00+08:00`,closed:true,call:onPlan,onPlan,productive,accepted_orders:orders,accepted_lines:orders*2});
  const summary = visitSummary({planned:[{id:1},{id:2}],visits:[v(1,'09:00','09:10',0,true),v(2,'10:00','10:20',0,true),v(3,'11:00','11:30',1,false,false)],coaching:[]});
  expect(summary.productivePct).toBe(100); expect(summary.strikeRate).toBe(33.3);
  expect(summary.dwellMin).toBe(60); expect(summary.time).toBe(150); expect(summary.offPlan).toBe(1);
  expect(visitSummary({planned:[],visits:[],coaching:[]}).strikeRate).toBeNull();
});

test("F-605 only accepted call-linked orders convert a completed call", async () => {
  const before = await (await f.get(`/api/v1/analytics/coverage?from=${f.today}&to=${f.today}`)).json();
  expect(before.kpis.find((/** @type {any} */ k)=>k.key==='strikeRate').value).toBe(0);
  const [act] = await h.db`select id from visit_activities where visit_id=${f.visit} limit 1`;
  const [order] = await h.db`select id from orders where customer_code='C0' order by created_at desc limit 1`;
  await h.db`update orders set outlet_id=${f.store},source_activity_id=${act.id},status='approved' where id=${order.id}`;
  const after = await (await f.get(`/api/v1/analytics/coverage?from=${f.today}&to=${f.today}`)).json();
  expect(after.kpis.find((/** @type {any} */ k)=>k.key==='strikeRate').value).toBe(100);
  expect(after.rows.find((/** @type {any} */ r)=>r.key===f.agent).dwellMin).toBe(30);
  await h.db`update orders set status='rejected' where id=${order.id}`;
  const rejected = await (await f.get(`/api/v1/analytics/coverage?from=${f.today}&to=${f.today}`)).json();
  expect(rejected.kpis.find((/** @type {any} */ k)=>k.key==='strikeRate').value).toBe(0);
});
