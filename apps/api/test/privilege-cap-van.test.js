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
import { computeOne, computeWithBudget, idKey } from "../src/domains/fiscal/privilege-cap.js";
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

/** IP-BIR: van sale with a PWD discount claim, through the real sale.record op. */
/** @param {string} path @param {any} [body] */
async function fiscalApi(path, body) {
  const res = await h.fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {number} sequence @param {number} qty @param {any} [claim] */
function pwdPayload(sequence, qty, claim) {
  const gross = qty * 12525;
  // PWD: VAT removed first, then 20% of the VAT-exclusive amount
  const ex = Math.round(gross / 1.12);
  const pay = ex - Math.round(ex * 0.2);
  const p = salePayload(sequence, qty);
  p.totalMinor = String(claim ? pay : gross);
  p.lines[0].totalMinor = String(claim ? pay : gross);
  p.payment.amountMinor = p.totalMinor;
  p.payment.tenderedMinor = p.totalMinor;
  return claim ? Object.assign(p, { discountClaim: claim }) : p;
}
const pwd = {
  type: "pwd",
  idNumber: "PWD-CEB-0099",
  holderName: "Mario Reyes",
};
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
test("statutory discount is OFF on vans by default: a PWD claim is refused until the office switches it on", async () => {
  const p = pwdPayload(1, 2, pwd);
  const r = await push([op("sale.record", p)]);
  expect(r.body.results[0].status).toBe("rejected");
  expect((await h.db`select count(*)::int as n from van_sales`)[0].n).toBe(0);
  expect(
    (await h.db`select count(*)::int as n from sale_discount_claims`)[0].n,
  ).toBe(0);
  const on = await fiscalApi("/api/v1/fiscal/privilege/settings", {
    orgUnitId: unit,
    surface: "van",
    enabled: true,
  });
  expect(on.status).toBe(200);
  await new Promise((r) => setTimeout(r, 15));
});
let pwdSale = "";
test("van sale with a PWD claim: VAT removed, 20% off, tax buckets, claim row, receipt model", async () => {
  const p = pwdPayload(1, 2, pwd);
  pwdSale = p.saleId;
  expect(p.totalMinor).toBe("17893");
  await apply(op("sale.record", p));
  const [s] = await h.db`select * from van_sales where id=${p.saleId}`;
  expect(s.total_centavos.toString()).toBe("17893");
  expect(s.receipt.tax).toMatchObject({
    vatableSalesMinor: "0",
    vatMinor: "0",
    vatExemptMinor: "22366",
    totalMinor: "17893",
    grossMinor: "25050",
    privilegeDiscountMinor: "4473",
    vatRemovedMinor: "2684",
    privilegeType: "pwd",
  });
  expect(s.receipt.discountClaim).toMatchObject({
    type: "pwd",
    idNumber: "PWD-CEB-0099",
    holderName: "Mario Reyes",
  });
  expect(s.receipt.buyer).toMatchObject({ name: "Sample store" });
  const [claim] =
    await h.db`select * from sale_discount_claims where source_id=${p.saleId}`;
  expect(claim).toMatchObject({
    source_type: "van_sale",
    privilege_type: "pwd",
    applied: true,
  });
  expect(String(claim.total_centavos)).toBe("17893");
  const [t] =
    await h.db`select t.* from fiscal_document_tax t join fiscal_documents d on d.id=t.document_id where d.source_id=${p.saleId}`;
  expect(String(t.privilege_discount_centavos)).toBe("4473");
  expect(String(t.vat_removed_centavos)).toBe("2684");
  expect(t.privilege_type).toBe("pwd");
  // cash collected is the discounted amount, stock left the truck for 2 pieces
  const m = await fiscalApi(`/api/v1/fiscal/receipts/${p.saleId}/print-model`);
  expect(m.status).toBe(200);
  expect(m.body.model.privilege).toMatchObject({
    type: "pwd",
    holderName: "Mario Reyes",
  });
  expect(m.body.model.totals).toMatchObject({
    totalDueMinor: "17893",
    privilegeDiscountMinor: "4473",
    vatRemovedMinor: "2684",
    vatExemptSalesMinor: "22366",
    changeMinor: "0",
  });
  expect(m.body.model.buyer.name).toBe("Sample store");
  expect(m.body.model.banner).toBe("NOT FILED - SAMPLE");
});

/** IP-SCPWD-CAP on the van: the same server rule through the real sale.record op. */
const sleepMs = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** What a phone with `budget` centavos of limit prints for `qty` pieces to a PWD. @param {number} qty @param {number|null} budget */
function cappedFacts(qty, budget) {
  const gross = qty * 12525;
  const line = { productId: product, grossCentavos: gross, promoDiscountCentavos: 0, taxTreatment: "vatable", taxBasisPoints: 1200 };
  const r = computeWithBudget([line], (l, g, p, w) => computeOne(l, g, p, w ? "pwd" : null), () => true, budget);
  const sum = (/** @type {string} */ k) => r.results.reduce((a, x) => a + x[k], 0);
  return { total: sum("netCentavos"), discount: sum("privilegeDiscountCentavos"), removed: sum("vatRemovedCentavos"), applied: r.appliedGross };
}
/** @param {number} sequence @param {number} qty @param {number|null|undefined} budget undefined = an older build (no limit) */
function capVanPayload(sequence, qty, budget) {
  const f = cappedFacts(qty, budget === undefined ? null : budget);
  const p = salePayload(sequence, qty);
  p.totalMinor = String(f.total);
  p.lines[0].totalMinor = String(f.total);
  p.payment.amountMinor = String(f.total);
  p.payment.tenderedMinor = String(f.total);
  return Object.assign(p, {
    discountClaim: {
      ...pwd,
      privilegeDiscountMinor: String(f.discount),
      vatRemovedMinor: String(f.removed),
      ...(budget === undefined ? {} : { capBasis: { budgetCentavos: String(budget) } }),
    },
  });
}
const pwdLedger = () => h.db`select * from privilege_cap_ledger where id_key=${idKey("pwd", pwd.idNumber)} order by created_at`;

test("van: the first PWD sale used PHP 250.50 of the shipped default limit (PHP 2,500), and said what was left", async () => {
  const rows = await pwdLedger();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ source_type: "van_sale", applied_gross_centavos: "25050", cap_centavos: "250000", used_before_centavos: "0", overage_centavos: "0", claim_basis: "phone_uncapped" });
  const [s] = await h.db`select receipt from van_sales where id=${pwdSale}`;
  expect(s.receipt.discountClaim.weeklyLimit).toMatchObject({ capMinor: "250000", usedMinor: "25050", leftMinor: "224950", text: "Weekly limit: ₱2,249.50 left" });
  const m = await fiscalApi(`/api/v1/fiscal/receipts/${pwdSale}/print-model`);
  expect(m.body.model.privilege.weeklyLimitText).toBe("Weekly limit: ₱2,249.50 left");
});

