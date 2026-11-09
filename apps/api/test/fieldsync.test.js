import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  setSystemTime,
  test,
} from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  startHarness,
  profileStore,
  boundDevice,
  signedPost,
} from "./harness.js";
import { install } from "../src/domains/fieldsync/index.js";
import { installProjections as installReports } from "../src/domains/fieldreports/mobile.js";
import { closeDays, purgeExpired } from "../src/domains/fieldsync/jobs.js";
import {
  closeAt,
  manilaDate,
  midnight,
  DAY_MS,
} from "../src/domains/fieldsync/model.js";
import { recordChange } from "../src/core/sync.js";

mock.module("../src/domains/org/scope.js", () => ({
  scopeFilterForActor: async (
    /** @type {any} */ _db,
    /** @type {any} */ actor,
  ) => ({
    unitIds: ["super_admin", "analyst"].includes(actor.role)
      ? null
      : [actor.orgUnitId],
  }),
  outletOwnerUnit: async (/** @type {any} */ db, /** @type {string} */ id) => {
    const [r] =
      await db`select custodian_org_unit_id from outlets where id=${id}`;
    return r?.custodian_org_unit_id ?? null;
  },
}));
mock.module("../src/domains/orders/pricing.js", () => ({
  resolvePrice: async () => ({
    unitPriceCentavos: 1250,
    priceListId: null,
    source: "test-governed",
  }),
}));

/** @type {Awaited<ReturnType<typeof startHarness>>} */ let h;
/** @type {Awaited<ReturnType<typeof boundDevice>>} */ let who;
/** @type {ReturnType<typeof profileStore>} */ let profiles;
/** @type {any} */ let f;
let now = 0,
  date = "";
async function fixture() {
  const db = h.db;
  const [unit] =
    await db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values ('sunpride','CEBU','Cebu','region','active','2026-01-01') returning id`;
  who = await boundDevice(h, profiles, { orgUnitId: unit.id });
  await db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values (${who.profile.id},${who.userId},${who.userId},'Rhea Santos',${who.email},'sales','active',${unit.id})`;
  const [outlet] =
    await db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values ('sunpride','O1','Live store','active',${unit.id},'test') returning id`;
  const [plan] =
    await db`insert into coverage_plans(organization_id,assignee_profile_id,local_month,version,cycle_type,org_unit_id,requested_from,requested_to,effective_from,effective_to,status,prepared_by,prepared_at,approval_signature,content_hash,content_revision,created_by,updated_by)
    values ('sunpride',${who.profile.id},${date.slice(0, 7)},1,'monthly',${unit.id},${new Date(midnight(date))},${new Date(midnight(date) + 3 * DAY_MS)},${new Date(midnight(date))},${new Date(midnight(date) + 3 * DAY_MS)},'active','test',now(),'signed','hash',1,'test','test') returning id`;
  const snapshot = {
    outletId: outlet.id,
    outletName: "Signed store",
    outletCode: "SIGNED-1",
    routeId: null,
    latitude: 10.3,
    longitude: 123.9,
  };
  const [slot] =
    await db`insert into coverage_plan_slots(slot_key,plan_id,assignee_profile_id,service_date,kind,outlet_id,intents,sequence,expected_duration_minutes,approved_snapshot,content_revision,updated_by)
    values ('s1',${plan.id},${who.profile.id},${date},'outlet_visit',${outlet.id},array['sell'],1,20,${snapshot},1,'test') returning id`;
  const [planned] =
    await db`insert into planned_visits(generation_key,plan_id,plan_version,plan_slot_id,assignee_profile_id,outlet_id,service_date,status,approved_snapshot,intents,expected_duration_minutes,generated_at)
    values ('g1',${plan.id},1,${slot.id},${who.profile.id},${outlet.id},${date},'planned',${snapshot},array['sell'],20,now()) returning id`;
  const [visit] =
    await db`insert into visit_executions(organization_id,client_visit_id,planned_visit_id,plan_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,state,productivity,last_server_time,checked_in_at)
    values ('sunpride',${crypto.randomUUID()},${planned.id},${plan.id},${who.profile.id},${outlet.id},${unit.id},${date},'planned','checked-in','pending',${new Date(now - 3_600_000)},${new Date(now - 3_600_000)}) returning id`;
  const [customer] =
    await db`insert into customers(code,name,channel,territory,credit_limit,active) values ('C1','Account','GT','Cebu',1000,true) returning id`;
  await db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason) values (${outlet.id},${customer.id},'test','2026-01-01','test','test')`;
  const [uom] =
    await db`insert into units_of_measure(organization_id,code,name,dimension,decimal_places,active) values ('sunpride','PC','Piece','count',0,true) returning id`;
  const [product] =
    await db`insert into products(code,name,category,uom,unit_price,active,organization_id,base_uom_id,quantity_scale) values ('SKU1','Sample product','Canned','PC',0,true,'sunpride',${uom.id},1) returning id`;
  await db`insert into product_selling_uoms(product_id,ordinal,uom_id) values (${product.id},0,${uom.id})`;
  const [sheet] =
    await db`insert into call_sheet_accounts(organization_id,outlet_id,revision,header_account_name,updated_by) values ('sunpride',${outlet.id},1,'Store sheet','test') returning id`;
  await db`insert into call_sheet_account_lines(call_sheet_account_id,ordinal,product_id) values (${sheet.id},0,${product.id})`;
  await db`insert into fieldsync_location_consents(profile_id,enabled,effective_from) values (${who.profile.id},true,${new Date(now - 2 * 3_600_000)})`;
  return {
    unit: unit.id,
    outlet: outlet.id,
    plan: plan.id,
    slot: slot.id,
    planned: planned.id,
    visit: visit.id,
    product: product.id,
    uom: uom.id,
    customer: customer.id,
  };
}
/** @param {string} [projection] @param {any} [params] @param {any} [extra] */
async function pull(
  projection = "field.bundle",
  params = { dayFrom: date },
  extra = {},
) {
  return signedPost(h, who, "/api/sync/pull", {
    version: 2,
    app: who.app,
    deviceId: who.deviceId,
    since: null,
    pageCursor: null,
    scopes: [{ scopeId: f.unit, projection, params }],
    limit: 100,
    ...extra,
  });
}
/** @param {any} [over] */
function ping(over = {}) {
  const id = crypto.randomUUID();
  const payload = {
    clientPingId: id,
    recordedAt: now,
    latitude: 10.3,
    longitude: 123.9,
    accuracyMeters: 10,
    speedMetersPerSecond: 0,
    headingDegrees: null,
    batteryPercent: 80,
    mockLocation: false,
    provider: "gps",
    trigger: "still",
    visitId: f.visit,
    ...over,
  };
  return {
    clientOpId: payload.clientPingId,
    opType: "location.record",
    clientTime: payload.recordedAt,
    dependsOn: [],
    payload,
  };
}
/** @param {any[]} operations */
async function push(operations) {
  return signedPost(h, who, "/api/sync/push", {
    version: 2,
    app: who.app,
    deviceId: who.deviceId,
    scopeId: f.unit,
    operations,
  });
}
/** @param {string} path @param {any} [body] */
async function api(path, body) {
  const r = await h.fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${who.access}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: /** @type {any} */ (await r.json()) };
}

