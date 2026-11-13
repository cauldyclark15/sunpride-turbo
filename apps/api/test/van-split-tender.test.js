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


// IP-INT3 gap 1: a van sale paid with cash plus ONE other tender, through the real sale.record op, with the exact
// `payment` JSON the phone's SplitTenders.paymentJson makes (fixtures/phone-ops.json, written by the Android unit test).
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/phone-ops.json", import.meta.url), "utf8"),
);
const { cashExpectation } = await import("../src/domains/van/facts.js");
const { splitSalePayment } = await import("../src/domains/van/split-tender.js");
/** @param {string} path @param {any} [body] */
async function fiscalApi(path, body) {
  const res = await h.fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}

/** A 1-piece sale (₱125.25) with the given payment shape. @param {number} sequence @param {any} pay @param {any} [extra] */
function splitSale(sequence, pay, extra = {}) {
  const p = salePayload(sequence, 1);
  delete (/** @type {any} */ (p)).payment;
  return Object.assign(p, pay, extra);
}
const phonePayment = () => structuredClone(fixture.splitSalePayment);
const sales = async () =>
  (await h.db`select count(*)::int as n from van_sales`)[0].n;
/** @param {string} saleId */
const paymentRows = (saleId) =>
  h.db`select kind,method,amount_centavos::text as amount,facts from van_payments where sale_id=${saleId} order by method`;
/** Rejected ops leave nothing behind. @param {any} p @param {string} words */
async function refused(p, words) {
  const before = await sales();
  const r = await push([op("sale.record", p)]);
  expect(r.body.results[0].status).toBe("rejected");
  expect(await sales()).toBe(before);
  // The sync result carries only a code; the plain words the phone shows come from the same check, called directly.
  await expect(
    splitSalePayment(h.db, { org_unit_id: unit }, p, BigInt(p.totalMinor), Date.now()),
  ).rejects.toThrow(words);
  expect(
    (await h.db`select count(*)::int as n from van_payments where sale_id=${p.saleId}`)[0].n,
  ).toBe(0);
}

