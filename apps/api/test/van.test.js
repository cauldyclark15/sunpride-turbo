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

test("plans vehicle, trip and load through scoped audited commands", async () => {
  const v = await web("vehicles/create", {
    orgUnitId: unit,
    vehicleCode: "V1",
    plateNumber: "SAMPLE",
    truckLocationId: truck,
    homeLocationId: depot,
  });
  expect(v.status).toBe(200);
  const t = await web("trips/plan", {
    vehicleId: v.body.vehicleId,
    salespersonProfileId: who.profile.id,
    serviceDate: today(),
  });
  expect(t.status).toBe(200);
  trip = t.body;
  const l = await web("loads/plan", {
    tripId: trip.tripId,
    lines: [{ productId: product, expectedBase: "48" }],
  });
  expect(l.status).toBe(200);
  load = l.body;
  expect(
    (await h.db`select count(*)::int as n from van_audit_events`)[0].n,
  ).toBe(3);
});
test("load confirmation posts actual depot → truck lines exactly once", async () => {
  const operation = op("load.confirm", {
    tripId: trip.tripId,
    loadId: load.loadId,
    lines: [{ lineNumber: 1, actualBase: "48" }],
  });
  const a = await apply(operation),
    length = postings.length;
  expect(postings.at(-1).kind).toBe("van_load");
  // A territory seller loads from an area depot: the trip vouches for exactly its two locations.
  expect(postings.at(-1).authorizedLocations).toEqual([depot, truck]);
  expect(postings.at(-1).lines).toEqual([
    {
      productId: product,
      fromLocationId: depot,
      toLocationId: truck,
      quantityBase: 48,
      uom: "PC",
      lotId: null,
      stockStatus: "available",
    },
  ]);
  const r = await push([operation]);
  expect(r.body.results[0].status).toBe("duplicate");
  expect(r.body.results[0].ack).toEqual(a.ack);
  expect(postings.length).toBe(length);
  const conflict = await push([
    {
      ...operation,
      payload: {
        ...operation.payload,
        lines: [{ lineNumber: 1, actualBase: "47" }],
      },
    },
  ]);
  expect(conflict.body.results[0].code).toBe("idempotency_conflict");
});
test("start → governed sale freezes receipt and posts stock only through seam", async () => {
  await apply(
    op("trip.start", {
      tripId: trip.tripId,
      vehicleConfirmed: true,
      routeConfirmed: true,
    }),
  );
  const p = salePayload(1, 8);
  await apply(op("sale.record", p));
  expect(postings.at(-1).lines[0]).toMatchObject({
    quantityBase: 8,
    fromLocationId: truck,
    toLocationId: null,
  });
  const [s] = await h.db`select * from van_sales where id=${p.saleId}`;
  expect(s.receipt.customer.name).toBe("Sample store");
  expect(s.receipt.lines[0].name).toBe("Sample product");
  await h.db`update products set name='Renamed product' where id=${product}`;
  expect(
    (await h.db`select receipt from van_sales where id=${p.saleId}`)[0].receipt
      .lines[0].name,
  ).toBe("Sample product");
});
test("linked return restores stock without rewriting original sale/payment; all captured facts bind replay", async () => {
  const [s] = await h.db`select * from van_sales order by created_at limit 1`;
  const original = (
    await h.db`select receipt,captured_request from van_sales where id=${s.id}`
  )[0];
  const p = {
    tripId: trip.tripId,
    returnId: crypto.randomUUID(),
    returnNumber: `${trip.tripNumber}-AABBCCDD-0002`,
    customer: { outletId: outlet },
    originalSale: { saleId: s.id, receiptNumber: s.receipt_number },
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
  };
  const operation = op("return.record", p);
  await apply(operation);
  expect(postings.at(-1).kind).toBe("pos_return");
  expect(postings.at(-1).lines[0].quantityBase).toBe(2);
  expect(
    (
      await h.db`select receipt,captured_request from van_sales where id=${s.id}`
    )[0],
  ).toEqual(original);
  const conflict = await push([
    op("return.record", { ...p, note: "different note" }),
  ]);
  expect(conflict.body.results[0].code).toBe("idempotency_conflict");
});
test("void needs an issued code, preserves sale and adds compensating stock/cash", async () => {
  const p = salePayload(3, 4);
  await apply(op("sale.record", p));
  const facts = {
    receiptNumber: p.receiptNumber,
    totalMinor: p.totalMinor,
    reasonCode: "wrong_items",
  };
  const bad = await push([
    op("sale.void", {
      tripId: trip.tripId,
      saleId: p.saleId,
      ...facts,
      approval: { method: "supervisor_code", code: "00000000" },
    }),
  ]);
  expect(bad.res.status).toBe(200);
  expect(bad.body.results[0]).toMatchObject({
    status: "rejected",
    code: "invalid_request",
  });
  const issued = await web("void/approval-code", facts);
  expect(issued.status).toBe(200);
  await apply(
    op("sale.void", {
      tripId: trip.tripId,
      saleId: p.saleId,
      ...facts,
      approval: { method: "supervisor_code", code: issued.body.code },
    }),
  );
  expect(postings.at(-1).kind).toBe("pos_void");
  expect(postings.at(-1).lines[0]).toMatchObject({
    quantityBase: 4,
    fromLocationId: null,
    toLocationId: truck,
  });
  expect(
    (await h.db`select total_centavos from van_sales where id=${p.saleId}`)[0]
      .total_centavos,
  ).toBe("50100");
});
test("cases/pieces and centavo variances reconcile; code binds exact full count", async () => {
  const id = crypto.randomUUID(),
    lines = [
      {
        productId: product,
        status: "available",
        expectedBase: "42",
        countedBase: "41",
        reasonCode: "missing",
      },
      {
        productId: product,
        status: "damaged",
        expectedBase: "0",
        countedBase: "0",
        reasonCode: "",
      },
    ];
  const countCode = stockCountCode(trip.tripId, id, lines);
  const issued = await web("stock/approval-code", {
    tripNumber: trip.tripNumber,
    countCode,
    varianceLines: 1,
    shortBase: "1",
    overBase: "0",
  });
  expect(issued.status).toBe(200);
  await apply(
    op("stock.reconcile", {
      tripId: trip.tripId,
      reconciliationId: id,
      countCode,
      varianceLines: 1,
      shortBase: "1",
      overBase: "0",
      lines,
      approval: { method: "supervisor_code", code: issued.body.code },
    }),
  );
  expect(postings.at(-1).kind).toBe("inventory_adjustment");
  expect(postings.at(-1).lines[0].quantityBase).toBe(1);
  const detail = await tx(h.db, async (db) =>
    tripDetail(db, await actorFor(db, manager.userId), trip.tripId),
  );
  expect(detail.stock[0].expected.display).toBe("3 cases + 6 pieces");
  expect(detail.stock[0].counted?.display).toBe("3 cases + 5 pieces");
  expect(detail.stock[0].variance?.display).toBe("−0 cases + 1 pieces");
  expect(detail.stock[0].varianceCentavos).toBe(-10000);
  expect(detail.cash.expectedCentavos).toBe(100200);
  expect(detail.sales.find((s) => s.voided)?.approvedBy).toBe("Supervisor");
});
test("cash variance approval, close and unload are atomic and auditable", async () => {
  const issued = await web("cash/approval-code", {
    tripNumber: trip.tripNumber,
    expectedMinor: "100200",
    declaredMinor: "90000",
    reasonCode: "counting_error",
  });
  expect(issued.status).toBe(200);
  await apply(
    op("cash.reconcile", {
      tripId: trip.tripId,
      reconciliationId: crypto.randomUUID(),
      currency: "PHP",
      expectedMinor: "100200",
      declaredMinor: "90000",
      counts: [{ denominationMinor: "10000", count: "9" }],
      reasonCode: "counting_error",
      approval: { method: "supervisor_code", code: issued.body.code },
    }),
  );
  const beforeHandIn = await h.fetch(`/api/v1/van/trip?tripId=${trip.tripId}`, {
    headers: { cookie },
  });
  const unremitted = /** @type {any} */ (await beforeHandIn.json());
  expect(unremitted.cash.declaredCentavos).toBe(90000);
  expect(unremitted.cash.remittedCentavos).toBeNull();
  const refusedClose = await push([
    op("trip.close", {
      tripId: trip.tripId,
      closeId: crypto.randomUUID(),
      exceptionsReviewed: true,
      operations: [],
    }),
  ]);
  expect(refusedClose.body.results[0].status).toBe("rejected");
  const received = await web("cash/remit", {
    tripId: trip.tripId,
    amountMinor: "90000",
    reference: "SAMPLE-HANDIN",
  });
  expect(received.status).toBe(200);
  await apply(
    op("trip.close", {
      tripId: trip.tripId,
      closeId: crypto.randomUUID(),
      exceptionsReviewed: true,
      operations: accepted.map((o) => ({
        kind: o.opType,
        clientRequestId: o.clientOpId,
        status: "done",
      })),
    }),
  );
  expect(postings.at(-1).kind).toBe("van_unload");
  expect(postings.at(-1).lines[0]).toMatchObject({
    quantityBase: 41,
    fromLocationId: truck,
    toLocationId: depot,
  });
  const r = await h.fetch(`/api/v1/van/trip?tripId=${trip.tripId}`, {
    headers: { cookie },
  });
  expect(r.status).toBe(200);
  const d = /** @type {any} */ (await r.json());
  expect(d.status).toBe("closed");
  expect(d.cash.varianceCentavos).toBe(-10200);
  expect(d.cash.approvedBy).toBe("Supervisor");
});
test("owner day list includes full settlement and CSV protects formulas", async () => {
  const r = await h.fetch(`/api/v1/van/trips?date=${today()}`, {
    headers: { cookie },
  });
  expect(r.status).toBe(200);
  const d = /** @type {any} */ (await r.json());
  expect(d.rows[0].stock[0].loaded.display).toBe("4 cases + 0 pieces");
  expect(d.targetCentavos).toBeNull();
  const exportRes = await h.fetch(
    `/api/v1/van/trips?date=${today()}&format=csv`,
    { headers: { cookie } },
  );
  expect(exportRes.headers.get("content-type")).toContain("text/csv");
  expect(await exportRes.text()).toContain(trip.tripNumber);
});
test("full van bundle uses exact root keys, own scope and typed policy", async () => {
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
        params: { serviceDate: today() },
      },
    ],
    limit: 100,
  });
  expect(r.res.status).toBe(200);
  const d = r.body.bundles[0].data;
  expect(Object.keys(d).sort()).toEqual(
    [
      "serviceDate",
      "seller",
      "policy",
      "trip",
      "load",
      "truckStock",
      "products",
      "customers",
      "priceLines",
      "damageRecords",
      "promotions",
    ].sort(),
  );
  expect(d.policy.voidApproval.key).toHaveLength(43);
  expect(d.products[0].quantityScale).toBe("1");
  const since = await signedPost(h, who, "/api/sync/pull", {
    version: 2,
    app: "van-android",
    deviceId: who.deviceId,
    since: r.body.nextCursor,
    pageCursor: null,
    scopes: [
      {
        scopeId: unit,
        projection: "van.bundle",
        params: { serviceDate: today() },
      },
    ],
    limit: 50,
  });
  expect(since.res.status).toBe(409);
  expect(since.body.error).toMatchObject({
    code: "cursor_invalid",
    action: "rebootstrap",
  });
});
test("suspension committed after proof inside the batch refuses next op and even replay with no van writes", async () => {
  const before = (
      await h.db`select count(*)::int as n from van_audit_events`
    )[0].n,
    posted = postings.length;
  const r = await push([op("test.suspend", {}), accepted[0]]);
  expect(r.res.status).toBe(403);
  expect(
    (await h.db`select count(*)::int as n from van_audit_events`)[0].n,
  ).toBe(before);
  expect(postings.length).toBe(posted);
  await h.db`update registered_devices set status='active' where id=${who.deviceId}`;
});
test("persisted profile withdrawal between proof and replay is refused", async () => {
  const r = await push([op("test.withdraw", {}), accepted[0]]);
  expect(r.res.status).toBe(403);
  await h.db`update profiles set status='active' where id=${who.profile.id}`;
});
test("media claim rejects foreign trip; integer units and half-up money are exact", async () => {
  const actor = await actorFor(h.db, who.userId);
  expect(
    await canClaimMedia(h.db, actor, {
      purpose: "truck-damage",
      ownerId: crypto.randomUUID(),
      deviceId: who.deviceId,
    }),
  ).toBe(false);
  expect(units(25n, 12n, 1n).display).toBe("2 cases + 1 pieces");
  expect(extend(101n, 5n, 10n)).toBe(51n);
});

