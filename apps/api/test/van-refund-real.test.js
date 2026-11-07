import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  signedPost,
} from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { tx } from "@sunpride/db/client";
import { readFileSync } from "node:fs";
import { runDueJobs } from "../src/core/jobs.js";
import {
  today,
  units,
  extend,
  PAYMENT_METHODS,
} from "../src/domains/van/model.js";
import {
  stockCountCode,
  approvalCodeFor,
  approvalMessage,
  approvalKey,
} from "../src/domains/van/approvals.js";
import { tripDetail } from "../src/domains/van/queries.js";
import { canClaimMedia } from "../src/domains/van/media.js";
const { soldLotLines, truckLot } =
  await import("../src/domains/van/operations.js");

mock.module("../src/domains/orders/pricing.js", () => ({
  resolvePrice: async () => ({
    unitPriceCentavos: 12525,
    priceListId: null,
    source: "office",
    taxCode: "VAT12",
    taxBasisPoints: 1200,
    taxTreatment: "vatable",
    taxInclusive: true,
    sourceTaxInclusive: true,
    sourceUnitPriceCentavos: 12525,
  }),
  creditCheck: async () => ({ status: "within", limit: 1000000, exposure: 0 }),
}));
mock.module("../src/domains/org/scope.js", () => ({
  scopeFilterForActor: async (
    /** @type {any} */ _db,
    /** @type {any} */ actor,
  ) => ({ unitIds: actor.role === "super_admin" ? null : [actor.orgUnitId] }),
  outletOwnerUnit: async (/** @type {any} */ db, /** @type {string} */ id) =>
    (await db`select custodian_org_unit_id from outlets where id=${id}`)[0]
      ?.custodian_org_unit_id ?? null,
}));
/** @type {any[]} */ const refreshes = [];
mock.module("../src/domains/analytics/refresh.js", () => ({
  enqueueRefresh: async (/** @type {any} */ _ctx, /** @type {any} */ p) => {
    if (
      typeof _ctx.enqueue !== "function" ||
      typeof _ctx.publish !== "function"
    )
      throw new Error("Analytics seam needs the durable handler context");
    refreshes.push(p);
  },
}));
const { install } = await import("../src/domains/van/index.js");
const { install: installFiscal } =
  await import("../src/domains/fiscal/index.js");
/** @type {any} */ let h;
/** @type {any} */ let profiles;
const unit = crypto.randomUUID(),
  foreignUnit = crypto.randomUUID(),
  base = crypto.randomUUID(),
  caseId = crypto.randomUUID(),
  product = crypto.randomUUID(),
  outlet = crypto.randomUUID(),
  depot = crypto.randomUUID(),
  truck = crypto.randomUUID();
