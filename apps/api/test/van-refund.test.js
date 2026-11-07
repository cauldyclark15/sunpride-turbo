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

/** @type {any[]} */ const postings = [];
mock.module("../src/domains/inventory/posting.js", () => ({
  postMovement: async (/** @type {any} */ db, /** @type {any} */ input) => {
    postings.push(input);
    const id = crypto.randomUUID();
    await db`insert into inventory_movements(id,organization_id,movement_number,movement_type,source_type,source_document_id,status,effective_at,posted_at,posted_by,idempotency_key,schema_version)
    values(${id},${input.organizationId},${id},${input.kind},${input.sourceType},${input.sourceId},'posted',now(),now(),${input.actor.userId},${input.idempotencyKey},1)`;
    // This is the mocked INVENTORY authority, not a production van balance writer.
    for (const line of input.lines) {
      if (
        line.fromLocationId === truck &&
        line.toLocationId === truck &&
        line.fromStockStatus !== line.toStockStatus
      ) {
        const signed = (/** @type {string} */ s) =>
          s === "damaged" ? line.quantityBase : -line.quantityBase;
        await db`update inventory_balances set damaged_base=coalesce(damaged_base,0)+${signed(line.toStockStatus)},available_base=coalesce(available_base,0)-${signed(line.toStockStatus)} where product_id=${line.productId} and location_id=${truck}`;
        continue;
      }
      const delta =
        (line.toLocationId === truck ? line.quantityBase : 0) -
        (line.fromLocationId === truck ? line.quantityBase : 0);
      if (!delta) continue;
      if (line.stockStatus === "damaged")
        await db`update inventory_balances set damaged_base=coalesce(damaged_base,0)+${delta},physical_base=coalesce(physical_base,0)+${delta} where product_id=${line.productId} and location_id=${truck}`;
      else
        await db`update inventory_balances set available_base=coalesce(available_base,0)+${delta},physical_base=coalesce(physical_base,0)+${delta} where product_id=${line.productId} and location_id=${truck}`;
    }
    return { movementId: id, duplicate: false };
  },
}));
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

/** @type {any} */ let sale;
/** @type {any} */ let first;
test("a van refund of one piece: stock back on the truck, cash out of the trip's expected cash, a credit memo from its own range", async () => {
  sale = salePayload(1, 3);
  await apply(op("sale.record", sale));
  const cashBefore = await cashExpectation(h.db, trip.tripId);
  const stockBefore = await truckStock();
  first = await refundOp(sale, "1", "RF-CHANGED-MIND", "12525");
  await apply(first);
  const [r] =
    await h.db`select * from sale_refunds where id=${first.clientOpId}`;
  expect(r).toMatchObject({
    surface: "van",
    trip_id: trip.tripId,
    sale_id: sale.saleId,
    credit_number: "TEST-CM-000000001",
    destination: "sellable",
  });
  expect(String(r.total_centavos)).toBe("12525");
  expect(r.tax).toMatchObject({ totalMinor: "12525" });
  expect(await pay(sale.saleId)).toEqual([
    { kind: "sale", method: "cash", amount: "37575" },
    { kind: "refund", method: "cash", amount: "12525" },
  ]);
  expect(await cashExpectation(h.db, trip.tripId)).toBe(cashBefore - 12525n);
  expect(Number((await truckStock()).a)).toBe(Number(stockBefore.a) + 1);
  const [doc] =
    await h.db`select snapshot from fiscal_documents where source_type='van_refund' and source_id=${first.clientOpId}`;
  expect(doc.snapshot).toMatchObject({
    documentType: "credit_memo",
    originalInvoice: sale.receiptNumber,
    totalMinor: "12525",
  });
  // the trip's stock facts count it as a customer return
  const ev =
    await h.db`select kind,delta_base::text as d,stock_status from van_stock_events where source_id=${first.clientOpId}`;
  expect(ev).toEqual([{ kind: "return", d: "1", stock_status: "available" }]);
  // the same op again is a duplicate and writes nothing
  expect((await push([first])).body.results[0].status).toBe("duplicate");
  expect((await h.db`select count(*)::int as n from sale_refunds`)[0].n).toBe(
    1,
  );
});