beforeEach(async () => {
  // Exercise a deterministic selling hour, even when CI runs after the real 22:00 close.
  // The next noon is future but less than a day away: SQL-issued one-day
  // integrity assessments and auth credentials remain valid at the service clock.
  const realNow = Date.now();
  const noon = midnight(manilaDate(realNow)) + 12 * 3_600_000;
  setSystemTime(new Date(noon > realNow ? noon : noon + DAY_MS));
  now = Date.now();
  date = manilaDate(now);
  h = await startHarness({
    installers: [
      install,
      (/** @type {any} */ _router, /** @type {any} */ ctx) =>
        installReports(ctx),
    ],
  });
  profiles = profileStore(h);
  f = await fixture();
});
afterEach(async () => {
  try {
    await h?.close();
  } finally {
    setSystemTime();
  }
});

describe("FIELDSYNC projections through real core proof/cursor harness", () => {
  test("account summaries preserve 91-day/28-day windows and all open orders", async () => {
    for (const [name, days, amount] of [
      ["HISTORY", 50, 100],
      ["OLDER-OPEN", 120, 20],
    ])
      await h.db`insert into orders(organization_id,client_request_id,order_number,customer_code,salesperson_subject,status,subtotal,total,created_at)
      values ('sunpride',${crypto.randomUUID()},${name},'C1',${who.userId},'approved',${amount},${amount},${new Date(now - Number(days) * DAY_MS)})`;
    const r = await pull();
    expect(r.res.status).toBe(200);
    const summary = r.body.bundles[0].data.accountSummaries[0];
    expect(summary.sales.from).toBe(manilaDate(midnight(date) - 90 * DAY_MS));
    expect(summary.sales.orders).toBe(1);
    expect(summary.sales.amountMinor).toBe(10000);
    expect(summary.sales.recentOrders).toBe(0);
    expect(summary.openOrders).toEqual({ count: 2, amountMinor: 12000 });
  });

  test("a shared account outside the downloaded plan withholds every financial figure", async () => {
    const [outlet] =
      await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,created_by) values ('sunpride','SHARED','Not on this plan','active',${f.unit},'test') returning id`;
    await h.db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason) values (${outlet.id},${f.customer},'test','2026-01-01','test','shared')`;
    const r = await pull();
    expect(r.res.status).toBe(200);
    expect(r.body.bundles[0].data.accountSummaries[0]).toEqual({
      outletId: f.outlet,
      asOfDate: date,
      availability: "withheld",
      creditLimitMinor: null,
      sales: null,
      openOrders: null,
    });
  });

  test("F-203 signed sync snapshot carries objectives, prior outcome and absent versus unmeasured MSL", async () => {
    const db = h.db,
      previous = manilaDate(midnight(date) - DAY_MS);
    await db`update planned_visits set required_objectives=ARRAY['Review shelf gaps'] where id=${f.planned}`;
    const [second] =
      await db`insert into products(code,name,category,uom,unit_price,active,organization_id) values ('SKU2','Unmeasured sample','Canned','PC',0,true,'sunpride') returning id`;
    const [set] =
      await db`insert into outlet_assortments(organization_id,outlet_id,effective_from,source_ref,actor_subject) values ('sunpride',${f.outlet},'2026-01-01','Sample F-203','test') returning id`;
    await db`insert into outlet_assortment_products(outlet_assortment_id,ordinal,product_id) values (${set.id},0,${f.product}),(${set.id},1,${second.id})`;
    const [audit] =
      await db`insert into merchandising_audits(organization_id,org_unit_id,visit_id,outlet_id,assignee_profile_id,service_date,client_audit_id,payload_hash,audit_version,assortment_id,required_count,required_available_count,required_out_of_stock_count,actor_subject,source,device_time,server_time) values ('sunpride',${f.unit},${f.visit},${f.outlet},${who.profile.id},${previous},${crypto.randomUUID()},'test','1',${set.id},2,0,1,'test','web',${new Date(now - DAY_MS)},${new Date(now - DAY_MS)}) returning id`;
    await db`insert into merchandising_availability(organization_id,org_unit_id,audit_id,outlet_id,product_id,service_date,required,status) values ('sunpride',${f.unit},${audit.id},${f.outlet},${f.product},${previous},true,'out_of_stock')`;
    await db`insert into visit_executions(organization_id,client_visit_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,state,outcome,productivity,last_server_time,ended_at) values ('sunpride',${crypto.randomUUID()},${who.profile.id},${f.outlet},${f.unit},${previous},'unplanned','checked-out','completed','nonproductive',${new Date(now - DAY_MS)},${new Date(now - DAY_MS)})`;
    const { res, body } = await pull();
    expect(res.status).toBe(200);
    const agenda = body.bundles[0].data.plannedVisits[0].agenda;
    expect(agenda.objectives).toEqual(["Review shelf gaps"]);
    expect(agenda.lastVisit).toEqual({ date: previous, outcome: "completed" });
    expect(agenda.msl.gaps.map((/** @type {any} */ r) => r.name)).toEqual([
      "Sample product",
    ]);
    expect(agenda.msl.unmeasured.map((/** @type {any} */ r) => r.name)).toEqual(
      ["Unmeasured sample"],
    );
    expect(agenda.msl.requiredCount).toBe(2);
    expect(agenda.ar.amountMinor).toBeNull();
  });
  test("closed v2 snapshot uses signed names and governed price, not product.unit_price", async () => {
    const { res, body } = await pull();
    expect(res.status).toBe(200);
    expect(body.version).toBe(2);
    expect(body.hasMore).toBe(false);
    const b = body.bundles[0];
    expect(b.mode).toBe("snapshot");
    expect(b.complete).toBe(true);
    expect(b.data.outlets[0].name).toBe("Signed store");
    expect(b.data.plannedVisits[0]).toEqual({
      id: f.planned,
      outletId: f.outlet,
      serviceDate: date,
      planId: f.plan,
      planVersion: 1,
      intents: ["sell"],
      sequence: 1,
      requiredObjectives: [],
      agenda: {
        asOfDate: date,
        beat: null,
        planVersion: 1,
        objectives: [],
        lastVisit: null,
        ar: {
          status: "unavailable",
          amountMinor: null,
          source: "SAP open items not connected",
          asOfDate: null,
        },
        msl: {
          status: "needs_setup",
          source: "No applicable MSL supplied",
          version: null,
          asOfDate: null,
          gaps: [],
          unmeasured: [],
          requiredCount: null,
        },
      },
    });
    expect(b.data.productCatalog[0].baseUom.code).toBe("PC");
    expect(b.data.orderTerms[0].lines[0].unitPriceMinor).toBe(1250);
    expect(b.offlineLease.expiresAt).toBe(closeAt(date));
    expect(b.data.appConfig.orderCaptureEnabled).toBe(false);
    expect(Object.keys(b.data).sort()).toEqual(
      [
        "permissions",
        "employee",
        "scope",
        "appConfig",
        "plannedVisits",
        "outlets",
        "localCustomers",
        "route",
        "tasks",
        "productCatalog",
        "inventoryAvailability",
        "callSheets",
        "orderTerms",
        "accountSummaries",
        "activityRules",
        "photoTypes",
        "visitExecutions",
        "dayTarget",
        "daySales",
      ].sort(),
    );
  });
  test("outlets carry the store's owner contact (approved Edit store shows on the phone)", async () => {
    const before = (await pull()).body.bundles[0].data.outlets[0];
    expect(before.ownerName).toBeUndefined();
    expect(before.ownerPhone).toBeUndefined();
    await h.db`insert into outlet_contacts(outlet_id,ordinal,name,phone) values(${f.outlet},0,'New Owner','0917 555 0199')`;
    try {
      const o = (await pull()).body.bundles[0].data.outlets[0];
      expect(o.ownerName).toBe("New Owner");
      expect(o.ownerPhone).toBe("0917 555 0199");
    } finally {
      await h.db`delete from outlet_contacts where outlet_id=${f.outlet}`;
    }
  });
  test("snapshot carries this person's own recorded calls so a mid-day bootstrap knows done stops", async () => {
    await h.db`update visit_executions set state='checked-out',checked_out_at=now(),productivity='verified' where id=${f.visit}`;
    const { body } = await pull();
    const rows = body.bundles[0].data.visitExecutions;
    const row = rows.find((/** @type {any} */ r) => r.id === f.visit);
    expect(row).toBeDefined();
    expect(Object.keys(row).sort()).toEqual([
      "id",
      "outletId",
      "plannedVisitId",
      "productivity",
      "serviceDate",
      "state",
    ]);
    expect(row.state).toBe("checked-out");
    expect(row.serviceDate).toBe(date);
    const foreign =
      await h.db`select id from visit_executions where assignee_profile_id<>${who.profile.id}`;
    const ids = new Set(foreign.map((/** @type {any} */ r) => r.id));
    expect(rows.some((/** @type {any} */ r) => ids.has(r.id))).toBe(false);
  });
  test("visit delta and tombstone preserve v2 DTO and advancing cursor", async () => {
    const first = await pull();
    await tx(h.db, async (db) => {
      await db`update visit_executions set state='checked-out',checked_out_at=now(),productivity='verified' where id=${f.visit}`;
      await recordChange(db, {
        entity: "visit",
        entityId: f.visit,
        scopeKey: `profile:${who.profile.id}`,
      });
    });
    const delta = await pull(
      "field.bundle",
      { dayFrom: date },
      { since: first.body.nextCursor },
    );
    expect(delta.res.status).toBe(200);
    expect(delta.body.bundles[0].mode).toBe("delta");
    expect(delta.body.bundles[0].changes[0].value.state).toBe("checked-out");
    await tx(h.db, async (db) => {
      await db`update visit_executions set deleted_at=now() where id=${f.visit}`;
      await recordChange(db, {
        entity: "visit",
        entityId: f.visit,
        scopeKey: `profile:${who.profile.id}`,
        op: "tombstone",
      });
    });
    const deleted = await pull(
      "field.bundle",
      { dayFrom: date },
      { since: delta.body.nextCursor },
    );
    expect(deleted.body.bundles[0].changes[0].op).toBe("tombstone");
    expect(deleted.body.bundles[0].changes[0].value).toBeNull();
    const empty = await pull(
      "field.bundle",
      { dayFrom: date },
      { since: deleted.body.nextCursor },
    );
    expect(empty.body.bundles[0].changes).toEqual([]);
    expect(empty.body.nextCursor).toBeString();
  });
  test("plan change forces rebootstrap even without another lane recording a change", async () => {
    const first = await pull();
    await h.db`update coverage_plans set content_revision=content_revision+1 where id=${f.plan}`;
    const delta = await pull(
      "field.bundle",
      { dayFrom: date },
      { since: first.body.nextCursor },
    );
    expect(delta.res.status).toBe(409);
    expect(delta.body.error.code).toBe("rebootstrap_required");
    const fresh = await pull();
    expect(fresh.res.status).toBe(200);
    const stale = await pull(
      "field.bundle",
      { dayFrom: date },
      { since: first.body.nextCursor },
    );
    expect(stale.body.error.code).toBe("rebootstrap_required");
    const renewed = await pull(
      "field.bundle",
      { dayFrom: date },
      { since: fresh.body.nextCursor },
    );
    expect(renewed.res.status).toBe(200);
  });
  test("outlet assignment changes invalidate reference manifest", async () => {
    const first = await pull();
    await h.db`update outlet_customer_links set reason='new assignment' where outlet_id=${f.outlet}`;
    const delta = await pull(
      "field.bundle",
      { dayFrom: date },
      { since: first.body.nextCursor },
    );
    expect(delta.body.error.code).toBe("rebootstrap_required");
  });
  test("field.sales gates source creator and location even with shared customer code", async () => {
    const [foreign] =
      await h.db`insert into org_units(organization_id,code,name,type_code,status,effective_from) values ('sunpride','FOREIGN','Foreign','region','active','2026-01-01') returning id`;
    const [location] =
      await h.db`insert into inventory_locations(organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values ('sunpride',${foreign.id},'SITE','REMOTE','Remote','warehouse',true,true,true,true,false) returning id`;
    for (const [number, subject, source, amount] of [
      ["O1", who.userId, null, 100],
      ["O2", who.userId, location.id, 200],
      ["O3", "foreign-subject", null, 300],
    ]) {
      const [order] =
        await h.db`insert into orders(organization_id,client_request_id,order_number,customer_code,salesperson_subject,status,subtotal,total,source_location_id,created_at) values ('sunpride',${crypto.randomUUID()},${number},'C1',${subject},'approved',${amount},${amount},${source},${new Date(now)}) returning id`;
      await h.db`insert into order_lines(order_id,product_code,description,quantity,unit_price,line_total) values (${order.id},'SKU1','Sample product',1,${amount},${amount})`;
    }
    const result = await pull("field.sales", {
      profileId: who.profile.id,
      serviceDate: date,
    });
    expect(result.res.status).toBe(200);
    expect(result.body.bundles[0].data.totals.todaySales).toBe(10000);
    const bundle = await pull();
    expect(
      bundle.body.bundles[0].data.accountSummaries[0].sales.amountMinor,
    ).toBe(10000);
  });
  test("suggestions explicitly unavailable without analytics read model", async () => {
    const r = await pull("suggested-order", {
      outletId: f.outlet,
      asOfDate: date,
    });
    expect(r.res.status).toBe(200);
    expect(r.body.bundles[0].data.lines).toEqual([]);
    expect(r.body.bundles[0].data.historyStatus).toBe("analytics_unavailable");
  });
});

