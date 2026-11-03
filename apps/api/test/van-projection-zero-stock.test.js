import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
} from "./harness.js";
import { actorFor } from "../src/core/context.js";
import { tx } from "@sunpride/db/client";
import { today, PAYMENT_METHODS } from "../src/domains/van/model.js";

/**
 * Van bundle catalogue bounds. A truck can carry historical ALL-ZERO `inventory_balances` rows (stock once moved
 * through). They must not turn into products, and through them 25 outlets x N price lines, so a trip with a small
 * planned load must still download. Anything that really holds stock, in ANY status, must stay represented, and a
 * genuinely oversized catalogue must still be refused (never truncated).
 */
mock.module("../src/domains/orders/pricing.js", () => ({
  resolvePrice: async () => ({
    unitPriceCentavos: 12525,
    priceListId: "11111111-1111-4111-8111-111111111111",
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
const { install } = await import("../src/domains/van/index.js");
const { bundle } = await import("../src/domains/van/projection.js");
const { quoteVanSchemes } = await import("../src/domains/van/commercial.js");
/** @type {any} */ let h;
/** @type {any} */ let profiles;
/** @type {any} */ let who;
/** @type {any} */ let manager;
/** @type {any} */ let trip;
let cookie = "";
const unit = crypto.randomUUID(),
  base = crypto.randomUUID(),
  depot = crypto.randomUUID(),
  truck = crypto.randomUUID(),
  loadProducts = [
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
  ];
const OUTLETS = 25;
const QUANTITY_COLUMNS = [
  "physical_base",
  "available_stock_base",
  "reserved_base",
  "available_base",
  "quality_hold_base",
  "quarantine_base",
  "damaged_base",
  "expired_base",
  "rejected_base",
  "wip_base",
  "in_transit_base",
];
/** @param {any} user */
async function persistPerson(user) {
  const p = user.profile;
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user.userId},${user.userId},${p.name},${user.email},${p.role},'active',${p.orgUnitId})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${p.orgUnitId},${p.role},now()-interval '1 day','fixture','fixture')`;
}
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
/** Insert `count` active products named ZP<from..> plus one truck balance row each, all quantities zero (or null). @param {number} from @param {number} count @param {boolean} [nulls] */
async function zeroRows(from, count, nulls = false) {
  await h.db`insert into products(id,organization_id,code,name,category,uom,unit_price,active,base_uom_id,quantity_scale)
    select gen_random_uuid(),'sunpride','ZP'||g,'Zero history '||g,'Canned','PC',0,true,${base},1 from generate_series(${from},${from + count - 1}) g`;
  await h.db`insert into inventory_balances(product_code,warehouse_code,on_hand,reserved,available,as_of,organization_id,product_id,location_id,physical_base,available_stock_base,reserved_base,available_base,quality_hold_base,quarantine_base,damaged_base,expired_base,rejected_base,wip_base,in_transit_base)
    select p.code,'TRUCK',0,0,0,now(),'sunpride',p.id,${truck},0,${nulls ? null : 0n},${nulls ? null : 0n},0,0,${nulls ? null : 0n},0,${nulls ? null : 0n},0,${nulls ? null : 0n},0 from products p where p.code like 'ZP%' and not exists(select 1 from inventory_balances b where b.product_id=p.id and b.location_id=${truck})`;
}
async function ctx() {
  return {
    db: h.db,
    actor: await actorFor(h.db, who.userId),
    device: { id: who.deviceId },
    params: { serviceDate: today() },
    now: Date.now(),
  };
}
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  profiles = profileStore(h);
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','VAN','Van team','national','active',now()-interval '1 day')`;
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
  await h.db`insert into units_of_measure(id,organization_id,code,name,dimension,decimal_places,active) values(${base},'sunpride','PC','Piece','count',0,true)`;
  for (const [i, id] of loadProducts.entries())
    await h.db`insert into products(id,organization_id,code,name,category,uom,unit_price,active,base_uom_id,quantity_scale) values(${id},'sunpride',${`LOAD${i}`},${`Load product ${i}`},'Canned','PC',0,true,${base},1)`;
  for (const [id, code, type] of [
    [depot, "DEPOT", "warehouse"],
    [truck, "TRUCK", "truck"],
  ])
    await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${id},'sunpride',${unit},'CEBU',${code},${code},${type},true,true,true,true,false)`;
  // One load product also has a historical zero row on the truck: a planned load line stays represented regardless.
  await h.db`insert into inventory_balances(product_code,warehouse_code,on_hand,reserved,available,as_of,organization_id,product_id,location_id,physical_base,weighted_average_cost_minor) values('LOAD0','TRUCK',0,0,0,now(),'sunpride',${loadProducts[0]},${truck},0,10000)`;
  await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,channel,created_by) select gen_random_uuid(),'sunpride','STORE'||g,'Sample store '||g,'active',${unit},'GT','fixture' from generate_series(1,${OUTLETS}) g`;
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
  const l = await web("loads/plan", {
    tripId: t.body.tripId,
    lines: loadProducts.map((productId) => ({ productId, expectedBase: "48" })),
  });
  expect(l.status).toBe(200);
  [trip] = await h.db`select * from van_trips where id=${t.body.tripId}`;
}, 60000);
afterAll(async () => {
  await h?.close();
});

