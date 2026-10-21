import { afterAll, beforeAll, expect, test, mock } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  signedPost,
} from "./harness.js";
import { sha256Hex } from "../src/core/util.js";
import { runDueJobs } from "../src/core/jobs.js";
import { install as presell } from "../src/domains/presell/index.js";
import { install as visits } from "../src/domains/visits/index.js";
import { install as callflow } from "../src/domains/callflow/index.js";
import { install as orders } from "../src/domains/orders/index.js";
import {
  validateRequestedDay,
  policyAt,
} from "../src/domains/presell/promise.js";
import { validateDeliveryLines } from "../src/domains/presell/driver.js";
import {
  processHandoff,
  processNotification,
} from "../src/domains/presell/service.js";
import { configuration } from "../src/domains/callflow/engine.js";
import { captureFieldOrder } from "../src/domains/orders/field.js";
import {
  ensurePresellSamples,
  ensurePresellDemo,
} from "../../../packages/db/seed/presell.js";
import { Dataset, persist } from "../../../packages/db/seed/store.js";

mock.module("../src/domains/org/scope.js", () => ({
  scopeFilterForActor: async (
    /** @type {any} */ db,
    /** @type {any} */ actor,
  ) => ({
    unitIds: ["super_admin", "analyst"].includes(actor.role)
      ? null
      : [actor.orgUnitId],
  }),
  outletOwnerUnit: async (/** @type {any} */ db, /** @type {string} */ id) =>
    (await db`select custodian_org_unit_id from outlets where id=${id}`)[0]
      ?.custodian_org_unit_id ?? null,
}));
/** @type {import('./harness.js').Harness} */ let h;
/** @type {ReturnType<typeof profileStore>} */ let profiles;
/** @type {any} */ let admin;
const DAY = 86400000,
  now = Date.now();
const day = (/** @type {number} */ at) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 10);
const today = day(now),
  next = day(now + 2 * DAY);