test("quantity cap, wrong amount, unknown reason and an unknown receipt are refused", async () => {
  const over = await refundOp(sale, "3", "RF-CHANGED-MIND", "37575");
  expect((await send(over)).status).toBe("rejected");
  const wrong = await refundOp(sale, "1", "RF-CHANGED-MIND", "12000");
  const r = await send(wrong);
  expect(r.status).toBe("rejected");
  expect(r.code).toBe("stock_conflict");
  const reason = await refundOp(sale, "1", "NOPE", "12525");
  expect((await send(reason)).status).toBe("rejected");
  const ghost = await refundOp(
    { saleId: crypto.randomUUID(), receiptNumber: "X" },
    "1",
    "RF-CHANGED-MIND",
    "12525",
  );
  expect((await send(ghost)).status).toBe("rejected");
  expect((await h.db`select count(*)::int as n from sale_refunds`)[0].n).toBe(
    1,
  );
  expect(
    (
      await h.db`select count(*)::int as n from van_payments where kind='refund'`
    )[0].n,
  ).toBe(1);
});

test("above the supervisor amount a van refund needs an office-issued code that matches these exact facts; damaged goes to damaged stock", async () => {
  await h.db`update refund_policies set supervisor_over_centavos=1000 where organization_id='sunpride'`;
  const bare = await refundOp(sale, "1", "RF-DAMAGED", "12525", {
    refundNumber: 2,
  });
  expect((await send(bare)).status).toBe("rejected");
  const facts = {
    receiptNumber: sale.receiptNumber,
    totalMinor: "12525",
    reasonCode: "RF-DAMAGED",
    refundNumber: 2,
  };
  const issued = await web("refund/approval-code", facts);
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  // a code issued for a different refund number does not open this one
  const stale = await refundOp(sale, "1", "RF-DAMAGED", "12525", {
    refundNumber: 3,
    approval: { method: "supervisor_code", code: issued.body.code },
  });
  expect((await send(stale)).status).toBe("rejected");
  const before = await truckStock();
  const good = await refundOp(sale, "1", "RF-DAMAGED", "12525", {
    refundNumber: 2,
    approval: { method: "supervisor_code", code: issued.body.code },
  });
  await apply(good);
  const after = await truckStock();
  expect(Number(after.d)).toBe(Number(before.d) + 1);
  expect(after.a).toBe(before.a);
  // the code is one-use: the same facts cannot open a third refund
  const again = await refundOp(sale, "1", "RF-DAMAGED", "12525", {
    refundNumber: 3,
    approval: { method: "supervisor_code", code: issued.body.code },
  });
  expect((await send(again)).status).toBe("rejected");
  await h.db`update refund_policies set supervisor_over_centavos=50000 where organization_id='sunpride'`;
});