test("40 historical zero truck rows + 25 outlets + 3 load products: the bundle downloads with only the load catalogue", async () => {
  await zeroRows(1, 40);
  const [{ n }] =
    await h.db`select count(*)::int n from inventory_balances where location_id=${truck}`;
  expect(n).toBe(41);
  const d = await bundle(await ctx(), h.env);
  expect(d.trip?.status).toBe("loading");
  expect(d.load?.lines).toHaveLength(3);
  expect(d.customers).toHaveLength(OUTLETS);
  expect(d.products.map((/** @type {any} */ p) => p.productId).sort()).toEqual(
    [...loadProducts].sort(),
  );
  expect(d.priceLines).toHaveLength(OUTLETS * 3);
  // the load product's own (zero) row is still reported; the 40 dead products are not
  expect(d.truckStock.map((/** @type {any} */ s) => s.productId)).toEqual([
    loadProducts[0],
  ]);
});
test("hundreds of zero rows (null or 0 in every status) neither trip the 500-row bound nor the sibling commercial catalogue", async () => {
  await zeroRows(41, 480, true);
  const [{ n }] =
    await h.db`select count(*)::int n from inventory_balances where location_id=${truck}`;
  expect(n).toBe(521);
  const d = await bundle(await ctx(), h.env);
  expect(d.products).toHaveLength(3);
  expect(d.priceLines).toHaveLength(OUTLETS * 3);
  // commercial.js builds the same catalogue: it must price a load product, and not know a dead zero-row product
  const [outlet] = await h.db`select id,channel from outlets limit 1`;
  const quote = async (/** @type {string} */ productId) =>
    tx(h.db, async (db) =>
      quoteVanSchemes(
        db,
        trip,
        await actorFor(db, who.userId),
        h.env,
        {
          schemeEngineVersion: 1,
          deviceTime: Date.now(),
          lines: [{ productId, quantityBase: "1" }],
        },
        { id: outlet.id, channel: outlet.channel, customerCode: null },
      ),
    );
  expect((await quote(loadProducts[1]))?.captured.has(loadProducts[1])).toBe(
    true,
  );
  const [dead] =
    await h.db`select product_id from inventory_balances where location_id=${truck} and product_code='ZP41'`;
  await expect(quote(dead.product_id)).rejects.toThrow(
    "Sale products do not match the trip catalog",
  );
});
test("a quantity in ANY status keeps its product represented (each column on its own)", async () => {
  const rows =
    await h.db`select b.product_id from inventory_balances b join products p on p.id=b.product_id where b.location_id=${truck} and p.code like 'ZP%' order by p.code limit ${QUANTITY_COLUMNS.length}`;
  expect(rows).toHaveLength(QUANTITY_COLUMNS.length);
  for (const [i, column] of QUANTITY_COLUMNS.entries())
    await h.db.unsafe(
      `update inventory_balances set ${column}=${i + 1} where location_id=$1 and product_id=$2`,
      [truck, rows[i].product_id],
    );
  const d = await bundle(await ctx(), h.env);
  const ids = d.products.map((/** @type {any} */ p) => p.productId);
  expect(ids).toHaveLength(3 + QUANTITY_COLUMNS.length);
  for (const r of rows) expect(ids).toContain(r.product_id);
  expect(
    d.truckStock.map((/** @type {any} */ s) => s.productId).sort(),
  ).toEqual(
    [
      loadProducts[0],
      ...rows.map((/** @type {any} */ r) => r.product_id),
    ].sort(),
  );
  expect(d.priceLines).toHaveLength(OUTLETS * ids.length);
});
test("a genuinely oversized catalogue is still refused, never truncated", async () => {
  // 30 more real stock-bearing products: (3 + 11 + 30) x 25 outlets = 1100 price lines > 600
  const more =
    await h.db`select b.product_id from inventory_balances b join products p on p.id=b.product_id where b.location_id=${truck} and p.code like 'ZP%' and coalesce(b.physical_base,0)=0 and coalesce(b.available_stock_base,0)=0 and coalesce(b.reserved_base,0)=0 and coalesce(b.available_base,0)=0 and coalesce(b.quality_hold_base,0)=0 and coalesce(b.quarantine_base,0)=0 and coalesce(b.damaged_base,0)=0 and coalesce(b.expired_base,0)=0 and coalesce(b.rejected_base,0)=0 and coalesce(b.wip_base,0)=0 and coalesce(b.in_transit_base,0)=0 limit 30`;
  expect(more).toHaveLength(30);
  await h.db`update inventory_balances set physical_base=5,available_base=5 where location_id=${truck} and product_id in ${h.db(more.map((/** @type {any} */ r) => r.product_id))}`;
  await expect(bundle(await ctx(), h.env)).rejects.toMatchObject({
    code: "projection_too_large",
    status: 422,
  });
});
test("more than 500 stock-bearing rows is refused at the row bound", async () => {
  await h.db`update inventory_balances set physical_base=1,available_base=1 where location_id=${truck}`;
  await expect(bundle(await ctx(), h.env)).rejects.toMatchObject({
    code: "projection_too_large",
  });
});