/** @param {string} role @param {string} unit */
async function person(role, unit) {
  const user = await createUser(
    h,
    `${crypto.randomUUID()}@test.invalid`,
    "fixture-only-long-password",
  );
  const p = profiles.set(user, {
    role,
    orgUnitId: unit,
    name: "Sample colleague",
  });
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user},${user},'Sample colleague',${user + "@test.invalid"},${role},'active',${unit})`;
  const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
  await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${user},${sha256Hex(token)},'web',now()+interval '1 day')`;
  return { ...p, cookie: `sp_session=${token}` };
}
/** @param {any} who @param {string} path @param {any} [body] */
async function api(who, path, body) {
  const r = await h.fetch("/api/v1/" + path, {
    method: body ? "POST" : "GET",
    headers: { cookie: who.cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: /** @type {any} */ (await r.json()) };
}
/** @param {string} action @param {any} body @param {any} [who] */
async function cmd(action, body, who = admin) {
  return api(who, "presell/" + action, {
    idempotencyKey: crypto.randomUUID(),
    ...body,
  });
}
/** @param {any} [opts] */
async function fixture(opts = {}) {
  const unit = crypto.randomUUID();
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride',${unit},'Cebu','region','active','2020-01-01')`;
  const d = await boundDevice(h, profiles, {
    app: opts.app ?? "van-android",
    role: "sales",
    orgUnitId: unit,
  });
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${d.profile.id},${d.userId},${d.userId},'Sample driver',${d.email},'sales','active',${unit})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${d.profile.id},${unit},'sales','2020-01-01',${d.userId},'fixture')`;
  const [customer] =
    await h.db`insert into customers(code,name,channel,territory,credit_limit,active) values(${crypto.randomUUID()},'Sample account','gt_presell','Cebu',0,true) returning *`;
  const [outlet] =
    await h.db`insert into outlets(organization_id,code,name,address,status,custodian_org_unit_id,channel,created_by) values('sunpride',${crypto.randomUUID()},'Sample store','Cebu street','active',${unit},'gt_presell',${d.userId}) returning *`;
  const [territory] =
    await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by) values('sunpride',${crypto.randomUUID()},'Cebu','active','2020-01-01',${d.userId}) returning id`;
  await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values(${territory.id},${unit},'2020-01-01',${d.userId},'fixture')`;
  await h.db`insert into outlet_assignments(outlet_id,territory_id,effective_from,actor_subject,reason) values(${outlet.id},${territory.id},'2020-01-01',${d.userId},'fixture')`;
  await h.db`insert into territory_salespeople(territory_id,profile_id,effective_from,actor_subject,reason) values(${territory.id},${d.profile.id},'2020-01-01',${d.userId},'fixture')`;
  await h.db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason) values(${outlet.id},${customer.id},'sample','2020-01-01',${d.userId},'fixture')`;
  await h.db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,source,status,effective_from,proposed_by,proposed_at,verified_by,verified_at) values(${outlet.id},10.33,123.94,100,'fixture','verified','2020-01-01','one','2020-01-01','two','2020-01-01')`;
  const [sku] =
    await h.db`insert into products(code,name,category,uom,unit_price,active,organization_id,quantity_scale) values(${crypto.randomUUID()},'Sample food','Food','PC',1,true,'sunpride',1) returning id`;
  const [order] =
    await h.db`insert into orders(organization_id,client_request_id,order_number,order_type,customer_code,salesperson_subject,salesperson_profile_id,created_by_subject,org_unit_id,outlet_id,territory_id,service_date,status,subtotal,total,amount_known) values('sunpride',${crypto.randomUUID()},${"SAMPLE-" + crypto.randomUUID().slice(0, 8)},'field_order',${customer.code},${d.userId},${d.profile.id},${d.userId},${unit},${outlet.id},${territory.id},${today},${opts.status ?? "approved"},1,1,true) returning *`;
  await h.db`insert into order_lines(order_id,ordinal,product_id,product_code,description,uom,quantity,quantity_base,unit_price,line_total) values(${order.id},0,${sku.id},'FOOD','Sample food','PC',10,10,1,10)`;
  const policy = await policyAt(h.db, now);
  await h.db`insert into presell_order_promises(order_id,requested_delivery_date,policy_id,policy_snapshot,captured_at) values(${order.id},${opts.deliveryDay ?? next},${policy.id},${policy},${new Date(now)})`;
  const [location] =
    await h.db`insert into inventory_locations(organization_id,site_code,code,name,type,active,org_unit_id,allows_picking,allows_receiving,allows_sale,allows_production) values('sunpride','CEBU',${crypto.randomUUID()},'Sample truck','truck',true,${unit},true,true,true,false) returning id`;
  const [vehicle] =
    await h.db`insert into vehicles(organization_id,vehicle_code,name,plate_number,status,org_unit_id,truck_location_id,home_location_id,created_by) values('sunpride',${crypto.randomUUID()},'Sample truck','SAMPLE','active',${unit},${location.id},${location.id},${d.userId}) returning id`;
  const [trip] =
    await h.db`insert into van_trips(organization_id,org_unit_id,trip_number,vehicle_id,salesperson_profile_id,salesperson_subject,service_date,status,truck_location_id,source_location_id,created_by) values('sunpride',${unit},${crypto.randomUUID()},${vehicle.id},${d.profile.id},${d.userId},${opts.deliveryDay ?? next},'active',${location.id},${location.id},${d.userId}) returning *`;
  return { unit, d, outlet, sku, order, trip, policy };
}
beforeAll(async () => {
  h = await startHarness({ installers: [visits, orders, callflow, presell] });
  profiles = profileStore(h);
  const unit = crypto.randomUUID();
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','National','national','active','2020-01-01')`;
  admin = await person("super_admin", unit);
  await ensurePresellSamples(h.db, now - DAY);
});
afterAll(async () => {
  await h?.close();
});
/** @param {any} f */
async function release(f) {
  const c = await cmd("confirm", {
    orderId: f.order.id,
    confirmedDeliveryDate: day(f.trip.service_date.getTime()),
    reason: "Sample buyer confirmation",
  });
  expect(c.status).toBe(200);
  await processHandoff(h.db, c.body.id);
  return (
    await h.db`select * from delivery_drops where handoff_id=${c.body.id}`
  )[0];
}
/** @param {any} f */
async function dispatched(f) {
  const drop = await release(f),
    r = await cmd("createRun", { tripId: f.trip.id, label: "Cebu delivery" });
  expect(r.status).toBe(200);
  expect(
    (await cmd("schedule", { dropId: drop.id, runId: r.body.id })).status,
  ).toBe(200);
  expect((await cmd("releaseRun", { runId: r.body.id })).status).toBe(200);
  return { ...drop, runId: r.body.id };
}
/** @param {string} type @param {any} p */
const op = (type, p) => ({
  clientOpId: crypto.randomUUID(),
  opType: type,
  clientTime: p.deviceTime,
  dependsOn: [],
  payload: p,
});
/** @param {any} f @param {any[]} ops */
async function push(f, ...ops) {
  const r = await signedPost(h, f.d, "/api/sync/push", {
    version: 2,
    deviceId: f.d.deviceId,
    scopeId: f.unit,
    operations: ops,
  });
  expect(r.res.status).toBe(200);
  return r.body.results;
}