test("van setup: trip started with stock on the truck", async () => {
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

test("the old single-payment sale still works exactly as before: one cash row", async () => {
  const p = salePayload(1, 1);
  await apply(op("sale.record", p));
  const rows = await paymentRows(p.saleId);
  expect(rows.map((/** @type {any} */ r) => [r.method, r.amount])).toEqual([
    ["cash", "12525"],
  ]);
  const [s] = await h.db`select receipt from van_sales where id=${p.saleId}`;
  expect(s.receipt.payment).toMatchObject({ method: "cash", kind: "cash" });
  expect(s.receipt.tenders).toBeUndefined();
});

let phoneSaleId = "";
test("the phone's own split payment JSON (cash + GCash) is accepted and saved as two payment rows", async () => {
  const cashBefore = await cashExpectation(h.db, trip.tripId);
  const p = splitSale(2, { payment: phonePayment() });
  phoneSaleId = p.saleId;
  await apply(op("sale.record", p));
  const rows = await paymentRows(p.saleId);
  expect(rows.map((/** @type {any} */ r) => [r.kind, r.method, r.amount])).toEqual([
    ["sale", "cash", "7525"],
    ["sale", "gcash", "5000"],
  ]);
  // Settlement and expected cash count the cash part only: 75.25, not 125.25 and not the 100.00 handed over.
  expect(await cashExpectation(h.db, trip.tripId)).toBe(cashBefore + 7525n);
  const [s] = await h.db`select total_centavos::text as total,receipt from van_sales where id=${p.saleId}`;
  expect(s.total).toBe("12525");
  expect(s.receipt.payment).toMatchObject({
    kind: "split",
    method: "split",
    label: "Cash + GCash",
    amountMinor: "12525",
  });
  expect(s.receipt.payment.parts).toHaveLength(2);
  expect(s.receipt.payment.parts[1]).toMatchObject({
    method: "gcash",
    reference: "GC-77821",
    status: "awaiting_confirmation",
  });
  // Change comes only from cash: handed over 100.00 for a 75.25 cash part.
  expect(s.receipt.payment.parts[0]).toMatchObject({
    tenderedMinor: "10000",
    changeMinor: "2475",
  });
  // The printed receipt lists both tenders and the change.
  const m = await fiscalApi(`/api/v1/fiscal/receipts/${p.saleId}/print-model`);
  expect(m.status).toBe(200);
  expect(m.body.model.tenders.map((/** @type {any} */ t) => t.label)).toEqual([
    "Cash",
    "GCash",
  ]);
  expect(m.body.model.totals).toMatchObject({
    totalDueMinor: "12525",
    changeMinor: "2475",
  });
  // The GCash row awaits the office like any other non-cash tender; the cash row never does.
  const conf = await h.db`select v.method from van_payments v where v.sale_id=${p.saleId} and v.method<>'cash'`;
  expect(conf).toHaveLength(1);
});

test("the office shape payments:[{tender, amountCentavos, ref}] is accepted too (numbers or strings)", async () => {
  const before = await cashExpectation(h.db, trip.tripId);
  const p = splitSale(3, {
    payments: [
      { tender: "cash", amountCentavos: 2525, tenderedCentavos: 3000 },
      { tender: "gcash", amountCentavos: "10000", ref: "GC-2" },
    ],
  });
  await apply(op("sale.record", p));
  const rows = await paymentRows(p.saleId);
  expect(rows.map((/** @type {any} */ r) => [r.method, r.amount])).toEqual([
    ["cash", "2525"],
    ["gcash", "10000"],
  ]);
  expect(await cashExpectation(h.db, trip.tripId)).toBe(before + 2525n);
  const [s] = await h.db`select receipt from van_sales where id=${p.saleId}`;
  expect(s.receipt.payment.parts[0]).toMatchObject({ tenderedMinor: "3000", changeMinor: "475" });
  // No tendered amount: exact cash.
  const q = splitSale(4, {
    payments: [
      { tender: "cash", amountCentavos: "5000" },
      { tender: "check", amountCentavos: "7525", ref: "CHK-100234" },
    ],
  });
  await apply(op("sale.record", q));
  const [t] = await h.db`select receipt from van_sales where id=${q.saleId}`;
  expect(t.receipt.payment.parts[0]).toMatchObject({ tenderedMinor: "5000", changeMinor: "0" });
  // A one-element payments array is just a single tender.
  const one = splitSale(5, {
    payments: [{ tender: "cash", amountCentavos: "12525", tenderedCentavos: "13000" }],
  });
  await apply(op("sale.record", one));
  expect(
    (await paymentRows(one.saleId)).map((/** @type {any} */ r) => [r.method, r.amount]),
  ).toEqual([["cash", "12525"]]);
});

test("refusals leave nothing behind: wrong total, two cash parts, no cash, credit, change from a non-cash tender, no reference, short cash, unknown tender, three parts", async () => {
  const cash = (/** @type {number} */ n, /** @type {number} */ t = n) => ({ tender: "cash", amountCentavos: n, tenderedCentavos: t });
  const gcash = (/** @type {number} */ n, ref = "GC-9") => ({ tender: "gcash", amountCentavos: n, ref });
  await refused(splitSale(6, { payments: [cash(7525), gcash(5001)] }), "add up to the sale total");
  await refused(splitSale(7, { payments: [cash(7525), cash(5000)] }), "exactly one cash part");
  await refused(splitSale(8, { payments: [gcash(7525), { tender: "check", amountCentavos: 5000, ref: "CHK-5551" }] }), "exactly one cash part");
  await refused(splitSale(9, { payments: [cash(7525), { tender: "credit", amountCentavos: 5000 }] }), "Credit cannot be part of a split sale");
  await refused(
    splitSale(10, { payments: [cash(7525), { ...gcash(5000), tenderedCentavos: 6000 }] }),
    "Only cash can give change",
  );
  await refused(splitSale(11, { payments: [cash(7525), { tender: "gcash", amountCentavos: 5000 }] }), "Text is required");
  await refused(splitSale(12, { payments: [cash(7525, 7000), gcash(5000)] }), "Cash handed over is less than the cash part");
  await refused(splitSale(13, { payments: [cash(7525), { tender: "paypal", amountCentavos: 5000, ref: "X-1" }] }), "not authorized");
  await refused(splitSale(14, { payments: [cash(1000), gcash(1000), gcash(10525)] }), "cash plus one other");
  await refused(splitSale(15, { payments: [cash(0), gcash(12525)] }), "more than zero");
  // The phone shape: parts that do not add up to the amount, and a wrong change figure.
  const bad = phonePayment();
  bad.parts[1].amountMinor = "5001";
  await refused(splitSale(16, { payment: bad }), "add up to the sale total");
  const wrongChange = phonePayment();
  wrongChange.parts[0].changeMinor = "2400";
  await refused(splitSale(17, { payment: wrongChange }), "Cash and change do not reconcile");
  const wrongTotal = phonePayment();
  wrongTotal.amountMinor = "12000";
  await refused(splitSale(18, { payment: wrongTotal }), "Payment must match the sale total");
});

test("a tender the office has switched off cannot be the second part", async () => {
  await h.db`update fiscal_tender_rules set enabled=false where org_unit_id=${unit} and method='gcash'`;
  const p = splitSale(19, { payment: phonePayment() });
  try {
    await refused(p, "authorized");
  } finally {
    await h.db`update fiscal_tender_rules set enabled=true where org_unit_id=${unit} and method='gcash'`;
  }
});

test("voiding a split sale gives both parts back and expected cash returns to what it was", async () => {
  // A supervisor void code needs a governed authority rule that allows handheld codes (as in van.test.js).
  await h.db`insert into fiscal_authority_rules(org_unit_id,kind,role,channel,min_centavos,max_centavos,self_limit_centavos,approver_roles,offline_allowed,effective_from,sample) values(${unit},'void','sales','GT',0,100000000,0,${["super_admin"]},true,now()-interval '1 day',true)`;
  const p = splitSale(20, { payment: phonePayment() });
  await apply(op("sale.record", p));
  const afterSale = await cashExpectation(h.db, trip.tripId);
  const facts = { receiptNumber: p.receiptNumber, totalMinor: p.totalMinor, reasonCode: "wrong_items" };
  const issued = await web("void/approval-code", facts);
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  await apply(
    op("sale.void", {
      tripId: trip.tripId,
      saleId: p.saleId,
      ...facts,
      approval: { method: "supervisor_code", code: issued.body.code },
    }),
  );
  const rows = await paymentRows(p.saleId);
  expect(
    rows.map((/** @type {any} */ r) => `${r.kind}:${r.method}:${r.amount}`).sort(),
  ).toEqual([
    "sale:cash:7525",
    "sale:gcash:5000",
    "void_refund:cash:7525",
    "void_refund:gcash:5000",
  ]);
  expect(await cashExpectation(h.db, trip.tripId)).toBe(afterSale - 7525n);
});

test("the handheld bundle says splitTender only to the vanDay build; the office shape needs nothing else", async () => {
  /** @param {boolean} handheld */
  const pull = async (handheld) => {
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
          params: {
            serviceDate: today(),
            ...(handheld ? { handheld: true, vanDay: true } : {}),
          },
        },
      ],
      limit: 100,
    });
    expect(r.res.status).toBe(200);
    return /** @type {any} */ (r.body.bundles[0].data);
  };
  expect((await pull(true)).policy.splitTender).toBe(true);
  expect((await pull(false)).policy.splitTender).toBeUndefined();
});