test("new day workflow rejects absent damage evidence without stock or audit writes", async () => {
  const [v] =
    await h.db`select id from vehicles where truck_location_id=${truck}`;
  const planned = await web("trips/plan", {
    vehicleId: v.id,
    salespersonProfileId: who.profile.id,
    serviceDate: today(),
  });
  expect(planned.status).toBe(200);
  trip = planned.body;
  accepted.length = 0;
  const plannedLoad = await web("loads/plan", {
    tripId: trip.tripId,
    lines: [{ productId: product, expectedBase: "30" }],
  });
  expect(plannedLoad.status).toBe(200);
  await apply(
    op("load.confirm", {
      tripId: trip.tripId,
      loadId: plannedLoad.body.loadId,
      lines: [{ lineNumber: 1, actualBase: "30" }],
    }),
  );
  await apply(
    op("trip.start", {
      tripId: trip.tripId,
      vehicleConfirmed: true,
      routeConfirmed: true,
    }),
  );
  expect(
    await canClaimMedia(h.db, await actorFor(h.db, who.userId), {
      purpose: "truck-damage",
      ownerId: trip.tripId,
      deviceId: who.deviceId,
    }),
  ).toBe(true);
  const before = postings.length;
  const r = await push([
    op("truck.damage", {
      tripId: trip.tripId,
      productId: product,
      quantityBase: "12",
      reason: "crushed",
    }),
  ]);
  expect(r.body.results[0]).toMatchObject({
    status: "rejected",
    code: "evidence_pending_review",
  });
  expect(postings.length).toBe(before);
  expect(
    (
      await h.db`select count(*)::int as n from van_damage_records where trip_id=${trip.tripId}`
    )[0].n,
  ).toBe(0);
});
test("damage consumes own trip-bound JPEG, transfers statuses, and independent rejection reverses it", async () => {
  const digest = "a".repeat(64),
    fileId = crypto.randomUUID();
  await h.db`insert into files(id,owner_id,purpose,sha256,mime,size,device_id,created_by,status,path,stored_at) values(${fileId},${trip.tripId},'truck-damage',${digest},'image/jpeg',100,${who.deviceId},${who.userId},'stored','fixture.jpg',now())`;
  const a = await apply(
    op("truck.damage", {
      tripId: trip.tripId,
      productId: product,
      quantityBase: "12",
      reason: "crushed",
      photoSha256: digest,
    }),
  );
  // One in-place status change so lot-tracked stock keeps its lots.
  expect(postings.at(-1).lines).toEqual([
    {
      productId: product,
      fromLocationId: truck,
      toLocationId: truck,
      quantityBase: 12,
      uom: "PC",
      fromStockStatus: "available",
      toStockStatus: "damaged",
      lotId: null,
    },
  ]);
  const [photo] =
    await h.db`select * from van_damage_photos where storage_id=${fileId}`;
  expect(photo.damage_record_id).toBe(a.ack.entityId);
  const noteMissing = await web("damage/decide", {
    damageId: a.ack.entityId,
    decision: "reject",
  });
  expect(noteMissing.status).toBe(400);
  const rejected = await web("damage/decide", {
    damageId: a.ack.entityId,
    decision: "reject",
    note: "Verified good stock",
  });
  expect(rejected.status).toBe(200);
  expect(postings.at(-1).kind).toBe("reversal");
  expect(postings.at(-1).lines).toEqual([
    {
      productId: product,
      fromLocationId: truck,
      toLocationId: truck,
      quantityBase: 12,
      uom: "PC",
      fromStockStatus: "damaged",
      toStockStatus: "available",
      lotId: null,
    },
  ]);
  const again = await push([
    op("truck.damage", {
      tripId: trip.tripId,
      productId: product,
      quantityBase: "12",
      reason: "crushed",
      photoSha256: digest,
    }),
  ]);
  expect(again.body.results[0].status).toBe("rejected");
});
test("a forged return disposition cannot resell expired stock; promotion and missing credit setup fail closed", async () => {
  const p = salePayload(1, 1);
  await apply(op("sale.record", p));
  const before = postings.length;
  const badReturn = await push([
    op("return.record", {
      tripId: trip.tripId,
      returnId: crypto.randomUUID(),
      returnNumber: "BAD-RETURN",
      customer: { outletId: outlet },
      originalSale: { saleId: p.saleId, receiptNumber: p.receiptNumber },
      lines: [
        {
          productId: product,
          quantityBase: "1",
          stockEffect: "available",
          reason: "expired",
          lotNumber: "LOT",
          disposition: "resellable",
          approvalRequired: false,
        },
      ],
    }),
  ]);
  expect(badReturn.body.results[0].status).toBe("rejected");
  const discounted = salePayload(2, 1);
  discounted.lines[0].discountMinor = "1";
  const badPrice = await push([op("sale.record", discounted)]);
  expect(badPrice.body.results[0].status).toBe("rejected");
  const credit = salePayload(3, 1);
  credit.payment = { ...credit.payment, method: "credit", kind: "credit" };
  const noCredit = await push([op("sale.record", credit)]);
  expect(noCredit.body.results[0].status).toBe("rejected");
  expect(postings.length).toBe(before);
});
test("a valid actor snapshot cannot bypass persisted status on a direct operation transaction", async () => {
  const { applyOperation } = await import("../src/domains/van/operations.js"),
    actor = await actorFor(h.db, who.userId);
  await h.db`update profiles set status='disabled' where id=${who.profile.id}`;
  const operation = op("sale.record", salePayload(4, 1)),
    before = postings.length;
  await expect(
    tx(h.db, async (db) =>
      applyOperation(
        {
          db,
          actor,
          device: { id: who.deviceId },
          op: operation,
          payload: operation.payload,
          now: Date.now(),
          reject: () => {
            throw new Error("unexpected business rejection");
          },
        },
        h.env,
      ),
    ),
  ).rejects.toMatchObject({ code: "scope_withdrawn" });
  expect(postings.length).toBe(before);
  await h.db`update profiles set status='active' where id=${who.profile.id}`;
});
test("a stock change outside the trip explanation refuses the entire count", async () => {
  await h.db`update inventory_balances set available_base=available_base+1,physical_base=physical_base+1 where product_id=${product} and location_id=${truck}`;
  const id = crypto.randomUUID(),
    lines = [
      {
        productId: product,
        status: "available",
        expectedBase: "29",
        countedBase: "29",
        reasonCode: "",
      },
      {
        productId: product,
        status: "damaged",
        expectedBase: "0",
        countedBase: "0",
        reasonCode: "",
      },
    ];
  const result = await push([
    op("stock.reconcile", {
      tripId: trip.tripId,
      reconciliationId: id,
      lines,
      countCode: stockCountCode(trip.tripId, id, lines),
      varianceLines: 0,
      shortBase: "0",
      overBase: "0",
      approval: { method: "none" },
    }),
  ]);
  expect(result.body.results[0]).toMatchObject({
    status: "rejected",
    code: "stock_conflict",
  });
  expect(
    (
      await h.db`select count(*)::int as n from van_stock_counts where trip_id=${trip.tripId}`
    )[0].n,
  ).toBe(0);
  await h.db`update inventory_balances set available_base=available_base-1,physical_base=physical_base-1 where product_id=${product} and location_id=${truck}`;
});
test("cross-language void, cash and stock approval vectors remain byte-compatible", async () => {
  for (const kind of ["void", "cash", "stock"]) {
    const fixture = await Bun.file(
      new URL(
        `../../../packages/domain-contracts/fixtures/van-v1/${kind}-approval.json`,
        import.meta.url,
      ),
    ).json();
    const key = approvalKey(
      { SYNC_CURSOR_SECRET: fixture.secret },
      fixture.tripId,
      kind,
    );
    expect(key).toBe(fixture.key);
    for (const row of fixture.cases) {
      if (kind === "stock")
        expect(stockCountCode(fixture.tripId, row.countId, row.lines)).toBe(
          row.countCode,
        );
      expect(
        approvalCodeFor(key, approvalMessage(kind, fixture.tripId, row)),
      ).toBe(row.code);
    }
  }
});
test("after-commit van refresh is durable and coalesced", async () => {
  expect(refreshes).toHaveLength(0);
  const [pending] =
    await h.db`select count(*)::int as n from jobs where kind='van.refresh' and status='pending'`;
  expect(pending.n).toBe(1);
  expect(await runDueJobs(h.db)).toBe(1);
  expect(refreshes).toEqual([{ kind: "van", date: today(), unitId: unit }]);
});