test("F-301 F-303 sample dispatch never clones a partially resolved source order or its full amount", async () => {
  const f = await fixture(),
    data = new Dataset(today, 1);
  const [unit] =
    await h.db`insert into units_of_measure(organization_id,code,name,dimension,decimal_places,active) values('sunpride','PC','Piece','count',0,true) returning id`;
  await h.db`update products set base_uom_id=${unit.id} where id=${f.sku.id}`;
  const [p] = await h.db`select code from products where id=${f.sku.id}`;
  const { id, created_at, updated_at, change_seq, ...facts } = f.order;
  const source = data.add("orders", "presell-incomplete-source", {
    ...facts,
    subtotal: 2,
    total: 2,
    subtotal_centavos: 200,
    total_centavos: 200,
    client_request_id: crypto.randomUUID(),
    order_number: "SAMPLE-INCOMPLETE-PRESELL-SOURCE",
  });
  data.add("order_lines", "presell-resolved-line", {
    order_id: source.id,
    ordinal: 0,
    product_id: f.sku.id,
    product_code: p.code,
    description: "Sample resolved product",
    uom: "PC",
    quantity: 1,
    quantity_base: 1,
    unit_price: 1,
    line_total: 1,
  });
  data.add("order_lines", "presell-unresolved-line", {
    order_id: source.id,
    ordinal: 1,
    product_code: "SAMPLE-NO-CURRENT-MASTER",
    description: "Sample unresolvable product",
    uom: "PC",
    quantity: 1,
    unit_price: 1,
    line_total: 1,
  });
  await persist(h.db, data);
  expect((await ensurePresellDemo(h.db, today)).added).toBe(0);
  expect(
    (
      await h.db`select id from orders where order_number like 'SAMPLE-PRESELL-%'`
    ).length,
  ).toBe(0);
});
test("F-301 Manila cutoff includes the exact boundary and retains offline capture time", () => {
  const p = { lead_days: 1, horizon_days: 30, cutoff_minute: 840 };
  expect(
    validateRequestedDay(
      p,
      "2026-10-21",
      Date.parse("2026-10-20T13:59:59+08:00"),
    ),
  ).toBe("2026-10-21");
  expect(() =>
    validateRequestedDay(
      p,
      "2026-10-21",
      Date.parse("2026-10-20T14:00:00+08:00"),
    ),
  ).toThrow();
  expect(
    validateRequestedDay(
      p,
      "2026-10-22",
      Date.parse("2026-10-20T14:00:00+08:00"),
    ),
  ).toBe("2026-10-22");
  expect(() => validateRequestedDay(p, "2026-11-31", now)).toThrow();
});
test("F-301 shared pre-sell profile rejects a missing requested day before accepting an activity", async () => {
  const f = await fixture({ app: "field-android" }),
    at = Date.now(),
    fix = {
      latitude: 10.33,
      longitude: 123.94,
      accuracyMeters: 5,
      fixTime: at,
      provider: "gps",
      mockSignal: false,
    };
  const config = await configuration(h.db, "pre_sell", f.outlet, at);
  const start = op("visit.checkIn", {
    clientVisitId: crypto.randomUUID(),
    outletId: f.outlet.id,
    serviceDate: today,
    intents: ["sell"],
    unplannedReason: "Sample proof",
    deviceTime: at,
    location: fix,
    flowDefinitionId: config.definition.id,
  });
  const s = (await push(f, start))[0];
  expect(s.status).toBe("applied");
  const [account] =
    await h.db`insert into call_sheet_accounts(organization_id,outlet_id,revision,header_account_name,updated_by) values('sunpride',${f.outlet.id},1,'Sample account',${f.d.userId}) returning id`;
  await h.db`insert into call_sheet_account_lines(call_sheet_account_id,ordinal,product_id) values(${account.id},0,${f.sku.id})`;
  const activity = {
    kind: "order_intent",
    clientOrderId: crypto.randomUUID(),
    lines: [{ productId: f.sku.id, uom: "PC", quantity: 2 }],
  };
  expect(
    (
      await push(
        f,
        op("visit.activity", {
          visitId: s.ack.entityId,
          deviceTime: at + 10,
          activity,
        }),
      )
    )[0].status,
  ).toBe("rejected");
  const good = op("visit.activity", {
    visitId: s.ack.entityId,
    deviceTime: at + 20,
    activity: { ...activity, requestedDeliveryDate: next },
  });
  const a = (await push(f, good))[0];
  expect(a.status).toBe("applied");
  const actor = {
    userId: f.d.userId,
    profileId: f.d.profile.id,
    role: "sales",
    orgUnitId: f.unit,
    subject: f.d.userId,
  };
  await tx(h.db, (db) =>
    captureFieldOrder(
      {
        db,
        actor,
        app: "field-android",
        now: Date.now(),
        enqueue: (/** @type {any} */ job) => Promise.resolve(null),
        publish: () => {},
      },
      { activityId: a.ack.entityId },
    ),
  );
  const [promise] =
    await h.db`select s.* from presell_order_promises s join orders o on o.id=s.order_id where o.source_activity_id=${a.ack.entityId}`;
  expect(day(+new Date(promise.requested_delivery_date) - 8 * 3600000)).toBe(
    next,
  );
});
test("F-302 only approved orders confirm; captured SLA rejects an out-of-range promise", async () => {
  const f = await fixture({ status: "pending_approval" });
  expect(
    (
      await cmd("confirm", {
        orderId: f.order.id,
        confirmedDeliveryDate: next,
        reason: "Buyer",
      })
    ).status,
  ).toBe(400);
  await h.db`update orders set status='approved' where id=${f.order.id}`;
  expect(
    (
      await cmd("confirm", {
        orderId: f.order.id,
        confirmedDeliveryDate: day(now + 10 * DAY),
        reason: "Buyer",
      })
    ).status,
  ).toBe(400);
});
test("F-302 confirmed order releases once through durable mock SAP handoff; replay changes nothing", async () => {
  const f = await fixture(),
    p = {
      orderId: f.order.id,
      confirmedDeliveryDate: next,
      reason: "Buyer",
      idempotencyKey: crypto.randomUUID(),
    };
  const a = await cmd("confirm", p);
  expect(a.status).toBe(200);
  expect((await cmd("confirm", p)).body).toEqual(a.body);
  await Promise.all([
    processHandoff(h.db, a.body.id),
    processHandoff(h.db, a.body.id),
  ]);
  expect(
    (await h.db`select * from delivery_drops where handoff_id=${a.body.id}`)
      .length,
  ).toBe(1);
  const [r] = await h.db`select * from delivery_handoffs where id=${a.body.id}`;
  expect(r.source).toBe("mock_sap");
  expect(r.attempts).toBe(1);
  expect((await cmd("confirm", { ...p, reason: "Changed" })).status).toBe(409);
});
test("F-302 source-order withdrawal prevents delayed handoff and retry; cancellation retains the original order", async () => {
  const f = await fixture(),
    r = await cmd("confirm", {
      orderId: f.order.id,
      confirmedDeliveryDate: next,
      reason: "Buyer",
    });
  await h.db`update orders set status='voided' where id=${f.order.id}`;
  await processHandoff(h.db, r.body.id);
  expect(
    (await h.db`select status from delivery_handoffs where id=${r.body.id}`)[0]
      .status,
  ).toBe("failed");
  expect((await cmd("retryHandoff", { handoffId: r.body.id })).status).toBe(
    400,
  );
  expect(
    (await cmd("cancel", { handoffId: r.body.id, reason: "Buyer cancelled" }))
      .status,
  ).toBe(200);
  expect(
    (await h.db`select status from orders where id=${f.order.id}`)[0].status,
  ).toBe("voided");
});
test("F-301 F-303 board counts real drops, not unconfirmed delivery requests", async () => {
  const deliveryDay = day(now + 17 * DAY);
  const f = await fixture({ deliveryDay });
  const manager = await person("manager", f.unit);
  const path = "presell/board?date=" + deliveryDay;
  const before = await api(manager, path);
  expect(before.status).toBe(200);
  expect(
    before.body.rows.find((/** @type {any} */ r) => r.id === f.order.id)
      .confirmed_delivery_date,
  ).toBeNull();
  expect(before.body.current.drops).toBe(0);
  expect(before.body.current.proofs).toBe(0);
  expect(before.body.trend.at(-1).drops).toBe(0);
  await release(f);
  const after = await api(manager, path);
  expect(after.status).toBe(200);
  expect(after.body.current.drops).toBe(1);
  expect(after.body.current.proofs).toBe(0);
  expect(after.body.trend.at(-1).drops).toBe(1);
});

