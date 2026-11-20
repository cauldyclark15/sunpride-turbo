import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  signedPost,
  deviceKey,
  nativeSignIn,
  bind,
} from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { tx } from "@sunpride/db/client";
import { today, PAYMENT_METHODS } from "../src/domains/van/model.js";

// SP-0191: a Field app phone (field-android) counts as a van phone on the van paths only while its owner has
// Selling switched on. Same van wire as the Van app: same ops, same payloads, same fiscal ranges. Real Postgres,
// real stock writer; only pricing, analytics and the org scope boundary are mocked (as in van-refund-real).
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
mock.module("../src/domains/analytics/refresh.js", () => ({
  enqueueRefresh: async () => {},
}));
const { install } = await import("../src/domains/van/index.js");
const { install: installFiscal } =
  await import("../src/domains/fiscal/index.js");
const { allocateDocumentNumber } =
  await import("../src/domains/fiscal/series.js");
const { currentDeviceActor, currentStoreDeviceActor } =
  await import("../src/domains/van/access.js");
const { isSellingDevice } = await import("../src/domains/van/selling.js");
const { cashExpectation, expectedStock } =
  await import("../src/domains/van/facts.js");
const { stockCountCode } = await import("../src/domains/van/approvals.js");

/** @type {any} */ let h;
/** @type {any} */ let profiles;
const unit = crypto.randomUUID(),
  base = crypto.randomUUID(),
  product = crypto.randomUUID(),
  outlet = crypto.randomUUID(),
  depot = crypto.randomUUID(),
  truck = crypto.randomUUID();
/** @type {any} */ let seller; // Field app phone
/** @type {any} */ let vanSeller; // Van app phone (unchanged behaviour)
/** @type {any} */ let manager;
let cookie = "";
/** @type {{invoice:string, credit:string}} */ const series = {
  invoice: "",
  credit: "",
};
/** @param {any} user */
async function persistPerson(user) {
  const p = user.profile;
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user.userId},${user.userId},${p.name},${user.email},${p.role},'active',${p.orgUnitId})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${p.orgUnitId},${p.role},now()-interval '1 day','fixture','fixture')`;
}
/** @param {boolean} on */
const setSelling = (on) =>
  h.db`update profiles set selling=${on},scope_epoch=scope_epoch+1 where id=${seller.profile.id}`;

beforeAll(async () => {
  h = await startHarness({ installers: [install, installFiscal] });
  profiles = profileStore(h);
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','VAN','Van team','national','active',now()-interval '1 day')`;
  seller = await boundDevice(h, profiles, {
    app: "field-android",
    orgUnitId: unit,
  });
  seller.profile.name = "Rhea Field";
  await persistPerson(seller);
  vanSeller = await boundDevice(h, profiles, {
    app: "van-android",
    orgUnitId: unit,
  });
  await persistPerson(vanSeller);
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
  await h.db`insert into units_of_measure(id,organization_id,code,name,dimension,decimal_places,active) values(${base},'sunpride','PC','Piece','count',0,true)`;
  await h.db`insert into products(id,organization_id,code,name,category,uom,unit_price,active,base_uom_id,quantity_scale) values(${product},'sunpride','SAMPLE','Sample product','Canned','PC',0,true,${base},1)`;
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
  for (const [kind, prefix] of [
    ["sales_invoice", "SEL-SI"],
    ["credit_memo", "SEL-CM"],
  ]) {
    const [reg] =
      await h.db`insert into fiscal_registrations(org_unit_id,entity_name,branch_name,tin,address,document_type,status,effective_from,entered_by,sample) values(${unit},'SAMPLE','Sample branch','SAMPLE TIN','Sample address',${kind},'sample_not_filed',now()-interval '1 day',${manager.profile.id},true) returning id`;
    const [s] =
      await h.db`insert into fiscal_series(registration_id,prefix,first_serial,last_serial,next_allocate,effective_from) values(${reg.id},${prefix},1,1000,1,now()-interval '1 day') returning id`;
    series[kind === "sales_invoice" ? "invoice" : "credit"] = s.id;
  }
}, 30000);
afterAll(async () => {
  await h?.close();
});