test("linked return and void put goods back under the lots the sale took (latest first); untracked keeps one line", async () => {
  const saleId = crypto.randomUUID(),
    movementId = crypto.randomUUID(),
    lotA = crypto.randomUUID(),
    lotB = crypto.randomUUID(),
    t = { truck_location_id: truck };
  await h.db`insert into inventory_movements(id,organization_id,movement_number,movement_type,source_type,source_document_id,status,effective_at,posted_at,posted_by,idempotency_key,schema_version)
    values(${movementId},'sunpride',${movementId},'pos_sale','van_sale',${saleId},'posted',now(),now(),'fixture',${movementId},2)`;
  const lineId = crypto.randomUUID();
  await h.db`insert into inventory_movement_lines(id,organization_id,movement_id,line_number,product_id,quantity_base,from_location_id,effective_at)
    values(${lineId},'sunpride',${movementId},1,${product},5,${truck},now())`;
  for (const [lot, qty, seq, code] of [
    [lotA, 3, 1, "LOT-A"],
    [lotB, 2, 2, "LOT-B"],
  ]) {
    await h.db`insert into inventory_lots(id,organization_id,product_id,lot_number,normalized_lot_number,source_type,received_at,quality_status)
      values(${lot},'sunpride',${product},${code},${code},'fixture',now(),'released')`;
    await h.db`insert into inventory_allocations(organization_id,movement_id,movement_line_id,product_id,lot_id,quantity_base,from_location_id,to_location_id,from_stock_status,allocation_sequence,allocation_policy,user_selected,effective_at)
      values('sunpride',${movementId},${lineId},${product},${lot},${qty},${truck},null,'available',${seq},'fefo',false,now())`;
  }
  const facts = { productId: product, uomCode: "PC" };
  const lines = await soldLotLines(h.db, t, saleId, facts, 4n, "damaged");
  expect(
    lines.map((l) => [
      l.lotId,
      l.quantityBase,
      l.stockStatus,
      l.fromLocationId,
      l.toLocationId,
    ]),
  ).toEqual([
    [lotB, 2n, "damaged", null, truck],
    [lotA, 2n, "damaged", null, truck],
  ]);
  await expect(
    soldLotLines(h.db, t, saleId, facts, 6n, "available"),
  ).rejects.toThrow("Returned quantity exceeds the sold lots");
  const untracked = await soldLotLines(
    h.db,
    t,
    crypto.randomUUID(),
    facts,
    2n,
    "available",
  );
  expect(untracked).toHaveLength(1);
  expect(untracked[0].lotId).toBeNull();
});