// IP-INT3FIX P0: beta.26/27 (f2aba224) validate `policy` with additionalProperties:false and strip only
// operationsVersion/fiscal/schemes/storePos/handheld, so any other new key makes them refuse the whole bundle.
// Their request is `handheld:true` WITHOUT `vanDay`. `splitTender` must go only to the build that sends `vanDay:true`.
test("a beta.26-shaped bundle request (handheld only) gets no policy key the frozen v1 schema refuses", async () => {
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
  // a second seller with no trip: the empty "no trip yet" bundle is built by a different branch of bundle()
  h.setHooks({
    loadProfile: async (/** @type {any} */ _db, /** @type {string} */ id) =>
      profiles.byUser.get(id) ?? null,
  });
  const idle = await boundDevice(h, profiles, {
    app: "van-android",
    orgUnitId: unit,
  });
  await persistPerson(idle);
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
  /** @param {any} device @param {any} params */
  const pull = async (device, params) => {
    const r = await signedPost(h, device, "/api/sync/pull", {
      version: 2,
      app: "van-android",
      deviceId: device.deviceId,
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
  // the exact params of VanSyncClient.kt at f2aba224
  const beta26 = {
    catalogue: true,
    schemeEngine: 1,
    posMode: true,
    handheld: true,
  };
  const withTrip = await pull(who, beta26);
  const withoutTrip = await pull(idle, beta26);
  expect(withTrip.trip).not.toBeNull();
  expect(withoutTrip.trip).toBeNull();
  for (const b of [withTrip, withoutTrip]) {
    expect(b.policy.handheld).toBeDefined();
    expect(Object.keys(b.policy).filter((k) => !known.has(k))).toEqual([]);
  }
  // the hh2 build (also sends vanDay) is told, on both
  const hh2 = { ...beta26, vanDay: true, categories: true };
  expect((await pull(who, hh2)).policy.splitTender).toBe(true);
  expect((await pull(idle, hh2)).policy.splitTender).toBe(true);
});

test("NF-R4-V1: a trip on the road with no start handheld (office-started or seeded on route) still takes the seller's sale", async () => {
  await h.db`update van_trips set started_device_id=null where id=${trip.tripId}`;
  const p = salePayload(9, 1);
  const r = await push([op("sale.record", p)]);
  expect(r.body.results[0]).toMatchObject({ status: "applied" });
  const [t] = await h.db`select started_device_id from van_trips where id=${trip.tripId}`;
  expect(t.started_device_id).toBe(who.deviceId);
  const [d] = await h.db`select a.device_id from fiscal_documents f join fiscal_allocations a on a.id=f.allocation_id where f.source_id=${p.saleId}`;
  expect(d.device_id).toBe(who.deviceId);
});