/** @param {string} path @param {any} body */
async function web(path, body) {
  const res = await h.fetch(`/api/v1/van/${path}`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}
/** @param {string} path */
async function read(path) {
  const res = await h.fetch(`/api/v1/van/${path}`, { headers: { cookie } });
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
/** The exact Van app envelope, sent from the Field app's device key (app "field-android"). @param {any[]} operations */
const push = (operations) =>
  signedPost(h, seller, "/api/sync/push", {
    version: 2,
    app: "field-android",
    deviceId: seller.deviceId,
    scopeId: unit,
    operations,
  });
/** @param {any} operation */
async function send(operation) {
  const r = await push([operation]);
  expect(r.res.status).toBe(200);
  return r.body.results[0];
}
/** @type {any[]} */ const accepted = [];
/** @param {any} operation */
async function apply(operation) {
  const r = await send(operation);
  expect(r.status, JSON.stringify(r)).toBe("applied");
  accepted.push(operation);
  return r;
}
/** @param {string} seriesId @param {number} count */
const allocate = (seriesId, count) =>
  tx(h.db, async (db) =>
    allocateDocumentNumber(db, {
      actor: await actorFor(db, seller.userId),
      deviceId: seller.deviceId,
      seriesId,
      requestKey: crypto.randomUUID(),
      count,
    }),
  );
/** @type {any} */ let trip;
/** @type {any} */ let load;
/** @type {any} */ let sale;
let creditAllocation = "";

test("with Selling off, a Field app phone is not a van phone: no receipt range, van ops refused one by one (final), no bind", async () => {
  expect(
    await isSellingDevice(h.db, {
      app: "field-android",
      profile_id: seller.profile.id,
    }),
  ).toBe(false);
  let refusal = /** @type {any} */ (null);
  try {
    await allocate(series.invoice, 10);
  } catch (e) {
    refusal = e;
  }
  expect(refusal?.code).toBe("out_of_scope");
  expect(refusal?.retryable).toBe(false);
  const v = await web("vehicles/create", {
    orgUnitId: unit,
    vehicleCode: "V1",
    plateNumber: "SAMPLE",
    truckLocationId: truck,
    homeLocationId: depot,
  });
  expect(v.status).toBe(200);
  trip = (
    await web("trips/plan", {
      vehicleId: v.body.vehicleId,
      salespersonProfileId: seller.profile.id,
      serviceDate: today(),
    })
  ).body;
  trip.vehicleId = v.body.vehicleId;
  load = (
    await web("loads/plan", {
      tripId: trip.tripId,
      lines: [{ productId: product, expectedBase: "48" }],
    })
  ).body;
  const refused = await send(
    op("load.confirm", {
      tripId: trip.tripId,
      loadId: load.loadId,
      lines: [{ lineNumber: 1, actualBase: "48" }],
    }),
  );
  // Refused for this op only (the push itself answers 200), final, and kept for the office.
  expect(refused).toMatchObject({
    status: "rejected",
    code: "out_of_scope",
    retryable: false,
  });
  const [loadRow] =
    await h.db`select status from van_trip_loads where id=${load.loadId}`;
  expect(loadRow.status).not.toBe("posted");
  // The office cannot put this phone on a truck, and it is not offered in the phone list.
  const bind = await web("devices/bind", {
    vehicleId: trip.vehicleId,
    deviceId: seller.deviceId,
  });
  expect(bind.status).toBe(422);
  const list = await read("devices");
  expect(list.status).toBe(200);
  const ids = list.body.items.map((/** @type {any} */ d) => d.deviceId);
  expect(ids).toContain(vanSeller.deviceId);
  expect(ids).not.toContain(seller.deviceId);
});

test("with Selling on, the Field app phone gets receipt ranges, loads, starts the trip and sells with a receipt number", async () => {
  await setSelling(true);
  expect(
    await isSellingDevice(h.db, {
      app: "field-android",
      profile_id: seller.profile.id,
    }),
  ).toBe(true);
  const inv = await allocate(series.invoice, 100);
  expect(inv.allocationId).toBeString();
  creditAllocation = (await allocate(series.credit, 20)).allocationId;
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
  const [started] =
    await h.db`select status,started_device_id from van_trips where id=${trip.tripId}`;
  expect(started.status).toBe("active");
  expect(started.started_device_id).toBe(seller.deviceId);
  // The van data download (the same van.bundle the Van app reads) answers the selling Field app phone.
  const bundle = await signedPost(h, seller, "/api/sync/pull", {
    version: 2,
    app: "field-android",
    deviceId: seller.deviceId,
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
  expect(bundle.res.status, JSON.stringify(bundle.body)).toBe(200);
  expect(bundle.body.bundles[0].projection).toBe("van.bundle");
  const [a] =
    await h.db`select a.id,a.next_issue,s.prefix from fiscal_allocations a join fiscal_series s on s.id=a.series_id where a.id=${inv.allocationId}`;
  const total = String(3 * 12525);
  sale = {
    tripId: trip.tripId,
    saleId: crypto.randomUUID(),
    receiptNumber: `${a.prefix}-${String(a.next_issue).padStart(9, "0")}`,
    fiscal: { allocationId: a.id, serial: String(a.next_issue) },
    customer: { outletId: outlet },
    currency: "PHP",
    totalMinor: total,
    lines: [
      {
        productId: product,
        quantityBase: "3",
        paidBase: "3",
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
  await apply(op("sale.record", sale));
  const [doc] =
    await h.db`select document_number,source_type from fiscal_documents where source_id=${sale.saleId}`;
  expect(doc.source_type).toBe("van_sale");
  expect(doc.document_number).toBe(sale.receiptNumber);
  const [s] =
    await h.db`select total_centavos::text as t from van_sales where id=${sale.saleId}`;
  expect(s.t).toBe(total);
});

test("the selling Field app phone refunds (credit memo), is offered to the office for a truck, and closes the trip", async () => {
  const [c] =
    await h.db`select next_issue from fiscal_allocations where id=${creditAllocation}`;
  const serial = String(c.next_issue);
  const refund = op("refund.record", {
    tripId: trip.tripId,
    originalSale: { saleId: sale.saleId, receiptNumber: sale.receiptNumber },
    lines: [{ lineIndex: 0, productId: product, quantityBase: "1" }],
    reasonCode: "RF-CHANGED-MIND",
    note: null,
    expectedMinor: "12525",
    fiscal: { allocationId: creditAllocation, serial },
    creditNumber: `SEL-CM-${serial.padStart(9, "0")}`,
    refundNumber: 1,
  });
  refund.payload.refundId = refund.clientOpId;
  await apply(refund);
  const [r] =
    await h.db`select total_centavos::text as t from sale_refunds where sale_id=${sale.saleId}`;
  expect(r.t).toBe("12525");
  // Rule 6: the office list offers the phone, named so it reads as the person's Field app phone, and binding works.
  const list = await read("devices");
  const mine = list.body.items.find(
    (/** @type {any} */ d) => d.deviceId === seller.deviceId,
  );
  expect(mine.app).toBe("field-android");
  expect(mine.name).toContain("Rhea Field");
  expect(mine.name).toContain("(Field app)");
  const bind = await web("devices/bind", {
    vehicleId: trip.vehicleId,
    deviceId: seller.deviceId,
  });
  expect(bind.status, JSON.stringify(bind.body)).toBe(200);
  // Count cash and stock exactly, the office receives the cash, then the trip closes.
  const countId = crypto.randomUUID();
  const lines = (await expectedStock(h.db, trip.tripId)).map(
    (/** @type {any} */ e) => ({
      productId: e.productId,
      status: e.status,
      expectedBase: String(e.expectedBase),
      countedBase: String(e.expectedBase),
      reasonCode: "",
    }),
  );
  await apply(
    op("stock.reconcile", {
      tripId: trip.tripId,
      reconciliationId: countId,
      countCode: stockCountCode(trip.tripId, countId, lines),
      varianceLines: 0,
      shortBase: "0",
      overBase: "0",
      lines,
    }),
  );
  const expected = String(await cashExpectation(h.db, trip.tripId));
  await apply(
    op("cash.reconcile", {
      tripId: trip.tripId,
      reconciliationId: crypto.randomUUID(),
      currency: "PHP",
      expectedMinor: expected,
      declaredMinor: expected,
      counts: [{ denominationMinor: "1", count: expected }],
      reasonCode: "",
    }),
  );
  const remit = await web("cash/remit", {
    tripId: trip.tripId,
    amountMinor: expected,
    reference: "SAMPLE-HANDIN",
  });
  expect(remit.status, JSON.stringify(remit.body)).toBe(200);
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
  const [closed] =
    await h.db`select status from van_trips where id=${trip.tripId}`;
  expect(closed.status).toBe("closed");
});

test("Selling switched off again: the next van op from that Field app phone is refused (final), the Van app phone is unchanged, Store POS never takes a Field app phone", async () => {
  await setSelling(false);
  const refused = await send(
    op("trip.start", {
      tripId: trip.tripId,
      vehicleConfirmed: true,
      routeConfirmed: true,
    }),
  );
  expect(refused).toMatchObject({
    status: "rejected",
    code: "out_of_scope",
    retryable: false,
  });
  const [kept] =
    await h.db`select code from op_refusals where device_id=${seller.deviceId} order by created_at desc limit 1`;
  expect(kept.code).toBe("out_of_scope");
  // The Van app phone still counts as a van phone, with or without any Selling flag.
  const van = await tx(h.db, async (db) =>
    currentDeviceActor(
      db,
      await actorFor(db, vanSeller.userId),
      vanSeller.deviceId,
    ),
  );
  expect(van.device.app).toBe("van-android");
  // Store POS stays Van-app-only, even while the person has Selling on.
  await setSelling(true);
  let store = /** @type {any} */ (null);
  try {
    await tx(h.db, async (db) =>
      currentStoreDeviceActor(
        db,
        await actorFor(db, seller.userId),
        seller.deviceId,
      ),
    );
  } catch (e) {
    store = e;
  }
  expect(store?.code).toBe("device_unavailable");
  expect(store?.status).toBe(403);
  const fieldVan = await tx(h.db, async (db) =>
    currentDeviceActor(db, await actorFor(db, seller.userId), seller.deviceId),
  );
  expect(fieldVan.device.app).toBe("field-android");
});

test("the Field app's own /api/me carries profile.selling (what the phone reads at sign-in/refresh); the Van app's does not", async () => {
  /** @param {any} dev */
  const me = async (dev) => {
    const r = await h.fetch("/api/me", {
      headers: {
        authorization: `Bearer ${dev.access}`,
        "x-app": dev.app,
        "x-device-key-id": dev.key.keyId,
      },
    });
    expect(r.status).toBe(200);
    return /** @type {any} */ (await r.json());
  };
  await setSelling(false);
  expect((await me(seller)).profile.selling).toBe(false);
  await setSelling(true);
  const on = await me(seller);
  expect(on.profile.selling).toBe(true);
  expect(on.selling).toBeUndefined(); // only inside profile
  // Same rule as the field bundle: a non-sales role never sells, even with the stored flag on.
  await h.db`update profiles set role='viewer' where id=${seller.profile.id}`;
  try {
    expect((await me(seller)).profile.selling).toBe(false);
  } finally {
    await h.db`update profiles set role='sales' where id=${seller.profile.id}`;
  }
  // Van app phones and old parsers: no new key at all.
  expect("selling" in (await me(vanSeller)).profile).toBe(false);
});

test("SP-0194 the Field app's /api/me carries profile.appMode and profile.modes next to selling", async () => {
  /** @param {any} dev */
  const me = async (dev) => {
    const r = await h.fetch("/api/me", {
      headers: {
        authorization: `Bearer ${dev.access}`,
        "x-app": dev.app,
        "x-device-key-id": dev.key.keyId,
      },
    });
    expect(r.status).toBe(200);
    return /** @type {any} */ (await r.json()).profile;
  };
  const id = seller.profile.id;
  try {
    for (const [mode, selling] of /** @type {const} */ ([
      ["mapping", false],
      ["visits", false],
      ["selling", true],
    ])) {
      await h.db`update profiles set app_mode=${mode},selling=${selling},scope_epoch=scope_epoch+1 where id=${id}`;
      const p = await me(seller);
      expect(p.appMode).toBe(mode);
      expect(p.modes).toEqual([mode]);
      expect(p.selling).toBe(selling);
    }
    // SP-0219: a regular Sales person receives every office-enabled mode in the real signed-in response.
    await h.db`update profiles set app_modes=array['visits','selling'],scope_epoch=scope_epoch+1 where id=${id}`;
    const multi = await me(seller);
    expect(multi.modes).toEqual(["visits", "selling"]);
    expect(multi.selling).toBe(true);
    // A stored Truck selling mode for someone who is no longer Sales reads as Field visits, never Sell.
    await h.db`update profiles set role='viewer' where id=${id}`;
    const viewer = await me(seller);
    expect(viewer.appMode).toBe("visits");
    expect(viewer.selling).toBe(false);
  } finally {
    await h.db`update profiles set role='sales',app_mode='mapping',selling=false where id=${id}`;
  }
  // Van app phones: no new keys.
  const van = await me(vanSeller);
  expect("appMode" in van || "modes" in van).toBe(false);
});

test("SP-0193 a super_admin's own Field app phone is approved at sign-in and starts a van trip with no Selling switch", async () => {
  const email = "owner@example.com";
  const userId = await createUser(h, email, "correct horse battery");
  const owner = {
    userId,
    email,
    profile: profiles.set(userId, {
      role: "super_admin",
      orgUnitId: unit,
      name: "System Owner",
    }),
  };
  await persistPerson(owner);
  const key = await deviceKey();
  const signIn = await nativeSignIn(
    h,
    email,
    "correct horse battery",
    "field-android",
    { keyId: key.keyId, publicKeySpki: key.publicKeySpki },
  );
  expect(signIn.res.status).toBe(200);
  const [device] =
    await h.db`select d.id,d.status,p.selling from registered_devices d join profiles p on p.id=d.profile_id where d.profile_id=${owner.profile.id}`;
  expect(device.status).toBe("active");
  expect(device.selling).toBe(false); // nobody flipped the switch
  const who = {
    access: signIn.body.accessToken,
    deviceId: device.id,
    key,
  };
  expect((await bind(h, who.access, device.id, key)).body.bindingStatus).toBe(
    "bound",
  );
  const me = await h.fetch("/api/me", {
    headers: {
      authorization: `Bearer ${who.access}`,
      "x-app": "field-android",
      "x-device-key-id": key.keyId,
    },
  });
  const ownerProfile = /** @type {any} */ (await me.json()).profile;
  expect(ownerProfile.selling).toBe(true);
  // SP-0194: the owner may switch between every mode on the phone; appMode is the stored one.
  expect(ownerProfile.modes).toEqual(["mapping", "visits", "selling"]);
  expect(ownerProfile.appMode).toBe("mapping");
  expect(
    await isSellingDevice(h.db, {
      app: "field-android",
      profile_id: owner.profile.id,
    }),
  ).toBe(true);
  // The office lists the owner's Field app phone for a truck.
  const list = await read("devices");
  expect(list.body.items.map((/** @type {any} */ d) => d.deviceId)).toContain(
    device.id,
  );
  // His own truck and trip.
  const truck2 = crypto.randomUUID();
  await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${truck2},'sunpride',${unit},'CEBU','TRUCK2','TRUCK2','truck',true,true,true,true,false)`;
  await h.db`insert into inventory_balances(product_code,warehouse_code,on_hand,reserved,available,as_of,organization_id,product_id,location_id,physical_base,weighted_average_cost_minor) values('SAMPLE','TRUCK2',0,0,0,now(),'sunpride',${product},${truck2},0,10000)`;
  const v = await web("vehicles/create", {
    orgUnitId: unit,
    vehicleCode: "V2",
    plateNumber: "SAMPLE2",
    truckLocationId: truck2,
    homeLocationId: depot,
  });
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  const planned = await web("trips/plan", {
    vehicleId: v.body.vehicleId,
    salespersonProfileId: owner.profile.id,
    serviceDate: today(),
  });
  expect(planned.status, JSON.stringify(planned.body)).toBe(200);
  const ownLoad = await web("loads/plan", {
    tripId: planned.body.tripId,
    lines: [{ productId: product, expectedBase: "12" }],
  });
  expect(ownLoad.status, JSON.stringify(ownLoad.body)).toBe(200);
  /** @param {any} operation */
  const ownApply = async (operation) => {
    const r = await signedPost(h, who, "/api/sync/push", {
      version: 2,
      app: "field-android",
      deviceId: device.id,
      scopeId: unit,
      operations: [operation],
    });
    expect(r.res.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.results[0].status, JSON.stringify(r.body)).toBe("applied");
  };
  await ownApply(
    op("load.confirm", {
      tripId: planned.body.tripId,
      loadId: ownLoad.body.loadId,
      lines: [{ lineNumber: 1, actualBase: "12" }],
    }),
  );
  await ownApply(
    op("trip.start", {
      tripId: planned.body.tripId,
      vehicleConfirmed: true,
      routeConfirmed: true,
    }),
  );
  const [started] =
    await h.db`select status,started_device_id from van_trips where id=${planned.body.tripId}`;
  expect(started).toMatchObject({
    status: "active",
    started_device_id: device.id,
  });
  // No sale was made on the owner's behalf: the trip has no receipts.
  const [{ n }] =
    await h.db`select count(*)::int as n from van_sales where trip_id=${planned.body.tripId}`;
  expect(n).toBe(0);
});