test("a sale that was partly refunded cannot be voided; the last piece can still be refunded, and then nothing is left", async () => {
  const facts = {
    receiptNumber: sale.receiptNumber,
    totalMinor: sale.totalMinor,
    reasonCode: "wrong_items",
  };
  await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,offline_allowed,effective_from,sample) values(${unit},'void','sales','GT',0,100000000,0,${["super_admin"]},true,now()-interval '1 day',true)`;
  const issued = await web("void/approval-code", facts);
  expect(issued.status).toBe(200);
  const v = await send(
    op("sale.void", {
      tripId: trip.tripId,
      saleId: sale.saleId,
      ...facts,
      approval: { method: "supervisor_code", code: issued.body.code },
    }),
  );
  expect(v.status).toBe("rejected");
  const last = await refundOp(sale, "1", "RF-CHANGED-MIND", "12525", {
    refundNumber: 3,
  });
  await apply(last);
  const none = await refundOp(sale, "1", "RF-CHANGED-MIND", "12525", {
    refundNumber: 4,
  });
  expect((await send(none)).status).toBe("rejected");
  const rows =
    await h.db`select total_centavos::text as t,tax from sale_refunds where sale_id=${sale.saleId} order by refunded_at,created_at`;
  expect(
    rows.reduce(
      (/** @type {bigint} */ n, /** @type {any} */ r) => n + BigInt(r.t),
      0n,
    ),
  ).toBe(37575n);
  const [original] =
    await h.db`select receipt from van_sales where id=${sale.saleId}`;
  const vat = rows.reduce(
    (/** @type {bigint} */ n, /** @type {any} */ r) =>
      n + BigInt(r.tax.vatMinor),
    0n,
  );
  expect(String(vat)).toBe(original.receipt.tax.vatMinor);
});

test("a van refund shows in the tax summary as a credit memo and in the trip's cash facts", async () => {
  const [{ n }] =
    await h.db`select count(*)::int as n from fiscal_documents where source_type='van_refund'`;
  expect(n).toBe(3);
  const [cash] =
    await h.db`select coalesce(sum(case when kind in ('refund','void_refund') then -amount_centavos else amount_centavos end),0)::text as net from van_payments where trip_id=${trip.tripId} and method='cash' and sale_id=${sale.saleId}`;
  expect(cash.net).toBe("0");
  // the invoice (+375.75) and its three credit memos (-375.75) net to zero output VAT and zero sales
  const res = await h.fetch("/api/v1/fiscal/tax-summary", {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.totals.total_due).toBe("0");
  expect(body.totals.vat).toBe("0");
});

test("only a phone that asks with params.refunds is told about refunds or given a credit-memo range", async () => {
  /** @param {any} params */
  const pull = async (params) => {
    const r = await signedPost(h, who, "/api/sync/pull", {
      version: 2,
      app: "van-android",
      deviceId: who.deviceId,
      since: null,
      pageCursor: null,
      scopes: [
        {
          scopeId: unit,
          projection: "van.bundle",
          params: { serviceDate: today(), ...params },
        },
      ],
      limit: 100,
    });
    expect(r.res.status).toBe(200);
    return /** @type {any} */ (r.body.bundles[0].data);
  };
  // the exact params of the oldest build in the field that sends handheld (beta.26/27)
  const beta26 = {
    catalogue: true,
    schemeEngine: 1,
    posMode: true,
    handheld: true,
  };
  const allowed = JSON.parse(
    readFileSync(
      new URL("./fixtures/van-wire-v1-policy-keys.json", import.meta.url),
      "utf8",
    ),
  );
  const known = new Set([
    ...allowed.validatedKeys,
    ...allowed.strippedBeforeValidation,
  ]);
  const old = await pull(beta26);
  expect(Object.keys(old.policy).filter((k) => !known.has(k))).toEqual([]);
  expect(old.policy.refunds).toBeUndefined();
  expect(
    old.policy.fiscal.ranges.map((/** @type {any} */ x) => x.documentType),
  ).not.toContain("credit_memo");
  // the newest build asks for refunds
  const hh = { ...beta26, vanDay: true, categories: true };
  const nu = await pull({ ...hh, refunds: true });
  expect(nu.policy.refunds.supervisorOverMinor).toBe("50000");
  expect(
    nu.policy.refunds.reasons.map((/** @type {any} */ x) => x.code).sort(),
  ).toEqual([
    "RF-CHANGED-MIND",
    "RF-DAMAGED",
    "RF-EXPIRED",
    "RF-QUALITY",
    "RF-WRONG-ITEM",
  ]);
  expect(
    nu.policy.refunds.reasons.find(
      (/** @type {any} */ x) => x.code === "RF-DAMAGED",
    ).destination,
  ).toBe("damaged");
  expect(typeof nu.policy.refunds.approvalKey).toBe("string");
  expect(nu.policy.refunds.made).toHaveLength(3);
  expect(
    nu.policy.fiscal.ranges
      .map((/** @type {any} */ x) => x.documentType)
      .sort(),
  ).toContain("credit_memo");
  // a build that sends vanDay but not refunds (hh2) is not given them either
  const hh2 = await pull(hh);
  expect(hh2.policy.refunds).toBeUndefined();
});