/** @type {any} */ let who;
/** @type {any} */ let manager;
let cookie = "";
let cmAllocation = "";
/** @param {any} user */
async function persistPerson(user) {
  const p = user.profile;
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user.userId},${user.userId},${p.name},${user.email},${p.role},'active',${p.orgUnitId})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${p.orgUnitId},${p.role},now()-interval '1 day','fixture','fixture')`;
}
beforeAll(async () => {
  h = await startHarness({
    installers: [
      install,
      installFiscal,
      (/** @type {any} */ router, /** @type {any} */ ctx) => {
        ctx.registerOp("test.suspend", async (/** @type {any} */ c) => {
          await c.db`update registered_devices set status='suspended' where id=${c.device.id}`;
          return { entityId: c.device.id };
        });
        ctx.registerOp("test.withdraw", async (/** @type {any} */ c) => {
          await c.db`update profiles set status='disabled' where id=${c.actor.profileId}`;
          return { entityId: c.actor.profileId };
        });
      },
    ],
  });
  profiles = profileStore(h);
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','VAN','Van team','national','active',now()-interval '1 day'),(${foreignUnit},'sunpride','OTHER','Other team','region','active',now()-interval '1 day')`;
  who = await boundDevice(h, profiles, { app: "van-android", orgUnitId: unit });
  await persistPerson(who);
  const userId = await createUser(
    h,
    "manager@example.com",
    "correct horse battery",
  );
  manager = {
    userId,
    email: "manager@example.com",
    profile: profiles.set(userId, {
      role: "super_admin",
      orgUnitId: unit,
      name: "Supervisor",
    }),
  };
  await persistPerson(manager);
  h.setHooks({
    loadProfile: async (/** @type {any} */ db, /** @type {string} */ id) => {
      const [p] =
        await db`select * from profiles where user_id=${id} and deleted_at is null`;
      return p
        ? {
            id: p.id,
            userId: p.user_id,
            name: p.name,
            role: p.role,
            orgUnitId: p.org_unit_id,
            status: p.status,
          }
        : null;
    },
  });
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: manager.email,
      password: "correct horse battery",
    }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  expect(login.status).toBe(200);
  await h.db`insert into units_of_measure(id,organization_id,code,name,dimension,decimal_places,active) values(${base},'sunpride','PC','Piece','count',0,true),(${caseId},'sunpride','CS','Case','count',0,true)`;
  await h.db`insert into products(id,organization_id,code,name,category,uom,unit_price,active,base_uom_id,quantity_scale) values(${product},'sunpride','SAMPLE','Sample product','Canned','PC',0,true,${base},1)`;
  await h.db`insert into uom_conversions(organization_id,product_id,from_uom_id,to_uom_id,numerator,denominator,rounding_mode,effective_from,active) values('sunpride',${product},${caseId},${base},12,1,'exact',now()-interval '1 day',true)`;
  for (const [id, code, type] of [
    [depot, "DEPOT", "warehouse"],
    [truck, "TRUCK", "truck"],
  ])
    await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${id},'sunpride',${unit},'CEBU',${code},${code},${type},true,true,true,true,false)`;
  await h.db`insert into inventory_balances(product_code,warehouse_code,on_hand,reserved,available,as_of,organization_id,product_id,location_id,physical_base,weighted_average_cost_minor) values('SAMPLE','TRUCK',0,0,0,now(),'sunpride',${product},${truck},0,10000)`;
  await h.db`insert into inventory_balances(product_code,warehouse_code,on_hand,reserved,available,as_of,organization_id,product_id,location_id,physical_base,available_stock_base,available_base,weighted_average_cost_minor,inventory_value_minor) values('SAMPLE','DEPOT',1000,0,1000,now(),'sunpride',${product},${depot},1000,1000,1000,10000,10000000)`;
  await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values(${outlet},'sunpride','STORE','Sample store','active',${unit},'GT','fixture')`;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('fiscal-test','org_units',${unit},'branch')`;
  for (const method of PAYMENT_METHODS)
    await h.db`insert into fiscal_tender_rules(org_unit_id,method,label,reference_label,enabled,effective_from,sample,entered_by) values(${unit},${method.code},${method.label},${method.referenceLabel},true,now()-interval '1 day',true,${manager.profile.id})`;
  const [reg] =
    await h.db`insert into fiscal_registrations(org_unit_id,entity_name,branch_name,tin,address,document_type,status,effective_from,entered_by,sample) values(${unit},'SAMPLE','Sample branch','SAMPLE TIN','Sample address','sales_invoice','sample_not_filed',now()-interval '1 day',${manager.profile.id},true) returning id`;
  const [series] =
    await h.db`insert into fiscal_series(registration_id,prefix,first_serial,last_serial,next_allocate,effective_from) values(${reg.id},'TEST-SI',1,1000,1,now()-interval '1 day') returning id`;
  const { allocateDocumentNumber } =
    await import("../src/domains/fiscal/series.js");
  await tx(h.db, async (db) =>
    allocateDocumentNumber(db, {
      actor: await actorFor(db, who.userId),
      deviceId: who.deviceId,
      seriesId: series.id,
      requestKey: crypto.randomUUID(),
      count: 1000,
    }),
  );
  // IP-REFUND: the credit-memo series (a refund is a credit memo), allocated to the phone like the invoice range
  const [cmReg] =
    await h.db`insert into fiscal_registrations(org_unit_id,entity_name,branch_name,tin,address,document_type,status,effective_from,entered_by,sample) values(${unit},'SAMPLE','Sample branch','SAMPLE TIN','Sample address','credit_memo','sample_not_filed',now()-interval '1 day',${manager.profile.id},true) returning id`;
  const [cmSeries] =
    await h.db`insert into fiscal_series(registration_id,prefix,first_serial,last_serial,next_allocate,effective_from) values(${cmReg.id},'TEST-CM',1,1000,1,now()-interval '1 day') returning id`;
  const cm = await tx(h.db, async (db) =>
    allocateDocumentNumber(db, {
      actor: await actorFor(db, who.userId),
      deviceId: who.deviceId,
      seriesId: cmSeries.id,
      requestKey: crypto.randomUUID(),
      count: 100,
    }),
  );
  cmAllocation = cm.allocationId;
}, 30000);
afterAll(async () => {
  await h?.close();
});
/** @param {string} path @param {any} body @param {string} [key] */
async function web(path, body, key = crypto.randomUUID()) {
  const res = await h.fetch(`/api/v1/van/${path}`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {string} type @param {any} payload */
function op(type, payload) {
  const at = Date.now();
  return {
    clientOpId: crypto.randomUUID(),
    opType: type,
    clientTime: at,
    dependsOn: [],
    payload: Object.assign(payload, { deviceTime: at }),
  };
}
/** @param {any[]} operations */
async function push(operations) {
  for (const op of operations)
    if (op.opType === "sale.record" && !op.payload.fiscal) {
      const [a] =
        await h.db`select a.*,s.prefix from fiscal_allocations a join fiscal_series s on s.id=a.series_id where a.device_id=${who.deviceId} order by a.created_at limit 1`;
      op.payload.fiscal = { allocationId: a.id, serial: String(a.next_issue) };
      op.payload.receiptNumber = `${a.prefix}-${String(a.next_issue).padStart(9, "0")}`;
    }
  return signedPost(h, who, "/api/sync/push", {
    version: 2,
    app: "van-android",
    deviceId: who.deviceId,
    scopeId: unit,
    operations,
  });
}
/** @type {any} */ let trip;
/** @type {any} */ let load;
/** @type {any[]} */ const accepted = [];
/** @param {any} operation */
async function apply(operation) {
  const r = await push([operation]);
  expect(r.res.status).toBe(200);
  expect(r.body.results[0].status).toBe("applied");
  accepted.push(operation);
  return r.body.results[0];
}
/** @param {number} sequence @param {number} qty */
function salePayload(sequence, qty) {
  const total = String(qty * 12525);
  return {
    tripId: trip.tripId,
    saleId: crypto.randomUUID(),
    receiptNumber: `${trip.tripNumber}-AABBCCDD-${String(sequence).padStart(4, "0")}`,
    customer: { outletId: outlet },
    currency: "PHP",
    totalMinor: total,
    lines: [
      {
        productId: product,
        quantityBase: String(qty),
        paidBase: String(qty),
        freeBase: "0",
        unitPriceMinor: "12525",
        grossMinor: total,
        discountMinor: "0",
        totalMinor: total,
      },
    ],
    payment: {
      method: "cash",
      kind: "cash",
      amountMinor: total,
      tenderedMinor: total,
      changeMinor: "0",
      status: "paid",
    },
  };
}

const { cashExpectation } = await import("../src/domains/van/facts.js");
const pay = (/** @type {string} */ saleId) =>
  h.db`select kind,method,amount_centavos::text as amount from van_payments where sale_id=${saleId} order by created_at,method`;
const truckStock = async () =>
  (
    await h.db`select available_base::text as a,damaged_base::text as d from inventory_balances where location_id=${truck} and product_id=${product}`
  )[0];
/** A refund op the way the phone builds it. @param {any} sale @param {string} qty @param {string} reasonCode @param {string} expected @param {any} [extra] */
async function refundOp(sale, qty, reasonCode, expected, extra = {}) {
  const [c] =
    await h.db`select next_issue from fiscal_allocations where id=${cmAllocation}`;
  const serial = String(c.next_issue);
  const o = op("refund.record", {
    tripId: trip.tripId,
    originalSale: { saleId: sale.saleId, receiptNumber: sale.receiptNumber },
    lines: [{ lineIndex: 0, productId: product, quantityBase: qty }],
    reasonCode,
    note: null,
    expectedMinor: expected,
    fiscal: { allocationId: cmAllocation, serial },
    creditNumber: `TEST-CM-${serial.padStart(9, "0")}`,
    refundNumber: 1,
    ...extra,
  });
  o.payload.refundId = o.clientOpId;
  return o;
}
/** @param {any} operation */
async function send(operation) {
  const r = await push([operation]);
  expect(r.res.status).toBe(200);
  return r.body.results[0];
}

test("van setup: trip started with stock on the truck, a 3-piece cash sale", async () => {
  const v = await web("vehicles/create", {
    orgUnitId: unit,
    vehicleCode: "V1",
    plateNumber: "SAMPLE",
    truckLocationId: truck,
    homeLocationId: depot,
  });
  const t = await web("trips/plan", {
    vehicleId: v.body.vehicleId,
    salespersonProfileId: who.profile.id,
    serviceDate: today(),
  });
  trip = t.body;
  const l = await web("loads/plan", {
    tripId: trip.tripId,
    lines: [{ productId: product, expectedBase: "48" }],
  });
  load = l.body;
  await apply(
    op("load.confirm", {
      tripId: trip.tripId,
      loadId: load.loadId,
      lines: [{ lineNumber: 1, actualBase: "48" }],
    }),
  );
  await apply(
    op("trip.start", {
      tripId: trip.tripId,
      vehicleConfirmed: true,
      routeConfirmed: true,
    }),
  );
});


// IP-INT5FIX: these run the REAL stock writer (no postMovement mock), so cost behaviour is what production does.
const bal = async () =>
  (
    await h.db`select available_base::text as a, physical_base::text as p, weighted_average_cost_minor::text as wac, inventory_value_minor::text as val from inventory_balances where location_id=${truck} and product_id=${product}`
  )[0];

test("a van refund puts the goods back at the cost the sale took them out at: the truck's weighted average cost does not move", async () => {
  const s1 = salePayload(1, 3);
  await apply(op("sale.record", s1));
  const before = await bal();
  const o = await refundOp(s1, "1", "RF-CHANGED-MIND", "12525");
  await apply(o);
  const after = await bal();
  expect(after.wac).toBe(before.wac);
  expect(Number(after.p)).toBe(Number(before.p) + 1);
  // the inbound line carries the sale's unit cost, not zero
  const [sold] =
    await h.db`select l.unit_cost_minor::text as c from inventory_movement_lines l join inventory_movements m on m.id=l.movement_id where m.source_type='van_sale' and m.source_document_id=${s1.saleId} and l.product_id=${product} limit 1`;
  const [back] =
    await h.db`select l.unit_cost_minor::text as c from inventory_movement_lines l join inventory_movements m on m.id=l.movement_id where m.source_type='van_refund' and m.source_document_id=${o.clientOpId} and l.product_id=${product} limit 1`;
  expect(Number(sold.c)).toBeGreaterThan(0);
  expect(back.c).toBe(sold.c);
  // a second and third refund keep it too
  await apply(await refundOp(s1, "1", "RF-CHANGED-MIND", "12525", { refundNumber: 2 }));
  expect((await bal()).wac).toBe(before.wac);
});

test("splitting a receipt into refunds that are each under the supervisor amount still needs approval once the total is over it", async () => {
  // 12 x 125.25 = 1503.00; the amount is 500.00; each refund of 3 pieces is 375.75
  const s2 = salePayload(2, 12);
  await apply(op("sale.record", s2));
  const r1 = await refundOp(s2, "3", "RF-CHANGED-MIND", "37575");
  expect((await send(r1)).status).toBe("applied");
  // 375.75 + 375.75 is over 500.00: no code, refused
  const bare = await refundOp(s2, "3", "RF-CHANGED-MIND", "37575", { refundNumber: 2 });
  const rejected = await send(bare);
  expect(rejected.status).toBe("rejected");
  // with the office's code for exactly this refund it goes through
  const issued = await web("refund/approval-code", {
    receiptNumber: s2.receiptNumber,
    totalMinor: "37575",
    reasonCode: "RF-CHANGED-MIND",
    refundNumber: 2,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  const good = await refundOp(s2, "3", "RF-CHANGED-MIND", "37575", {
    refundNumber: 2,
    approval: { method: "supervisor_code", code: issued.body.code },
  });
  expect((await send(good)).status).toBe("applied");
  const [{ n }] =
    await h.db`select count(*)::int as n from sale_refunds where sale_id=${s2.saleId}`;
  expect(n).toBe(2);
});

test("the trip's and the day's sales figures are net of part refunds (settlement, trip detail, scorecard, day board)", async () => {
  const [gross] =
    await h.db`select coalesce(sum(total_centavos),0)::text as t from van_sales where trip_id=${trip.tripId}`;
  const [refunded] =
    await h.db`select coalesce(sum(total_centavos),0)::text as t from sale_refunds where trip_id=${trip.tripId}`;
  expect(BigInt(refunded.t)).toBeGreaterThan(0n);
  const net = String(BigInt(gross.t) - BigInt(refunded.t));
  const detail = await tripDetail(h.db, await actorFor(h.db, manager.userId), trip.tripId);
  expect(String(detail.salesCentavos)).toBe(net);
  const { tripScorecard } = await import("../src/domains/van/scorecard.js");
  const [row] = await h.db`select * from van_trips where id=${trip.tripId}`;
  const card = await tripScorecard(h.db, row);
  expect(card.salesCentavos).toBe(net);
  expect(card.monthSalesCentavos).toBe(net);
  // the trend and the same-month figure read the same net number
  expect(card.trend.at(-1).salesCentavos).toBe(net);
  // the day board
  const res = await h.fetch(`/api/v1/van/day-board?date=${today()}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const board = JSON.stringify(await res.json());
  expect(board).toContain(`"salesCentavos":${net}`);
});

