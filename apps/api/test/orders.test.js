import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { tx } from "@sunpride/db/client";
import { startMock } from "../../sap-mock/src/server.js";
import { ingestMaster } from "../src/domains/integration/replicas.js";
import { sampleMaster } from "../../sap-mock/src/sample.js";
import { hooks } from "../src/core/hooks.js";
import { registerOp } from "../src/core/sync.js";
import { sha256Hex } from "../src/core/util.js";
import {
  boundDevice,
  createUser,
  profileStore,
  signedPost,
  startHarness,
} from "./harness.js";

/** Named cross-lane boundaries only; business SQL, HTTP and CORE receipts are real. */
mock.module("../src/domains/org/scope.js", () => ({
  scopeFilterForActor: async (
    /** @type {any} */ _db,
    /** @type {any} */ actor,
  ) => ({
    unitIds: ["super_admin", "analyst"].includes(actor.role)
      ? null
      : [actor.orgUnitId],
  }),
  outletOwnerUnit: async (/** @type {any} */ db, /** @type {string} */ id) =>
    (await db`select custodian_org_unit_id from outlets where id = ${id}`)[0]
      ?.custodian_org_unit_id ?? null,
}));
mock.module("../src/domains/org/audit.js", () => ({
  writeAudit: async (/** @type {any} */ db, /** @type {any} */ e) => {
    await db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${e.subject},${e.action},${e.entityType},${e.entityId},${e.details})`;
  },
}));
/** @type {ReturnType<typeof startMock>} */ let sap;
/** @type {any[]} */
const refreshes = [];
mock.module("../src/domains/analytics/refresh.js", () => ({
  enqueueRefresh: async (/** @type {any} */ _c, /** @type {any} */ r) => {
    refreshes.push(r);
  },
}));
const { install } = await import("../src/domains/orders/index.js");
const { configureSap } =
  await import("../src/domains/integration/transport.js");
const { drainFieldOrders } =
  await import("../src/domains/orders/field-queue.js");
const { resolvePrice, creditCheck, applyPromotions } =
  await import("../src/domains/orders/pricing.js");
const { assertTransition } = await import("../src/domains/orders/service.js");
/** @type {import('./harness.js').Harness} */ let h;
/** @type {ReturnType<typeof profileStore>} */ let profiles;
/** @type {any} */ let admin;
/** @type {any} */ let manager;
/** @type {any} */ let sales;
let unit = "",
  otherUnit = "",
  product = "",
  second = "",
  outlet = "",
  territory = "";
const today = () =>
  new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/** @param {string} role @param {string} name @param {string} org */
async function person(role, name, org) {
  const user = await createUser(
    h,
    `${crypto.randomUUID()}@test.invalid`,
    "password long enough",
  );
  const p = profiles.set(user, { role, name, orgUnitId: org });
  await persist(p);
  const token = `sps_${crypto.randomUUID().replaceAll("-", "")}`;
  await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${user},${sha256Hex(token)},'web',now()+interval '1 day')`;
  return { ...p, cookie: `sp_session=${token}` };
}
/** @param {any} p */
async function persist(p) {
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id)
    values(${p.id},${p.userId},${p.userId},${p.name},${p.userId + "@test.invalid"},${p.role},'active',${p.orgUnitId})`;
}
/** @param {any} who @param {string} path @param {any} [body] */
async function api(who, path, body) {
  const res = await h.fetch(`/api/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: { cookie: who.cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = { status: res.status, body: await res.json() };
  // F-016 fixture adapter: office import is a sample staging feed, not price authority.
  if (path === "pricing/price-lists/import" && result.body.ok)
    await replicatePrices();
  return result;
}
/** @param {any} [over] */
async function create(over = {}) {
  return api(admin, "orders/create", {
    clientRequestId: crypto.randomUUID(),
    customerCode: "ACCT",
    outletId: outlet,
    lines: [{ productId: product, uom: "PC", quantity: 2 }],
    ...over,
  });
}
/** F-016 retain legacy import safety tests, then ingest their exact fixtures as SAP conditions. */
async function replicatePrices() {
  const rows =
    await h.db`select l.*,p.code as product_code,pl.code as list_code,pl.channel_key from price_list_lines l join price_lists pl on pl.id=l.price_list_id join products p on p.id=l.product_id where pl.source='office'`;
  for (const l of rows) {
    const key = `test:${l.id}`;
    const [old] =
      await h.db`select sap_version,payload from sap_replicas where kind='condition' and sap_key=${key} order by sap_version desc limit 1`;
    const m = sampleMaster(
      "condition",
      key,
      {
        productCode: l.product_code,
        uom: l.uom,
        customerCode: null,
        channelKey: l.channel_key,
        currency: "PHP",
        unitPriceCentavos: Number(l.unit_price_minor),
        taxCode: "SAMPLE-VAT12",
        taxBasisPoints: 1200,
        taxInclusive: true,
        precedence: 10,
        priceListCode: l.list_code,
      },
      Number(old?.sap_version ?? 0) + 1,
    );
    m.effectiveFrom = new Date(l.effective_from).getTime();
    m.effectiveTo = l.effective_to ? new Date(l.effective_to).getTime() : null;
    if (
      old?.payload.data.unitPriceCentavos === m.data.unitPriceCentavos &&
      old.payload.effectiveTo === m.effectiveTo
    )
      continue;
    await ingestMaster(h.db, m);
  }
}
beforeAll(async () => {
  h = await startHarness({ installers: [install] });
  sap = startMock({
    path: h.filesDir + "/orders-sap.sqlite",
    port: 0,
    seed: false,
  });
  h.env.SAP_ORIGIN = sap.origin;
  configureSap(h.db, h.env);
  sap.db
    .query("insert into credit_accounts values(?,?,?)")
    .run("ACCT", 100000000, 0);
  profiles = profileStore(h);
  unit = crypto.randomUUID();
  otherUnit = crypto.randomUUID();
  for (const [id, code] of [
    [unit, "ROOT"],
    [otherUnit, "OTHER"],
  ])
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${id},'sunpride',${code},${code},'region','active','2020-01-01')`;
  admin = await person("super_admin", "Office Admin", unit);
  manager = await person("manager", "Review Manager", unit);
  sales = await person("sales", "Ana Sales", unit);
  for (const code of ["P1", "P2"]) {
    const [p] =
      await h.db`insert into products(code,name,category,uom,unit_price,active,organization_id,quantity_scale) values(${code},${code + " canned food"},'Canned','PC',0,true,'sunpride',1) returning id`;
    if (code === "P1") product = p.id;
    else second = p.id;
  }
  await h.db`insert into customers(code,name,channel,territory,credit_limit,active) values('ACCT','=Client Account','gt','NORTH',1000,true)`;
  const [t] =
    await h.db`insert into territories(organization_id,code,name,status,effective_from,created_by) values('sunpride','NORTH','North Cebu','active','2020-01-01',${admin.userId}) returning id`;
  territory = t.id;
  await h.db`insert into territory_ownerships(territory_id,org_unit_id,effective_from,actor_subject,reason) values(${territory},${unit},'2020-01-01',${admin.userId},'fixture')`;
  const [o] =
    await h.db`insert into outlets(organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values('sunpride','STORE','Market Store','active',${unit},'gt',${admin.userId}) returning id`;
  outlet = o.id;
  await h.db`insert into outlet_assignments(outlet_id,territory_id,effective_from,actor_subject,reason) values(${outlet},${territory},'2020-01-01',${admin.userId},'fixture')`;
  await h.db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason) select ${outlet},id,'office','2020-01-01',${admin.userId},'fixture' from customers where code='ACCT'`;
  await h.db`insert into sales_assignments(salesperson_subject,customer_code,territory,active) values(${admin.userId},'ACCT','NORTH',true),(${sales.userId},'ACCT','NORTH',true)`;
  await h.db`insert into territory_salespeople(territory_id,profile_id,kind,effective_from,actor_subject,reason) values(${territory},${sales.id},'primary','2020-01-01',${admin.userId},'fixture')`;
  h.setHooks({ rootUnitId: async () => unit });
});
afterAll(async () => {
  sap?.stop();
  await h?.close();
});

describe("orders and governed prices on Postgres", () => {
  test("all-or-nothing price import reports exact row errors and writes no list", async () => {
    const r = await api(admin, "pricing/price-lists/import", {
      priceListCode: "BAD",
      channelKey: "bad",
      effectiveFrom: "2020-01-01T00:00:00Z",
      rows: [
        { productCode: "P1", uom: "PC", unitPriceCentavos: 1000 },
        { productCode: "UNKNOWN", uom: "PC", unitPriceCentavos: 1000 },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: false,
      errors: [{ row: 2, message: "Product is unknown or inactive" }],
    });
    expect(
      (await h.db`select count(*) as n from price_lists where code='BAD'`)[0].n,
    ).toBe("0");
  });
  test("effective dated price versions resolve at the exact boundary and import replay", async () => {
    const input = {
      priceListCode: "GT",
      channelKey: "gt",
      effectiveFrom: "2020-01-01T00:00:00Z",
      rows: [{ productCode: "P1", uom: "PC", unitPriceCentavos: 1000 }],
    };
    expect(
      (await api(admin, "pricing/price-lists/import", input)).body.ok,
    ).toBe(true);
    expect(
      (await api(admin, "pricing/price-lists/import", input)).body.ok,
    ).toBe(true);
    expect(
      (
        await api(admin, "pricing/price-lists/import", {
          ...input,
          effectiveFrom: "2025-01-01T00:00:00Z",
          rows: [{ productCode: "P1", uom: "PC", unitPriceCentavos: 1250 }],
        })
      ).body.ok,
    ).toBe(true);
    const resolve = (/** @type {number} */ at) =>
      resolvePrice(h.db, {
        organizationId: "sunpride",
        productId: product,
        uom: "PC",
        channelKey: "gt",
        customerCode: "ACCT",
        at,
      });
    expect(
      (await resolve(Date.parse("2024-12-31T23:59:59Z"))).unitPriceCentavos,
    ).toBe(1000);
    expect(
      (await resolve(Date.parse("2025-01-01T00:00:00Z"))).unitPriceCentavos,
    ).toBe(1250);
    expect((await h.db`select count(*) as n from price_list_lines`)[0].n).toBe(
      "2",
    );
  });
  test("unknown price never reports within or no-limit", async () => {
    const r = await create({
      lines: [{ productId: second, uom: "PC", quantity: 2 }],
    });
    expect(r.status).toBe(200);
    const d = await api(admin, `orders/detail?id=${r.body.id}`);
    expect(d.body.totalCentavos).toBeNull();
    expect(d.body.credit.status).toBe("unknown");
    expect(d.body.lines[0].unitPriceCentavos).toBeNull();
    const decide = await api(manager, "orders/approve", {
      id: r.body.id,
      reason: "Check",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(decide.status).toBe(422);
    expect(decide.body.error.code).toBe("price_unknown");
    expect(
      (await creditCheck(h.db, { customerCode: "ACCT", addCentavos: null }))
        .status,
    ).toBe("unknown");
    await h.db`update orders set status='rejected' where id=${r.body.id}`;
  });
  test("no self approval, separate approver, named history and replay", async () => {
    // HTTP callers cannot forge field lineage, a cheaper channel, credited person or capture time.
    const r = await create({
      activityId: crypto.randomUUID(),
      channelKey: "no-price",
      salespersonProfileId: manager.id,
      orderType: "van_sale",
      at: 0,
    });
    expect(r.status).toBe(200);
    const [stored] =
      await h.db`select source_activity_id,order_type,salesperson_profile_id from orders where id=${r.body.id}`;
    expect(stored).toEqual({
      source_activity_id: null,
      order_type: "booking",
      salesperson_profile_id: admin.id,
    });
    const key = crypto.randomUUID(),
      body = {
        id: r.body.id,
        reason: "Buyer PO checked",
        idempotencyKey: key,
        sapDocumentNumber: "FORGED",
      };
    const self = await api(admin, "orders/approve", body);
    expect(self.status).toBe(422);
    expect(self.body.error.code).toBe("self_approval");
    const yes = await api(manager, "orders/approve", body);
    expect(yes.status).toBe(200);
    expect((await api(manager, "orders/approve", body)).status).toBe(200);
    const d = await api(manager, `orders/detail?id=${r.body.id}`);
    expect(d.body.status).toBe("approved");
    expect(
      (
        await h.db`select sap_document_number from orders where id=${r.body.id}`
      )[0].sap_document_number,
    ).toBeNull();
    expect(d.body.history.map((/** @type {any} */ x) => x.name)).toEqual([
      "Office Admin",
      "Review Manager",
    ]);
    expect(d.body.history[1].reason).toBe(body.reason);
    expect(d.body.totalCentavos).toBe(2500);
    expect(
      (await api(manager, "orders/approve", { ...body, reason: "Different" }))
        .status,
    ).toBe(409);
    expect(
      (
        await api(manager, "orders/transition", {
          id: r.body.id,
          status: "fulfilled",
          reason: "Delivery confirmed",
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
  });
  test("status machine allows submitted through pending and refuses illegal jumps", async () => {
    expect(() => assertTransition("draft", "approved")).toThrow();
    expect(() => assertTransition("fulfilled", "approved")).toThrow();
    const r = await create({ status: "draft" });
    for (const status of ["submitted", "pending_approval"])
      expect(
        (
          await api(admin, "orders/transition", {
            id: r.body.id,
            status,
            reason: "Submit",
            idempotencyKey: crypto.randomUUID(),
          })
        ).status,
      ).toBe(200);
    expect(
      (
        await api(manager, "orders/reject", {
          id: r.body.id,
          reason: "Wrong quantity",
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
  });
  test("bulk decisions roll back all rows when one is a self approval", async () => {
    const a = await create(),
      b = await api(manager, "orders/create", {
        clientRequestId: crypto.randomUUID(),
        customerCode: "ACCT",
        outletId: outlet,
        lines: [{ productId: product, quantity: 1 }],
      });
    expect(b.status).toBe(200);
    const r = await api(manager, "orders/approve", {
      ids: [a.body.id, b.body.id],
      reason: "Batch",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(r.status).toBe(422);
    expect(
      (await h.db`select status from orders where id=${a.body.id}`)[0].status,
    ).toBe("pending_approval");
  });
  test("scope filters source before pagination and blocks detail and replay", async () => {
    const foreign = await person("manager", "Other region", otherUnit),
      r = await create();
    expect((await api(foreign, `orders/detail?id=${r.body.id}`)).status).toBe(
      403,
    );
    const list = await api(foreign, "orders/list");
    expect(list.status).toBe(200);
    expect(list.body.rows).toEqual([]);
    const own = await api(manager, "orders/list?limit=1");
    expect(own.status).toBe(200);
    expect(own.body.rows).toHaveLength(1);
    expect(own.body.next).toBeTruthy();
    const next = await api(
      manager,
      `orders/list?limit=1&cursor=${encodeURIComponent(own.body.next)}`,
    );
    expect(next.status).toBe(200);
    expect(next.body.rows[0].id).not.toBe(own.body.rows[0].id);
  });
  test("search and CSV preserve centavos, protect formulas, and invalidate analytics", async () => {
    const list = await api(admin, "orders/list?q=Client%20Account&channel=gt");
    expect(list.status).toBe(200);
    expect(list.body.rows.length).toBeGreaterThan(0);
    const res = await h.fetch("/api/v1/orders/list?format=csv", {
      headers: { cookie: admin.cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("'=Client Account");
    expect(refreshes.some((x) => x.kind === "order" && x.unitId === unit)).toBe(
      true,
    );
  });
  test("missing-price channel check includes unpriced product and known zero is not missing", async () => {
    const r = await api(admin, "pricing/missing-prices?channel=gt");
    expect(r.status).toBe(200);
    expect(r.body.rows.map((/** @type {any} */ x) => x.productCode)).toEqual([
      "P2",
    ]);
    const prior = await api(
      admin,
      `pricing/matrix?channel=gt&at=${Date.now() - 7 * 86400_000}`,
    );
    expect(prior.status).toBe(200);
    expect(
      prior.body.rows.find((/** @type {any} */ p) => p.productCode === "P1")
        .prices[0].unitPriceCentavos,
    ).toBe(1250);
  });
  test("a regional manager cannot edit nationwide pricing", async () => {
    const r = await api(manager, "pricing/price-lists/import", {
      priceListCode: "GT",
      channelKey: "gt",
      effectiveFrom: "2026-01-01",
      rows: [],
    });
    expect(r.status).toBe(403);
  });
  test("outside PO is credited, only credited person records, never makes a call", async () => {
    const body = {
      clientRequestId: crypto.randomUUID(),
      outletId: outlet,
      salespersonProfileId: sales.id,
      serviceDate: today(),
      poNumber: "PO-1",
      receivedVia: "viber",
      lines: [{ productId: product, quantity: 2 }],
    };
    const r = await api(admin, "orders/outside-calls/encode", body);
    expect(r.status).toBe(200);
    expect(r.body.commercialOrderId).toBeTruthy();
    expect(
      (await api(admin, "orders/outside-calls/encode", body)).body.orderId,
    ).toBe(r.body.orderId);
    const activity = {
      orderId: r.body.orderId,
      contact: "phone",
      codes: ["collection"],
      idempotencyKey: crypto.randomUUID(),
    };
    expect(
      (await api(manager, "orders/outside-calls/record-activity", activity))
        .status,
    ).toBe(422);
    expect(
      (await api(sales, "orders/outside-calls/record-activity", activity))
        .status,
    ).toBe(200);
    const listed = await api(
      sales,
      "orders/outside-calls/list?status=activity_recorded",
    );
    expect(listed.status).toBe(200);
    expect(listed.body.page[0].order.activity.codes).toEqual([
      "purchase_order",
      "collection",
    ]);
    expect((await h.db`select count(*) as n from visit_executions`)[0].n).toBe(
      "0",
    );
    const office = await person("operations", "Second Office Encoder", unit);
    const cancelled = await api(office, "orders/outside-calls/cancel", {
      orderId: r.body.orderId,
      reason: "Buyer withdrew the PO",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(cancelled.status).toBe(200);
    expect(
      (
        await h.db`select status from outside_call_orders where id=${r.body.orderId}`
      )[0].status,
    ).toBe("cancelled");
    expect(
      (
        await h.db`select status from orders where outside_call_id=${r.body.orderId}`
      )[0].status,
    ).toBe("voided");
  });
  test("F-112 SAP exposure includes all channels and unknown wins", async () => {
    sap.db
      .query(
        "update credit_accounts set credit_limit=1000,exposure=1500 where customer=?",
      )
      .run("ACCT");
    await h.db`update customers set credit_limit=99999 where code='ACCT'`; // local limits cannot override SAP
    const r = await create();
    const d = await api(admin, `orders/detail?id=${r.body.id}`);
    expect(d.body.credit.status).toBe("over");
    expect(d.body.credit.exposure).toBeGreaterThan(1000);
    expect(
      (await creditCheck(h.db, { customerCode: "ACCT", addCentavos: 1 }))
        .status,
    ).toBe("over");
    expect(
      (await creditCheck(h.db, { customerCode: "ACCT", addCentavos: null }))
        .status,
    ).toBe("unknown");
    sap.db
      .query(
        "update credit_accounts set credit_limit=100000000,exposure=0 where customer=?",
      )
      .run("ACCT");
  });
  test("a conflicting price version rolls the entire multi-row import back", async () => {
    const r = await api(admin, "pricing/price-lists/import", {
      priceListCode: "GT",
      channelKey: "gt",
      effectiveFrom: "2025-01-01T00:00:00Z",
      rows: [
        { productCode: "P1", uom: "PC", unitPriceCentavos: 9999 },
        { productCode: "P2", uom: "PC", unitPriceCentavos: 500 },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.errors[0].row).toBe(1);
    expect(
      (
        await resolvePrice(h.db, {
          organizationId: "sunpride",
          productId: second,
          uom: "PC",
          channelKey: "gt",
          customerCode: null,
          at: Date.now(),
        })
      ).unitPriceCentavos,
    ).toBeNull();
  });
  test("ambiguous channel prices fail closed instead of choosing the newest list", async () => {
    const ambiguous = sampleMaster("condition", "GT-AMBIG", {
      productCode: "P1",
      uom: "PC",
      customerCode: null,
      channelKey: "gt",
      currency: "PHP",
      unitPriceCentavos: 1250,
      taxCode: "SAMPLE-VAT12",
      taxBasisPoints: 1200,
      taxInclusive: true,
      precedence: 10,
      priceListCode: "GT-AMBIG",
    });
    await ingestMaster(h.db, ambiguous);
    expect(
      await resolvePrice(h.db, {
        organizationId: "sunpride",
        productId: product,
        uom: "PC",
        channelKey: "gt",
        customerCode: null,
        at: Date.now(),
      }),
    ).toEqual({
      unitPriceCentavos: null,
      priceListId: null,
      source: "ambiguous",
    });
    await ingestMaster(h.db, { ...ambiguous, version: 2, deleted: true });
  });
  test("promotion CRUD freezes net line totals that reconcile to the order", async () => {
    const p = {
      code: "FIVE",
      name: "Five percent",
      effectiveFrom: "2020-01-01T00:00:00Z",
      rule: {
        kind: "percent_off",
        item: { productId: product, uom: "PC", quantity: 1 },
        percentOffBasisPoints: 500,
      },
    };
    const made = await api(admin, "pricing/promotions/create", p);
    expect(made.status).toBe(200);
    expect(made.body.id).toBeTruthy();
    const r = await create(),
      d = await api(admin, `orders/detail?id=${r.body.id}`);
    expect(d.body.totalCentavos).toBe(2375);
    expect(
      d.body.lines.reduce(
        (/** @type {number} */ n, /** @type {any} */ l) =>
          n + l.lineTotalCentavos,
        0,
      ),
    ).toBe(2375);
    expect(d.body.pricing.promotionsApplied[0].name).toBe("Five percent");
    const update = {
      ...p,
      id: made.body.id,
      effectiveTo: null,
      status: "inactive",
      idempotencyKey: crypto.randomUUID(),
    };
    expect((await api(admin, "pricing/promotions/update", update)).status).toBe(
      200,
    );
    expect(
      (
        await api(admin, "pricing/promotions/update", {
          ...update,
          status: "active",
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(admin, "pricing/promotions/update", {
          ...update,
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(admin, "pricing/promotions/delete", {
          id: made.body.id,
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    expect(
      (await api(admin, `orders/detail?id=${r.body.id}`)).body.totalCentavos,
    ).toBe(2375);
  });
  test("same-customer foreign stock source cannot leak through current customer membership", async () => {
    const r = await create();
    const [loc] =
      await h.db`insert into inventory_locations(organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production)
      values('sunpride',${otherUnit},'OTHER','OTHER','Other stock','warehouse',true,true,true,true,false) returning id`;
    await h.db`update orders set source_location_id=${loc.id} where id=${r.body.id}`;
    expect((await api(manager, `orders/detail?id=${r.body.id}`)).status).toBe(
      403,
    );
    const whole = await api(admin, `orders/detail?id=${r.body.id}`);
    expect(
      (await api(admin, `orders/list?q=${whole.body.orderNumber}`)).body.rows,
    ).toHaveLength(1);
    const list = await api(manager, `orders/list?q=${whole.body.orderNumber}`);
    expect(list.body.rows).toEqual([]);
  });
  test("saved approval view excludes self requests and filter choices use names", async () => {
    const r = await api(manager, "orders/list?view=waiting");
    expect(r.status).toBe(200);
    for (const o of r.body.rows)
      expect(o.salespersonProfileId).not.toBe(manager.id);
    const opts = await api(manager, "orders/filter-options");
    expect(opts.status).toBe(200);
    expect(
      opts.body.people.some(
        (/** @type {any} */ p) => p.label === "Office Admin",
      ),
    ).toBe(true);
  });
  test("CORE replays exact visit.activity order op once through the commercial seam", async () => {
    const d = await boundDevice(h, profiles, { orgUnitId: unit });
    await persist(d.profile);
    await h.db`insert into sales_assignments(salesperson_subject,customer_code,territory,active) values(${d.userId},'ACCT','NORTH',true)`;
    const [v] =
      await h.db`insert into visit_executions(organization_id,client_visit_id,assignee_profile_id,outlet_id,org_unit_id,service_date,source,state,productivity,last_server_time,checked_in_at)
      values('sunpride',${crypto.randomUUID()},${d.profile.id},${outlet},${unit},${today()},'planned','in-progress','pending',now(),now()-interval '1 hour') returning id`;
    const [account] =
      await h.db`insert into call_sheet_accounts(organization_id,outlet_id,revision,header_account_name,updated_by,updated_at) values('sunpride',${outlet},1,'Store',${admin.userId},now()-interval '1 day') returning id`;
    await h.db`insert into call_sheet_account_lines(call_sheet_account_id,ordinal,product_id) values(${account.id},0,${product})`;
    // VISITS-owned insertion fixture only: the orders lane must not own this writer.
    registerOp("visit.activity", async (c) => {
      const p = /** @type {any} */ (c.payload);
      const [a] =
        await c.db`insert into visit_activities(organization_id,org_unit_id,visit_id,assignee_profile_id,outlet_id,activity_kind,activity,device_time,server_time)
        values('sunpride',${unit},${v.id},${d.profile.id},${outlet},'order_intent',${p.activity},${new Date(p.deviceTime)},now()) returning id`;
      return { entityId: a.id };
    });
    const op = {
      clientOpId: crypto.randomUUID(),
      opType: "visit.activity",
      clientTime: Date.now(),
      dependsOn: [],
      payload: {
        visitId: v.id,
        deviceTime: Date.now(),
        activity: {
          kind: "order_intent",
          clientOrderId: crypto.randomUUID(),
          lines: [{ productId: product, uom: "PC", quantity: 1 }],
        },
      },
    };
    const body = {
      version: 2,
      app: d.app,
      deviceId: d.deviceId,
      scopeId: unit,
      operations: [op],
    };
    const a = await signedPost(h, d, "/api/sync/push", body);
    expect(a.body.error).toBeUndefined();
    expect(a.res.status).toBe(200);
    expect(a.body.results[0].status).toBe("applied");
    const b = await signedPost(h, d, "/api/sync/push", body);
    expect(b.body.results[0].status).toBe("duplicate");
    expect(b.body.results[0].ack).toEqual(a.body.results[0].ack);
    const c = await signedPost(h, d, "/api/sync/push", {
      ...body,
      operations: [
        {
          ...op,
          payload: { ...op.payload, deviceTime: op.payload.deviceTime + 1 },
        },
      ],
    });
    expect(c.body.results[0].code).toBe("idempotency_conflict");
    expect(
      await drainFieldOrders({ db: h.db, env: h.env, publish: async () => {} }),
    ).toEqual({ captured: 1, review: 0 });
    expect(
      await drainFieldOrders({ db: h.db, env: h.env, publish: async () => {} }),
    ).toEqual({ captured: 0, review: 0 });
    expect(
      (
        await h.db`select count(*) as n from field_order_captures where visit_id=${v.id}`
      )[0].n,
    ).toBe("1");
  });
  test("invalid queued field facts stay visible for review without partial commercial writes", async () => {
    const [v] =
      await h.db`select * from visit_executions order by created_at limit 1`;
    const before = (await h.db`select count(*) as n from orders`)[0].n;
    const original = {
      kind: "order_intent",
      clientOrderId: crypto.randomUUID(),
      lines: [{ productId: product, uom: "PC", quantity: 1 }],
    };
    const [a] =
      await h.db`insert into visit_activities(organization_id,org_unit_id,visit_id,assignee_profile_id,outlet_id,activity_kind,activity,device_time,server_time)
      values('sunpride',${unit},${v.id},${v.assignee_profile_id},${outlet},'order_intent',${original},${new Date(new Date(v.checked_in_at).getTime() - 1)},now()) returning id`;
    expect(
      await drainFieldOrders({ db: h.db, env: h.env, publish: async () => {} }),
    ).toEqual({ captured: 0, review: 1 });
    expect((await h.db`select count(*) as n from orders`)[0].n).toBe(before);
    expect(
      (await h.db`select activity from visit_activities where id=${a.id}`)[0]
        .activity,
    ).toEqual(original);
    const list = await api(admin, "orders/field-review");
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.rows[0].storeName).toBe("Market Store");
    expect(
      (
        await api(admin, "orders/field-review/retry", {
          id: list.body.rows[0].id,
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    expect(
      await drainFieldOrders({ db: h.db, env: h.env, publish: async () => {} }),
    ).toEqual({ captured: 0, review: 1 });
    expect((await h.db`select count(*) as n from orders`)[0].n).toBe(before);
  });
  test("F-112/F-119 approved field orders bind SAP credit and only a worker acknowledgement can supply a SAP document number", async () => {
    const made = await create();
    expect(
      (
        await api(manager, "orders/approve", {
          id: made.body.id,
          reason: "Buyer PO and SAP credit checked",
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    const [order] = await h.db`select * from orders where id=${made.body.id}`;
    expect(order.sap_credit_decision_id).toBeTruthy();
    const [effect] =
      await h.db`select * from integration_events where source_type='order' and source_id=${order.id}`;
    expect(effect.status).toBe("pending");
    expect(effect.payload.document.facts.creditDecision.token).toBeTruthy();
    const before = await api(admin, "orders/transition", {
      id: order.id,
      status: "posted",
      reason: "Do not trust a typed SAP number",
      sapDocumentNumber: "FORGED",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(before.status).toBe(422);
    expect(before.body.error.code).toBe("sap_pending");
    const [field] =
      await h.db`select order_id from field_order_captures order by created_at limit 1`;
    expect(field).toBeDefined();
    expect(
      (
        await api(manager, "orders/approve", {
          id: field.order_id,
          reason: "Field order and SAP credit checked",
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    const { runOutbox } = await import("../src/domains/integration/outbox.js");
    await runOutbox(h.db, { env: { SAP_ORIGIN: sap.origin } });
    const [fieldAck] =
      await h.db`select sap_document_number,sap_credit_decision_id from orders where id=${field.order_id}`;
    expect(fieldAck.sap_document_number).toContain("SAMPLE-ORDER-");
    expect(fieldAck.sap_credit_decision_id).toBeTruthy();
    const [ack] = await h.db`select * from orders where id=${order.id}`;
    expect(ack.sap_document_number).toContain("SAMPLE-ORDER-");
    const posted = await api(admin, "orders/transition", {
      id: order.id,
      status: "posted",
      reason: "SAP acknowledgement reconciled",
      sapDocumentNumber: "FORGED",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(posted.status).toBe(200);
    expect(
      (
        await h.db`select sap_document_number from orders where id=${order.id}`
      )[0].sap_document_number,
    ).toBe(ack.sap_document_number);
    expect(
      sap.db
        .query("select count(*) as n from receipts where effect=?")
        .get(effect.event_id).n,
    ).toBe(1);
  });
  test("selling cases convert to exact base pieces; fractional base units fail", async () => {
    const [pc] =
      await h.db`insert into units_of_measure(organization_id,code,name,dimension,decimal_places,active) values('sunpride','PC','Piece','count',0,true) returning id`;
    const [cs] =
      await h.db`insert into units_of_measure(organization_id,code,name,dimension,decimal_places,active) values('sunpride','CS','Case','count',0,true) returning id`;
    const [p] =
      await h.db`insert into products(code,name,category,uom,unit_price,active,organization_id,base_uom_id,quantity_scale) values('CASE','Case SKU','Canned','PC',0,true,'sunpride',${pc.id},1) returning *`;
    await h.db`insert into product_selling_uoms(product_id,ordinal,uom_id) values(${p.id},0,${cs.id})`;
    await h.db`insert into uom_conversions(organization_id,product_id,from_uom_id,to_uom_id,numerator,denominator,rounding_mode,effective_from,active) values('sunpride',${p.id},${cs.id},${pc.id},24,1,'exact','2020-01-01',true)`;
    const { baseQuantity } = await import("../src/domains/orders/pricing.js");
    expect(await baseQuantity(h.db, p, "CS", 2, Date.now())).toBe(48);
    expect(await baseQuantity(h.db, p, "CS", 0.5, Date.now())).toBe(12);
    await expect(baseQuantity(h.db, p, "PC", 0.5, Date.now())).rejects.toThrow(
      "exact base unit",
    );
  });
});

describe("F-502 legacy promotion arithmetic (integer money; exclusive defaults)", () => {
  const lines = [
    {
      productId: "a",
      uom: "PC",
      quantity: 12,
      unitPriceCentavos: 101,
      lineTotalCentavos: 1212,
    },
    {
      productId: "b",
      uom: "PC",
      quantity: 6,
      unitPriceCentavos: 200,
      lineTotalCentavos: 1200,
    },
  ];
  test("percent discount rounds half-up", () => {
    const r = applyPromotions(lines, [
      {
        id: "1",
        code: "P",
        name: "Five percent",
        rule: {
          kind: "percent_off",
          item: { productId: "a", uom: "PC", quantity: 1 },
          percentOffBasisPoints: 500,
        },
      },
    ]);
    expect(r.totalCentavos).toBe(2351);
  });
  test("buy X adds free Y for complete multiples", () => {
    const r = applyPromotions(lines, [
      {
        id: "1",
        code: "P",
        name: "Buy six",
        rule: {
          kind: "buy_x_get_y",
          buy: { productId: "a", uom: "PC", quantity: 6 },
          free: { productId: "b", uom: "PC", quantity: 1 },
        },
      },
    ]);
    expect(r.promotionsApplied[0].freeGoods[0].quantity).toBe(2);
    expect(r.totalCentavos).toBe(2412);
  });
  test("F-502 bundle applies only full sets and honors exclusive precedence", () => {
    const r = applyPromotions(lines, [
      {
        id: "1",
        code: "P",
        name: "Bundle",
        rule: {
          kind: "bundle",
          components: [
            { productId: "a", uom: "PC", quantity: 2 },
            { productId: "b", uom: "PC", quantity: 1 },
          ],
          bundlePriceMinor: 300,
        },
      },
      {
        id: "2",
        code: "P2",
        name: "Half off",
        rule: {
          kind: "percent_off",
          item: { productId: "a", uom: "PC", quantity: 1 },
          percentOffBasisPoints: 5000,
        },
      },
    ]);
    expect(r.totalCentavos).toBe(1800);
    expect(r.promotionsApplied).toHaveLength(1);
  });
});

test("F-502 F-504 F-511 real order quote, authority refusal, stacked allocation and budget-backed deferred accrual", async () => {
  const { setTpmSeams } = await import("../src/domains/tpm/seams.js");
  const [master] =
    await h.db`insert into campaigns(code) values('TRANSACTION-PROOF') returning id`;
  const [version] =
    await h.db`insert into campaign_versions(campaign_id,version,name,mechanic,status,effective_from,effective_to,budget_centavos,expected_volume_base,expected_roi_bps,source,created_by) values(${master.id},1,'Sample transaction proof','Stacked rebate','active',now()-interval '1 hour',now()+interval '1 day',100000,0,0,'sample',${admin.userId}) returning id`;
  for (const [i, timing, bps] of [
    [1, "claimable", 2000],
    [2, "on_invoice", 1000],
  ]) {
    const made = await api(admin, "pricing/promotions/create", {
      code: "TX-" + i,
      name: "Transaction " + timing,
      rule: {
        kind: "percent_off",
        item: { productId: product, uom: "PC", quantity: 1 },
        percentOffBasisPoints: bps,
      },
      campaignVersionId: version.id,
      effectiveFrom: Date.now() - 10000,
      effectiveTo: Date.now() + 3600000,
      precedence: i,
      stacking: "stack",
      benefitTiming: timing,
    });
    expect(made.status).toBe(200);
  }
  expect((await create()).status).toBe(422);
  /** @type {any} */ let authorityFacts;
  setTpmSeams({
    requestOverride: async (_c, facts) => {
      authorityFacts = facts;
      return { status: "authorized", reference: "test-fiscal" };
    },
  });
  const made = await create();
  expect(made.status).toBe(200);
  const detail = await api(admin, "orders/detail?id=" + made.body.id);
  expect(detail.body.pricing.promotionsApplied).toHaveLength(2);
  expect(detail.body.totalCentavos).toBe(2300);
  expect(authorityFacts.totalCentavos).toBe(2300);
  expect(
    detail.body.lines.reduce(
      (/** @type {number} */ n, /** @type {any} */ l) =>
        n + l.lineTotalCentavos,
      0,
    ),
  ).toBe(2300);
  const approved = await api(manager, "orders/approve", {
    id: made.body.id,
    reason: "Independent approval",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(approved.status).toBe(200);
  const earnings =
    await h.db`select * from promotion_earnings where campaign_version_id=${version.id}`;
  expect(earnings).toHaveLength(1);
  expect(Number(earnings[0].amount_centavos)).toBe(500);
  const [committed] =
    await h.db`select sum(amount_centavos) as n from campaign_commitments where campaign_id=${master.id}`;
  expect(Number(committed.n)).toBe(700);
  const [posts] =
    await h.db`select count(*) as n from tpm_posting_instructions where earning_id=${earnings[0].id}`;
  expect(Number(posts.n)).toBe(1);
});
