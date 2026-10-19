import { afterAll, beforeAll, expect, test } from "bun:test";
import { seedDemo } from "../../../packages/db/seed/index.js";
import { domainInstallers } from "../src/domains/index.js";
import { drainFieldOrders } from "../src/domains/orders/field-queue.js";
import { manilaDate } from "../src/domains/visits/shared.js";
import {
  startHarness,
  deviceKey,
  registerDevice,
  nativeSignIn,
  bind,
  signedPost,
} from "./harness.js";

/** No module mocks: real installers, ORG auth/scope/audit, pricing, visit,
 * call-sheet writer, order queue and analytics share one migrated database. */
/** @type {Awaited<ReturnType<typeof startHarness>>} */ let h;
/** @type {any} */ let agent;
/** @type {any} */ let who;
/** @type {any} */ let visit;
/** @type {any} */ let product;
let cookie = "";
const date = manilaDate(Date.now());
beforeAll(async () => {
  h = await startHarness({ installers: domainInstallers });
  await seedDemo(h.db, { anchorDate: date, days: 7 });
  const password = (
    await Bun.file(`${process.env.HOME}/.sunpride-keys/v2-test-password`).text()
  ).trim();
  const response = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@sunpride.test", password }),
  });
  expect(response.status).toBe(200);
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  [agent] =
    await h.db`select * from profiles where email='agent@sunpride.test'`;
  [visit] =
    await h.db`select * from visit_executions where assignee_profile_id=${agent.id} and service_date=${date} order by checked_in_at limit 1`;
  expect(visit).toBeDefined();
  // Arrange an open current call; seed is historical, this is a fresh test DB.
  await h.db`update visit_executions set state='completed',checked_out_at=coalesce(checked_out_at,now()) where assignee_profile_id=${agent.id} and state in ('checked-in','in-progress','arrived')`;
  await h.db`update visit_executions set state='in-progress',started_at=now()-interval '1 minute',checked_in_at=now()-interval '1 minute',checked_out_at=null where id=${visit.id}`;
  [product] =
    await h.db`select p.* from call_sheet_account_lines l join call_sheet_accounts a on a.id=l.call_sheet_account_id join products p on p.id=l.product_id where a.outlet_id=${visit.outlet_id} and l.deleted_at is null limit 1`;
  const { actorFor } = await import("../src/core/context.js");
  expect((await actorFor(h.db, agent.user_id))?.profileId).toBe(agent.id);
  const key = await deviceKey();
  const deviceId = await registerDevice(h, {
    profileId: agent.id,
    orgUnitId: agent.org_unit_id,
    key,
  });
  const tokens = await nativeSignIn(
    h,
    "agent@sunpride.test",
    password,
    "field-android",
    { keyId: key.keyId, publicKeySpki: key.publicKeySpki },
  );
  expect(tokens.res.status).toBe(200);
  const binding = await bind(h, tokens.body.accessToken, deviceId, key);
  expect(binding.body.bindingStatus, JSON.stringify(binding.body)).toBe(
    "bound",
  );
  who = { access: tokens.body.accessToken, deviceId, key };
}, 60000);
afterAll(async () => {
  await h?.close();
});
/** @param {string} path */
async function get(path) {
  const res = await h.fetch(path, { headers: { cookie } });
  const body = /** @type {any} */ (await res.json());
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body;
}
/** @param {any} activity */
async function push(activity) {
  const op = {
    clientOpId: crypto.randomUUID(),
    opType: "visit.activity",
    clientTime: Date.now(),
    dependsOn: [],
    payload: { visitId: visit.id, deviceTime: Date.now(), activity },
  };
  const request = {
    version: 2,
    app: "field-android",
    deviceId: who.deviceId,
    scopeId: agent.org_unit_id,
    operations: [op],
  };
  const first = await signedPost(h, who, "/api/sync/push", request);
  expect(first.res.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.results[0].status, JSON.stringify(first.body)).toBe(
    "applied",
  );
  const repeat = await signedPost(h, who, "/api/sync/push", request);
  expect(repeat.body.results[0].status).toBe("duplicate");
  expect(repeat.body.results[0].ack).toEqual(first.body.results[0].ack);
  return first.body.results[0].ack;
}
test("real visit.activity atomically creates Annex C entries and keeps replay exact", async () => {
  const before = Number(
    (
      await h.db`select count(*) n from call_sheet_entries where visit_id=${visit.id}`
    )[0].n,
  );
  await push({
    kind: "call_sheet",
    lines: [
      {
        productId: product.id,
        order: 1,
        beginningInventory: 2,
        take: null,
        delivered: null,
        offtake: null,
        endInventory: null,
      },
    ],
  });
  expect(
    Number(
      (
        await h.db`select count(*) n from call_sheet_entries where visit_id=${visit.id}`
      )[0].n,
    ),
  ).toBe(before + 1);
  const [entry] =
    await h.db`select * from call_sheet_entries where visit_id=${visit.id} order by server_time desc limit 1`;
  expect(entry.order_qty).toBe(1);
  expect(entry.beginning_inventory).toBe(2);
  expect(
    await h.db`select id from visit_activities where id=${entry.activity_id}`,
  ).toHaveLength(1);
});
test("real visit.activity queues and materializes exactly one governed order", async () => {
  const clientOrderId = crypto.randomUUID();
  await push({
    kind: "order_intent",
    clientOrderId,
    lines: [{ productId: product.id, uom: "PC", quantity: 1 }],
  });
  expect(
    h.app.scheduler.tasks.some((task) => task.name === "orders.field-capture"),
  ).toBe(true);
  await h.app.scheduler.runNow("orders.field-capture");
  expect(await drainFieldOrders({ db: h.db, publish: async () => {} })).toEqual(
    { captured: 0, review: 0 },
  );
  const rows =
    await h.db`select o.*,c.activity_id from field_order_captures c join orders o on o.id=c.order_id where c.client_order_id=${clientOrderId}`;
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].total)).toBeGreaterThan(0);
  expect(
    await h.db`select id from audit_logs where entity_id=${rows[0].id}`,
  ).not.toHaveLength(0);
});
test("canonical sample settlements populate vans, Today and actionable cash variance", async () => {
  const from = new Date(Date.parse(date + "T00:00:00Z") - 6 * 86400000)
    .toISOString()
    .slice(0, 10);
  const vans = await get(`/api/v1/analytics/vans?from=${from}&to=${date}`);
  const short = vans.rows.find(
    (/** @type {any} */ row) => row.variance === -125000,
  );
  expect(short).toBeDefined();
  expect(short.cashExpected - short.cashRemitted).toBe(125000);
  expect(short.soldCases).toBeGreaterThan(0);
  expect(short.returnedCases).toBeGreaterThan(0);
  expect(short.stockVarianceCases).toBe(0);
  const exceptions = await get(
    `/api/v1/analytics/exceptions?from=${from}&to=${date}&kind=cash_variance`,
  );
  expect(exceptions.counts.cash_variance).toBe(1);
  expect(exceptions.items[0].owner).not.toBeNull();
  expect(exceptions.items[0].action.href).toContain("/van-trips?tripId=");
  const today = await get(`/api/v1/analytics/today?date=${date}`);
  expect(today.vans).toHaveLength(2);
  expect(
    today.vans.every(
      (/** @type {any} */ v) =>
        v.status === "on_route" && v.cashExpected !== null,
    ),
  ).toBe(true);
});
test("seeded admin, supervisor and agent reconcile nonzero sales within successively smaller scope", async () => {
  const password = (
    await Bun.file(`${process.env.HOME}/.sunpride-keys/v2-test-password`).text()
  ).trim();
  const totals = [];
  for (const account of ["admin", "supervisor", "agent"]) {
    const response = await h.fetch("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${account}@sunpride.test`, password }),
    });
    expect(response.status).toBe(200);
    const scopedCookie =
      response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const [today, sales] = await Promise.all(
      ["today?date=" + date, `sales?from=${date}&to=${date}&groupBy=agent`].map(
        async (path) => {
          const r = await h.fetch("/api/v1/analytics/" + path, {
            headers: { cookie: scopedCookie },
          });
          expect(r.status).toBe(200);
          return /** @type {any} */ (await r.json());
        },
      ),
    );
    const total = today.kpis.find(
      (/** @type {any} */ k) => k.key === "salesToday",
    ).value;
    expect(total).toBeGreaterThan(0);
    expect(
      sales.rows.reduce(
        (/** @type {number} */ n, /** @type {any} */ row) => n + row.sales,
        0,
      ),
    ).toBe(total);
    totals.push(total);
  }
  expect(totals[0]).toBeGreaterThan(totals[1]);
  expect(totals[1]).toBeGreaterThan(totals[2]);
});
test("store drill matches the actual web contract with readable history and exact quantity display", async () => {
  const stores = await get(
    `/api/v1/analytics/stores?from=${date.slice(0, 7)}-01&to=${date}&limit=200`,
  );
  const store = stores.rows.find(
    (/** @type {any} */ row) => row.salesPeriod > 0,
  );
  const detail = await get(
    `/api/v1/analytics/store?storeId=${store.storeId}&from=${date.slice(0, 7)}-01&to=${date}`,
  );
  expect(detail.store.storeId).toBe(store.storeId);
  expect(detail.salesTrend).toHaveLength(12);
  expect(detail.orders.length).toBeGreaterThan(0);
  for (const order of detail.orders) {
    expect(order.number).toBeTruthy();
    expect(order.lines).toBeGreaterThan(0);
  }
  for (const visit of detail.visits) {
    expect(visit.agent).toBeTruthy();
    expect(visit.outcome).toBeTruthy();
  }
  for (const suggestion of detail.suggestedOrder)
    expect(suggestion.quantityDisplay).toMatch(/cases|pieces|unavailable/);
});
test("canonical target rows use the exact four levels and centavos", async () => {
  const month = date.slice(0, 7);
  const company = await get(`/api/v1/targets?month=${month}&level=company`);
  expect(company.total).toBeGreaterThan(0);
  const [target] =
    await h.db`select * from sales_targets where month=${month} and level='company'`;
  expect(target.subject_kind).toBe("company");
  expect(target.team_id).toBeNull();
  expect(company.total).toBe(Number(target.amount_centavos));
});