test("a refund list over 500 is trimmed to the most recent 500 and flagged, never refused", async () => {
  const { tripRefunds } = await import("../src/domains/van/refunds.js");
  const { recentRefunds } = await import("../src/domains/storepos/bundle.js");
  const fake = (/** @type {number} */ n) =>
    // newest first, like the queries: row 0 is the newest
    (async () =>
      Array.from({ length: n }, (_, i) => ({
        id: `r${i}`,
        sale_id: "s",
        credit_number: `CM-${i}`,
        total: "100",
        reason_code: "RF-CHANGED-MIND",
        tenders: [],
        lines: [],
        refunded_at: new Date(1_800_000_000_000 - i * 1000),
      })));
  const many = await tripRefunds(/** @type {any} */ (fake(501)), "t");
  expect(many.madeComplete).toBe(false);
  expect(many.made).toHaveLength(500);
  expect(many.made.some((/** @type {any} */ r) => r.id === "r500")).toBe(false); // the oldest is the one dropped
  expect(many.made.at(-1).id).toBe("r0"); // oldest first, newest last, as before
  const few = await tripRefunds(/** @type {any} */ (fake(3)), "t");
  expect(few).toMatchObject({ madeComplete: true });
  expect(few.made).toHaveLength(3);
  const store = await recentRefunds(/** @type {any} */ (fake(501)), "reg");
  expect(store.madeComplete).toBe(false);
  expect(store.made).toHaveLength(500);
  expect(store.made[0].id).toBe("r0"); // newest first on the till, as before
  expect((await recentRefunds(/** @type {any} */ (fake(2)), "reg")).madeComplete).toBe(true);
});