describe("location work/consent boundary and retention", () => {
  test("explicit Start day admits pings before the first visit and retries preserve its boundary", async () => {
    await h.db`delete from visit_executions where id=${f.visit}`;
    const startedAt = Date.now();
    expect(
      (
        await api("/api/v1/location/consent", {
          enabled: true,
          startDay: true,
          startedAt,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api("/api/v1/location/consent", {
          enabled: true,
          startDay: true,
          startedAt: startedAt + 1,
        })
      ).status,
    ).toBe(200);
    const [day] =
      await h.db`select started_at,ended_at from fieldsync_work_days where profile_id=${who.profile.id}`;
    expect(new Date(day.started_at).getTime()).toBe(startedAt);
    expect(day.ended_at).toBeNull();
    expect(
      (await push([ping({ recordedAt: startedAt + 11_000, visitId: null })]))
        .body.results[0].status,
    ).toBe("applied");
    const [audit] =
      await h.db`select count(*)::int n from audit_logs where action='location.start_day'`;
    expect(audit.n).toBe(1);
  });
  test("only an explicit Start day reopens an ended period and closed-gap pings stay refused", async () => {
    expect((await push([ping()])).body.results[0].status).toBe("applied");
    expect((await api("/api/v1/location/end-day", {})).status).toBe(200);
    const [closed] =
      await h.db`select ended_at from fieldsync_work_days where profile_id=${who.profile.id}`;
    const end = new Date(closed.ended_at).getTime();
    const startedAt = end + 20_000;
    expect(
      (
        await api("/api/v1/location/consent", {
          enabled: true,
          startDay: true,
          startedAt: end,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api("/api/v1/location/consent", {
          enabled: true,
          startDay: true,
          startedAt,
        })
      ).status,
    ).toBe(200);
    expect(
      (await push([ping({ recordedAt: end + 1000 })])).body.results[0].code,
    ).toBe("invalid_transition");
    expect(
      (await push([ping({ recordedAt: startedAt + 11_000 })])).body.results[0]
        .status,
    ).toBe("applied");
    const [audit] =
      await h.db`select details from audit_logs where action='location.start_day'`;
    expect(JSON.parse(audit.details).previousEndedAt).toBe(end);
  });
  test("Start day refuses disabled consent, invalid timestamps and the daily close", async () => {
    for (const payload of [
      { enabled: false, startDay: true },
      { enabled: true, startDay: true, startedAt: "now" },
      { enabled: true, startDay: true, startedAt: null },
      {
        enabled: true,
        startDay: true,
        startedAt: midnight(date) + 4 * 3_600_000,
      },
      { enabled: true, startDay: true, startedAt: closeAt(date) },
    ]) {
      expect((await api("/api/v1/location/consent", payload)).status).toBe(400);
    }
    const [rows] = await h.db`select count(*)::int n from fieldsync_work_days`;
    expect(rows.n).toBe(0);
  });
  test("records and replays one UUID without duplicating location rows", async () => {
    const op = ping();
    const first = await push([op]);
    expect(first.res.status).toBe(200);
    expect(first.body.results[0].status).toBe("applied");
    const replay = await push([op]);
    expect(replay.body.results[0].status).toBe("duplicate");
    expect(replay.body.results[0].ack).toEqual(first.body.results[0].ack);
    const [n] = await h.db`select count(*)::int as n from location_pings`;
    expect(n.n).toBe(1);
    const live = await api("/api/v1/location/live");
    expect(live.status).toBe(200);
    expect(live.body.positions[0].planned).toBe(1);
    expect(live.body.positions[0].visited).toBe(1);
    expect(live.body.positions[0].productive).toBe(0);
  });
  test("map workload includes a planned person before any location ping", async () => {
    const live = await api("/api/v1/location/live");
    expect(live.status).toBe(200);
    expect(live.body.positions).toEqual([]);
    expect(live.body.trend.at(-1).planned).toBe(1);
  });
  test("refuses before first check-in, after End day, and at 22:00", async () => {
    const before = await push([ping({ recordedAt: now - 2 * 3_600_000 })]);
    expect(before.body.results[0].status).toBe("rejected");
    const end = await api("/api/v1/location/end-day", {});
    expect(end.status).toBe(200);
    const after = await push([ping({ recordedAt: Date.now() + 1000 })]);
    expect(after.body.results[0].code).toBe("invalid_transition");
    const yesterday = manilaDate(midnight(date) - 1);
    const late = await push([ping({ recordedAt: closeAt(yesterday) })]);
    expect(late.body.results[0].status).toBe("rejected");
    const [n] = await h.db`select count(*)::int as n from location_pings`;
    expect(n.n).toBe(0);
  });
  test("consent is explicit, historical and revocable", async () => {
    await h.db`delete from fieldsync_location_consents where profile_id=${who.profile.id}`;
    expect((await push([ping()])).body.results[0].code).toBe(
      "invalid_transition",
    );
    expect((await api("/api/v1/location/consent")).body.enabled).toBe(false);
    expect(
      (await api("/api/v1/location/consent", { enabled: true })).status,
    ).toBe(200);
    expect((await api("/api/v1/location/consent")).body.enabled).toBe(true);
    expect(
      (await push([ping({ recordedAt: Date.now() })])).body.results[0].status,
    ).toBe("applied");
    await api("/api/v1/location/consent", { enabled: false });
    expect(
      (await push([ping({ recordedAt: Date.now() + 1000, trigger: "moving" })]))
        .body.results[0].status,
    ).toBe("rejected");
  });
  test("late buffered fix never rewinds live head and fanout coalesces", async () => {
    expect(
      (await push([ping({ recordedAt: now, trigger: "start" })])).body
        .results[0].status,
    ).toBe("applied");
    expect(
      (
        await push([
          ping({ recordedAt: now - 60_000, latitude: 10.4, trigger: "start" }),
        ])
      ).body.results[0].status,
    ).toBe("applied");
    const [head] = await h.db`select latitude,recorded_at from live_locations`;
    expect(head.latitude).toBe(10.3);
    const [jobs] =
      await h.db`select count(*)::int as n from jobs where kind='fieldsync.location-publish' and status='pending'`;
    expect(jobs.n).toBe(1);
  });
  test("purges past 90 days, keeps exact boundary and fresh rows", async () => {
    await push([ping()]);
    await h.db`update location_pings set recorded_at=${new Date(now - 90 * DAY_MS - 1)}`;
    await h.db`update live_locations set recorded_at=${new Date(now - 90 * DAY_MS)}`;
    const result = await purgeExpired(h.db, now);
    expect(result.deleted).toBe(1);
    expect(result.more).toBe(false);
    expect((await h.db`select id from location_pings`).length).toBe(0);
    expect((await h.db`select id from live_locations`).length).toBe(1);
  });
  test("day close closes days and stops live tracking; rerun is idempotent", async () => {
    await push([ping()]);
    const result = await closeDays(h.db, {
      now: closeAt(date),
      vanAbsent: true,
    });
    expect(result.closed).toBe(1);
    expect(result.positions).toBe(1);
    const [day] =
      await h.db`select ended_at,end_reason from fieldsync_work_days`;
    expect(new Date(day.ended_at).getTime()).toBe(closeAt(date));
    expect(day.end_reason).toBe("daily_close");
    const second = await closeDays(h.db, {
      now: closeAt(date) + 1,
      vanAbsent: true,
    });
    expect(second.closed).toBe(0);
    expect(second.positions).toBe(0);
  });
  test("trail returns time-ordered fixes, visited and off-plan stops, distance", async () => {
    await push([
      ping({ recordedAt: now - 60_000, trigger: "start" }),
      ping({ recordedAt: now, latitude: 10.31, trigger: "moving" }),
    ]);
    // The previous planned stop must close before an off-plan call can start.
    await h.db`update visit_executions set state='completed',checked_out_at=${new Date(now - 30_000)} where id=${f.visit}`;
    await h.db`insert into visit_executions(organization_id,client_visit_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,state,productivity,last_server_time,checked_in_at,unplanned_reason)
      values ('sunpride',${crypto.randomUUID()},${who.profile.id},${f.outlet},${f.unit},${date},'unplanned','checked-in','pending',${new Date(now - 15_000)},${new Date(now - 15_000)},'sample off-plan stop')`;
    const result = await api(
      `/api/v1/location/trail?profileId=${who.profile.id}&date=${date}`,
    );
    expect(result.status).toBe(200);
    expect(result.body.pings).toHaveLength(2);
    expect(result.body.distanceKm).toBeGreaterThan(1);
    expect(result.body.stops[0].onPlan).toBe(true);
    expect(result.body.stops[1].onPlan).toBe(false);
    expect(result.body.stops[1].latitude).toBe(10.31);
    expect(result.body.stops[1].pinned).toBe(false);
    expect(result.body.plannedStops[0].visited).toBe(true);
  });
  test("manager sees their team only, not a peer in the same unit", async () => {
    await push([ping()]);
    const manager = await boundDevice(h, profiles, {
      role: "manager",
      orgUnitId: f.unit,
    });
    await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values (${manager.profile.id},${manager.userId},${manager.userId},'Supervisor',${manager.email},'manager','active',${f.unit})`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,supervisor_id,effective_from,actor_subject,reason) values (${who.profile.id},${f.unit},'sales',${manager.profile.id},'2026-01-01','test','team')`;
    const old = who;
    who = manager;
    const live = await api("/api/v1/location/live");
    expect(live.status).toBe(200);
    expect(
      live.body.positions.map((/** @type {any} */ p) => p.profileId),
    ).toEqual([old.profile.id]);
    const team = await pull("team.summary", {
      serviceDate: date,
      directOnly: true,
    });
    expect(team.res.status).toBe(200);
    expect(
      team.body.bundles[0].data.people.map(
        (/** @type {any} */ p) => p.profileId,
      ),
    ).toEqual([old.profile.id]);
    await h.db`delete from employee_assignments where profile_id=${old.profile.id}`;
    expect((await api("/api/v1/location/live")).body.positions).toEqual([]);
    expect(
      (
        await api(
          `/api/v1/location/trail?profileId=${old.profile.id}&date=${date}`,
        )
      ).status,
    ).toBe(403);
  });

  test("100-ping batches are accepted; 101 is refused by core before ingestion", async () => {
    const operations = Array.from({ length: 100 }, (_, i) =>
      ping({ recordedAt: now - 1_800_000 + i * 10_000, visitId: null }),
    );
    const result = await push(operations);
    expect(result.res.status).toBe(200);
    expect(
      result.body.results.filter(
        (/** @type {any} */ r) => r.status === "applied",
      ),
    ).toHaveLength(100);
    const oversized = await push([...operations, ping()]);
    expect(oversized.res.status).toBe(400);
    const [n] = await h.db`select count(*)::int as n from location_pings`;
    expect(n.n).toBe(100);
  }, 15000);

  test("old buffered fixes after consent withdrawal cannot resume live sharing", async () => {
    await push([ping({ recordedAt: now - 60_000, trigger: "start" })]);
    await api("/api/v1/location/consent", { enabled: false });
    const buffered = await push([
      ping({ recordedAt: now - 30_000, trigger: "start" }),
    ]);
    expect(buffered.body.results[0].status).toBe("applied");
    const [head] = await h.db`select tracking_ended from live_locations`;
    expect(head.tracking_ended).toBe(true);
    expect((await api("/api/v1/location/live")).body.positions[0].status).toBe(
      "offline",
    );
  });

  test("old buffered fixes after End day cannot resume live sharing", async () => {
    await push([ping({ recordedAt: now - 60_000, trigger: "start" })]);
    await api("/api/v1/location/end-day", {});
    const buffered = await push([
      ping({ recordedAt: now - 30_000, trigger: "start" }),
    ]);
    expect(buffered.body.results[0].status).toBe("applied");
    const [head] = await h.db`select tracking_ended from live_locations`;
    expect(head.tracking_ended).toBe(true);
  });

  test("retention continues in durable bounded jobs until expired rows are gone", async () => {
    await push([ping()]);
    await h.db`insert into location_pings(organization_id,kind,profile_id,device_id,client_ping_id,org_unit_id,service_date,latitude,longitude,accuracy_meters,mock_location,provider,trigger,recorded_at,received_at)
      select 'sunpride','field',${who.profile.id}::uuid,${who.deviceId}::uuid,gen_random_uuid()::text,${f.unit}::uuid,${date}::date,10.3,123.9,10,false,'gps','still',${new Date(now - 91 * DAY_MS)},now() from generate_series(1,501)`;
    const first = await purgeExpired(h.db, now);
    expect(first.deleted).toBe(500);
    expect(first.more).toBe(true);
    // The domain clock is pinned; make its continuation due on the real SQL scheduler clock.
    await h.db`update jobs set run_at=now() where kind='fieldsync.location-purge' and status='pending'`;
    await h.app.scheduler.drain();
    const [n] = await h.db`select count(*)::int as n from location_pings`;
    expect(n.n).toBe(1);
    const [pending] =
      await h.db`select count(*)::int as n from jobs where kind='fieldsync.location-purge' and status='pending'`;
    expect(pending.n).toBe(0);
  });

  test("van location requires its bound active trip; daily fallback changes status only", async () => {
    const field = who;
    const van = await boundDevice(h, profiles, {
      orgUnitId: f.unit,
      app: "van-android",
    });
    await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values (${van.profile.id},${van.userId},${van.userId},'Van seller',${van.email},'sales','active',${f.unit})`;
    await h.db`insert into fieldsync_location_consents(profile_id,enabled,effective_from) values (${van.profile.id},true,${new Date(now - 2 * 3_600_000)})`;
    const [location] =
      await h.db`insert into inventory_locations(organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production)
      values ('sunpride',${f.unit},'S','TRUCK','Truck','truck',true,true,true,true,false) returning id`;
    const [vehicle] =
      await h.db`insert into vehicles(organization_id,org_unit_id,vehicle_code,plate_number,truck_location_id,home_location_id,status,created_by)
      values ('sunpride',${f.unit},'V1','TEST-01',${location.id},${location.id},'active','test') returning id`;
    const [trip] =
      await h.db`insert into van_trips(organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,started_at,started_device_id,created_by)
      values ('sunpride',${f.unit},'TRIP-TEST',${vehicle.id},${location.id},${location.id},${date},${van.profile.id},${van.userId},'active',${new Date(now - 3_600_000)},${van.deviceId},'test') returning *`;
    who = van;
    const accepted = await push([ping({ tripId: trip.id, visitId: null })]);
    expect(accepted.body.results[0].status).toBe("applied");
    const atStore = await api("/api/v1/location/live");
    expect(atStore.body.positions[0].kind).toBe("van");
    expect(atStore.body.positions[0].vehicleLabel).toBe("V1 · TEST-01");
    const untouched = await closeDays(h.db, {
      now: closeAt(date),
      vanAbsent: false,
    });
    expect(untouched.trips).toBe(0);
    expect(
      (await h.db`select status from van_trips where id=${trip.id}`)[0].status,
    ).toBe("active");
    const closed = await closeDays(h.db, {
      now: closeAt(date),
      vanAbsent: true,
    });
    expect(closed.trips).toBe(1);
    const [after] = await h.db`select * from van_trips where id=${trip.id}`;
    expect(after.status).toBe("review_required");
    expect(after.closed_at).toBeNull();
    expect(after.started_at).toEqual(trip.started_at);
    expect(after.start_note).toEqual(trip.start_note);
    const refused = await push([
      ping({
        tripId: trip.id,
        visitId: null,
        trigger: "start",
        recordedAt: now + 10_000,
      }),
    ]);
    expect(refused.body.results[0].code).toBe("invalid_transition");
    who = field;
  });

  test("idle flag uses movement or visit evidence, not phone silence alone", async () => {
    await push([ping({ recordedAt: now - 46 * 60_000, trigger: "start" })]);
    await push([ping()]);
    const idle = await api("/api/v1/location/live");
    expect(idle.body.positions[0].idleFlag).toBe(true);
    expect(idle.body.positions[0].freshness).toBe("fresh");
    await h.db`update visit_executions set last_server_time=${new Date(Date.now())} where id=${f.visit}`;
    const active = await api("/api/v1/location/live");
    expect(active.body.positions[0].idleFlag).toBe(false);
    expect(active.body.positions[0].status).toBe("at-store");
    expect(active.body.trend.at(-1).planned).toBe(
      active.body.positions[0].planned,
    );
    expect(active.body.trend.at(-1).visited).toBe(
      active.body.positions[0].visited,
    );
  });

  test("daily jobs are registered at 19:40 and 22:00 Manila", async () => {
    const tasks = h.app.scheduler.tasks;
    const purge = tasks.find((t) => t.name === "fieldsync.location-purge");
    const close = tasks.find((t) => t.name === "fieldsync.day-close");
    expect(
      new Date(/** @type {any} */ (purge).next() + 28_800_000)
        .toISOString()
        .slice(11, 16),
    ).toBe("19:40");
    expect(
      new Date(/** @type {any} */ (close).next() + 28_800_000)
        .toISOString()
        .slice(11, 16),
    ).toBe("22:00");
  });

  test("scoped trail and live filters reject a foreign unit", async () => {
    const id = crypto.randomUUID();
    expect((await api(`/api/v1/location/live?orgUnitId=${id}`)).status).toBe(
      403,
    );
    expect(
      (await api(`/api/v1/location/trail?profileId=${id}&date=${date}`)).status,
    ).toBe(403);
    expect(
      (
        await api(
          `/api/v1/location/trail?profileId=${who.profile.id}&date=2026-02-30`,
        )
      ).status,
    ).toBe(400);
  });
});

describe("projection completeness, scheduled fences and authorized inventory", () => {
  test("reads the analytics recommendation model when installed, rather than synthesizing orders", async () => {
    await h.db`create table analytics_suggested_orders(outlet_id uuid,as_of_date date,product_id uuid,code text,name text,unit text,status text,suggested_quantity bigint,reasons text[])`;
    await h.db`insert into analytics_suggested_orders values (${f.outlet},${date},${f.product},'SKU1','Sample product','PC','suggest',6,array['analytics_fixture'])`;
    const r = await pull("suggested-order", {
      outletId: f.outlet,
      asOfDate: date,
    });
    expect(r.res.status).toBe(200);
    expect(r.body.bundles[0].data.historyStatus).toBe("available");
    expect(r.body.bundles[0].data.lines).toEqual([
      {
        productId: f.product,
        code: "SKU1",
        name: "Sample product",
        unit: "PC",
        status: "suggest",
        suggestedQuantity: 6,
        reasons: ["analytics_fixture"],
      },
    ]);
  });

  test("catalog emits every active barcode after an inactive history prefix", async () => {
    await h.db`insert into product_barcodes(organization_id,product_id,barcode,uom_id,active,source)
      select 'sunpride',${f.product}::uuid,'OLD-'||n,${f.uom}::uuid,false,'sample' from generate_series(1,30) n`;
    await h.db`insert into product_barcodes(organization_id,product_id,barcode,uom_id,active,source)
      select 'sunpride',${f.product}::uuid,'ACTIVE-'||n,${f.uom}::uuid,true,'sample' from generate_series(1,25) n`;
    const r = await pull();
    expect(r.res.status).toBe(200);
    const barcodes = r.body.bundles[0].data.productCatalog[0].barcodes;
    expect(barcodes).toHaveLength(25);
    expect(
      barcodes.every((/** @type {any} */ b) => b.barcode.startsWith("ACTIVE-")),
    ).toBe(true);
    await h.db`update products set quantity_scale='9007199254740993' where id=${f.product}`;
    const refused = await pull();
    expect(refused.res.status).toBe(422);
    expect(refused.body.error.code).toBe("projection_overflow");
  });

  test("snapshot pagination keeps a closed typed bundle and invalidates a changed generation", async () => {
    const first = await pull("field.bundle", { dayFrom: date }, { limit: 1 });
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextCursor).toBeNull();
    let page = first;
    const photos = [...page.body.bundles[0].data.photoTypes];
    let pages = 1;
    while (page.body.hasMore) {
      page = await pull(
        "field.bundle",
        { dayFrom: date },
        { limit: 1, pageCursor: page.body.nextPageCursor },
      );
      expect(page.res.status).toBe(200);
      photos.push(...page.body.bundles[0].data.photoTypes);
      pages++;
      if (pages > 20) throw new Error("Unbounded snapshot");
    }
    expect(photos.map((/** @type {any} */ p) => p.code)).toEqual([
      "storefront",
      "shelf_display",
      "price_tag",
      "promotion",
      "other",
    ]);
    expect(page.body.nextCursor).toBeString();
    const again = await pull("field.bundle", { dayFrom: date }, { limit: 1 });
    await h.db`update coverage_plan_slots set sequence=2 where id=${f.slot}`;
    const refused = await pull(
      "field.bundle",
      { dayFrom: date },
      { limit: 1, pageCursor: again.body.nextPageCursor },
    );
    expect(refused.res.status).toBe(409);
    expect(refused.body.error.code).toBe("rebootstrap_required");
  });

  test("an assignment becoming effective after snapshot forces resnapshot without a new write", async () => {
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values (${who.profile.id},${f.unit},'sales',${new Date(now + 60_000)},'test','scheduled')`;
    const first = await pull();
    expect(first.res.status).toBe(200);
    const clock = spyOn(Date, "now").mockReturnValue(now + 61_000);
    try {
      const r = await pull(
        "field.bundle",
        { dayFrom: date },
        { since: first.body.nextCursor },
      );
      expect(r.res.status).toBe(409);
      expect(r.body.error.code).toBe("rebootstrap_required");
    } finally {
      clock.mockRestore();
    }
  });

  test("governed targets and day sales stay consistent with field.sales", async () => {
    await h.db`insert into sales_targets(organization_id,subject_kind,profile_id,period,metric,value,effective_from,source_ref,created_by)
      values ('sunpride','employee',${who.profile.id},'daily','sales_value',1000,${new Date(midnight(date))},'sample target','test')`;
    await h.db`insert into orders(organization_id,client_request_id,order_number,customer_code,salesperson_subject,status,subtotal,total,created_at)
      values ('sunpride',${crypto.randomUUID()},'TARGET-O1','C1',${who.userId},'approved',125.50,125.50,${new Date(now)})`;
    await h.db`insert into order_lines(order_id,product_code,description,quantity,unit_price,line_total) select id,'SKU1','Sample product',1,125.50,125.50 from orders where order_number='TARGET-O1'`;
    const report = await pull("field.sales", {
      profileId: who.profile.id,
      serviceDate: date,
    });
    expect(report.res.status).toBe(200);
    const bundle = await pull();
    const data = bundle.body.bundles[0].data;
    expect(data.daySales).toEqual({
      amountMinor: 12550,
      orders: 1,
      targetMinor: 100000,
    });
    expect(report.body.bundles[0].data.totals.todaySales).toBe(
      data.daySales.amountMinor,
    );
    expect(report.body.bundles[0].data.targets.daily).toBe(
      data.daySales.targetMinor,
    );
  });

  test("inventory snapshot/delta use the unit feed and scope reassignment forces bootstrap", async () => {
    const db = h.db;
    const [location] =
      await db`insert into inventory_locations(organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production)
      values ('sunpride',${f.unit},'S','DEPOT','Cebu depot','warehouse',true,true,true,true,false) returning id`;
    const [balance] =
      await db`insert into inventory_balances(product_code,warehouse_code,on_hand,reserved,available,as_of,organization_id,product_id,location_id,physical_base,reserved_base,available_base,version)
      values ('SKU1','DEPOT',12,2,10,now(),'sunpride',${f.product},${location.id},12,2,10,1) returning id`;
    const first = await pull();
    expect(first.res.status).toBe(200);
    expect(
      first.body.bundles[0].data.inventoryAvailability[0].availableBase,
    ).toBe(10);
    await tx(db, async (t) => {
      await t`update inventory_balances set available_base=8 where id=${balance.id}`;
      await recordChange(t, {
        entity: "inventory",
        entityId: balance.id,
        scopeKey: `unit:${f.unit}`,
      });
    });
    const delta = await pull(
      "field.bundle",
      { dayFrom: date },
      { since: first.body.nextCursor },
    );
    expect(delta.res.status).toBe(200);
    expect(delta.body.bundles[0].changes[0].value.availableBase).toBe(8);
    await db`update inventory_locations set org_unit_id=null where id=${location.id}`;
    await tx(db, async (t) => {
      await recordChange(t, {
        entity: "inventory",
        entityId: balance.id,
        scopeKey: `unit:${f.unit}`,
      });
    });
    const withdrawn = await pull(
      "field.bundle",
      { dayFrom: date },
      { since: delta.body.nextCursor },
    );
    expect(withdrawn.res.status).toBe(409);
    expect(withdrawn.body.error.code).toBe("rebootstrap_required");
  });
});
