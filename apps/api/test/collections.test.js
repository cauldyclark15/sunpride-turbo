import { test, expect, beforeAll, afterAll } from "bun:test";
import { startHarness } from "./harness.js";
import { analyticsFixture } from "./analytics-fixture.js";
import { sha256Hex } from "../src/core/util.js";
import { addDays } from "../src/domains/analytics/measures.js";
const { installCollections } =
  await import("../src/domains/coverage/collections.js");

/** @type {any} */ let h;
/** @type {any} */ let f;
/** @type {string} */ let managerB;
/** @type {string} */ let c1;
/** @type {string} */ let c2;
beforeAll(async () => {
  h = await startHarness({
    installers: [(/** @type {any} */ router) => installCollections(router)],
  });
  f = await analyticsFixture(h);
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${f.boss},${f.root},'super_admin','2020-01-01','fixture','fixture')`;
  const [u] =
    await h.db`insert into users(email,password_hash) values('manager-b@example.com','not-a-password-hash') returning id`;
  const [p] =
    await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id) values(${u.id},${u.id},'Manager B','manager-b@example.com','manager','active',${f.b}) returning id`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${f.b},'manager','2020-01-01','fixture','fixture')`;
  await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${u.id},${sha256Hex("sps_manager_b")},'web',now()+interval '1 day')`;
  managerB = "sp_session=sps_manager_b";
  // Team A customers of Store 1 and Store 5 (both owned by Team A in the fixture).
  [{ customer_code: c1 }] =
    await h.db`select customer_code from analytics_store_scope where name='Store 1'`;
  [{ customer_code: c2 }] =
    await h.db`select customer_code from analytics_store_scope where name='Store 5'`;
  /** @param {string} code @param {any} d */
  const ar = (code, d) =>
    h.db`insert into admin_pack_records(organization_id,org_unit_id,period,source,code,kind,details) values('fixture',${f.a},${f.today.slice(0, 7)},'sample',${"AR-" + code},'ar_balance',${{ kind: "ar_balance", customerCode: code, asOfDate: addDays(f.today, -1), termsDays: 30, ...d }})`;
  await ar(c1, {
    currentMinor: 50_000,
    days1to30Minor: 30_000,
    days31to60Minor: 0,
    days61to90Minor: 0,
    over90Minor: 0,
    invoices: [
      {
        orderId: "INV-1",
        invoiceDate: "2026-09-01",
        dueDate: "2026-10-01",
        amountMinor: 30_000,
        remainingMinor: 30_000,
      },
      {
        orderId: "INV-2",
        invoiceDate: "2026-10-10",
        dueDate: "2026-11-09",
        amountMinor: 60_000,
        remainingMinor: 50_000,
      },
      {
        orderId: "INV-0",
        invoiceDate: "2026-08-01",
        dueDate: "2026-08-31",
        amountMinor: 10_000,
        remainingMinor: 0,
      },
    ],
  });
  await ar(c2, {
    currentMinor: 0,
    days1to30Minor: 0,
    days31to60Minor: 0,
    days61to90Minor: 70_000,
    over90Minor: 5_000,
    invoices: [],
  });
}, 120000);
afterAll(async () => {
  await h?.close();
});
/** @param {string} path @param {any} [body] @param {string} [cookie] */
async function call(path, body, cookie = f.cookie) {
  const r = await h.fetch(path, {
    method: body ? "POST" : "GET",
    headers: { cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: /** @type {any} */ (await r.json()) };
}

test("F-613 promise-to-pay is bounded by the sample AR open items, scoped, idempotent and settled once", async () => {
  const promise = {
    customerCode: c1,
    amountMinor: 30_000,
    promisedOn: addDays(f.today, 2),
    openItemRef: "INV-1",
    note: "TEST owner promised to pay the September invoice",
    idempotencyKey: "p1",
  };
  for (const bad of [
    { ...promise, amountMinor: 30_001, idempotencyKey: "b1" },
    { ...promise, openItemRef: "INV-0", idempotencyKey: "b2" },
    { ...promise, promisedOn: addDays(f.today, -1), idempotencyKey: "b3" },
    { ...promise, promisedOn: addDays(f.today, 61), idempotencyKey: "b4" },
  ])
    expect((await call("/api/v1/money/collections/promise", bad)).status).toBe(
      400,
    );
  expect(
    (
      await call(
        "/api/v1/money/collections/promise",
        { ...promise, idempotencyKey: "x" },
        managerB,
      )
    ).status,
  ).toBe(403);
  const made = await call("/api/v1/money/collections/promise", promise);
  expect(made.status).toBe(200);
  expect(
    (await call("/api/v1/money/collections/promise", promise)).body.id,
  ).toBe(made.body.id);
  expect(
    (
      await call("/api/v1/money/collections/promise", {
        ...promise,
        note: "changed",
      })
    ).status,
  ).toBe(409);
  // Open promises cannot exceed the customer's whole open balance (80,000).
  expect(
    (
      await call("/api/v1/money/collections/promise", {
        customerCode: c1,
        amountMinor: 50_001,
        promisedOn: addDays(f.today, 3),
        note: "TEST too much",
        idempotencyKey: "p2",
      })
    ).status,
  ).toBe(400);
  const read = await call("/api/v1/money/collections");
  expect(read.status).toBe(200);
  expect(read.body.source).toContain("not live SAP");
  expect(read.body.summary.openPromisesMinor).toBe(30_000);
  expect(read.body.summary.dueThisWeekMinor).toBe(30_000);
  const kinds = read.body.actions.map((/** @type {any} */ a) => [
    a.kind,
    a.customerCode,
  ]);
  expect(kinds).toContainEqual(["overdue_balance", c2]);
  expect(kinds.some((/** @type {any} */ k) => k[1] === c1)).toBe(false);
  const one = read.body.customers.find(
    (/** @type {any} */ c) => c.customerCode === c1,
  );
  expect(one.openItems.map((/** @type {any} */ i) => i.ref)).toEqual([
    "INV-1",
    "INV-2",
  ]);
  expect(one.promisedMinor).toBe(30_000);
  expect(read.body.promises[0].openItemLabel).toBe(
    "Invoice of Sep 1, 2026, due Oct 1, 2026",
  );
  // Team B's manager sees none of Team A's collections.
  const other = await call("/api/v1/money/collections", undefined, managerB);
  expect(
    other.body.customers.some((/** @type {any} */ c) => c.customerCode === c1),
  ).toBe(false);
  const settle = {
    promiseId: made.body.id,
    outcome: "broken",
    note: "TEST not paid",
  };
  expect(
    (await call("/api/v1/money/collections/promise/settle", settle)).status,
  ).toBe(400);
  const kept = {
    ...settle,
    outcome: "kept",
    note: "TEST paid in cash at the visit",
  };
  expect(
    (await call("/api/v1/money/collections/promise/settle", kept)).status,
  ).toBe(200);
  expect(
    (await call("/api/v1/money/collections/promise/settle", kept)).status,
  ).toBe(200);
  expect(
    (
      await call("/api/v1/money/collections/promise/settle", {
        ...kept,
        outcome: "cancelled",
      })
    ).status,
  ).toBe(409);
  expect(
    (await call("/api/v1/money/collections")).body.summary.keptLast28,
  ).toBe(1);
});

test("F-613 cheque lifecycle: post-dated cannot be deposited early; bounce needs a reason and a replacement retires it", async () => {
  const pdc = {
    customerCode: c1,
    chequeNumber: "000123",
    bank: "TEST Bank",
    amountMinor: 20_000,
    chequeDate: addDays(f.today, 10),
    idempotencyKey: "q1",
  };
  const p = await call("/api/v1/money/collections/cheque", pdc);
  expect(p.status).toBe(200);
  expect(
    (
      await call("/api/v1/money/collections/cheque", {
        ...pdc,
        idempotencyKey: "q1b",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call("/api/v1/money/collections/cheque/event", {
        chequeId: p.body.id,
        kind: "deposited",
      })
    ).status,
  ).toBe(400);
  const dated = await call("/api/v1/money/collections/cheque", {
    ...pdc,
    chequeNumber: "000124",
    chequeDate: f.today,
    idempotencyKey: "q2",
  });
  const id = dated.body.id;
  expect((await call("/api/v1/money/collections")).body.actions[0].kind).toBe(
    "cheque_deposit",
  );
  expect(
    (
      await call("/api/v1/money/collections/cheque/event", {
        chequeId: id,
        kind: "cleared",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call("/api/v1/money/collections/cheque/event", {
        chequeId: id,
        kind: "deposited",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call("/api/v1/money/collections/cheque/event", {
        chequeId: id,
        kind: "bounced",
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call("/api/v1/money/collections/cheque/event", {
        chequeId: id,
        kind: "bounced",
        note: "TEST insufficient funds",
      })
    ).status,
  ).toBe(200);
  const read = await call("/api/v1/money/collections");
  expect(read.body.actions[0].kind).toBe("cheque_replacement");
  expect(read.body.summary.bouncedOpen).toBe(1);
  expect(read.body.summary.postDatedMinor).toBe(20_000);
  const swap = await call("/api/v1/money/collections/cheque", {
    ...pdc,
    chequeNumber: "000125",
    chequeDate: f.today,
    replacesId: id,
    idempotencyKey: "q3",
  });
  expect(swap.status).toBe(200);
  const [{ status }] =
    await h.db`select status from cheque_instruments where id=${id}`;
  expect(status).toBe("replaced");
  const events =
    await h.db`select kind from cheque_events where cheque_id=${id} order by created_at`;
  expect(events.map((/** @type {any} */ e) => e.kind)).toEqual([
    "received",
    "deposited",
    "bounced",
    "replaced",
  ]);
  expect(
    (await call("/api/v1/money/collections")).body.summary.bouncedOpen,
  ).toBe(0);
});

test("F-613 collector route: ordered, scoped stops for today or the next 14 days", async () => {
  const [{ id: collector }] =
    await h.db`select id from profiles where name='Agent 0'`;
  const route = {
    routeDate: f.today,
    collectorProfileId: collector,
    stops: [
      { customerCode: c2, reason: "overdue_balance" },
      { customerCode: c1, reason: "cheque_pickup" },
    ],
  };
  expect(
    (
      await call("/api/v1/money/collections/route", {
        ...route,
        routeDate: addDays(f.today, -1),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call("/api/v1/money/collections/route", {
        ...route,
        stops: [route.stops[0], route.stops[0]],
      })
    ).status,
  ).toBe(400);
  expect(
    (await call("/api/v1/money/collections/route", route, managerB)).status,
  ).toBe(403);
  expect(
    (await call("/api/v1/money/collections/route", route)).body.stops,
  ).toBe(2);
  // Saving again replaces, never duplicates.
  expect(
    (await call("/api/v1/money/collections/route", route)).body.stops,
  ).toBe(2);
  const read = await call(`/api/v1/money/collections?date=${f.today}`);
  const r = read.body.routes.find(
    (/** @type {any} */ x) => x.collectorId === collector,
  );
  expect(
    r.stops.map((/** @type {any} */ s) => [
      s.sequence,
      s.customerCode,
      s.reason,
    ]),
  ).toEqual([
    [1, c2, "overdue_balance"],
    [2, c1, "cheque_pickup"],
  ]);
});