// IP-RCOST: the other van ways to put a sale back (a linked return, a whole-sale void) also restock at the sale's cost.
const saleLineCost = async (/** @type {string} */ saleId) =>
  Number(
    (
      await h.db`select l.unit_cost_minor::text as c from inventory_movement_lines l join inventory_movements m on m.id=l.movement_id where m.source_type='van_sale' and m.source_document_id=${saleId} and l.product_id=${product} limit 1`
    )[0].c,
  );
const backCost = async (/** @type {string} */ type, /** @type {string} */ id) =>
  (
    await h.db`select l.unit_cost_minor::text as c from inventory_movement_lines l join inventory_movements m on m.id=l.movement_id where m.source_type=${type} and m.source_document_id=${id} and l.product_id=${product}`
  ).map((/** @type {any} */ r) => Number(r.c));

test("a linked van return restocks at the sale's cost: the truck's weighted average cost does not move", async () => {
  const s = salePayload(20, 4);
  await apply(op("sale.record", s));
  const before = await bal();
  const returnId = crypto.randomUUID();
  await apply(
    op("return.record", {
      tripId: trip.tripId,
      returnId,
      returnNumber: `${trip.tripNumber}-AABBCCDD-0021`,
      customer: { outletId: outlet },
      originalSale: { saleId: s.saleId, receiptNumber: s.receiptNumber },
      lines: [
        {
          productId: product,
          quantityBase: "2",
          stockEffect: "available",
          reason: "wrong_item",
          disposition: "resellable",
          approvalRequired: false,
        },
      ],
    }),
  );
  const after = await bal();
  expect(Number(after.p)).toBe(Number(before.p) + 2);
  const cost = await saleLineCost(s.saleId);
  expect(cost).toBeGreaterThan(0);
  expect(await backCost("van_return", returnId)).toEqual([cost]);
  expect(after.wac).toBe(before.wac);
  expect(Number(after.val)).toBe(Number(before.val) + 2 * cost);
});

test("a van whole-sale void restocks at the sale's cost: the truck's weighted average cost does not move", async () => {
  const s = salePayload(22, 5);
  await apply(op("sale.record", s));
  const before = await bal();
  const facts = {
    receiptNumber: s.receiptNumber,
    totalMinor: s.totalMinor,
    reasonCode: "wrong_items",
  };
  await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,offline_allowed,effective_from,sample) values(${unit},'void','sales','GT',0,100000000,0,${["super_admin"]},true,now()-interval '1 day',true)`;
  const issued = await web("void/approval-code", facts);
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  await apply(
    op("sale.void", {
      tripId: trip.tripId,
      saleId: s.saleId,
      ...facts,
      approval: { method: "supervisor_code", code: issued.body.code },
    }),
  );
  const [v] = await h.db`select id from van_sale_voids where sale_id=${s.saleId}`;
  const after = await bal();
  expect(Number(after.p)).toBe(Number(before.p) + 5);
  const cost = await saleLineCost(s.saleId);
  expect(await backCost("van_sale_void", v.id)).toEqual([cost]);
  expect(after.wac).toBe(before.wac);
  expect(Number(after.val)).toBe(Number(before.val) + 5 * cost);
});