test("F-303 dispatch freezes sequence and returns an ordered printable driver manifest", async () => {
  const f = await fixture(),
    drop = await dispatched(f);
  const m = await api(admin, "presell/manifest?runId=" + drop.runId);
  expect(m.status).toBe(200);
  expect(m.body.rows[0].store).toBe("Sample store");
  expect(m.body.rows[0].lines[0].expected_base).toBe("10");
  expect(
    (await cmd("sequence", { runId: drop.runId, dropIds: [drop.id] })).status,
  ).toBe(400);
});
test("F-303 scheduling refuses a different truck scope and confirmed date", async () => {
  const f = await fixture(),
    other = await fixture(),
    drop = await release(f);
  const r = await cmd("createRun", {
    tripId: other.trip.id,
    label: "Other truck",
  });
  expect(
    (await cmd("schedule", { dropId: drop.id, runId: r.body.id })).status,
  ).toBe(400);
});
test("F-304 every counted piece belongs to exactly one accepted/short/rejected/damaged partition", () => {
  const e = [{ id: "one", expected_base: 10 }],
    reasons = [{ code: "buyer_rejected" }];
  const l = {
    lineId: "one",
    acceptedBase: 7,
    shortBase: 1,
    rejectedBase: 1,
    damagedBase: 1,
    reason: "buyer_rejected",
  };
  expect(validateDeliveryLines(e, [l], reasons)[0].acceptedBase).toBe(7);
  expect(() =>
    validateDeliveryLines(e, [{ ...l, acceptedBase: 8 }], reasons),
  ).toThrow();
  expect(() =>
    validateDeliveryLines(e, [{ ...l, reason: "free_text" }], reasons),
  ).toThrow();
  expect(() =>
    validateDeliveryLines(e, [{ ...l, shortBase: -1 }], reasons),
  ).toThrow();
  expect(() => validateDeliveryLines(e, [l, l], reasons)).toThrow();
});
test("F-308 slot booking preserves window and prevents oversubscription including concurrent requests", async () => {
  const f = await fixture(),
    d = await release(f),
    stamp = Date.parse(next + "T09:00:00+08:00");
  const s = await cmd("slot", {
    outletId: f.outlet.id,
    label: "Morning unloading",
    startsAt: stamp,
    endsAt: stamp + 3600000,
    capacity: 1,
  });
  expect(s.status).toBe(200);
  const b = await cmd("book", {
    dropId: d.id,
    slotId: s.body.id,
    bookingReference: "SAMPLE-BOOK",
  });
  expect(b.status).toBe(200);
  const row = (await h.db`select * from delivery_drops where id=${d.id}`)[0];
  expect(+new Date(row.window_start)).toBe(stamp);
  const [copy] =
    await h.db`insert into orders(organization_id,client_request_id,order_number,order_type,customer_code,salesperson_subject,salesperson_profile_id,created_by_subject,org_unit_id,outlet_id,status,subtotal,total) values('sunpride',${crypto.randomUUID()},${crypto.randomUUID()},'field_order',${f.order.customer_code},${f.d.userId},${f.d.profile.id},${f.d.userId},${f.unit},${f.outlet.id},'approved',1,1) returning id`;
  const [handoff] =
    await h.db`insert into delivery_handoffs(order_id,org_unit_id,outlet_id,snapshot,payload_hash,status) select ${copy.id},org_unit_id,outlet_id,snapshot,payload_hash,'acknowledged' from delivery_handoffs where id=${d.handoff_id} returning id`;
  const [second] =
    await h.db`insert into delivery_drops(handoff_id) values(${handoff.id}) returning id`;
  const rs = await Promise.all([
    cmd("book", {
      dropId: second.id,
      slotId: s.body.id,
      bookingReference: "OTHER",
    }),
    cmd("book", {
      dropId: second.id,
      slotId: s.body.id,
      bookingReference: "OTHER-2",
    }),
  ]);
  expect(rs.map((r) => r.status)).toEqual([409, 409]);
});
test("F-612 consented ETA is queued once and mocked SMS/email terminate only in the dev sink", async () => {
  const f = await fixture(),
    d = await dispatched(f),
    eta = Date.parse(next + "T11:00:00+08:00");
  expect(
    (
      await cmd("eta", {
        dropId: d.id,
        eta,
        channel: "sms",
        recipient: "+639000000000",
        consent: false,
      })
    ).status,
  ).toBe(400);
  for (const channel of ["sms", "email"]) {
    const r = await cmd("eta", {
      dropId: d.id,
      eta,
      channel,
      recipient: channel === "sms" ? "+639000000000" : "sample@example.invalid",
      consent: true,
    });
    expect(r.status).toBe(200);
    await Promise.all([
      processNotification(h.db, r.body.id),
      processNotification(h.db, r.body.id),
    ]);
    expect(
      (
        await h.db`select * from delivery_notification_sink where notification_id=${r.body.id}`
      ).length,
    ).toBe(1);
    expect(
      (
        await h.db`select attempts from delivery_notification_outbox where id=${r.body.id}`
      )[0].attempts,
    ).toBe(1);
  }
});
test("F-302 F-303 current source scope is checked before command replay and every board/manifest read", async () => {
  const f = await fixture(),
    d = await dispatched(f),
    stranger = await person("operations", (await fixture()).unit);
  expect(
    (await api(stranger, "presell/manifest?runId=" + d.runId)).status,
  ).toBe(403);
  expect(
    (await api(stranger, "presell/board?date=" + next)).body.rows.some(
      (/** @type {any} */ r) => r.id === f.order.id,
    ),
  ).toBe(false);
  expect((await api(stranger, "presell/drop?dropId=" + d.id)).status).toBe(403);
});
test("F-301 policies publish prospectively and keep captured promise snapshots unchanged", async () => {
  const f = await fixture(),
    r = await cmd("publishPolicy", {
      label: "Future next-day",
      effectiveFrom: Date.now() + 3600000,
      cutoffMinute: 900,
      leadDays: 1,
      horizonDays: 20,
      slaDays: 1,
      epodTargetPercent: 99,
      varianceReasons: [{ code: "buyer_rejected", label: "Buyer refused" }],
    });
  expect(r.status).toBe(200);
  const [promise] =
    await h.db`select policy_snapshot from presell_order_promises where order_id=${f.order.id}`;
  expect(promise.policy_snapshot.epod_target_percent).toBe(98);
});

