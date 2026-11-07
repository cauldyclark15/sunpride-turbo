import { beforeAll, afterAll, test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  signedPost,
  CURSOR_SECRET,
} from "./harness.js";
import { install } from "../src/domains/storepos/index.js";
import { install as installFiscal } from "../src/domains/fiscal/index.js";
import { actorFor } from "../src/core/context.js";
import { ingestMaster } from "../src/domains/integration/replicas.js";
import { sampleMaster, sampleMasters } from "../../sap-mock/src/sample.js";
import { postMovement } from "../src/domains/inventory/posting.js";
import {
  allocateDocumentNumber,
  saveRegistration,
  createSeries,
} from "../src/domains/fiscal/series.js";
import { setSupervisorPin } from "../src/domains/storepos/overrides.js";

/**
 * Store refunds restock at the cost the sale took the goods out at, so the stock average cost does not move
 * (it used to be a concern on the van; this proves the till). Uses the REAL stock writer (postMovement), nothing mocked.
 */
/** @type {any} */ let h;
/** @type {any} */ let people;
/** @type {any} */ let seller;
/** @type {any} */ let boss;
/** @type {any} */ let actor;
/** @type {any} */ let supervisor;
let cookie = "";
const unit = crypto.randomUUID(),
  location = crypto.randomUUID(),
  outlet = crypto.randomUUID();
let register = "",
  policy = "",
  mode = "",
  productA = "",
  productB = "",
  shift = "",
  siAllocation = "",
  siPrefix = "",
  cmAllocation = "",
  cmPrefix = "";
const PIN = "482915";
/** @param {any} who */ async function persist(who) {
  const p = who.profile;
  await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${who.userId},${who.userId},${p.name},${who.email},${p.role},'active',${unit})`;
  await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},now()-interval '1 day','fixture','fixture')`;
}
/** @param {string} path @param {any} p */ async function web(path, p) {
  const res = await h.fetch("/api/v1/storepos/" + path, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      registerId: register,
      ...p,
      requestKey: crypto.randomUUID(),
    }),
  });
  const data = await res.json();
  if (res.status !== 200) throw new Error(JSON.stringify(data));
  return data;
}
/** @param {string} kind @param {any} p */ function op(kind, p) {
  const time = Date.now();
  return {
    clientOpId: crypto.randomUUID(),
    opType: kind,
    clientTime: time,
    dependsOn: [],
    payload: {
      registerId: register,
      modeVersionId: mode,
      shiftId: shift,
      ...p,
      deviceTime: time,
    },
  };
}
/** @param {any} operation */ async function send(operation) {
  const r = await signedPost(h, seller, "/api/sync/push", {
    version: 2,
    app: "van-android",
    deviceId: seller.deviceId,
    scopeId: unit,
    operations: [operation],
  });
  expect(r.res.status).toBe(200);
  return r.body.results[0];
}
/** @param {any} operation */ async function push(operation) {
  const r = await send(operation);
  if (r.status !== "applied") throw new Error(JSON.stringify(r));
  return r;
}
/** A sale of 2 x VAT39 + 1 x EXM112 (19,000 centavos), cash 150.00 + GCash 40.00. */
async function bigSale() {
  const [a] =
    await h.db`select next_issue from fiscal_allocations where id=${siAllocation}`;
  const serial = String(a.next_issue),
    id = crypto.randomUUID();
  const operation = op("store.sale", {
    saleId: id,
    receiptNumber: `${siPrefix}-${serial.padStart(9, "0")}`,
    lines: [
      { productId: productA, uom: "PC", quantity: 2 },
      { productId: productB, uom: "PC", quantity: 1 },
    ],
    totalCentavos: "19000",
    fiscal: { allocationId: siAllocation, serial },
    tenders: [
      { method: "cash", amountCentavos: "15000" },
      {
        method: "gcash",
        amountCentavos: "4000",
        reference: "REF-" + id.slice(0, 8),
      },
    ],
  });
  await push(operation);
  return id;
}
/** @param {string} saleId @param {{lineIndex:number, productId:string, quantityBase:string}[]} lines @param {string} reasonCode @param {string} expected @param {any} [extra] */
async function refundOp(saleId, lines, reasonCode, expected, extra = {}) {
  const [c] =
    await h.db`select next_issue from fiscal_allocations where id=${cmAllocation}`;
  const serial = String(c.next_issue);
  const operation = op("store.refund.part", {
    saleId,
    lines,
    reasonCode,
    note: null,
    expectedCentavos: expected,
    fiscal: { allocationId: cmAllocation, serial },
    creditNumber: `${cmPrefix}-${serial.padStart(9, "0")}`,
    ...extra,
  });
  operation.payload.refundId = operation.clientOpId;
  return operation;
}
const stock = async (/** @type {string} */ product) =>
  (
    await h.db`select available_base::text as a,damaged_base::text as d from inventory_balances where location_id=${location} and product_id=${product}`
  )[0];