test("a settled earlier trip does not hide the next same-day trip; two open trips still refuse", async () => {
  const { bundle } = await import("../src/domains/van/projection.js");
  const actor = await actorFor(h.db, who.userId);
  const ctx = {
    db: h.db,
    actor,
    device: { id: who.deviceId },
    params: { serviceDate: today() },
  };
  expect((await bundle(ctx, h.env)).trip?.tripId).toBe(trip.tripId);
  const conflicting = async () => {
    await h.db`insert into van_trips(organization_id,org_unit_id,trip_number,vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,status,created_by)
    select organization_id,org_unit_id,'CONFLICT-PROOF',vehicle_id,truck_location_id,source_location_id,service_date,salesperson_profile_id,salesperson_subject,'planned','fixture' from van_trips where id=${trip.tripId}`;
  };
  await expect(conflicting()).rejects.toMatchObject({ errno: "23505" });
  await h.db`update van_trips set status='closed' where id=${trip.tripId}`;
  expect((await bundle(ctx, h.env)).trip?.tripId).toBe(trip.tripId);
});
test("a counted overage is booked to a lot the product already holds on the truck (same status first)", async () => {
  const other = crypto.randomUUID(),
    t = { truck_location_id: truck };
  expect(await truckLot(h.db, t, other, "damaged")).toBeNull();
  const lots = [];
  for (const [code, status, qty] of [
    ["CNT-AV", "available", 5],
    ["CNT-DM", "damaged", 1],
  ]) {
    const [lot] =
      await h.db`insert into inventory_lots(organization_id,product_id,lot_number,normalized_lot_number,source_type,received_at,quality_status)
        values('sunpride',${product},${code},${code},'fixture',now(),'released') returning id`;
    await h.db`insert into inventory_lot_balances(organization_id,product_id,lot_id,location_id,stock_status,physical_base,reserved_base,available_base,expiry_sort_key,receipt_sequence,version)
      values('sunpride',${product},${lot.id},${truck},${status},${qty},0,${qty},0,1,1)`;
    lots.push(lot.id);
  }
  expect(await truckLot(h.db, t, product, "damaged")).toBe(lots[1]);
  expect(await truckLot(h.db, t, product, "available")).toBe(lots[0]);
});