test("F-303 F-304 F-308 signed driver ePOD advances the shared engine, freezes evidence, retains order and replays exactly", async () => {
  const f = await fixture({ deliveryDay: today }),
    drop = await dispatched(f),
    at = Date.now();
  const [campaign] =
    await h.db`insert into campaigns(code) values('SAMPLE-DELIVERY-BENEFITS') returning id`;
  const [version] =
    await h.db`insert into campaign_versions(campaign_id,version,name,mechanic,status,effective_from,effective_to,budget_centavos,expected_volume_base,expected_roi_bps,source,created_by) values(${campaign.id},1,'Sample delivery rebate','Sample proportional variance','active',${new Date(at - 1000)},${new Date(at + 86400000)},1000,10,1000,'sample','sample') returning id`;
  const [promotion] =
    await h.db`insert into promotions(organization_id,code,name,rule_kind,rule,status,source,effective_from,effective_to,campaign_version_id,benefit_timing) values('sunpride','SAMPLE-DELIVERY-BENEFITS','Sample delivery rebate','basket',${{ kind: "basket", minSubtotalCentavos: 1, valueCentavos: 100 }},'active','sample',${new Date(at - 1000)},${new Date(at + 86400000)},${version.id},'claimable') returning id`;
  const pricing = {
    pricedAt: at,
    promotionsApplied: [
      {
        id: promotion.id,
        campaignVersionId: version.id,
        benefitTiming: "claimable",
        earnedCentavos: 100,
        discountCentavos: 0,
        allocations: [100],
        freeGoods: [],
      },
    ],
  };
  await h.db`update orders set pricing_snapshot=${pricing} where id=${f.order.id}`;
  const { accrueOrder } = await import("../src/domains/tpm/finance.js");
  await tx(h.db, (db) =>
    accrueOrder(
      { db, env: h.env, actor: { subject: "sample-delivery" }, now: at },
      { ...f.order, pricing_snapshot: pricing },
    ),
  );
  const config = await configuration(h.db, "driver_delivery", f.outlet, at),
    fix = {
      latitude: 10.33,
      longitude: 123.94,
      accuracyMeters: 5,
      fixTime: at,
      provider: "gps",
      mockSignal: false,
    };
  const start = op("call.start", {
    tripId: f.trip.id,
    clientCallId: crypto.randomUUID(),
    outletId: f.outlet.id,
    deviceTime: at,
    location: fix,
    flowDefinitionId: config.definition.id,
    unplannedReason: "Assigned delivery",
  });
  expect((await push(f, start))[0].status).toBe("applied");
  const end = op("call.close", {
    tripId: f.trip.id,
    clientCallId: start.payload.clientCallId,
    deviceTime: at + 1,
    location: { ...fix, fixTime: at + 1 },
    zeroSaleReason: "delivery_only",
  });
  expect((await push(f, end))[0].status).toBe("rejected");
  await h.db`update delivery_drops set window_start=${new Date(at + 60000)},window_end=${new Date(at + 120000)} where id=${drop.id}`;
  /** @param {string} stage @param {number} offset @param {string|null} [reason] */
  const timing = (stage, offset, reason = null) =>
    op("delivery.timing", {
      tripId: f.trip.id,
      dropId: drop.id,
      clientCallId: start.payload.clientCallId,
      deviceTime: at + offset,
      stage,
      ...(reason ? { reason } : {}),
    });
  expect((await push(f, timing("unloading", 1)))[0].status).toBe("rejected");
  expect((await push(f, timing("arrival", 1)))[0].status).toBe("rejected");
  const arrival = timing("arrival", 1, "Buyer asked us to receive early");
  expect((await push(f, arrival))[0].status).toBe("applied");
  expect((await push(f, arrival))[0].status).toBe("duplicate");
  expect((await push(f, timing("unloading", 2)))[0].status).toBe("applied");
  expect((await push(f, timing("departure", 3)))[0].status).toBe("rejected");
  const [line] =
    await h.db`select * from delivery_drop_lines where drop_id=${drop.id}`;
  const digest = "b".repeat(64);
  await h.db`insert into files(owner_id,purpose,sha256,mime,size,device_id,created_by,status,path,stored_at) values(${f.trip.id},'truck-damage',${digest},'image/jpeg',100,${f.d.deviceId},${f.d.userId},'stored','fixture.jpg',now())`;
  const p = {
    tripId: f.trip.id,
    dropId: drop.id,
    clientCallId: start.payload.clientCallId,
    deviceTime: at + 2,
    location: { ...fix, fixTime: at + 2 },
    receiverName: "Sample buyer",
    signature: [
      [0.1, 0.2],
      [0.8, 0.7],
    ],
    photoSha256: digest,
    watermark: {
      version: 1,
      outletId: f.outlet.id,
      profileId: f.d.profile.id,
      capturedAt: at + 2,
      latitude: fix.latitude,
      longitude: fix.longitude,
    },
    lines: [
      {
        lineId: line.id,
        acceptedBase: 7,
        shortBase: 1,
        rejectedBase: 1,
        damagedBase: 1,
        reason: "buyer_rejected",
        lotNumber: "SAMPLE-BATCH",
      },
    ],
  };
  expect(
    (await push(f, op("delivery.confirm", { ...p, signature: [] })))[0].status,
  ).toBe("rejected");
  expect(
    (
      await push(
        f,
        op("delivery.confirm", {
          ...p,
          watermark: { ...p.watermark, outletId: crypto.randomUUID() },
        }),
      )
    )[0].status,
  ).toBe("rejected");
  const proofOp = op("delivery.confirm", p),
    result = (await push(f, proofOp))[0];
  expect(result.status).toBe("applied");
  expect((await push(f, proofOp))[0].status).toBe("duplicate");
  const [earning] =
    await h.db`select reversed_centavos from promotion_earnings where promotion_id=${promotion.id}`;
  expect(Number(earning.reversed_centavos)).toBe(30);
  expect(
    (
      await h.db`select * from tpm_posting_instructions where kind='reversal' and payload->>'sourceKey' like 'partial-return:%'`
    ).length,
  ).toBe(1);
  expect(
    Number(
      (
        await h.db`select amount_centavos from campaign_commitment_balances where campaign_id=${campaign.id}`
      )[0].amount_centavos,
    ),
  ).toBe(70);
  expect((await push(f, timing("departure", 3)))[0].status).toBe("applied");
  const [times] =
    await h.db`select arrived_at,unloading_at,departed_at,window_breach_reason from delivery_drops where id=${drop.id}`;
  expect(+new Date(times.arrived_at)).toBe(at + 1);
  expect(+new Date(times.unloading_at)).toBe(at + 2);
  expect(+new Date(times.departed_at)).toBe(at + 3);
  expect(times.window_breach_reason).toBe("Buyer asked us to receive early");
  const close = op("call.close", {
    ...end.payload,
    deviceTime: at + 3,
    location: { ...fix, fixTime: at + 3 },
  });
  expect((await push(f, close))[0].status).toBe("applied");
  expect(
    (
      await h.db`select adapter from call_step_events where call_id=(select call_id from delivery_proofs where drop_id=${drop.id}) order by created_at`
    ).map((/** @type {any} */ r) => r.adapter),
  ).toEqual(["check_in", "delivery_confirm", "check_out"]);
  expect(
    (await h.db`select status from orders where id=${f.order.id}`)[0].status,
  ).toBe("approved");
  expect(
    (await h.db`select status from delivery_drops where id=${drop.id}`)[0]
      .status,
  ).toBe("variance");
  expect(
    (
      await h.db`select short_base,rejected_base,damaged_base from delivery_variances where proof_id=${result.ack.entityId}`
    )[0],
  ).toMatchObject({ short_base: "1", rejected_base: "1", damaged_base: "1" });
  let refused = false;
  try {
    await h.db`update delivery_proofs set receiver_name='rewrite' where id=${result.ack.entityId}`;
  } catch {
    refused = true;
  }
  expect(refused).toBe(true);
  const read = await api(admin, "presell/drop?dropId=" + drop.id);
  expect(read.body.proof.receiver_name).toBe("Sample buyer");
});