beforeAll(async () => {
  h = await startHarness({ installers: [install, installFiscal] });
  people = profileStore(h);
  h.setHooks({ unitInScope: async () => true });
  await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE Cebu','national','active',now()-interval '1 day')`;
  await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('refund-test','org_units',${unit},'unit')`;
  seller = await boundDevice(h, people, {
    app: "van-android",
    orgUnitId: unit,
  });
  await persist(seller);
  const userId = await createUser(
    h,
    "refund-boss@example.com",
    "fixture password only",
  );
  boss = {
    userId,
    email: "refund-boss@example.com",
    profile: people.set(userId, {
      role: "super_admin",
      orgUnitId: unit,
      name: "Sample supervisor",
    }),
  };
  await persist(boss);
  actor = await actorFor(h.db, seller.userId);
  supervisor = await actorFor(h.db, userId);
  const login = await h.fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: boss.email,
      password: "fixture password only",
    }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const material = sampleMasters.find((m) => m.kind === "material");
  const condition = sampleMasters.find((m) => m.kind === "condition");
  let n = 0;
  for (const [
    code,
    name,
    price,
    treatment,
  ] of /** @type {[string,string,number,string][]} */ ([
    ["REF-VAT39", "Frozen nuggets 39", 3900, "vatable"],
    ["REF-EXM112", "Exempt item 112", 11200, "exempt"],
  ])) {
    await ingestMaster(
      h.db,
      sampleMaster("material", code, {
        ...material.data,
        code,
        name,
        tracking: "none",
        packs: [
          {
            uom: "PC",
            parentUom: null,
            numerator: 1,
            denominator: 1,
            barcode: String(9920000000000 + n++),
          },
        ],
      }),
    );
    await ingestMaster(
      h.db,
      sampleMaster("condition", `${code}-PRICE`, {
        ...condition.data,
        productCode: code,
        unitPriceCentavos: price,
        taxCode: `SAMPLE-${treatment}`,
        taxBasisPoints: treatment === "vatable" ? 1200 : 0,
        taxTreatment: treatment,
        taxInclusive: true,
      }),
    );
  }
  await ingestMaster(
    h.db,
    sampleMasters.find((m) => m.kind === "customer"),
  );
  productA = (await h.db`select id from products where code='REF-VAT39'`)[0].id;
  productB = (await h.db`select id from products where code='REF-EXM112'`)[0]
    .id;
  const customer = (
    await h.db`select id from customers where code='MOCK-C1'`
  )[0].id;
  await h.db`insert into outlets(id,organization_id,code,name,status,custodian_org_unit_id,channel,created_by) values(${outlet},'sunpride','STORE','Sample store','active',${unit},'gt',${seller.userId})`;
  await h.db`insert into outlet_customer_links(outlet_id,customer_id,source,effective_from,actor_subject,reason) values(${outlet},${customer},'sample',now()-interval '1 day','fixture','fixture')`;
  await h.db`insert into inventory_locations(id,organization_id,org_unit_id,site_code,code,name,type,active,allows_picking,allows_receiving,allows_sale,allows_production) values(${location},'sunpride',${unit},'CEBU','STORE','STORE','store',true,true,true,true,false)`;
  register = (
    await web("registers/save", {
      locationId: location,
      terminalCode: "SAMPLE-01",
      name: "Sample terminal",
    })
  ).id;
  await web("registers/link", { outletId: outlet });
  policy = (
    await web("policies/save", {
      toleranceCentavos: "100",
      loyaltyEnabled: true,
      earnPerCentavos: "1000",
      pointValueCentavos: "100",
      pin: "135790",
    })
  ).id;
  await web("cashiers/save", { profileId: seller.profile.id, enabled: true });
  mode = (
    await web("mode/set", {
      deviceId: seller.deviceId,
      mode: "store",
      allowLocalSwitch: true,
    })
  ).id;
  for (const method of ["cash", "gcash", "card"])
    await h.db`insert into fiscal_tender_rules(org_unit_id,method,label,enabled,effective_from,sample,entered_by) values(${unit},${method},${method},true,now()-interval '1 day',true,${boss.profile.id})`;
  for (const [type, p] of [
    ["sales_invoice", "REF-SI"],
    ["credit_memo", "REF-CM"],
  ]) {
    const reg = await tx(h.db, (db) =>
      saveRegistration(db, supervisor, {
        orgUnitId: unit,
        entityName: "SAMPLE company",
        branchName: "SAMPLE Cebu",
        tin: "SAMPLE",
        address: "Sample address",
        documentType: type,
        status: "sample_not_filed",
        effectiveFrom: "2026-01-01T00:00:00Z",
      }),
    );
    const series = await tx(h.db, (db) =>
      createSeries(db, supervisor, {
        registrationId: reg.id,
        prefix: p,
        firstSerial: "1",
        lastSerial: "100",
        effectiveFrom: "2026-01-01T00:00:00Z",
      }),
    );
    const a = await tx(h.db, (db) =>
      allocateDocumentNumber(db, {
        actor,
        deviceId: seller.deviceId,
        seriesId: series.id,
        requestKey: crypto.randomUUID(),
        count: 20,
      }),
    );
    if (type === "sales_invoice") {
      siAllocation = a.allocationId;
      siPrefix = p;
    } else {
      cmAllocation = a.allocationId;
      cmPrefix = p;
    }
  }
  await tx(h.db, (db) =>
    setSupervisorPin(db, supervisor, { profileId: boss.profile.id, pin: PIN }),
  );
  for (const product of [productA, productB])
    await tx(h.db, (db) =>
      postMovement(db, {
        kind: "opening_balance",
        sourceType: "cutover",
        sourceId: location,
        idempotencyKey: "refund-opening-" + product,
        occurredAt: Date.now(),
        organizationId: "sunpride",
        actor: { profileId: actor.profileId, userId: actor.userId },
        lines: [
          {
            productId: product,
            quantityBase: 10,
            fromLocationId: null,
            toLocationId: location,
            uom: "PC",
            unitCostMinor: 1000,
          },
        ],
      }),
    );
  shift = crypto.randomUUID();
  await push(
    op("store.shift.open", {
      shiftId: shift,
      policyId: policy,
      openingCentavos: "10000",
    }),
  );
}, 60000);
afterAll(async () => h?.close());

const VAT = (/** @type {string} */ q) => [
  { lineIndex: 0, productId: productA, quantityBase: q },
];
const EXM = () => [{ lineIndex: 1, productId: productB, quantityBase: "1" }];
const COST = 1000;
/** @param {string} product */
const balance = async (product) => {
  const [b] =
    await h.db`select physical_base::int as qty,weighted_average_cost_minor::int as wac,inventory_value_minor::int as val from inventory_balances where location_id=${location} and product_id=${product}`;
  return b;
};
/** Cost on every line of one movement, for a product. @param {string} movementId @param {string} product */
const lineCosts = async (movementId, product) =>
  (
    await h.db`select unit_cost_minor::int as c from inventory_movement_lines where movement_id=${movementId} and product_id=${product}`
  ).map((/** @type {any} */ r) => r.c);

test("the sale takes stock out at the store's average cost", async () => {
  const before = await balance(productA);
  expect(before).toEqual({ qty: 10, wac: COST, val: 10 * COST });
  const id = await bigSale();
  const [sale] = await h.db`select movement_id from store_sales where id=${id}`;
  expect(await lineCosts(sale.movement_id, productA)).toEqual([COST]);
  expect(await balance(productA)).toEqual({ qty: 8, wac: COST, val: 8 * COST });
});

test("a part refund restocks at the sale cost: average cost unchanged, stock value up by exactly the pieces x cost", async () => {
  const id = await bigSale();
  const [sale] = await h.db`select movement_id from store_sales where id=${id}`;
  const a0 = await balance(productA);
  const b0 = await balance(productB);
  const one = await refundOp(id, VAT("1"), "RF-CHANGED-MIND", "3900");
  await push(one);
  const [r1] =
    await h.db`select movement_id from sale_refunds where id=${one.clientOpId}`;
  // never zero, and the same as the sale's line
  expect(await lineCosts(r1.movement_id, productA)).toEqual(
    await lineCosts(sale.movement_id, productA),
  );
  expect(await lineCosts(r1.movement_id, productA)).toEqual([COST]);
  expect(await balance(productA)).toEqual({
    qty: a0.qty + 1,
    wac: COST,
    val: a0.val + COST,
  });
  // the second piece and the exempt line (the last line of the receipt)
  await push(await refundOp(id, VAT("1"), "RF-CHANGED-MIND", "3900"));
  await push(await refundOp(id, EXM(), "RF-CHANGED-MIND", "11200"));
  expect(await balance(productA)).toEqual({
    qty: a0.qty + 2,
    wac: COST,
    val: a0.val + 2 * COST,
  });
  expect(await balance(productB)).toEqual({
    qty: b0.qty + 1,
    wac: COST,
    val: b0.val + COST,
  });
});

test("a damaged-stock refund also goes back at the sale cost", async () => {
  const id = await bigSale();
  const a0 = await balance(productA);
  const refund = await refundOp(id, VAT("1"), "RF-QUALITY", "3900", {
    note: "Torn pack",
  });
  await push(refund);
  const [r] =
    await h.db`select movement_id,destination from sale_refunds where id=${refund.clientOpId}`;
  expect(r.destination).toBe("damaged");
  expect(await lineCosts(r.movement_id, productA)).toEqual([COST]);
  const a1 = await balance(productA);
  expect(a1.val).toBe(a0.val + COST);
  expect(a1.qty).toBe(a0.qty + 1);
});

test("a whole-receipt refund and a whole-receipt void both restock at the sale cost", async () => {
  for (const kind of ["store.refund", "store.void"]) {
    const id = await bigSale();
    const a0 = await balance(productA);
    const b0 = await balance(productB);
    const request = op(kind, { saleId: id, reason: "SAMPLE whole" });
    await push(request);
    await web("reversals/decide", {
      id: request.clientOpId,
      decision: "approved",
    });
    const [rev] =
      await h.db`select status,movement_id from store_reversals where id=${request.clientOpId}`;
    expect(rev.status).toBe("approved");
    expect(await lineCosts(rev.movement_id, productA)).toEqual([COST]);
    expect(await lineCosts(rev.movement_id, productB)).toEqual([COST]);
    expect(await balance(productA)).toEqual({
      qty: a0.qty + 2,
      wac: COST,
      val: a0.val + 2 * COST,
    });
    expect(await balance(productB)).toEqual({
      qty: b0.qty + 1,
      wac: COST,
      val: b0.val + COST,
    });
  }
});

test("when stock was received at a different cost after the sale, a refund still goes back at the SALE cost, not zero and not today's average", async () => {
  const id = await bigSale();
  // 10 more pieces arrive at double the cost: the store's average cost moves away from the sale's
  await tx(h.db, (db) =>
    postMovement(db, {
      kind: "opening_balance",
      sourceType: "cutover",
      sourceId: crypto.randomUUID(),
      idempotencyKey: "refund-cost-topup-" + crypto.randomUUID(),
      occurredAt: Date.now(),
      organizationId: "sunpride",
      actor: { profileId: actor.profileId, userId: actor.userId },
      lines: [
        {
          productId: productA,
          quantityBase: 10,
          fromLocationId: null,
          toLocationId: location,
          uom: "PC",
          unitCostMinor: 2 * COST,
        },
      ],
    }),
  );
  const before = await balance(productA);
  expect(before.wac).toBeGreaterThan(COST);
  const refund = await refundOp(id, VAT("1"), "RF-CHANGED-MIND", "3900");
  await push(refund);
  const [r] =
    await h.db`select movement_id from sale_refunds where id=${refund.clientOpId}`;
  expect(await lineCosts(r.movement_id, productA)).toEqual([COST]);
  const after = await balance(productA);
  expect(after.qty).toBe(before.qty + 1);
  expect(after.val).toBe(before.val + COST);
});
