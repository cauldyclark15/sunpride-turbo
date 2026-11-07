import { beforeAll, afterAll, test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import { pbkdf2Sync, createHash } from "node:crypto";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
  signedPost,
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
import {
  setSupervisorPin,
  overrideProof,
} from "../src/domains/storepos/overrides.js";
import { expectedCash } from "../src/domains/storepos/cash.js";
import { readingModel } from "../src/domains/storepos/readings.js";
import { modeBundle } from "../src/domains/storepos/model.js";

/** IP-REFUND: refund part of a store sale. Every figure is checked against the frozen original sale. */
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
/** What the handheld computes offline from the supervisor verifier it downloaded.
 * @param {string} refId @param {string} amount */
async function proof(refId, amount) {
  const [k] =
    await h.db`select * from store_supervisor_pins where profile_id=${boss.profile.id} and effective_to is null`;
  const key = pbkdf2Sync(PIN, k.pin_salt, 160000, 32, "sha256");
  expect(createHash("sha256").update(key).digest("hex")).toBe(k.pin_hash);
  return {
    profileId: boss.profile.id,
    pinId: k.id,
    method: "pin_offline",
    proof: overrideProof(key.toString("hex"), {
      kind: "refund",
      refId,
      shiftId: shift,
      amountCentavos: amount,
      pinId: k.id,
    }),
  };
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
/** @type {string} */ let saleId = "";
/** @type {any} */ let first;
test("a refund of one piece pays back its share, restocks it, lowers the till's cash and gets its own credit memo", async () => {
  saleId = await bigSale();
  const [sale] = await h.db`select * from store_sales where id=${saleId}`;
  expect(sale.receipt.totalMinor).toBe("19000");
  const cashBefore = await expectedCash(h.db, shift);
  const before = await stock(productA);
  first = await refundOp(saleId, VAT("1"), "RF-CHANGED-MIND", "3900");
  await push(first);
  const [r] =
    await h.db`select * from sale_refunds where id=${first.clientOpId}`;
  expect(r).toMatchObject({
    surface: "store",
    sale_id: saleId,
    credit_number: `${cmPrefix}-000000001`,
    reason_code: "RF-CHANGED-MIND",
    destination: "sellable",
  });
  expect(String(r.total_centavos)).toBe("3900");
  expect(r.tenders).toEqual([
    { method: "cash", label: "cash", amountCentavos: "3900" },
  ]);
  // one piece of a 2-piece vatable line: half of its VAT (836 / 2 = 418), the rest is VATable sales
  expect(r.tax).toMatchObject({
    totalMinor: "3900",
    vatMinor: "418",
    vatableSalesMinor: "3482",
    vatExemptMinor: "0",
  });
  // stock back through the ledger as sellable
  expect(Number((await stock(productA)).a)).toBe(Number(before.a) + 1);
  // the till gave 39.00 out of the drawer
  expect(await expectedCash(h.db, shift)).toBe(cashBefore - 3900n);
  // its own credit memo, naming the invoice, mirroring the invoice's tax
  const [doc] =
    await h.db`select * from fiscal_documents where source_type='store_refund' and source_id=${first.clientOpId}`;
  expect(doc.document_number).toBe(`${cmPrefix}-000000001`);
  expect(doc.snapshot.originalInvoice).toBe(sale.receipt_number);
  expect(doc.snapshot.documentType).toBe("credit_memo");
  expect(doc.snapshot.totalMinor).toBe("3900");
  expect(doc.snapshot.lines).toHaveLength(1);
  expect(doc.snapshot.lines[0].quantityBase).toBe("1");
  // the credit memo prints through the same model as an invoice
  const m = await h.fetch(
    `/api/v1/fiscal/receipts/${first.clientOpId}/print-model`,
    { headers: { cookie } },
  );
  expect(m.status).toBe(200);
  const model = (await m.json()).model;
  expect(model.title).toBe("CREDIT MEMO");
  expect(model.totals.totalDueMinor).toBe("3900");
  expect(model.totals.vatMinor).toBe("418");
  // the original sale and its receipt are untouched
  const [again] =
    await h.db`select receipt from store_sales where id=${saleId}`;
  expect(again.receipt).toEqual(sale.receipt);
  // canonical credit order keeps analytics net of the refund
  const [order] =
    await h.db`select total_centavos::text as t,original_order_id,order_type from orders where id=${first.clientOpId}`;
  expect(order).toMatchObject({ t: "-3900", order_type: "return" });
  expect(order.original_order_id).toBe(saleId);
  // stock card shows it as a customer return
  const [mv] =
    await h.db`select movement_type,source_type from inventory_movements where id=${r.movement_id}`;
  expect(mv).toMatchObject({
    movement_type: "pos_return",
    source_type: "store_refund",
  });
});

test("a replay of the same refund changes nothing", async () => {
  const dup = await send(first);
  expect(dup.status).toBe("duplicate");
  expect(
    (
      await h.db`select count(*)::int as n from sale_refunds where sale_id=${saleId}`
    )[0].n,
  ).toBe(1);
});

test("quantity is capped at sold minus already refunded, and a wrong amount or reason is refused", async () => {
  const tooMany = await refundOp(saleId, VAT("2"), "RF-CHANGED-MIND", "7800");
  expect((await send(tooMany)).status).toBe("rejected");
  const wrong = await refundOp(saleId, VAT("1"), "RF-CHANGED-MIND", "3899");
  const r = await send(wrong);
  expect(r.status).toBe("rejected");
  expect(r.code).toBe("stock_conflict");
  const noReason = await refundOp(saleId, VAT("1"), "CUST-RETURN", "3900");
  expect((await send(noReason)).status).toBe("rejected");
  const noNote = await refundOp(saleId, VAT("1"), "RF-QUALITY", "3900");
  expect((await send(noNote)).status).toBe("rejected");
  expect(
    (
      await h.db`select count(*)::int as n from sale_refunds where sale_id=${saleId}`
    )[0].n,
  ).toBe(1);
});

test("above the supervisor amount a refund needs a matching supervisor PIN proof; damaged goods go to damaged stock", async () => {
  await h.db`update refund_policies set supervisor_over_centavos=1000 where organization_id='sunpride'`;
  const bare = await refundOp(saleId, VAT("1"), "RF-DAMAGED", "3900");
  expect((await send(bare)).status).toBe("rejected");
  // a proof for another amount is not accepted
  const other = await refundOp(saleId, VAT("1"), "RF-DAMAGED", "3900");
  other.payload.supervisor = await proof(other.clientOpId, "3800");
  expect((await send(other)).status).toBe("rejected");
  // a proof for this exact refund is
  const before = await stock(productA);
  const good = await refundOp(saleId, VAT("1"), "RF-DAMAGED", "3900");
  good.payload.supervisor = await proof(good.clientOpId, "3900");
  await push(good);
  const after = await stock(productA);
  expect(Number(after.d)).toBe(Number(before.d) + 1);
  expect(after.a).toBe(before.a);
  // the override is on the log for the office
  const [o] =
    await h.db`select kind,amount_centavos::text as amount,supervisor_profile_id from store_overrides where ref_id=${good.clientOpId}`;
  expect(o).toMatchObject({
    kind: "refund",
    amount: "3900",
    supervisor_profile_id: boss.profile.id,
  });
  await h.db`update refund_policies set supervisor_over_centavos=50000 where organization_id='sunpride'`;
});

test("the last line comes back cash first, then GCash; the refunds add up to the sale, tax included", async () => {
  await push(await refundOp(saleId, EXM(), "RF-WRONG-ITEM", "11200"));
  const [sale] = await h.db`select receipt from store_sales where id=${saleId}`;
  const refunds =
    await h.db`select * from sale_refunds where sale_id=${saleId} order by refunded_at,created_at`;
  expect(refunds).toHaveLength(3);
  // cash taken was 150.00; 39.00 + 39.00 went back, so 72.00 cash is left, then GCash 40.00
  expect(refunds[2].tenders).toEqual([
    { method: "cash", label: "cash", amountCentavos: "7200" },
    { method: "gcash", label: "gcash", amountCentavos: "4000" },
  ]);
  const sum = (/** @type {string} */ k) =>
    refunds.reduce(
      (/** @type {bigint} */ n, /** @type {any} */ r) => n + BigInt(r.tax[k]),
      0n,
    );
  for (const k of [
    "totalMinor",
    "vatableSalesMinor",
    "vatMinor",
    "vatExemptMinor",
    "zeroRatedMinor",
  ])
    expect(String(sum(k))).toBe(String(BigInt(sale.receipt.tax[k])));
  // nothing is left to refund
  const more = await refundOp(saleId, EXM(), "RF-WRONG-ITEM", "11200");
  expect((await send(more)).status).toBe("rejected");
  // the negative tenders bring the sale's tenders to exactly zero
  const [net] =
    await h.db`select sum(amount_centavos)::text as n from store_tenders where sale_id=${saleId}`;
  expect(net.n).toBe("0");
});

test("the X reading counts the refunds and their credit memo range", async () => {
  const [{ till_day_id: day }] =
    await h.db`select till_day_id from store_shifts where id=${shift}`;
  const { model } = await readingModel(h.db, day, "x");
  expect(model.refunds).toMatchObject({
    count: 3,
    totalCentavos: "19000",
    beginning: `${cmPrefix}-000000001`,
    ending: `${cmPrefix}-000000003`,
  });
  expect(
    model.journal.filter((/** @type {any} */ j) => j.kind === "refund"),
  ).toHaveLength(3);
});

test("a senior sale refunds proportionally: discount, VAT removed and VAT-exempt buckets add back to the original", async () => {
  const [a] =
    await h.db`select next_issue from fiscal_allocations where id=${siAllocation}`;
  const serial = String(a.next_issue),
    id = crypto.randomUUID();
  await push(
    op("store.sale", {
      saleId: id,
      receiptNumber: `${siPrefix}-${serial.padStart(9, "0")}`,
      lines: [{ productId: productA, uom: "PC", quantity: 2 }],
      totalCentavos: "5571",
      fiscal: { allocationId: siAllocation, serial },
      tenders: [{ method: "cash", amountCentavos: "5571" }],
      discountClaim: {
        type: "senior",
        idNumber: "SC-2026-004411",
        holderName: "Juana Dela Cruz",
      },
    }),
  );
  const [sale] = await h.db`select receipt from store_sales where id=${id}`;
  expect(sale.receipt.tax).toMatchObject({
    vatExemptMinor: "6964",
    privilegeDiscountMinor: "1393",
    vatRemovedMinor: "836",
    totalMinor: "5571",
  });
  await push(await refundOp(id, VAT("1"), "RF-CHANGED-MIND", "2786"));
  await push(await refundOp(id, VAT("1"), "RF-CHANGED-MIND", "2785"));
  const refunds =
    await h.db`select * from sale_refunds where sale_id=${id} order by refunded_at,created_at`;
  expect(
    refunds.map((/** @type {any} */ r) => String(r.total_centavos)),
  ).toEqual(["2786", "2785"]);
  expect(refunds[0].tax).toMatchObject({
    vatExemptMinor: "3482",
    privilegeDiscountMinor: "697",
    vatRemovedMinor: "418",
    vatMinor: "0",
    privilegeType: "senior",
  });
  for (const k of [
    "totalMinor",
    "vatableSalesMinor",
    "vatMinor",
    "vatExemptMinor",
    "privilegeDiscountMinor",
    "vatRemovedMinor",
  ])
    expect(
      String(
        refunds.reduce(
          (/** @type {bigint} */ n, /** @type {any} */ r) =>
            n + BigInt(r.tax[k]),
          0n,
        ),
      ),
    ).toBe(String(BigInt(sale.receipt.tax[k])));
  // the credit memo keeps the holder, so the SC/PWD book can show the return
  const [doc] =
    await h.db`select snapshot from fiscal_documents where source_id=${refunds[0].id}`;
  expect(doc.snapshot.discountClaim).toMatchObject({
    type: "senior",
    idNumber: "SC-2026-004411",
  });
});

test("a sale that was partly refunded can no longer be voided or refunded whole", async () => {
  const id = await bigSale();
  await push(await refundOp(id, VAT("1"), "RF-CHANGED-MIND", "3900"));
  expect(
    (await send(op("store.void", { saleId: id, reason: "SAMPLE void" })))
      .status,
  ).toBe("rejected");
  expect(
    (await send(op("store.refund", { saleId: id, reason: "SAMPLE whole" })))
      .status,
  ).toBe("rejected");
});

test("a sale already under a whole-sale refund cannot be refunded by item, and the existing whole path still works", async () => {
  const id = await bigSale();
  const request = op("store.refund", { saleId: id, reason: "SAMPLE whole" });
  await push(request);
  const part = await refundOp(id, VAT("1"), "RF-CHANGED-MIND", "3900");
  expect((await send(part)).status).toBe("rejected");
  await web("reversals/decide", {
    id: request.clientOpId,
    decision: "approved",
  });
  const [r] =
    await h.db`select status from store_reversals where id=${request.clientOpId}`;
  expect(r.status).toBe("approved");
});

test("a partial refund after the session closed is refused", async () => {
  const id = await bigSale();
  await push(op("store.shift.close", { declaredCentavos: "10000" }));
  const part = await refundOp(id, VAT("1"), "RF-CHANGED-MIND", "3900");
  expect((await send(part)).status).toBe("rejected");
});

test("the store bundle carries refunds, reasons and the credit-memo range only for a phone that asks", async () => {
  const [m] =
    await h.db`select * from pos_device_modes where device_id=${seller.deviceId} and effective_to is null`;
  const device = { id: seller.deviceId };
  /** @type {any} */ const old = await modeBundle(h.db, actor, device, m, {
    taxFacts: true,
  });
  expect(old.refunds).toBeUndefined();
  expect(
    old.fiscal.ranges.map((/** @type {any} */ x) => x.documentType),
  ).toEqual(["sales_invoice"]);
  /** @type {any} */ const nu = await modeBundle(h.db, actor, device, m, {
    taxFacts: true,
    refunds: true,
  });
  expect(
    nu.fiscal.ranges.map((/** @type {any} */ x) => x.documentType).sort(),
  ).toEqual(["credit_memo", "sales_invoice"]);
  expect(nu.refunds.supervisorOverMinor).toBe("50000");
  expect(nu.refunds.reasons).toHaveLength(5);
  expect(
    nu.refunds.reasons.find((/** @type {any} */ x) => x.code === "RF-QUALITY"),
  ).toMatchObject({ destination: "damaged", requiresNote: true });
  // refunds already made on recent sales, per receipt line, so the phone shows "already refunded"
  expect(nu.refunds.made.length).toBeGreaterThan(5);
  const mine = nu.refunds.made.find(
    (/** @type {any} */ x) => x.id === first.clientOpId,
  );
  expect(mine).toMatchObject({
    saleId,
    totalMinor: "3900",
    lines: [{ lineIndex: 0, quantityBase: "1", amountCentavos: "3900" }],
  });
});

test("the Z reading freezes the refund count, total and credit memo range for the whole day", async () => {
  const [day] =
    await h.db`select id from store_till_days where register_id=${register} and status<>'z_done'`;
  await web(`days/${day.id}/z`, {});
  const [z] =
    await h.db`select refunds_count,refunds_centavos::text as total,beginning_refund,ending_refund from store_z_readings where till_day_id=${day.id}`;
  // 3 refunds of the first sale (19,000), 2 of the senior sale (5,571), 1 of the next (3,900), and one whole-sale refund (19,000)
  expect(z.refunds_count).toBe(7);
  expect(z.total).toBe(String(19000 + 5571 + 3900 + 19000));
  expect(z.beginning_refund).toBe(`${cmPrefix}-000000001`);
  expect(z.ending_refund).toMatch(/^REF-CM-0000000\d\d$/);
});