test("van: a phone that knows its remaining limit is accepted exactly; an older build that does not is accepted too and the overage is recorded", async () => {
  // office sets PHP 400 a week: PHP 149.50 left after the first sale
  const set = await fiscalApi("/api/v1/fiscal/privilege/cap", { enabled: true, capCentavos: 40000 });
  expect(set.status).toBe(200);
  await sleepMs(20);
  const p = await fiscalApi("/api/v1/fiscal/discount-claims/preview", {
    surface: "van",
    orgUnitId: unit,
    discountClaim: pwd,
    lines: [{ productId: product, description: "Case", grossCentavos: 25050, taxTreatment: "vatable", taxBasisPoints: 1200 }],
  });
  expect(p.body.cap).toMatchObject({ usedBeforeCentavos: 25050, remainingBeforeCentavos: 14950, appliedGrossCentavos: 14950, limited: true });
  const mine = cappedFacts(2, 14950);
  expect(p.body.totals.total).toBe(mine.total);
  const sale = capVanPayload(2, 2, 14950);
  await apply(op("sale.record", sale));
  const rows = await pwdLedger();
  expect(rows[1]).toMatchObject({ applied_gross_centavos: "14950", eligible_gross_centavos: "25050", used_before_centavos: "25050", overage_centavos: "0", short_centavos: "0", claim_basis: "phone_cap" });
  const [s] = await h.db`select receipt,total_centavos from van_sales where id=${sale.saleId}`;
  expect(String(s.total_centavos)).toBe(String(mine.total));
  expect(s.receipt.discountClaim.weeklyLimit).toMatchObject({ leftMinor: "0", usedMinor: "40000" });
  // an older build discounts the whole 250.50 although nothing is left: accepted as made, 25,050 over
  const old = capVanPayload(3, 2, undefined);
  await apply(op("sale.record", old));
  const after = await pwdLedger();
  expect(after[2]).toMatchObject({ applied_gross_centavos: "25050", used_before_centavos: "40000", overage_centavos: "25050", claim_basis: "phone_uncapped" });
  // a total that does not follow the phone's own stated budget is still refused, nothing saved
  const bad = capVanPayload(4, 2, undefined);
  bad.discountClaim.capBasis = { budgetCentavos: "0" };
  const r = await push([op("sale.record", bad)]);
  expect(r.body.results[0].status).toBe("rejected");
  expect((await pwdLedger()).length).toBe(3);
});
